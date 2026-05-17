/**
 * Node / Express / Fastify adapter for @rei-standard/amsg-instant.
 *
 * Converts a Fetch-API-style handler (`(req: Request) => Response`)
 * into a Node-style handler (`(req, res) => void`).
 *
 * Usage (Express):
 *   import express from 'express';
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *   import { toNodeHandler } from '@rei-standard/amsg-instant/adapters/node';
 *
 *   const app = express();
 *   const fetchHandler = createInstantHandler({ ... });
 *   app.post('/instant', toNodeHandler(fetchHandler));
 *
 * Notes:
 *   - The Node handler reads the raw body itself; do NOT install
 *     `express.json()` on this route. Conversely, ensure no body parser
 *     has already consumed the stream before this middleware runs.
 *   - Headers are forwarded case-insensitively via the Fetch API.
 */

/**
 * Lazy Web Crypto polyfill for Node 18.
 *
 * Node 19+ exposes `globalThis.crypto` natively, but Node 18 (the current
 * LTS at time of writing, and the default Netlify Functions runtime) does
 * not. The dynamic import path keeps Node out of the bundle on every other
 * platform — Workers / Edge / Deno never executes this branch, and tsup
 * leaves the specifier untouched because `node:crypto` is externalized.
 */
let _polyfillApplied = false;
async function ensureWebCryptoPolyfill() {
  if (_polyfillApplied || globalThis.crypto) return;
  const { webcrypto } = await import('node:crypto');
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  }
  _polyfillApplied = true;
}

/**
 * @param {(request: Request) => Promise<Response>} fetchHandler
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function toNodeHandler(fetchHandler) {
  return async function nodeHandler(req, res) {
    try {
      await ensureWebCryptoPolyfill();
      const fetchRequest = await nodeRequestToFetchRequest(req);
      const fetchResponse = await fetchHandler(fetchRequest);
      await writeFetchResponseToNode(fetchResponse, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.end(
        JSON.stringify({
          success: false,
          error: { code: 'ADAPTER_ERROR', message: err?.message || 'Node adapter error' }
        })
      );
    }
  };
}

async function nodeRequestToFetchRequest(req) {
  const host = req.headers.host || 'localhost';
  const protocol = req.socket && req.socket.encrypted ? 'https' : 'http';
  // req.url is usually a path (origin-form), but some proxy / sub-router setups
  // can hand back an absolute URL. Detect that case and use it verbatim
  // instead of double-prefixing the scheme+host.
  const rawUrl = req.url || '/';
  const url = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : `${protocol}://${host}${rawUrl}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }

  const method = (req.method || 'GET').toUpperCase();
  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await readBody(req);
    init.duplex = 'half';
  }

  return new Request(url, init);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function writeFetchResponseToNode(response, res) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  const body = await response.arrayBuffer();
  res.end(Buffer.from(body));
}

export default { toNodeHandler };
