/**
 * instant 任务的起跳器：一个 Durable Object，一条任务一个实例（实例名就是任务
 * uuid）。
 *
 * schedule-message 落库后叫醒它，它给自己设一个「现在到期」的 alarm 就返回，
 * 请求随即回 202。真正的投递跑在 alarm 里：那是一次独立的执行，有 15 分钟的墙
 * 钟预算，跟已经结束的那个请求无关，客户端断开、进程被杀都影响不到它。
 *
 * 选它而不是 Queue / waitUntil 的理由写在 server README「关于 messageType:
 * 'instant'」那一节，这里只记实现上的约束：
 *   - 一条任务一个实例：几条 instant 同时来各跑各的，互不排队。
 *   - 不继承 `cloudflare:workers` 的 DurableObject 基类，叫醒走 `stub.fetch()`
 *     而不是 RPC——这样这个包不用 import `cloudflare:workers`，非 Cloudflare 的
 *     打包也不受影响。
 *   - 投递调的是 Worker 的 runTask，和 cron 同一条链（占位、租约心跳、失败退避、
 *     hook 全套）。cron 同时扫到这条也只有一方领得到租约，不会重复发。
 *   - alarm 里 runTask 抛错就让它抛出去：Cloudflare 会自动重试 alarm（指数退避，
 *     最多 6 次）；全部失败后行仍是 pending，cron 接手。
 */

/** 默认的 Durable Object binding 名（wrangler 里 `durable_objects.bindings[].name`）。 */
export const INSTANT_TICK_BINDING = 'AMSG_INSTANT_TICK';

// 实例存储里记「我要跑哪条」的 key。
const UUID_KEY = 'uuid';

// 实例存储里记「这条任务我占位用的租约 token」的 key（见 alarm 里的说明）。
const LEASE_TOKEN_KEY = 'leaseToken';

// alarm 抛错后 Cloudflare 最多重试这么多次。
const MAX_ALARM_RETRIES = 6;

/**
 * 这个 env 值像不像一个 Durable Object namespace binding。
 *
 * @param {unknown} namespace
 * @returns {boolean}
 */
export function isInstantTickNamespace(namespace) {
  return !!namespace
    && typeof namespace.get === 'function'
    && typeof namespace.idFromName === 'function';
}

/**
 * 叫醒这条任务的起跳器实例。实例回非 2xx 时抛错（调用方据此报 kick_failed）。
 *
 * @param {{ get: function, idFromName: function }} namespace - Durable Object namespace binding
 * @param {string} uuid - 任务 uuid
 */
export async function kickInstantTick(namespace, uuid) {
  const stub = namespace.get(namespace.idFromName(uuid));
  // 地址只是占位，DO 的 fetch 不看它。
  const res = await stub.fetch('https://amsg-instant-tick/kick', { method: 'POST', body: uuid });
  if (!res.ok) throw new Error(`instant 起跳器回了 HTTP ${res.status}`);
}

/**
 * 造出 Durable Object 类。宿主在 Worker 入口里把它按 wrangler 配的 class_name 导出。
 *
 * @param {(uuid: string, env: Object, options?: { leaseToken?: string }) => Promise<{ ran: boolean, reason?: string, summary?: Object }>} runTask -
 *   Worker 工厂返回的 runTask
 */
export function createInstantTickClass(runTask) {
  return class AmsgInstantTick {
    /**
     * @param {{ storage: { get: function, put: function, delete: function, getAlarm: function, setAlarm: function } }} state
     * @param {Object} env
     */
    constructor(state, env) {
      this.state = state;
      this.env = env;
    }

    /** 叫醒：记下要跑哪条，设一个立刻到期的 alarm，马上返回。 */
    async fetch(request) {
      const uuid = (await request.text()).trim();
      if (!uuid) return new Response('missing task uuid', { status: 400 });
      await this.state.storage.put(UUID_KEY, uuid);
      // 已经挂着 alarm（客户端重发、叫醒了两次）就不再设，合并成一次投递。
      if ((await this.state.storage.getAlarm()) === null) {
        await this.state.storage.setAlarm(Date.now());
      }
      return new Response(null, { status: 204 });
    }

    /** @param {{ retryCount?: number }} [alarmInfo] - Cloudflare 传进来的重试信息 */
    async alarm(alarmInfo) {
      const uuid = await this.state.storage.get(UUID_KEY);
      if (!uuid) return;
      // 占位用的租约 token 第一次跑之前生成、存进实例存储，alarm 重试时取出同一个
      // 传给 runTask。实例被重置（部署后的强制代码更新、Cloudflare 的运行时更新）
      // 会杀掉正在跑的 alarm，那一轮的租约还没过期；换个新 token 就领不回来，只
      // 能等租约过期交给 cron。拿同一个 token 领回是安全的：一个实例同时只会有一
      // 个 alarm 在跑（Cloudflare 的保证），所以重试时上一轮一定已经不在跑了；行
      // 上的租约还是这个 token，说明 cron 没接手过。
      // 这依赖「一条任务一个实例」。以后要是改成一个实例管多条任务，token 必须按
      // uuid 分开存，不能共用一个。
      let leaseToken = await this.state.storage.get(LEASE_TOKEN_KEY);
      if (!leaseToken) {
        leaseToken = globalThis.crypto.randomUUID();
        await this.state.storage.put(LEASE_TOKEN_KEY, leaseToken);
      }
      let result;
      try {
        result = await runTask(uuid, this.env, { leaseToken });
      } catch (error) {
        // 最后一次重试也挂了：Cloudflare 不会再叫醒这个实例，先把存储清掉，任务留给 cron。
        if (alarmInfo && alarmInfo.retryCount >= MAX_ALARM_RETRIES) {
          await this.state.storage.deleteAll();
        }
        throw error;
      }
      // 跑完才清：中途被回收的话，alarm 重试时还知道要跑哪条。用 deleteAll 是因为
      // Cloudflare 要整个实例存储清空才不再计费，只删这一个 key 不算。
      await this.state.storage.deleteAll();
      // not_found 多半是 cron 抢先发完了（一次性任务发完即删），属正常。其余几种
      // （配置不全、在退避窗口里……）留一行日志，排障时看得出是哪种。
      if (!result.ran && result.reason !== 'not_found') {
        console.warn(`[amsg single-user] instant 任务 ${uuid} 没有跑：${result.reason}`);
      }
      // 跑了但没领到租约：cron 或别的执行者正拿着它，或者同分组有任务在跑。任务
      // 留在库里等 cron，这里留一行日志，不然从外面看不出这条为什么晚了。
      if (result.ran && result.summary?.details?.claimSkippedTasks > 0) {
        console.warn(`[amsg single-user] instant 任务 ${uuid} 没领到租约，留给 cron`);
      }
    }
  };
}
