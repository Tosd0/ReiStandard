/**
 * 错误类型：宿主 hook 与库内部共用的失败语义标注。
 */

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
 * 把错误原因脱敏成能明文落库（任务行 last_error 列）的摘要。
 *
 * 任务内容一律密文落库，last_error 是唯一一列明文的「为什么没发出去」——
 * 错误消息偶尔会回显请求细节（上游 API 的报错带 URL、header 片段），所以
 * 长得像凭据的 token 一律遮掉，再截断到 500 字符。
 *
 * @param {unknown} reason
 * @returns {string}
 */
export function sanitizeErrorSummary(reason) {
  let s = String(reason ?? '').replace(/\s+/g, ' ').trim();
  // Bearer 头与常见「前缀-长随机串」形态的 key。
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
  s = s.replace(/\b[A-Za-z]{2,6}-[A-Za-z0-9_-]{16,}/g, '[redacted]');
  // 光长随机串（base64 / JWT 片段）也不放行。
  s = s.replace(/[A-Za-z0-9+/_.-]{48,}/g, '[redacted]');
  if (s.length > 500) s = `${s.slice(0, 497)}…`;
  return s;
}

/**
 * @typedef {Object} ErrorCause
 * @property {'config'|'request'|'tick'} stage - 在哪一段炸的
 * @property {string} name - 错误类型（`error.name`，认不出来时是 'Error'）
 * @property {string} message - 脱敏后的错误消息
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
