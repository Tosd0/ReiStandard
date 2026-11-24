/**
 * Single-user amsg-server on Cloudflare Workers.
 * Schedules live in D1; cron runs via CF Cron Trigger, and instant tasks are
 * kicked off by a Durable Object alarm (see wrangler.toml).
 */
import {
  createSingleUserCloudflareWorker,
  createWebCryptoWebPush
} from '@rei-standard/amsg-server/cloudflare';

const worker = createSingleUserCloudflareWorker((env) => ({
  // db defaults to createD1Adapter(env.DB)
  masterKey: env.AMSG_MASTER_KEY,
  serverToken: env.AMSG_SERVER_TOKEN, // optional shared secret; omit to leave endpoints open
  vapid: {
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  },
  webpush: createWebCryptoWebPush({
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  })
}));

export default worker;

// messageType: 'instant' 的起跳器（Durable Object），名字要与 wrangler.toml 的 class_name 一致。
export const AmsgInstantTick = worker.InstantTick;
