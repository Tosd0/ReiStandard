/**
 * 错误类型：宿主 hook 与库内部共用的失败语义标注。
 */

import { redactCredentials } from '@rei-standard/amsg-shared';

/**
 * 确定性失败——重试必然同败，别再排退避阶梯。
 *
 * 典型场景全在 fire-time hook 里：onBeforeFire 发现 fire_pack 缺失、解析失
 * 败、缺必要的段……这类错误不会因为过两分钟再跑一次就好，按普通投递失败重
 * 试三轮只是让用户多白等十几分钟，还把 hook 里的计费调用（情绪评估之类）
 * 重复烧三遍。hook 抛这个类（或任何带 `permanent: true` 的错误），run-tick
 * 收到后跳过退避：一次性任务直接标 failed（原因进 last_error / payload 的
 * lastError），循环任务直接作废本次 occurrence。
 *
 * `code`（可选）会透传到 processSingleMessage 的 errorCode，宿主想按错误类
 * 别分流时用它。
 *
 * 用 `permanent` 属性而不是 instanceof 做判定：宿主的 worker 里可能打包了另
 * 一份本库（版本错开、bundler 双实例），跨 realm 的 instanceof 靠不住。
 */
export class NonRetryableError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'NonRetryableError';
    this.permanent = true;
    if (options.code) this.code = options.code;
  }
}

/**
 * 这个错误是不是「重试也好不了」。认 NonRetryableError，也认任何自带
 * `permanent: true` 的错误对象（跨包/跨版本安全）。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNonRetryableError(error) {
  return !!error && typeof error === 'object' && /** @type {any} */ (error).permanent === true;
}

/**
 * 部署级的配置 / 适配器能力错误——坏的不是这条任务，是这个部署。
 *
 * 典型场景：`hooks.onBeforeFire` 配了但 `onLLMOutput` 忘了配、`executeToolCalls`
 * 没配、自定义适配器缺 `createTask` / `deleteTaskByUuid` / `upsertClientState`。
 * 这类错误重试确实好不了，但**不能**判终态：同一个坏部署下每条到点的任务都会
 * 撞同一个错，判终态就等于在那段时间里把每一条一次性任务都永久标 `failed`，
 * 运维改好配置重新部署也捞不回来了（行已不在 pending，`PUT /update-message`
 * 回 409）。所以留在退避阶梯上——配置一修好，还在阶梯上的任务下一跳就正常发
 * 出去。这跟 VAPID 配错回的 400/401/403 是同一个道理，见
 * {@link PUSH_PAYLOAD_TOO_LARGE_STATUS} 那段注释。
 *
 * 带 `code` 但不带 `permanent`：失败原因照旧进 last_error 的 `errorCode`，宿主
 * 想分流照样读得到，只是不再跳过重试。
 */
export class DeploymentConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DeploymentConfigError';
    if (options.code) this.code = options.code;
  }
}

/**
 * 把一个已经构造好的错误标成确定性失败（就地改，原样返回），顺带补一个稳定
 * 的 `code`（错误自己带了 code 就不覆盖）。
 *
 * 用在错误由别处构造、又想保住它原本类型的时候——比如契约校验抛的
 * `TypeError`：宿主按 `instanceof TypeError` 分流的代码不该因为库多标了一个
 * 字段就走岔。自己现造错误的地方直接用 {@link NonRetryableError} 更直白。
 *
 * @template T
 * @param {T} error
 * @param {string} [code]
 * @returns {T}
 */
export function markPermanent(error, code) {
  if (!error || typeof error !== 'object') return error;
  const target = /** @type {any} */ (error);
  try {
    target.permanent = true;
    if (code && typeof target.code !== 'string') target.code = code;
  } catch (_frozen) {
    // 冻结的错误对象标不上就算了：按可重试处理，方向是安全的那一边。
  }
  return error;
}

/**
 * 投递期间发现「这条任务已经不归本次投递管了」时，推送侧抛的错误码：行被
 * `DELETE /message` 取消、被 `supersedesUuid` 顶替，或被别的执行者收尾了。
 *
 * 发送方（message-processor 的正文投递、agentic-fire 的 hook 投递）靠它区分
 * 「取消」和「发失败」——两者的收尾完全不同：取消要把这一批还没发出去的
 * outbox 行撤掉，发失败则要把它们留着等补收。
 */
export const TASK_CANCELLED_CODE = 'TASK_CANCELLED';

/**
 * 这个错误是不是「投递期间任务被取消/顶替」。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTaskCancelledError(error) {
  return !!error
    && typeof error === 'object'
    && /** @type {any} */ (error).code === TASK_CANCELLED_CODE;
}

/**
 * 推送半途失败、而这一批**没有**落进 outbox 时，这次失败还能不能重试（就地标
 * 注，原样返回传入的错误）。
 *
 * 落进了 outbox 的批次重试时只补推送、不重新生成（见 lib/message-processor.js
 * 的 redeliverCommittedBatch）。没落进去的（适配器没有 outbox，或者这一批落行
 * 失败）没有这条退路：重试只能把整条内容重新生成一遍。那样做安不安全，看设备上
 * 已经有没有这次触发的东西：
 *
 *   - 一条都没推出去 → 客户端什么都没收到，重新生成的那一份就是它唯一见到的一
 *     份。照旧重试（会多花一次生成——没有收件箱兜着的时候，这是唯一能把消息送
 *     到的办法）；
 *   - 已经推出去了几条 → 重新生成的内容跟设备上那几条不是同一份，客户端会看到
 *     前半截来自第一次生成、后半截来自第二次。所以就地判终审（标 permanent）：
 *     一次性任务标 failed、循环任务作废本次 occurrence，没推出去的那几段就此
 *     放弃。
 *
 * 取消（TASK_CANCELLED）不归这里管，照旧按取消收尾。
 *
 * @template T
 * @param {T} error - 推送那一步抛的错误
 * @param {{ outboxed: boolean, pushedCount: number }} state - 这一批落没落进
 *   outbox、已经推出去了几条
 * @returns {T}
 */
export function markUnrecoverablePartialDelivery(error, { outboxed, pushedCount }) {
  if (outboxed || !(pushedCount > 0) || isTaskCancelledError(error)) return error;
  return markPermanent(error);
}

// ─── 「重试也好不了」的判定 ──────────────────────────────────────────────
//
// 定时任务（run-tick 的退避阶梯）和 instant 任务（processMessagesByUuid 的
// 三轮重试）用的是同一套口径：判成永久性失败就不再重试。投递是先跑 LLM 再
// 推送，每多试一轮都要把整轮生成重跑一次，真花钱。

/**
 * 推送服务判了这条订阅死刑的状态码。
 *
 * 判成终态不代表要去删 push_subscriptions 里那一行：删了之后「云端登记了收件
 * 设备吗」会变成 false，客户端多半会把用户引去重新登记，而重新登记只是把同一
 * 条死订阅再写一遍。这件事靠 last_error 里的 pushStatus 说给下游听。
 */
const TERMINAL_PUSH_STATUSES = new Set([404, 410]);

/**
 * 「这条内容装不下」：本地大小护栏在加密前就抛 PUSH_PAYLOAD_TOO_LARGE
 * （lib/webpush-webcrypto.js，超一个字节都不发），推送服务在密文超限时回 413。
 * 两处说的是同一件事，只是发现得早晚不同，而这件事跟本次生成出来的内容绑死：
 * 隔两分钟重来一遍，得先把 LLM 那一整轮重跑一次，再撞同一堵墙。所以不进退避
 * 阶梯，一次就作废本次 occurrence，让下游拿 errorCode / pushStatus 去决定怎么
 * 裁短内容。
 *
 * VAPID 配错回的 400 / 401 / 403 不在此列，虽然重试同样好不了：那是整个部署
 * 级别的故障（一把钥匙配错，所有任务一起发不出去），判终态会把这段时间内每一
 * 条一次性任务都永久标 failed，配置修好也回不来了。这类失败留在退避阶梯里，
 * 原因靠 last_error 里的 errorCode / pushStatus 说清楚。
 */
const PUSH_PAYLOAD_TOO_LARGE_STATUS = 413;

/** 重试也好不了的错误码：订阅压根没登记、适配器不支持订阅存储、payload 超限。 */
const PERMANENT_ERROR_CODES = new Set([
  'PUSH_SUBSCRIPTION_MISSING',
  'PUSH_SUBSCRIPTION_STORE_UNSUPPORTED',
  'PUSH_PAYLOAD_TOO_LARGE',
]);

/**
 * shared 的 callLlm 在「上游答复了、但没给出能用的结果」时挂在错误上的 code，
 * 同时挂 `llmStatus`（上游回的 HTTP 状态码）。网络直接炸、超时的错误没有这两个
 * 字段。
 */
const LLM_CALL_FAILED_CODE = 'LLM_CALL_FAILED';

/**
 * LLM 上游回的 HTTP 状态码里，「请求本身有问题、原样重试也不会好」的那些：
 *
 * | 状态码 | 常见原因 |
 * |---|---|
 * | 400 | 请求体不合法、上下文超长、参数不认 |
 * | 401 / 403 | Key 错了、过期了、没权限 |
 * | 402 | 余额不足 |
 * | 404 / 405 | 模型名写错、apiUrl 没指到 chat 端点 |
 * | 413 | 请求体过大 |
 * | 422 | 参数校验不过 |
 *
 * 重试一次要把整条生成（onBeforeFire 里宿主的计费调用、前几轮已经成功的 LLM
 * 轮次）从头再跑一遍，这些错误重试几次都是同一个结果，只是白花钱。所以一跳就
 * 终审：一次性任务标 failed，循环任务作废本次 occurrence。
 *
 * 不在这张表里的都照旧重试，包括：
 *   - 408 / 409 / 425 / 429：超时、冲突、太早、限流，过一会儿通常就好；
 *   - 所有 5xx：上游自己的故障；
 *   - 没有 llmStatus 的失败（网络炸了、超时）；
 *   - 2xx 却装着报错的响应体（中转站把上游报错塞进 200 回来，真实原因说不准）；
 *   - 其余没列出来的 4xx：认不准的一律按老行为重试，宁可多试几轮，也不把一条
 *     本来能送达的消息判死。
 */
const PERMANENT_LLM_STATUSES = new Set([400, 401, 402, 403, 404, 405, 413, 422]);

/**
 * 这个错误是不是「LLM 上游明确拒了这次请求、重试也不会好」。判据见
 * {@link PERMANENT_LLM_STATUSES}。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPermanentLlmFailure(error) {
  if (!error || typeof error !== 'object') return false;
  const { code, llmStatus } = /** @type {any} */ (error);
  return code === LLM_CALL_FAILED_CODE
    && Number.isInteger(llmStatus)
    && PERMANENT_LLM_STATUSES.has(llmStatus);
}

/**
 * 按 {@link isPermanentLlmFailure} 的口径就地给 LLM 错误标上 `permanent: true`
 * （原样返回传入的错误）。
 *
 * 标在错误对象上而不是只在投递侧判：fire-time hook（`onFireSettled` /
 * `onAfterSend`）拿到的就是这个对象，宿主用 `error.permanent === true` 判断
 * 「这是终态、该告诉用户了」。只在投递侧判的话，hook 看到的是一个没有
 * `permanent` 的错误，任务却已经被判死了。
 *
 * 唯一的调用点是 lib/llm.js 的 callLlm（server 侧所有 LLM 调用都走它），别在
 * 别处各自判。
 *
 * @template T
 * @param {T} error
 * @returns {T}
 */
export function markPermanentIfLlmRejected(error) {
  return isPermanentLlmFailure(error) ? markPermanent(error) : error;
}

/**
 * 这次投递失败要不要判成永久性的（不再重试）。五个来源：
 *   - 已知的永久性错误码（见 {@link PERMANENT_ERROR_CODES}）；
 *   - hook 侧抛出的 NonRetryableError（`permanent`，见 {@link NonRetryableError}）——
 *     fire_pack 缺失、解析失败这类重试必然同败的错，隔两分钟再试三次只是让用户
 *     多白等十二分钟，还把情绪评估之类的计费重跑三遍；
 *   - LLM 上游明确拒了这次请求（401 / 403 / 400 …，见
 *     {@link PERMANENT_LLM_STATUSES}）。这一条同样经由 `permanent` 传进来：错
 *     误在 lib/llm.js 抛出的那一刻就标好了（见 {@link markPermanentIfLlmRejected}），
 *     hook 看到的和这里判的是同一个结论；
 *   - 推送服务判了这条订阅的死刑（见 {@link TERMINAL_PUSH_STATUSES}）；
 *   - 推送服务说这条 payload 太大（见 {@link PUSH_PAYLOAD_TOO_LARGE_STATUS}）。
 *
 * @param {{ permanent?: unknown, errorCode?: unknown, pushStatus?: unknown }} failure
 * @returns {boolean}
 */
export function isPermanentDeliveryFailure(failure) {
  const { permanent, errorCode, pushStatus } = failure || {};
  return permanent === true
    || (typeof errorCode === 'string' && PERMANENT_ERROR_CODES.has(errorCode))
    || (Number.isInteger(pushStatus) && (
      TERMINAL_PUSH_STATUSES.has(/** @type {number} */ (pushStatus))
      || pushStatus === PUSH_PAYLOAD_TOO_LARGE_STATUS
    ));
}

// 推送服务回的 HTTP 状态码：只有真正发 push 的那一步（message-processor 的
// 正文投递、agentic-fire 的 hook 投递）会给自己抛出来的错误打这个标。
//
// 投递失败的 catch 罩着整条链路——LLM 调用、fire-time hook、解密都在里面。
// `statusCode` 这个字段谁都能往错误对象上挂（Node 生态的 HTTP 库尤其爱挂），
// 见字段就认的话，宿主 hook 里转手抛出的一个 404 会让任务被判成「推送订阅已
// 失效」永久 failed，失败记录里的 pushStatus 还会让客户端去引导用户重建订阅。
//
// 标在 WeakMap 上而不是写成错误对象的属性：冻结的错误对象也标得上，也不会
// 混进 hook 看到的错误里。
const pushStatusCodes = new WeakMap();

/**
 * 标记「这个错误是发 push 那一步抛出来的」，把它的 `statusCode` 记成推送服务
 * 回的状态码。原样返回传入的错误。
 *
 * 模块私有：外面一律走 {@link sendTaggedPush}，不要各自 try/catch 手动标。
 *
 * @template T
 * @param {T} error
 * @returns {T}
 */
function tagPushStatusCode(error) {
  if (error && typeof error === 'object' && Number.isInteger(/** @type {any} */ (error).statusCode)) {
    pushStatusCodes.set(/** @type {object} */ (error), /** @type {any} */ (error).statusCode);
  }
  return error;
}

/**
 * 发一条 push，失败时自动标上「这是发 push 那一步抛的」。
 *
 * 发 push 的地方一律走这里，别各自写 `try { send } catch { throw
 * tagPushStatusCode(e) }`：漏标一处，那条路上的 410 就读不出状态码，一条早就
 * 失效的订阅会被当成普通失败，在退避阶梯上把 LLM 重跑三轮。忘了标是没有任何
 * 提示的。
 *
 * @param {{ sendNotification: (subscription: any, payload: string) => Promise<any> }} webpush
 * @param {any} subscription
 * @param {string} payloadJson
 * @returns {Promise<any>}
 */
export async function sendTaggedPush(webpush, subscription, payloadJson) {
  try {
    return await webpush.sendNotification(subscription, payloadJson);
  } catch (error) {
    throw tagPushStatusCode(error);
  }
}

/**
 * 读推送服务回的状态码。没被 {@link tagPushStatusCode} 标过 → null。
 *
 * @param {unknown} error
 * @returns {number|null}
 */
export function readPushStatusCode(error) {
  if (!error || typeof error !== 'object') return null;
  const statusCode = pushStatusCodes.get(/** @type {object} */ (error));
  return Number.isInteger(statusCode) ? statusCode : null;
}

/**
 * lastError 里的机读标注：`errorCode` 是底层错误的稳定 code（如
 * `PUSH_PAYLOAD_TOO_LARGE`），`pushStatus` 是推送服务回的 HTTP 状态码。两个都
 * 没有 → undefined，不往记录里塞空字段。
 *
 * reason 那句是给用户看的人话、措辞随时会变，判断「该让用户重建订阅还是裁短
 * 内容」得读这两个字段。定时任务（run-tick）与 instant 任务
 * （processMessagesByUuid）共用这一份，两条路记下来的形状一致。
 *
 * code 是标识符不是人话，不用脱敏，但也别让一个来路不明的超长 code 撑大明文
 * 列——截到 64 字符，够放所有约定过的码。
 *
 * @param {string|null|undefined} errorCode
 * @param {number|null|undefined} pushStatus
 * @returns {{ errorCode?: string, pushStatus?: number }|undefined}
 */
export function buildErrorExtra(errorCode, pushStatus) {
  /** @type {{ errorCode?: string, pushStatus?: number }} */
  const extra = {};
  if (typeof errorCode === 'string' && errorCode) extra.errorCode = errorCode.slice(0, 64);
  if (Number.isInteger(pushStatus)) extra.pushStatus = /** @type {number} */ (pushStatus);
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** 落库的 last_error 摘要最长留这么多字符。 */
const ERROR_SUMMARY_MAX_CHARS = 500;

/**
 * 把错误原因脱敏成能明文落库（任务行 last_error 列）的摘要。
 *
 * 任务内容一律密文落库，last_error 是唯一一列明文的「为什么没发出去」——
 * 错误消息偶尔会回显请求细节（上游 API 的报错带 URL、header 片段），所以
 * 长得像凭据的 token 一律遮掉，再截断。
 *
 * 遮什么、怎么遮由 @rei-standard/amsg-shared 的 `redactCredentials` 说了算，
 * 这里只负责压平空白和截断。
 *
 * @param {unknown} reason
 * @returns {string}
 */
export function sanitizeErrorSummary(reason) {
  const flattened = String(reason ?? '').replace(/\s+/g, ' ').trim();
  const safe = redactCredentials(flattened);
  return safe.length > ERROR_SUMMARY_MAX_CHARS
    ? `${safe.slice(0, ERROR_SUMMARY_MAX_CHARS - 3)}…`
    : safe;
}

/**
 * @typedef {Object} ErrorCause
 * @property {'config'|'request'|'tick'} stage - 在哪一段炸的
 * @property {string} name - 错误类型（`error.name`，认不出来时是 'Error'）
 * @property {string} [message] - 脱敏后的错误消息。降级 500（配置都没建起来那条
 *   路）回给跨域调用方时不带这个字段——那条路的 CORS 头是回显来访 Origin 的，任
 *   意第三方页面都能读，而构建期异常原文里常有 binding 名、内网域名、环境变量
 *   名。同源 / 无 Origin 的请求照旧带全文，`wrangler tail` 里也一直有。
 * @property {string} [code] - 错误自带的 `code` 字符串（有才带）
 */

/**
 * 把一个异常整理成能随响应体一起回给调用方的机读原因。
 *
 * 500 只回一句「服务器内部错误」的话，真因（`D1_ERROR: no such table:
 * message_outbox`、存储层写超时……）就只剩 console.error 里那一行，调用方拿不
 * 到，用户看到的也只是「服务器内部错误」——不知道哪儿坏了，也不知道该点哪里。
 * 这个函数把异常压成几个固定字段，让调用方能机读、能展示。
 *
 * 只带错误类型和消息文本。消息先过 `sanitizeErrorSummary`（遮掉长得像凭据的
 * 串、截断到 500 字符）；密钥、用户数据、任务正文都不在 `error.message` 上，
 * 也不往这里放。
 *
 * @param {unknown} error - 捕获到的异常，也收 `{ name, message }` 这样的普通对象
 * @param {'config'|'request'|'tick'} stage - 'config' = 构建配置时抛的（少了
 *   binding / 环境变量）；'request' = 路由或处理器抛的；'tick' = cron 那一跳抛的
 * @returns {ErrorCause}
 */
export function summarizeErrorCause(error, stage) {
  const raw = (error && typeof error === 'object') ? /** @type {any} */ (error) : {};
  const name = typeof raw.name === 'string' && raw.name ? raw.name : 'Error';
  const rawMessage = typeof raw.message === 'string' && raw.message
    ? raw.message
    : String(error ?? '');
  /** @type {ErrorCause} */
  const cause = {
    stage,
    name: sanitizeErrorSummary(name).slice(0, 100),
    message: sanitizeErrorSummary(rawMessage)
  };
  if (typeof raw.code === 'string' && raw.code) {
    cause.code = sanitizeErrorSummary(raw.code).slice(0, 100);
  }
  return cause;
}
