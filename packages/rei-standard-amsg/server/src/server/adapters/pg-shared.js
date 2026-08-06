/**
 * pg / neon 共用的 Postgres 查询实现。
 *
 * 两个适配器只在「怎么把 SQL 发出去」上不同（pg 的连接池 vs neon 的 HTTP
 * 驱动），SQL 与并发语义必须逐字一致——各自复制一份的话，修一边漏一边就会让
 * 两种 Postgres 部署的串行化行为静默分歧，而各自的测试还都是绿的。所以这里
 * 按执行器参数化：适配器只递一个 `query(text, params) → rows`。
 *
 * D1（SQLite 方言、单写者、ISO TEXT 时间戳）不走这份实现。
 *
 * @typedef {(text: string, params?: any[]) => Promise<any[]>} PgQuery
 */

/**
 * 领取一条到点的任务：在 lease_until 上写下「这条归我管到什么时候」，
 * 本次投递期间别的 tick 领不走它。
 *
 * 租约写在自己的列上，next_send_at 全程不动——那一列是用户设的触发时刻，
 * 任务列表要读它、循环任务推进下一次也要拿它当基准。
 *
 * 两个 tick 抢同一行时只有一个改得动，另一个拿不到 RETURNING 行，据此跳
 * 过。WHERE 里的两个条件各管一件事：
 *   - lease_until 为空或已过期：没人正在跑这条。领了任务的 tick 中途没了
 *     也不会把行焊死，租约到期后自然可以被接手。
 *   - next_send_at 等于读这行时看到的值：读出来之后用户又改了排期的话，
 *     这一跳就不该再按旧时刻发。
 *
 * 不加一个 'sending' 状态来表达「正在跑」：status 上有 CHECK 约束，加值
 * 要改表。
 *
 * 比 next_send_at 时两边都截到毫秒：列是 timestamptz（微秒精度），驱动读
 * 出来是 JS Date（毫秒精度），原值送回去可能因为亚毫秒差对不上。
 *
 * 带 serializeGroup 时多一道分组门：同一分组里已经有别的行拿着未到期的租
 * 约，这条就领不走（同一分组同时只跑一条）。判定和写租约在同一条 UPDATE
 * 里完成——但那只对「抢同一行」成立；READ COMMITTED 下两个并发 tick 各领
 * 同组的**不同**行时，各自的 NOT EXISTS 子查询都看不到对方尚未提交的租约，
 * 也没有行锁冲突逼它重查（写偏斜）。所以占位成功后再回头查一次：真撞上了
 * 就把自己刚写的租约放掉、这一跳不跑——两边都让也没事，行保持 pending，
 * 下一跳重试。分组门只看租约，不看 `retry_after`：等着重试的任务其实闲着，
 * 不该把同分组的其他任务一起堵住。
 *
 * @param {PgQuery} query
 * @param {number} taskId
 * @param {string|Date} expectedNextSendAt - 读这行时拿到的 next_send_at 原值
 * @param {string|Date} leaseUntil - 租期末尾
 * @param {string|null} [serializeGroup] - 串行分组标识；空表示不参与分组串行
 * @returns {Promise<boolean>} true = 领到了；false = 已被别人领走、同分组有
 *   任务正在跑、排期被改过、或行已不是 pending
 */
export async function claimTask(query, taskId, expectedNextSendAt, leaseUntil, serializeGroup = null) {
  const grouped = typeof serializeGroup === 'string' && serializeGroup.length > 0;
  const params = [leaseUntil, taskId, expectedNextSendAt];
  let setClause = 'lease_until = $1, updated_at = NOW()';
  let groupGuard = '';
  if (grouped) {
    params.push(serializeGroup); // $4
    setClause = 'lease_until = $1, serialize_group = $4, updated_at = NOW()';
    groupGuard = `
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_messages busy
           WHERE busy.serialize_group = $4 AND busy.id <> $2
             AND busy.status = 'pending' AND busy.lease_until > NOW()
        )`;
  }
  const rows = await query(
    `UPDATE scheduled_messages
        SET ${setClause}
      WHERE id = $2 AND status = 'pending'
        AND date_trunc('milliseconds', next_send_at)
          = date_trunc('milliseconds', $3::timestamptz)
        AND (lease_until IS NULL OR lease_until <= NOW())${groupGuard}
     RETURNING id`,
    params
  );
  if (rows.length === 0) return false;
  if (!grouped) return true;

  // 写偏斜的收口（见函数头注释）：自己的租约已提交，此刻再查，对方若也领
  // 到了同组的另一行，双方至少有一方看得见冲突并让路。
  const conflict = await query(
    `SELECT 1 FROM scheduled_messages busy
      WHERE busy.serialize_group = $1 AND busy.id <> $2
        AND busy.status = 'pending' AND busy.lease_until > NOW()
      LIMIT 1`,
    [serializeGroup, taskId]
  );
  if (conflict.length === 0) return true;
  await query(
    'UPDATE scheduled_messages SET lease_until = NULL, updated_at = NOW() WHERE id = $1',
    [taskId]
  );
  return false;
}

// ── push_subscriptions (user-level Web Push subscription) ──────────────

/**
 * 这个用户当前登记的推送订阅（密文原样返回，解密在上层）。
 *
 * @param {PgQuery} query
 * @param {string} userId
 * @returns {Promise<{ subscription: string, updated_at: number }|null>}
 */
export async function getPushSubscription(query, userId) {
  const rows = await query(
    'SELECT subscription, updated_at FROM push_subscriptions WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (rows.length === 0) return null;
  // BIGINT 在 pg 驱动里读出来是字符串，统一成 number 再往上给。
  return { subscription: rows[0].subscription, updated_at: Number(rows[0].updated_at) };
}

/**
 * 覆盖写这个用户的订阅。一个用户一行，没有 last-write-wins 之类的比较——
 * 客户端拿到的新订阅永远比旧的有效，旧的那份只会 410。
 *
 * @param {PgQuery} query
 * @param {string} userId
 * @param {string} encryptedSubscription
 * @param {number} updatedAt - epoch 毫秒
 * @returns {Promise<boolean>}
 */
export async function upsertPushSubscription(query, userId, encryptedSubscription, updatedAt) {
  const rows = await query(
    `INSERT INTO push_subscriptions (user_id, subscription, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       subscription = EXCLUDED.subscription,
       updated_at = EXCLUDED.updated_at
     RETURNING user_id`,
    [userId, encryptedSubscription, updatedAt]
  );
  return rows.length > 0;
}

/**
 * 删掉这个用户的订阅（设置页「停止接收推送」）。
 *
 * @param {PgQuery} query
 * @param {string} userId
 * @returns {Promise<boolean>} true = 确实删掉了一行
 */
export async function deletePushSubscription(query, userId) {
  const rows = await query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 RETURNING user_id',
    [userId]
  );
  return rows.length > 0;
}
