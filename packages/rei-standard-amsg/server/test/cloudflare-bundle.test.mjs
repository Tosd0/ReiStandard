import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Use the bundler from the existing build tool's dependency graph.
const requireFromTsup = createRequire(import.meta.resolve('tsup'));
const { build } = requireFromTsup('esbuild');

test('Cloudflare crypto helpers bundle and round-trip without Node runtime globals', async () => {
  const entry = fileURLToPath(new URL('../src/server/cloudflare.js', import.meta.url));
  const bundled = await build({
    stdin: {
      contents: `
        import { deriveUserEncryptionKey, decryptPayload, encryptPayload } from ${JSON.stringify(entry)};
        export async function roundTrip(payload) {
          const key = await deriveUserEncryptionKey('550e8400-e29b-41d4-a716-446655440000', 'a'.repeat(64));
          return decryptPayload(await encryptPayload(payload, key), key);
        }
      `,
      sourcefile: 'cloudflare-crypto-smoke.js',
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'CloudflareCryptoSmoke',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  assert.ok(Object.values(bundled.metafile.outputs).every(output => output.imports.length === 0));
  const runtime = { crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa };
  runInNewContext(bundled.outputFiles[0].text, runtime);
  const input = { taskInput: { request: 'immutable input' } };
  const output = await runtime.CloudflareCryptoSmoke.roundTrip(input);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), input);
});
