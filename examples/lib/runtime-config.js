/**
 * 运行时配置读取工具（v2.0.1）
 * 优先级：
 * 1) globalThis.__REI_CONFIG__（可选运行时注入）
 * 2) process.env（环境变量兜底）
 */

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getInjectedConfig() {
  const runtime = globalThis.__REI_CONFIG__;
  if (!runtime || typeof runtime !== 'object') {
    return {};
  }
  return runtime;
}

function getRuntimeConfig() {
  const injected = getInjectedConfig();
  const vapid = injected.vapid && typeof injected.vapid === 'object' ? injected.vapid : {};

  return {
    vapid: {
      email: pickString(vapid.email, process.env.VAPID_EMAIL),
      publicKey: pickString(vapid.publicKey, process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
      privateKey: pickString(vapid.privateKey, process.env.VAPID_PRIVATE_KEY)
    }
  };
}

function normalizeVapidSubject(email) {
  const value = pickString(email);
  if (!value) return '';
  return /^mailto:/i.test(value) ? value : `mailto:${value}`;
}

function getVapidConfig() {
  return getRuntimeConfig().vapid;
}

function getMissingVapidKeys(vapidConfig) {
  const vapid = vapidConfig || getVapidConfig();
  return [
    !vapid.email && 'VAPID_EMAIL',
    !vapid.publicKey && 'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
    !vapid.privateKey && 'VAPID_PRIVATE_KEY'
  ].filter(Boolean);
}

module.exports = {
  getRuntimeConfig,
  getVapidConfig,
  getMissingVapidKeys,
  normalizeVapidSubject
};
