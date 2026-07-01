/**
 * Single-user amsg-server on Cloudflare Workers.
 * Schedules live in D1; cron runs via CF Cron Trigger (see wrangler.toml).
 */
import {
  createSingleUserCloudflareWorker,
  createWebCryptoWebPush
} from '@rei-standard/amsg-server';

export default createSingleUserCloudflareWorker((env) => ({
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
