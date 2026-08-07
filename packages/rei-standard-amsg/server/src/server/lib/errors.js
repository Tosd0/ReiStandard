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
