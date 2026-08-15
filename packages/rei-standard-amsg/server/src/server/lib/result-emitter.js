/**
 * `ctx.emitResult(payload)` 的实现：把一条宿主自定义的结果送给客户端。
 *
 * 聊天正文之外的产出——整理好的一份数据、一条账目、后台生成的产物——以前只
 * 能靠宿主自己拼：`db.appendOutboxMessages` 加 `encryptForStorage` 手工组一
 * 行，落什么列、怎么加密全靠照着库里的实现抄。这里把那条路收编成正式能力，
 * 落进去的行与推送链路落的完全同构（见 lib/outbox-store.js 的 toOutboxRows），
 * 客户端补收时不用区分是谁写的。
 *
 * 走两条路，一条都不少：
 *   - **落进 message_outbox**：这是到达的保证。客户端下次 `GET /outbox?since=`
 *     一定拿得到——推送没送到、内容超过一条推送 4KB 的上限，都不会让它丢。
 *     每种结果各写一套轮询接口这件事，也就不用做了。
 *   - **发一条 Web Push**：这是及时性。生成完能当场弹一下叫人回来看，而不是
 *     等客户端下次上线。
 *
 * 落行失败会抛（那是到达的保证，静默丢掉正是要修的病）；推送发不出去只记日
 * 志、不抛——行已经落好，客户端补收照样拿得到。唯一例外是任务在这期间被取消
 * 或顶替，那个信号照旧往上抛（见 lib/errors.js 的 isTaskCancelledError）。
 *
 * 弹不弹通知：结果默认弹（`messageKind: 'result'` 在 SW 侧与聊天正文同待遇），
 * 标题正文在 payload 的 `notification` 里自定义，不想弹就 `show: false`。库会
 * 在宿主没表态时把 `show: 'always'` 补上——这样即使客户端的 SW 还是旧版本
 * （不认识 result 这个 kind），通知照样弹得出来。
 *
 * 订阅是按 `userVisibleOnly: true` 建的，收到 push 却不弹通知，Firefox 按配额
 * 退订、iOS 在订阅的宽限期过后直接吊销（见 amsg-sw README 的「不展示通知的代
 * 价」）。所以这里只有两条路：要推就一定弹（`show: 'always'`，嫌吵配 `tag`
 * 折叠 + `silent`），不想弹就 `show: false` ——那条不发推送、只落行，客户端
 * 上线补拉照样拿得到。`'when-hidden'` 是给老部署留的兼容值，照推，但应用在前
 * 台时它就是一条不弹的 push，那笔账照记。
 *
 * 取消语义与聊天分段一致：行上写 `task_uuid`，所以 `DELETE /message` 取消、
 * `supersedesUuid` 顶替时，这条任务名下还没发出去的结果会一起撤掉（见
 * lib/outbox-store.js 的 discardUndeliveredPushesForTask）。取消恰好发生在
 * 落行**之前**、而这条结果落行在后的那个窗口，取消侧扫不到它，由这里自己撤。
 */

import { buildResultPush } from '@rei-standard/amsg-shared';

import { DeploymentConfigError, isTaskCancelledError, sendTaggedPush } from './errors.js';
import {
  supportsOutbox,
  toOutboxRows,
  markPushesDelivered,
  discardUndeliveredPushes,
} from './outbox-store.js';
import { shouldSendPush } from './push-policy.js';
import { resolvePushSubscription } from './push-subscription-store.js';

/**
 * @typedef {Object} ResultEmitter
 * @property {(payload: Object) => Promise<{ messageId: string, pushed: boolean }>} emitResult
 *   把一条结果落进收件箱并推送出去。`payload` 是宿主自己的形状，只有两个约束：
 *   必须是普通对象，且带一个非空的 `resultKind`（这类结果的名字，客户端按它
 *   分流）。返回 `messageId`（补收和去重的键）与 `pushed`（这次推送有没有真
 *   的发出去；`false` 只表示没能当场送达，行还在收件箱里等补收）。
 */

/**
 * 造一份作用于某条任务的结果出口。
 *
 * 身份字段（`taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs` /
 * `messageKind`）由库覆盖写：它们描述的是这条任务行的事实，不是内容。
 * `messageId` / `sessionId` / `timestamp` 宿主没给才补——`messageId` 的缺省
 * 值掺了任务 id 与本次名义触发时刻，同一次触发重试时组出同一个 id，收件箱靠
 * `(user_id, message_id)` 唯一约束天然去重，不会补出第二条。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {Object} args.task - 数据库任务行
 * @param {string} args.userKey - per-user 存储密钥
 * @param {Object} args.decryptedPayload - 解密后的任务 payload（取 messageType / recurrenceType / 老任务里的订阅）
 * @param {string} args.messageIdBase - messageId 的前缀（与推送链路同一份）
 * @param {string} args.sessionId
 * @param {number|null} args.occurrenceMs
 * @param {{ sendNotification: Function }|null} args.webpush
 * @param {() => number} [args.now] - 取当前时刻（测试可注入假时钟）
 * @returns {ResultEmitter}
 */
export function createResultEmitter({
  db, task, userKey, decryptedPayload, messageIdBase, sessionId, occurrenceMs, webpush, now,
}) {
  const nowFn = typeof now === 'function' ? now : Date.now;
  // 本次 fire 已经发出去几条结果。缺省 messageId 按它编号，所以同一次触发重
  // 跑时第 n 条结果拿到的还是同一个 id。
  let emitted = 0;

  const emitResult = async (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('emitResult(payload) 需要一个普通对象');
    }
    if (!supportsOutbox(db)) {
      // 没有收件箱就只剩推送一条路，而推送不保证到达——那正是这个能力要解决
      // 的问题。静默降级会让宿主以为结果送出去了，所以这里响亮地失败。
      throw new DeploymentConfigError(
        'OUTBOX_UNSUPPORTED: 当前数据库适配器不支持 message_outbox，emitResult 没有落脚处',
        { code: 'OUTBOX_UNSUPPORTED' }
      );
    }

    const seq = emitted++;
    const push = buildResultPush({
      messageType: decryptedPayload.messageType || 'auto',
      source: 'scheduled',
      messageId: `${messageIdBase}_result_${seq}`,
      sessionId,
      ...payload,
      // 通知策略：宿主没表态就补一句「弹」。写进 payload 而不是只靠 SW 的默
      // 认行为，是为了让还没升级 SW 的客户端也弹得出来——旧版 SW 不认识
      // result 这个 kind，只认 notification.show。
      notification: withDefaultShow(payload.notification),
      // 任务身份由库覆盖写（与推送链路同一条规矩）。
      taskId: task.id ?? null,
      taskUuid: task.uuid ?? null,
      recurrenceType: decryptedPayload.recurrenceType || 'none',
      occurrenceMs,
    });

    // 先落行再推送，与推送链路同序：落进去的必须是发出去的同一份内容。
    await db.appendOutboxMessages(task.user_id, await toOutboxRows([push], userKey, nowFn()));

    // 宿主明说了不弹（`show: false`）就不推：推过去只会白违约一次
    // `userVisibleOnly` 的约定，而行已经落好，客户端补收照样拿得到。行落成功
    // 是走到这里的前提（上面那句失败会直接抛），所以不用再判 outboxed。
    let pushed;
    try {
      pushed = shouldSendPush(push, { outboxed: true })
        ? await sendResultPush({ db, task, userKey, decryptedPayload, webpush, push })
        : false;
    } catch (error) {
      // 走到这里只有一种可能：推送前发现这条任务已经被取消 / 顶替（见
      // sendResultPush）。取消动作发生在这一行落库之前，所以它清不到这一行，
      // 得由这里自己撤——不撤的话客户端下次补收照样把它拉回去，用户看到的就是
      // 「取消接口回了成功，东西还是来了」。与聊天分段那条路同一个处置。
      await discardUndeliveredPushes({ db, userId: task.user_id, pushes: [push], sentIds: [] });
      throw error;
    }
    if (pushed) {
      await markPushesDelivered({ db, userId: task.user_id, messageIds: [push.messageId] });
    }
    return { messageId: push.messageId, pushed };
  };

  return { emitResult };
}

/**
 * 通知策略的缺省值：宿主没说要不要弹就按「弹」补上，其余字段原样保留。
 *
 * @param {Object|undefined} notification
 * @returns {Object}
 */
function withDefaultShow(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    return { show: 'always' };
  }
  if (notification.show === undefined) return { ...notification, show: 'always' };
  return notification;
}

/**
 * 把结果推出去。发不出去不抛（行已经落进收件箱，客户端补收拿得到），只有
 * 「任务被取消 / 顶替」这个信号照旧往上抛——它的意思是这条任务已经不归本次
 * 投递管了，后面的活都该停。
 *
 * 推送没配齐（没有 webpush / VAPID / 订阅）时安静跳过：那种部署本来就只走补
 * 收，不该每条结果报一次错。
 *
 * @returns {Promise<boolean>} 这次有没有真的发出去
 */
async function sendResultPush({ db, task, userKey, decryptedPayload, webpush, push }) {
  if (!webpush || typeof webpush.sendNotification !== 'function') return false;
  try {
    const subscription = await resolvePushSubscription({
      db,
      userId: task.user_id,
      userKey,
      legacyFallback: (decryptedPayload && decryptedPayload.pushSubscription) ?? null,
    });
    await sendTaggedPush(webpush, subscription, JSON.stringify(push));
    return true;
  } catch (error) {
    if (isTaskCancelledError(error)) throw error;
    console.warn(
      `[amsg-server] 结果 ${push.messageId} 的推送没发出去（已落进收件箱，等客户端补收）:`,
      error && error.message
    );
    return false;
  }
}
