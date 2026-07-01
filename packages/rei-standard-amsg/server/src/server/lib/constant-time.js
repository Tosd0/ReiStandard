/**
 * Portable constant-time string comparison.
 *
 * Runs identically on Node (tests) and Cloudflare Workers (prod). We avoid
 * both node:crypto's timingSafeEqual (undefined on Workers historically) and
 * crypto.subtle.timingSafeEqual (absent on Node). Instead we HMAC-SHA256 both
 * inputs under one fresh random key, then compare the two digests. Because the
 * key is random per call, an attacker can't precompute or replay a stable
 * timing oracle; digests are a fixed 32 bytes, so the XOR-accumulate compare
 * runs the same number of steps regardless of input length, with no early-out.
 *
 * globalThis.crypto (Web Crypto) is available on Node >= 20 and on Workers.
 */
export async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const da = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(String(a))));
  const db = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(String(b))));

  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i] ^ db[i];
  }
  return diff === 0;
}
