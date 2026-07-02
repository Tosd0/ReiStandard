/**
 * ReiStandard Client SDK
 *
 * Lightweight browser client that handles:
 *  - AES-256-GCM encryption using the Web Crypto API (for amsg-server's
 *    schedule path and amsg-instant 0.1.x)
 *  - Optional plaintext mode for amsg-instant 0.2.x (instantEncryption: false)
 *  - Push subscription management via the Push API
 *  - The platform-agnostic `deliver()` delivery primitive (2.5.0+) which
 *    coordinates the foreground transport (SSE / JSON) with an out-of-band
 *    observation channel (SW broadcast / IPC / native push / polling …)
 *    so callers get a single correct outcome instead of having to second-
 *    guess "did the message actually land?". See the README's `deliver()`
 *    section for usage and the five-outcome contract.
 *
 * Usage:
 *   import { ReiClient } from '@rei-standard/amsg-client';
 *
 *   const client = new ReiClient({
 *     baseUrl: 'https://example.com/api/v1',
 *     userId: '550e8400-e29b-41d4-a716-446655440000',
 *   });
 *
 *   // Fetch user key and initialise encryption
 *   await client.init();
 *
 *   // Schedule a message (payload is auto-encrypted)
 *   await client.scheduleMessage({ ... });
 */

import { base64UrlToBytes, validateAvatarUrl } from '@rei-standard/amsg-shared';

// `TextEncoder` is stateless — hoist once instead of allocating a fresh
// instance for every encrypt + payload-size check.
const TEXT_ENCODER = new TextEncoder();

/** @typedef {import('@rei-standard/amsg-shared').MessageKind} MessageKind */
/** @typedef {import('@rei-standard/amsg-shared').MessageType} MessageType */
/** @typedef {import('@rei-standard/amsg-shared').PushSource} PushSource */
/** @typedef {import('@rei-standard/amsg-shared').AmsgPush} AmsgPush */
/** @typedef {import('@rei-standard/amsg-shared').ContentPush} ContentPush */
/** @typedef {import('@rei-standard/amsg-shared').ReasoningPush} ReasoningPush */
/** @typedef {import('@rei-standard/amsg-shared').ToolRequestPush} ToolRequestPush */
/** @typedef {import('@rei-standard/amsg-shared').ErrorPush} ErrorPush */

/**
 * @typedef {Object} ReiClientConfig
 * @property {string} baseUrl                            - Default base URL of the API (e.g. https://host/api/v1).
 *                                                         In plaintext-instant mode (`instantEncryption: false`)
 *                                                         this can be the amsg-instant Worker URL directly.
 * @property {Record<string, string>} [customBaseUrls]   - Optional per-endpoint base URL overrides.
 *                                                         Key is the endpoint name (e.g. `instant`); value is
 *                                                         the base URL to use for that endpoint instead of
 *                                                         `baseUrl`. Useful when different endpoints live on
 *                                                         different deployments (e.g. `instant` on Cloudflare
 *                                                         Workers while the rest run on Netlify). Future
 *                                                         endpoints (e.g. `schedule`, `messages`) can be
 *                                                         overridden the same way without an API change.
 * @property {string} [userId]                           - Current user identifier (UUID v4). Required for the
 *                                                         encrypted path (default `instantEncryption: true`,
 *                                                         and for `scheduleMessage` / `listMessages` /
 *                                                         `updateMessage` always). Can be omitted only when
 *                                                         `instantEncryption: false` AND you do not call any
 *                                                         encrypted method.
 * @property {boolean} [instantEncryption=true]          - When `false`, `sendInstant()` / `deliver()` post
 *                                                         plaintext JSON to amsg-instant 0.2.x+. `init()`
 *                                                         becomes a no-op. All other methods
 *                                                         (`scheduleMessage` etc.) keep using AES-256-GCM
 *                                                         regardless of this flag.
 * @property {string} [instantClientToken]               - When set, sent as the `X-Client-Token` header by
 *                                                         `sendInstant()` / `deliver()` in plaintext mode.
 *                                                         Note: this is a *weak* shared secret — it ships
 *                                                         inside any frontend bundle that uses it, so
 *                                                         devtools can read it. Use for casual URL-direct
 *                                                         abuse only.
 * @property {string} [serverToken]                       - Optional shared secret for a single-user amsg-server.
 *                                                         When set, sent as the `X-Client-Token` header on
 *                                                         amsg-server endpoints (schedule / messages / update /
 *                                                         cancel / user-key / init). Not applied to the instant
 *                                                         path (that uses `instantClientToken`).
 * @property {number|null} [maxPayloadBytes=null]        - Optional local UTF-8 byte cap for outgoing request
 *                                                         payloads before encryption. `null` / omitted means
 *                                                         no SDK-level request-size limit.
 */

/**
 * @typedef {Object} ObservedDeliveryReceipt
 * Receipt produced by the caller's out-of-band observation channel and
 * fed back to `deliver()` via `opts.delivery.observed`. Identifies the
 * delivered message so a concurrent send's signal cannot accidentally
 * satisfy this call's await.
 *
 * Identity requirement: **at least one** of `messageId` or `sessionId`
 * MUST be a non-empty string. A receipt with neither is invalid — the
 * library treats it as if the observed Promise never resolved (the race
 * keeps waiting). This is enforced at runtime; an empty receipt is a
 * caller-side bug, not a successful delivery.
 *
 * @property {string} [messageId]   - Stable per-message identifier.
 * @property {string} [sessionId]   - Session-scoped delivery identifier.
 * @property {string} [channel]     - Free-form origin label for diagnostics
 *                                    (e.g. 'sw', 'ipc', 'native', 'poll').
 *                                    Not validated by the library.
 */

/**
 * @typedef {'delivered'
 *   | 'completed-unconfirmed'
 *   | 'timeout'
 *   | 'cancelled'
 *   | 'send-failed'} DeliveryOutcome
 *
 * Terminal outcome of a `deliver()` call.
 *
 * - **delivered** — observed-mode only: the caller's observation channel
 *   produced a valid receipt within budget. Truth-grade success.
 * - **completed-unconfirmed** — transport-only mode only: transport
 *   reached natural EOF cleanly but there is no truth signal to confirm
 *   downstream consumption. Best-effort optimistic; the caller decides
 *   how to interpret it.
 * - **timeout** — total budget exhausted with no terminal signal; or,
 *   in observed mode, transport ended cleanly but the observation
 *   channel failed to deliver within grace (the observation pipeline
 *   may itself be broken — this is NOT classified as send-failed).
 *   `detail.observationChannelStalled` is set in the latter case.
 * - **cancelled** — caller `signal.abort()` fired and no delivery was
 *   observed within the cancellation grace.
 * - **send-failed** — transport rejected (with a captured error) AND no
 *   observed delivery landed within grace. Only fires when transport
 *   has a real error — a clean transport is never `send-failed`.
 */

/**
 * @typedef {Object} DeliveryResultDetail
 * @property {number}  waitedMs                       - Wall-clock ms spent in `deliver()`.
 * @property {boolean} [transportEnded]               - True if transport reached natural EOF (vs aborted / errored).
 * @property {unknown} [transportError]               - Non-null if transport rejected.
 * @property {unknown} [transportResponse]            - For JSON transport, the parsed response body.
 * @property {unknown} [chunkHandlerError]            - Non-null if `onChunk` threw at any point. Never promotes the outcome.
 * @property {boolean} [cancelledByCaller]            - True if caller's signal aborted before terminal outcome.
 * @property {boolean} [observationChannelStalled]    - True when observed-mode transport ended clean but observation never produced a valid receipt within grace.
 * @property {ObservedDeliveryReceipt} [receipt]      - Receipt as observed (for the `delivered` case).
 */

/**
 * @typedef {Object} DeliveryResult
 * @property {boolean}              ok        - True iff outcome === 'delivered'.
 * @property {DeliveryOutcome}      outcome
 * @property {DeliveryResultDetail} detail    - Always populated; gives diagnostic context regardless of outcome.
 */

/**
 * @typedef {Object} ObservedDeliverySpec
 * @property {'observed'}                           mode      - Standard path with truth signal.
 * @property {Promise<ObservedDeliveryReceipt>}     observed  - Resolves with a receipt when the message is
 *                                                              observed landed via the canonical out-of-band
 *                                                              channel for this platform (SW broadcast / IPC /
 *                                                              native push / polling …). The library does not
 *                                                              care what produces this promise — it just races
 *                                                              its settlement against transport / timeout /
 *                                                              abort.
 */

/**
 * @typedef {Object} TransportOnlyDeliverySpec
 * @property {'transport-only'} mode - Non-standard / advanced. No out-of-band signal is supplied.
 *                                     In this mode `outcome:'delivered'` will NEVER be returned (no truth
 *                                     signal); a clean transport yields `completed-unconfirmed`.
 */

/**
 * @typedef {Object} DeliverOptions
 * @property {ObservedDeliverySpec | TransportOnlyDeliverySpec} delivery - Discriminated union — caller must
 *   explicitly pick a mode. There is no implicit default to discourage "I forgot to wire up observation".
 * @property {number}   timeoutMs                  - Total budget in ms (transport + post-transport grace).
 * @property {(payload: unknown) => Promise<void> | void} [onChunk] - Optional inline chunk handler for the
 *   foreground SSE transport. If omitted, transport still runs (for delivery effects) but no per-chunk UI
 *   hook fires. Throws are captured into `detail.chunkHandlerError` and do NOT promote the outcome to
 *   `'send-failed'` — UI hook failures are caller-bug-shaped, not transport failures. Not invoked for the
 *   JSON transport.
 * @property {number}   [postTransportGraceMs]     - After transport settles (clean OR error), max wait for
 *   the observation channel before declaring failure. Default = `min(remainingBudget, max(5000, timeoutMs * 0.1))`.
 *   The 5s floor protects the grace from being slashed to ~0 by very short timeouts; the 10% scale gives
 *   sensible grace across 30s / 300s / multi-minute budgets. **Cancel-path note**: when the caller's
 *   `signal` fires before any other terminal event, the late-receipt window after the abort is
 *   `grace / 2` (the other half is reserved for cleanup). Tune this knob with that halving in mind if
 *   you care about late-arriving receipts after user cancellation.
 * @property {AbortSignal} [signal]                - Cooperative cancellation. Pre-flight: if already aborted
 *   at entry, returns `cancelled` synchronously without dispatching transport. Listeners added to this
 *   signal are removed on every terminal outcome, so a long-lived signal reused across many calls does
 *   not accumulate stale handlers.
 * @property {Record<string, string>} [headers]    - Extra request headers forwarded into the underlying fetch.
 *   Caller-supplied keys are merged AFTER `Content-Type`/encryption headers, so they can override
 *   `Content-Type` but NOT `X-User-Id` / `X-Payload-Encrypted` / `X-Encryption-Version` / `X-Client-Token`
 *   / `Authorization` (use the `authorization` option for the last one).
 * @property {string}   [authorization]            - Optional `Authorization` header forwarded as-is. Mirrors
 *   `sendInstant`'s `opts.authorization` so migrations from `sendInstant({authorization: ...})` to
 *   `deliver()` don't silently drop the header.
 * @property {string}   [endpointPath='/instant']  - Path under the resolved instant base URL. Pass
 *   `'/continue'` for tool-result resume on amsg-instant 0.9.0+.
 * @property {(meta: RawReadMeta) => void} [onRawRead] - Optional raw-read telemetry hook for the
 *   foreground SSE transport. Fires once per `reader.read()` BEFORE any SSE parsing/filtering, so it
 *   sees every byte that reached the client — including `: keepalive` comment frames that the parser
 *   silently drops. Use it to tell "connection alive but no business data" apart from "no bytes flowing
 *   at all" when diagnosing stalled streams. Purely observational: throws are swallowed and never affect
 *   transport. Not invoked for the JSON transport.
 * @property {boolean | { thresholdBytes?: number }} [compressRequest] - Opt-in gzip of the request
 *   BODY before it is sent (applies to both the SSE and JSON transports — it compresses the request,
 *   not the response). Omit / falsy = OFF and behavior is fully unchanged (backward compatible).
 *   `true` or `{}` enables it at the default 16384-byte (16 KB) threshold; `{ thresholdBytes: N }`
 *   sets a custom threshold. When enabled, the body is gzip-compressed only if its UTF-8 byte length
 *   exceeds the threshold AND the runtime provides `CompressionStream`; otherwise it is sent as
 *   plaintext (graceful degradation, never throws). On compression the request gains the custom
 *   header `X-Amsg-Request-Encoding: gzip` (NOT standard `Content-Encoding`, which CDNs / proxies
 *   would auto-decompress and double-decode) and the body is the raw gzip bytes — the receiving
 *   worker is responsible for gunzipping. Use it when delivering large bodies over slow / flaky
 *   uplinks where a big upload can outrun the connection's send timeout.
 */

/**
 * Metadata for a single raw `reader.read()` on the SSE body, passed to
 * `DeliverOptions.onRawRead`. The response-meta fields
 * (`status` / `contentEncoding` / `contentType`) are only populated on the
 * first invocation; later calls omit them.
 *
 * @typedef {Object} RawReadMeta
 * @property {number}  ts                       - `Date.now()` at the moment the read resolved.
 * @property {number}  byteLength               - Bytes in this chunk (`value?.byteLength ?? 0`).
 * @property {boolean} done                     - The `done` flag from `reader.read()`.
 * @property {string}  textPreview              - First ~120 chars of this chunk decoded as UTF-8,
 *   WITHOUT any keepalive/comment filtering (so `:`-prefixed lines stay visible).
 * @property {string|null} [contentEncoding]    - `res.headers.get('content-encoding')`. First call only.
 * @property {string|null} [contentType]        - `res.headers.get('content-type')`. First call only.
 * @property {number}  [status]                 - `res.status`. First call only.
 */

function makeLocalError(code, message, details) {
  const err = new Error(`[rei-standard-amsg-client] ${message}`);
  err.code = code;
  if (details) err.details = details;
  return err;
}

function isThenable(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

/**
 * Per SSE spec, a single line terminator is `\r\n`, `\n`, or `\r`;
 * an event ends with TWO consecutive terminators. We normalize the
 * buffer to LF-only before framing so the split logic stays a simple
 * `'\n\n'` (a `{2}` quantifier on alternations backtracks and would
 * mis-treat a lone `\r\n` as two terminators).
 */
const SSE_LINE_NORMALIZE = /\r\n?/g;

/**
 * Classify a Content-Type value as 'sse' (text/event-stream), 'json'
 * (application/json + structured-suffix variants like application/problem+json,
 * application/vnd.api+json), or 'unknown'.
 *
 * Properly parses the media-type: splits on `;` to drop parameters, trims,
 * lowercases, then exact-matches. A naïve substring search over the whole
 * header would mis-classify e.g. `application/json; note=text/event-stream`
 * as SSE, or `text/plain; x=application/json` as JSON.
 */
function classifyContentType(contentType) {
  const main = (contentType || '').split(';')[0].trim().toLowerCase();
  if (main === 'text/event-stream') return 'sse';
  if (main === 'application/json') return 'json';
  if (/^application\/[\w.+-]+\+json$/.test(main)) return 'json';
  return 'unknown';
}

/**
 * Default size floor for request-body gzip: bodies at or below this are not
 * worth compressing (the gzip header/overhead can outweigh the gain on tiny
 * payloads). 16 KB matches the contract documented on `DeliverOptions.compressRequest`.
 */
const COMPRESS_REQUEST_DEFAULT_THRESHOLD = 16384;

/**
 * Custom request header used to mark a gzip-compressed body. Deliberately NOT
 * the standard `Content-Encoding` — CDNs / reverse proxies (Cloudflare, etc.)
 * auto-decompress `Content-Encoding: gzip` on the way in, which would double-
 * decompress and corrupt the body. The receiving worker keys off this custom
 * header to know it must gunzip the body itself.
 */
const COMPRESS_REQUEST_HEADER = 'X-Amsg-Request-Encoding';

/**
 * Optionally gzip a request body string before it hits `fetch`.
 *
 * Pure optimization with graceful degradation: returns the original plaintext
 * body (and no extra header) whenever compression is disabled, the body is at
 * or below the threshold, the runtime lacks `CompressionStream`, or anything
 * throws. The wire bytes shrink (Chinese / repetitive JSON compresses ~5-8x)
 * so large uploads finish before flaky links time out — without dropping any
 * context. Decompression is the receiving worker's job (keyed off
 * `X-Amsg-Request-Encoding: gzip`).
 *
 * @param {string} body - The already-serialized request body (plaintext JSON).
 * @param {boolean | { thresholdBytes?: number } | undefined} compressRequest
 *   `undefined`/falsy ⇒ disabled (no-op, backward compatible). `true` / `{}` ⇒
 *   enabled at the 16 KB default. `{ thresholdBytes: N }` ⇒ enabled at N bytes.
 * @returns {Promise<{ body: string | Uint8Array, header: string | null }>}
 *   `header` is the gzip marker header name to set when compression happened,
 *   or `null` to send plaintext with no extra header.
 */
async function maybeCompressRequestBody(body, compressRequest) {
  // Disabled / no opt-in ⇒ behavior unchanged.
  if (!compressRequest) return { body, header: null };

  const threshold =
    typeof compressRequest === 'object' && typeof compressRequest.thresholdBytes === 'number'
      ? compressRequest.thresholdBytes
      : COMPRESS_REQUEST_DEFAULT_THRESHOLD;

  try {
    if (typeof CompressionStream === 'undefined') return { body, header: null };

    const bytes = new TextEncoder().encode(body);
    if (bytes.length <= threshold) return { body, header: null };

    const gz = new Uint8Array(
      await new Response(
        new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
      ).arrayBuffer()
    );
    return { body: gz, header: COMPRESS_REQUEST_HEADER };
  } catch {
    // Compression is an optimization, never a failure mode: fall back to plaintext.
    return { body, header: null };
  }
}

export class ReiClient {
  /**
   * @param {ReiClientConfig} config
   */
  constructor(config) {
    if (!config || !config.baseUrl) throw new Error('[rei-standard-amsg-client] baseUrl is required');

    const instantEncryption = config.instantEncryption !== false;
    if (!config.userId && instantEncryption) {
      throw new Error(
        '[rei-standard-amsg-client] userId is required (omit only when instantEncryption: false)'
      );
    }

    /** @private */
    this._baseUrl = config.baseUrl.replace(/\/+$/, '');
    /** @private */
    this._customBaseUrls = {};
    if (config.customBaseUrls && typeof config.customBaseUrls === 'object') {
      for (const [name, url] of Object.entries(config.customBaseUrls)) {
        if (typeof url === 'string' && url) {
          this._customBaseUrls[name] = url.replace(/\/+$/, '');
        }
      }
    }
    /** @private */
    this._userId = config.userId || '';
    /** @private */
    this._userKey = null;
    /** @private */
    this._instantEncryption = instantEncryption;
    /** @private */
    this._instantClientToken = typeof config.instantClientToken === 'string' && config.instantClientToken
      ? config.instantClientToken
      : '';
    /** @private */
    this._serverToken = typeof config.serverToken === 'string' && config.serverToken
      ? config.serverToken
      : '';
    /** @private */
    this._maxPayloadBytes = normalizeMaxPayloadBytes(config.maxPayloadBytes);
    /**
     * Per-instance latch (set of method names already warned). The
     * low-level dev warning fires at most once per ReiClient per method.
     * @private @type {Set<string>}
     */
    this._lowLevelWarned = new Set();
  }

  /**
   * Resolve the base URL for a given endpoint, falling back to `baseUrl`.
   *
   * @private
   * @param {string} endpointName
   * @returns {string}
   */
  _resolveBaseUrl(endpointName) {
    return this._customBaseUrls[endpointName] || this._baseUrl;
  }

  /**
   * Attach the single-user shared secret to amsg-server endpoint requests.
   * Never applied to the instant path (that uses instantClientToken).
   * @private
   * @param {Record<string, string>} headers
   * @returns {Record<string, string>}
   */
  _withServerToken(headers) {
    if (this._serverToken) headers['X-Client-Token'] = this._serverToken;
    return headers;
  }

  // ─── Initialisation ─────────────────────────────────────────────

  /**
   * Fetch the user-specific encryption key.
   * Must be called before any encrypted request.
   *
   * In plaintext-instant mode (`instantEncryption: false`) this is a no-op:
   * `sendInstant()` / `deliver()` do not need a userKey. Note that if you
   * also intend to call `scheduleMessage` / `listMessages` / `updateMessage`
   * (which always use AES-256-GCM), you must construct with
   * `instantEncryption: true` (the default) — those methods will throw
   * "Not initialised" otherwise.
   */
  async init() {
    if (this._instantEncryption === false) {
      return;
    }

    const res = await fetch(`${this._baseUrl}/get-user-key`, {
      method: 'GET',
      headers: this._withServerToken({ 'X-User-Id': this._userId })
    });

    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to fetch user key');

    const userKey = json?.data?.userKey;
    if (typeof userKey !== 'string' || !/^[0-9a-f]{64}$/i.test(userKey)) {
      throw new Error('[rei-standard-amsg-client] Invalid user key format');
    }

    this._userKey = this._hexToUint8Array(userKey);
  }

  /**
   * Fetch the amsg-server worker's own VAPID public key.
   *
   * A browser needs this as `applicationServerKey` when creating a Web Push
   * subscription. Each self-hosted worker owns its VAPID keypair, so pull the
   * key at runtime rather than baking it into the frontend. Sends
   * `X-Client-Token` when a `serverToken` is configured.
   *
   * @returns {Promise<string>} The base64url VAPID public key.
   * @throws {Error} When the worker has no VAPID public key configured (503).
   */
  async getVapidPublicKey() {
    const res = await fetch(`${this._baseUrl}/vapid-public-key`, {
      method: 'GET',
      headers: this._withServerToken({})
    });

    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to fetch VAPID public key');
    return json.publicKey;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Schedule a message.
   *
   * Note: For `messageType: 'instant'`, prefer `deliver()` (2.5.0+) or
   * `sendInstant()`. Both route through `@rei-standard/amsg-instant`
   * (stateless, no DB round-trip) rather than `amsg-server`'s schedule-
   * message endpoint. This method still works for instant via amsg-server
   * for backward compatibility — see CHANGELOG / README for details.
   *
   * The payload is automatically encrypted before transmission.
   *
   * If `avatarUrl` is unusable (`data:` URI, > 2 KB, or non-string), the
   * client soft-strips it on the payload and emits a `console.warn` — the
   * schedule still ships, just without an avatar. If `maxPayloadBytes` is
   * configured, oversized JSON payloads throw `PAYLOAD_TOO_LARGE_LOCAL`.
   *
   * @param {Object} payload - Schedule message payload.
   * @returns {Promise<Object>} API response body.
   */
  async scheduleMessage(payload) {
    this._sanitizeAvatarUrl(payload);
    const json = JSON.stringify(payload);
    this._assertPayloadSize(json, 'scheduleMessage');
    const encrypted = await this._encrypt(json);

    const res = await fetch(`${this._baseUrl}/schedule-message`, {
      method: 'POST',
      headers: this._withServerToken({
        'Content-Type': 'application/json',
        'X-User-Id': this._userId,
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1'
      }),
      body: JSON.stringify(encrypted)
    });

    return res.json();
  }

  /**
   * **Low-level JSON dispatcher.** Use `deliver()` for new code — it
   * gives you a correct `send-failed` vs `delivered` verdict by
   * coordinating transport with an out-of-band observation channel.
   *
   * Posts an instant message via `@rei-standard/amsg-instant` and
   * returns whatever the worker returns. **HTTP 200 ≠ delivery
   * confirmation** when amsg-instant is configured with backup Web
   * Push (default in 0.9.0+): the dispatch succeeded but the message
   * may still land via the backup channel even if this call rejected,
   * and a 200 here does not guarantee the consumer ever saw it. If
   * you only care about the transport response (no delivery
   * coordination needed), this stays useful — otherwise prefer
   * `deliver()`.
   *
   * Two transport modes (chosen by constructor `instantEncryption`):
   *
   * - **Encrypted (default)** — payload is AES-256-GCM encrypted with the
   *   `userKey` fetched by `init()`. Compatible with amsg-instant 0.1.x and
   *   with amsg-server's `schedule-message` instant path. Sends
   *   `X-User-Id` + `X-Payload-Encrypted: true` + `X-Encryption-Version: 1`.
   *
   * - **Plaintext** (`instantEncryption: false`) — payload is sent as raw
   *   JSON. Targets amsg-instant 0.2.x+. Sends `X-Client-Token` if
   *   `instantClientToken` was configured.
   *
   * Routes to `customBaseUrls.instant` if configured, otherwise `baseUrl`.
   *
   * @param {Object} payload - Instant message payload.
   * @param {string} [endpointPath] - Path under the resolved base URL. Default '/instant'.
   * @param {{ authorization?: string, expectsBackupPush?: boolean }} [opts]
   *   - `authorization`: optional auth header to forward.
   *   - `expectsBackupPush`: opt-in dev reminder. Set to `true` to log a
   *     one-shot console.warn that this is a low-level transport and
   *     "HTTP 200 ≠ delivery confirmation" once the worker has backup
   *     push enabled (amsg-instant 0.9.0+ default). Default (omitted) is
   *     silent.
   * @returns {Promise<Object>} `{ success, data?: { messagesSent, sentAt }, error? }`
   */
  async sendInstant(payload, endpointPath = '/instant', opts = {}) {
    this._maybeWarnLowLevel('sendInstant', opts);

    const { url, headers, body } = await this._buildInstantRequest(
      payload,
      endpointPath,
      { authorization: opts.authorization, methodName: 'sendInstant' }
    );
    // Pin the response shape: amsg-instant routes the JSON `{ success, data }`
    // envelope only when the caller asked exclusively for it. Omitting Accept
    // gets the SSE branch and `res.json()` then throws on the SSE bytes.
    headers['Accept'] = 'application/json';

    const res = await fetch(url, { method: 'POST', headers, body });
    return res.json();
  }

  /**
   * **Low-level SSE consumer.** Use `deliver()` for new code — it gives
   * you a correct `send-failed` vs `delivered` verdict by coordinating
   * transport with an out-of-band observation channel.
   *
   * **Rejection ≠ delivery failure** when amsg-instant is configured
   * with backup Web Push (default in 0.9.0+): SSE may reject for many
   * unrelated reasons (iOS background tab killed fetch, network blip,
   * worker 5xx) while the backup push still lands the message. Treating
   * the rejection as the canonical error path is wrong for that worker
   * configuration. If you need the foreground SSE chunk hook without
   * delivery coordination (you have your own observed channel), this
   * stays useful — otherwise prefer `deliver()`.
   *
   * Error semantics: any failure (network, protocol, abort, `onPayload`
   * callback throwing) rejects the returned Promise. `options.onError`
   * fires before the rejection as a side-channel notification — it does
   * NOT suppress the throw. Always wrap calls in `try / await`.
   *
   * @param {Object} payload - Instant message payload.
   * @param {string} [endpointPath] - Path under the resolved base URL. Default '/instant'.
   * @param {Object} options
   * @param {Record<string, string>} [options.headers]
   * @param {(payload: unknown) => Promise<void> | void} options.onPayload
   * @param {(error: unknown) => void} [options.onError]
   * @param {() => void} [options.onDone]
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.expectsBackupPush] - Opt-in dev reminder. Set
   *   to `true` to log a one-shot console.warn that "rejection ≠ delivery
   *   failure" once the worker has backup push enabled (amsg-instant 0.9.0+
   *   default). Default (omitted) is silent.
   * @returns {Promise<void>}
   */
  async consumeInstantStream(payload, endpointPath = '/instant', options = {}) {
    this._maybeWarnLowLevel('consumeInstantStream', options);

    const { url, headers, body } = await this._buildInstantRequest(
      payload,
      endpointPath,
      { headers: options.headers, methodName: 'consumeInstantStream' }
    );

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: options.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Instant request failed: ${res.status} ${text}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (classifyContentType(contentType) !== 'sse') {
      const text = await res.text().catch(() => '');
      throw new Error(`Expected text/event-stream, got ${contentType}: ${text}`);
    }

    if (!res.body) {
      throw new Error('Response body is null');
    }

    try {
      await this._consumeSseStream(res, { onPayload: options.onPayload });
      if (options.onDone) options.onDone();
    } catch (err) {
      if (options.onError) {
        try { options.onError(err); } catch { /* observer can't break the throw */ }
      }
      throw err;
    }
  }

  /**
   * Deliver a message with an explicit delivery contract.
   *
   * `deliver()` is the recommended primitive for new code. It coordinates
   * the foreground transport (SSE / JSON, picked automatically by
   * response Content-Type) with an optional out-of-band observation
   * channel that the caller supplies as a Promise — the library doesn't
   * care what produces that Promise (Service Worker broadcast, IPC,
   * native push handler, polling, anything). It returns a single
   * `DeliveryResult` with a five-value `outcome` so you can distinguish
   * `delivered` (truth-grade) from `cancelled` / `timeout` / `send-failed`
   * without inferring delivery from transport rejections.
   *
   * Why this exists: when the server uses always-on backup Web Push
   * (amsg-instant 0.9.0+ default), `sendInstant`'s HTTP 200 and
   * `consumeInstantStream`'s rejection are both ambiguous w.r.t. actual
   * delivery — the backup channel can still deliver after a transport
   * reject, and a clean transport doesn't prove the consumer ever
   * observed the message. `deliver()` resolves that ambiguity by
   * making the observation channel a first-class input.
   *
   * @param {Object}         payload  - Instant message payload (same shape as `sendInstant`).
   * @param {DeliverOptions} opts     - Delivery contract; see typedef.
   * @returns {Promise<DeliveryResult>}
   */
  async deliver(payload, opts) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('[rei-standard-amsg-client] deliver() requires an options object');
    }
    const {
      delivery, timeoutMs, onChunk, postTransportGraceMs,
      signal, headers, authorization, endpointPath, onRawRead,
      compressRequest,
    } = opts;

    if (!delivery || typeof delivery !== 'object') {
      throw new TypeError('[rei-standard-amsg-client] deliver() requires opts.delivery (discriminated union)');
    }
    if (delivery.mode !== 'observed' && delivery.mode !== 'transport-only') {
      throw new TypeError(
        '[rei-standard-amsg-client] opts.delivery.mode must be "observed" or "transport-only"'
      );
    }
    if (delivery.mode === 'observed' && !isThenable(delivery.observed)) {
      throw new TypeError(
        '[rei-standard-amsg-client] opts.delivery.observed must be a Promise<ObservedDeliveryReceipt>'
      );
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('[rei-standard-amsg-client] opts.timeoutMs must be a positive finite number');
    }
    if (
      postTransportGraceMs !== undefined &&
      (typeof postTransportGraceMs !== 'number' || !Number.isFinite(postTransportGraceMs) || postTransportGraceMs < 0)
    ) {
      throw new TypeError(
        '[rei-standard-amsg-client] opts.postTransportGraceMs, if set, must be a non-negative finite number'
      );
    }

    const start = Date.now();
    const detail = { waitedMs: 0 };

    // Pre-flight: don't dispatch transport if signal is already aborted.
    if (signal && signal.aborted) {
      detail.cancelledByCaller = true;
      return { ok: false, outcome: 'cancelled', detail };
    }

    // Build the request synchronously so local-validation errors
    // (PAYLOAD_TOO_LARGE_LOCAL, encryption "Not initialised") surface
    // as thrown Errors from deliver() itself — not buried inside a
    // post-grace `send-failed` detail.transportError.
    const built = await this._buildInstantRequest(
      payload,
      endpointPath || '/instant',
      { headers, authorization, methodName: 'deliver' }
    );

    // Second abort check: `_buildInstantRequest` is `await`ed
    // (encrypted path does Web Crypto), so the caller's signal may
    // have aborted while we were building. Catching it here keeps
    // the "aborted before dispatch ⇒ no fetch" contract honest.
    if (signal && signal.aborted) {
      detail.cancelledByCaller = true;
      detail.waitedMs = Date.now() - start;
      return { ok: false, outcome: 'cancelled', detail };
    }

    // ---- Once `finalized` flips, no late closure may mutate caller-visible
    // `detail` — caller holds it by reference and we don't want a post-return
    // write to flip transportResponse / chunkHandlerError underneath them.
    let finalized = false;

    // ---- Observation promise (observed mode only — no NEVER_SETTLES
    // retention in transport-only). ----
    let validatedObserved = null;
    let observedP = null;
    if (delivery.mode === 'observed') {
      validatedObserved = this._waitForValidReceipt(delivery.observed);
      observedP = validatedObserved.then((receipt) => ({ tag: 'delivered', receipt }));
    }

    // ---- onChunk wrapping (errors captured, never propagated; gated on
    // `finalized` so a late throw can't mutate caller-held detail). ----
    const wrappedOnChunk = onChunk
      ? async (chunk) => {
        try { await onChunk(chunk); }
        catch (err) {
          if (finalized) return;
          if (detail.chunkHandlerError === undefined) detail.chunkHandlerError = err;
        }
      }
      : undefined;

    // ---- Transport plumbing ----
    const internalAbort = new AbortController();
    let transportEnded = false;
    let transportError;

    const transportPromise = (async () => {
      try {
        const result = await this._runInstantTransport(built, {
          signal: internalAbort.signal,
          onChunk: wrappedOnChunk,
          onRawRead,
          compressRequest,
        });
        if (finalized) return;
        transportEnded = true;
        if (result && result.kind === 'json') detail.transportResponse = result.body;
      } catch (err) {
        if (finalized) return;
        transportError = err;
      }
    })();

    // ---- Race plumbing ----
    let timeoutId;
    const timeoutP = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ tag: 'timeout' }), timeoutMs);
    });

    // Track signal listeners so we can remove them on every terminal
    // outcome — otherwise a long-lived signal reused across many calls
    // accumulates {once:true} handlers that retain our closures.
    const signalListeners = [];
    let cancelledP = null;
    if (signal) {
      cancelledP = new Promise((resolve) => {
        const cancelListener = () => resolve({ tag: 'cancelled' });
        const abortForwarder = () => internalAbort.abort();
        signal.addEventListener('abort', cancelListener, { once: true });
        signal.addEventListener('abort', abortForwarder, { once: true });
        signalListeners.push(cancelListener, abortForwarder);
        // DOM spec: addEventListener('abort', ...) on an already-aborted
        // signal does NOT fire. Pre-flight covered "aborted before entry",
        // but the microtask window between that check and these adds is
        // observable — fire the listeners synchronously if we missed it.
        if (signal.aborted) {
          cancelListener();
          abortForwarder();
        }
      });
    }

    const transportP = transportPromise.then(() => ({ tag: 'transport-ended' }));

    // Build the race conditionally — only include racers that can actually
    // settle, so we don't attach handlers to a forever-pending Promise and
    // leak reactions across many calls.
    const racers = [transportP, timeoutP];
    if (observedP) racers.push(observedP);
    if (cancelledP) racers.push(cancelledP);

    const winner = await Promise.race(racers);

    // ---- Terminal-state finalization ----
    // `finalize` is the single exit gate. Sets `finalized=true` before
    // any return so the still-running transport IIFE / onChunk callback
    // can't mutate the caller-held detail; clears the main-timeout timer;
    // aborts the transport for cleanup; removes the caller-signal
    // listeners we attached; stamps waitedMs + transport status onto
    // detail; returns.
    const finalize = (outcome, ok, extras) => {
      finalized = true;
      clearTimeout(timeoutId);
      internalAbort.abort();
      if (signal) {
        for (const l of signalListeners) signal.removeEventListener('abort', l);
      }
      detail.waitedMs = Date.now() - start;
      if (transportEnded) detail.transportEnded = true;
      if (transportError !== undefined) detail.transportError = transportError;
      if (extras) Object.assign(detail, extras);
      return { ok, outcome, detail };
    };

    const remainingBudget = () => Math.max(0, timeoutMs - (Date.now() - start));

    // ── Winner: delivered ────────────────────────────────────────
    if (winner.tag === 'delivered') {
      return finalize('delivered', true, { receipt: winner.receipt });
    }

    // ── Winner: cancelled ────────────────────────────────────────
    if (winner.tag === 'cancelled') {
      // Cancel-grace window: late receipt may still arrive in the
      // microtask after abort. Only meaningful in observed mode — no
      // observation channel exists in transport-only, so the wait is
      // pure dead time and we short-circuit.
      detail.cancelledByCaller = true;
      if (validatedObserved) {
        internalAbort.abort();
        const cancelGrace = this._computeGrace(postTransportGraceMs, timeoutMs, remainingBudget()) / 2;
        const lateReceipt = await this._raceObservedWithTimeout(validatedObserved, cancelGrace);
        if (lateReceipt) {
          return finalize('delivered', true, { receipt: lateReceipt });
        }
      }
      return finalize('cancelled', false);
    }

    // ── Winner: timeout ──────────────────────────────────────────
    if (winner.tag === 'timeout') {
      return finalize('timeout', false);
    }

    // ── Winner: transport-ended ──────────────────────────────────
    clearTimeout(timeoutId);

    // Transport-only: no observation channel can ever settle, so the
    // grace wait is pure dead time. Decide the outcome from the
    // transport result immediately.
    if (!validatedObserved) {
      if (transportError !== undefined) return finalize('send-failed', false);
      return finalize('completed-unconfirmed', false, { transportEnded: true });
    }

    // Observed mode: wait up to `grace` for a late receipt, but keep the
    // caller's cancel signal in the race — otherwise an abort during
    // grace is silently downgraded to timeout / send-failed.
    const grace = this._computeGrace(postTransportGraceMs, timeoutMs, remainingBudget());
    const observedLateP = this._raceObservedWithTimeout(validatedObserved, grace)
      .then((receipt) => ({ tag: 'late', receipt }));
    const lateRacers = [observedLateP];
    if (cancelledP) lateRacers.push(cancelledP);
    const lateWinner = await Promise.race(lateRacers);

    if (lateWinner.tag === 'cancelled') {
      detail.cancelledByCaller = true;
      return finalize('cancelled', false);
    }
    if (lateWinner.receipt) {
      return finalize('delivered', true, { receipt: lateWinner.receipt });
    }
    if (transportError !== undefined) {
      // Case A: transport had captured error → real send failure
      return finalize('send-failed', false);
    }
    // Case C: observed mode + clean transport + missing observation = stalled
    return finalize('timeout', false, { transportEnded: true, observationChannelStalled: true });
  }

  /**
   * Update an existing scheduled message.
   *
   * If `updates.avatarUrl` is unusable (`data:` URI, > 2 KB, or non-string),
   * the client soft-strips it from the patch and emits a `console.warn` —
   * the rest of the update still applies, and the stored avatar is left
   * untouched. If `maxPayloadBytes` is configured, oversized JSON patches
   * throw `PAYLOAD_TOO_LARGE_LOCAL`.
   *
   * @param {string} uuid    - Task UUID.
   * @param {Object} updates - Fields to update.
   * @returns {Promise<Object>}
   */
  async updateMessage(uuid, updates) {
    // Match server-side semantics: a stripped patch shouldn't overwrite the
    // stored avatar with `null`. When sanitize fires, remove the field
    // entirely so the existing image is preserved.
    if (this._sanitizeAvatarUrl(updates)) {
      delete updates.avatarUrl;
    }
    const json = JSON.stringify(updates);
    this._assertPayloadSize(json, 'updateMessage');
    const encrypted = await this._encrypt(json);

    const res = await fetch(`${this._baseUrl}/update-message?id=${encodeURIComponent(uuid)}`, {
      method: 'PUT',
      headers: this._withServerToken({
        'Content-Type': 'application/json',
        'X-User-Id': this._userId,
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1'
      }),
      body: JSON.stringify(encrypted)
    });

    return res.json();
  }

  /**
   * Cancel / delete a scheduled message.
   *
   * @param {string} uuid - Task UUID.
   * @returns {Promise<Object>}
   */
  async cancelMessage(uuid) {
    const res = await fetch(`${this._baseUrl}/cancel-message?id=${encodeURIComponent(uuid)}`, {
      method: 'DELETE',
      headers: this._withServerToken({ 'X-User-Id': this._userId })
    });

    return res.json();
  }

  /**
   * List the current user's messages with optional filters.
   *
   * @param {Object} [opts]
   * @param {string} [opts.status]
   * @param {number} [opts.limit]
   * @param {number} [opts.offset]
   * @returns {Promise<Object>}
   */
  async listMessages(opts = {}) {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));

    const qs = params.toString();
    const url = `${this._baseUrl}/messages${qs ? '?' + qs : ''}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: this._withServerToken({
        'X-User-Id': this._userId,
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1'
      })
    });

    const json = await res.json();
    if (!json?.success || json?.encrypted !== true) return json;

    const decrypted = await this._decrypt(json.data);
    return {
      success: true,
      encrypted: true,
      version: json.version || 1,
      data: decrypted
    };
  }

  // ─── Push Subscription ──────────────────────────────────────────

  /**
   * Subscribe to Web Push notifications.
   *
   * @param {string} vapidPublicKey - The server's VAPID public key.
   * @param {ServiceWorkerRegistration} registration - An active SW registration.
   * @returns {Promise<PushSubscription>}
   */
  async subscribePush(vapidPublicKey, registration) {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(vapidPublicKey)
    });
    return subscription;
  }

  // ─── Local preflight (no network) ────────────────────────────────

  /**
   * Sanitize `avatarUrl` on an outgoing payload. If the value is unusable
   * (`data:` URI / oversized / non-string), set the field to `null` on the
   * payload, log a `console.warn`, and let the rest of the request go
   * through. Avatar is cosmetic — failing the entire schedule / instant
   * call over a bad image URL is too punishing. Mirrors the server-side
   * soft-strip in `@rei-standard/amsg-server` 2.3.3+ and `@rei-standard/amsg-instant`
   * 0.7.1+. See standards §6.2.
   *
   * @private
   * @param {object|null|undefined} target - Payload-like object holding `avatarUrl`.
   * @returns {boolean} `true` if the field was stripped, `false` otherwise.
   */
  _sanitizeAvatarUrl(target) {
    if (!target || typeof target !== 'object') return false;
    const reason = validateAvatarUrl(target.avatarUrl);
    if (reason) {
      console.warn('[rei-standard-amsg-client] avatarUrl 不合法，已置空：', reason);
      target.avatarUrl = null;
      return true;
    }
    return false;
  }

  /**
   * Enforce the optional local request payload cap before encryption.
   * By default there is no SDK-level request-size limit; runtime, proxy,
   * database, and LLM-provider limits remain the deployer's boundary.
   *
   * @private
   * @param {string} bodyJson  - `JSON.stringify(payload)`.
   * @param {string} methodName
   */
  _assertPayloadSize(bodyJson, methodName) {
    if (this._maxPayloadBytes == null) return;
    const bytes = TEXT_ENCODER.encode(bodyJson).length;
    if (bytes > this._maxPayloadBytes) {
      throw makeLocalError(
        'PAYLOAD_TOO_LARGE_LOCAL',
        `${methodName} payload 体积 ${bytes} 字节超过本地上限 ${this._maxPayloadBytes} 字节`,
        { method: methodName, actualBytes: bytes, limitBytes: this._maxPayloadBytes }
      );
    }
  }

  // ─── Transport helpers (shared by sendInstant / consumeInstantStream / deliver) ─

  /**
   * Build the URL, headers, and body for an instant-endpoint POST.
   * Used by `sendInstant`, `consumeInstantStream`, and `deliver`.
   *
   * @private
   * @param {Object} payload
   * @param {string} endpointPath
   * @param {{ headers?: Record<string, string>, authorization?: string, methodName: string }} opts
   * @returns {Promise<{ url: string, headers: Record<string, string>, body: string }>}
   */
  async _buildInstantRequest(payload, endpointPath, opts) {
    const { headers: extraHeaders, authorization, methodName } = opts;
    this._sanitizeAvatarUrl(payload);
    const json = JSON.stringify(payload);
    this._assertPayloadSize(json, methodName);

    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    let body;

    if (this._instantEncryption === false) {
      body = json;
      if (this._instantClientToken) headers['X-Client-Token'] = this._instantClientToken;
    } else {
      const encrypted = await this._encrypt(json);
      headers['X-User-Id'] = this._userId;
      headers['X-Payload-Encrypted'] = 'true';
      headers['X-Encryption-Version'] = '1';
      body = JSON.stringify(encrypted);
    }

    if (authorization) headers['Authorization'] = authorization;

    const path = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
    const url = `${this._resolveBaseUrl('instant')}${path}`;
    return { url, headers, body };
  }

  /**
   * Run the foreground transport for `deliver()`. Takes a request pre-built
   * by `_buildInstantRequest` so the caller can surface local-validation
   * errors (encryption, payload-size) synchronously, instead of having
   * them buried inside the post-transport grace race.
   * Picks SSE or JSON based on the response Content-Type. Resolves on
   * natural stream EOF / parsed JSON; throws on network / protocol / SSE
   * error frame / AbortError.
   *
   * @private
   * @param {{ url: string, headers: Record<string, string>, body: string }} built
   * @param {{ signal: AbortSignal, onChunk?: (p: unknown) => Promise<void> | void, onRawRead?: (meta: RawReadMeta) => void, compressRequest?: boolean | { thresholdBytes?: number } }} opts
   *   `onRawRead` is forwarded to the SSE consumer for raw read-loop telemetry (see `DeliverOptions.onRawRead`).
   *   `compressRequest` opts the request body into gzip before `fetch` (see `DeliverOptions.compressRequest`).
   * @returns {Promise<{ kind: 'sse' } | { kind: 'json', body: unknown }>}
   */
  async _runInstantTransport(built, opts) {
    const { signal, onChunk, onRawRead, compressRequest } = opts;
    const { url, headers, body } = built;

    // Optionally gzip the request body (opt-in, graceful fallback to plaintext).
    const { body: wireBody, header: compressionHeader } =
      await maybeCompressRequestBody(body, compressRequest);
    const wireHeaders = compressionHeader
      ? { ...headers, [compressionHeader]: 'gzip' }
      : headers;

    const res = await fetch(url, { method: 'POST', headers: wireHeaders, body: wireBody, signal });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Instant request failed: ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }

    const rawContentType = res.headers.get('content-type');
    const contentType = rawContentType || '';
    const kind = classifyContentType(contentType);
    if (kind === 'sse') {
      if (!res.body) throw new Error('Response body is null');
      await this._consumeSseStream(res, {
        onPayload: onChunk,
        onRawRead,
        responseMeta: {
          status: res.status,
          contentEncoding: res.headers.get('content-encoding'),
          contentType: rawContentType,
        },
      });
      return { kind: 'sse' };
    }
    if (kind === 'json') {
      const json = await res.json();
      return { kind: 'json', body: json };
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Expected text/event-stream or application/json, got ${contentType}: ${text}`);
  }

  /**
   * Consume an SSE response body, dispatching `event: payload` frames to
   * `onPayload`. Resolves on `event: done` or natural EOF. Throws on
   * `event: error` frames, `onPayload` throws, or stream read errors.
   *
   * @private
   * @param {Response} res
   * @param {{
   *   onPayload?: (p: unknown) => Promise<void> | void,
   *   onRawRead?: (meta: RawReadMeta) => void,
   *   responseMeta?: { status?: number, contentEncoding?: string | null, contentType?: string | null }
   * }} opts
   *   `onRawRead` (if supplied) fires once per `reader.read()` before any SSE parsing/filtering — it sees
   *   raw bytes including `: keepalive` comment frames. Throws from it are swallowed. `responseMeta` is
   *   attached to the FIRST `onRawRead` call only. See `DeliverOptions.onRawRead`.
   * @returns {Promise<void>}
   */
  async _consumeSseStream(res, opts) {
    const { onPayload, onRawRead, responseMeta } = opts;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let thrown;

    // Raw read-loop telemetry (opt-in via onRawRead). Kept completely
    // separate from the parsing path: a one-shot decoder for the preview so
    // it never perturbs the streaming `decoder` above, and the first call
    // carries response meta (status / encoding / content-type).
    const previewDecoder = onRawRead ? new TextDecoder() : null;
    let rawReadFired = false;
    const emitRawRead = (done, value) => {
      if (!onRawRead) return;
      try {
        let textPreview = '';
        if (value && value.byteLength) {
          // One-shot decode (no { stream: true }) so we don't carry state
          // between calls and disturb the main buffer's decoder.
          textPreview = previewDecoder.decode(value).slice(0, 120);
        }
        const meta = {
          ts: Date.now(),
          byteLength: value && value.byteLength ? value.byteLength : 0,
          done: !!done,
          textPreview,
        };
        if (!rawReadFired) {
          meta.status = responseMeta ? responseMeta.status : undefined;
          meta.contentEncoding = responseMeta ? responseMeta.contentEncoding : undefined;
          meta.contentType = responseMeta ? responseMeta.contentType : undefined;
        }
        rawReadFired = true;
        onRawRead(meta);
      } catch { /* telemetry must never break the transport */ }
    };

    // Parse one SSE frame body (lines between two terminators). Returns
    // `'done'` if the frame signals end-of-stream so the caller can
    // unwind without consuming further frames. Throws on `event: error`.
    // Assumes the input has already been line-normalized to LF.
    const processFrame = async (part) => {
      if (!part.trim()) return null;
      let eventName = 'message';
      // Per SSE spec multiple `data:` lines in one event concatenate
      // with `\n`. Our own server always emits a single data line,
      // but `_consumeSseStream` is a general-purpose consumer.
      let data = '';
      const lines = part.split('\n');
      for (const line of lines) {
        if (line.startsWith(':')) continue; // keepalive comment
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const piece = line.slice(5).trim();
          data = data ? `${data}\n${piece}` : piece;
        }
      }
      if (eventName === 'done') return 'done';
      if (eventName === 'error') {
        let parsedErr;
        try { parsedErr = JSON.parse(data); }
        catch { parsedErr = { code: 'PARSE_ERROR', message: data }; }
        const err = new Error(parsedErr.message || 'Stream error');
        err.code = parsedErr.code;
        throw err;
      }
      if (eventName === 'payload') {
        let parsedPayload;
        try { parsedPayload = JSON.parse(data); }
        catch { return null; }
        if (onPayload) await onPayload(parsedPayload);
      }
      return null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        emitRawRead(done, value);
        if (done) {
          // Flush any tail bytes the decoder held back (partial UTF-8
          // sequences split across the final chunk boundary).
          buffer += decoder.decode();
          // Some servers close without a final blank-line terminator;
          // the trailing buffer may still contain a complete frame body.
          const finalNormalized = buffer.replace(SSE_LINE_NORMALIZE, '\n');
          if (finalNormalized.trim()) {
            await processFrame(finalNormalized);
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        // A `\r` at the very end of the buffer is ambiguous — it might be
        // a standalone CR line terminator, OR the first byte of a CRLF
        // whose `\n` is in the next chunk. Defer normalization of that one
        // trailing byte until either more data arrives or the stream ends.
        const trailingCr = buffer.endsWith('\r');
        const head = trailingCr ? buffer.slice(0, -1) : buffer;
        const normalized = head.replace(SSE_LINE_NORMALIZE, '\n');
        const parts = normalized.split('\n\n');
        // Re-attach the deferred `\r` to whatever remains incomplete.
        buffer = (parts.pop() || '') + (trailingCr ? '\r' : '');
        for (const part of parts) {
          const result = await processFrame(part);
          if (result === 'done') return;
        }
      }
    } catch (err) {
      thrown = err;
    } finally {
      if (thrown) {
        try { await reader.cancel(thrown); } catch { /* already cancelled */ }
        try { reader.releaseLock(); } catch { /* already released */ }
        throw thrown;
      }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  // ─── deliver() helpers ──────────────────────────────────────────

  /**
   * Wraps the caller's observed Promise so it only settles on a valid
   * `ObservedDeliveryReceipt` (per RFC: at least one of messageId /
   * sessionId must be a non-empty string). Invalid receipts and
   * rejections leave the returned Promise pending — the race's timeout
   * or abort branches take over.
   *
   * @private
   * @param {Promise<ObservedDeliveryReceipt>} source
   * @returns {Promise<ObservedDeliveryReceipt>}
   */
  _waitForValidReceipt(source) {
    return new Promise((resolve) => {
      Promise.resolve(source).then(
        (receipt) => {
          if (this._validateReceipt(receipt)) {
            resolve(receipt);
          }
          // invalid receipt: never resolve — treat as if observed never fired
        },
        () => {
          // observed rejected: never resolve — race's timeout/abort take over
        }
      );
    });
  }

  /**
   * Identity check: a receipt must be an object with at least one of
   * `messageId` or `sessionId` as a non-empty string. Caller-supplied
   * observation channels can produce arbitrary shapes; this gate
   * prevents an empty-resolve from being interpreted as a successful
   * delivery (a common shape of caller bug).
   *
   * @private
   * @param {unknown} receipt
   * @returns {boolean}
   */
  _validateReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object') return false;
    const hasMsgId = typeof receipt.messageId === 'string' && receipt.messageId.length > 0;
    const hasSessionId = typeof receipt.sessionId === 'string' && receipt.sessionId.length > 0;
    return hasMsgId || hasSessionId;
  }

  /**
   * Race a Promise against a timeout. Returns the resolved value if the
   * Promise wins, or `null` if the timeout fires first. Promise rejection
   * is treated as "did not arrive" (same as timeout, returns `null`).
   *
   * @private
   * @template T
   * @param {Promise<T>} promise
   * @param {number} ms
   * @returns {Promise<T | null>}
   */
  _raceObservedWithTimeout(promise, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, Math.max(0, ms));
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      );
    });
  }

  /**
   * Post-transport grace formula. Defaults to
   * `min(remainingBudget, max(5000ms, timeoutMs * 0.1))`. Caller override
   * is capped by remaining budget so it can never exceed the total timeout.
   *
   * @private
   * @param {number | undefined} override
   * @param {number} totalTimeoutMs
   * @param {number} remainingMs
   * @returns {number}
   */
  _computeGrace(override, totalTimeoutMs, remainingMs) {
    if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
      return Math.min(override, remainingMs);
    }
    const defaultGrace = Math.max(5000, Math.floor(totalTimeoutMs * 0.1));
    return Math.min(defaultGrace, remainingMs);
  }

  /**
   * One-shot dev reminder for low-level instant APIs. The warning is opt-in
   * per call via `opts.expectsBackupPush === true` and fires at most once
   * per ReiClient instance per method name. Default (omitted or `false`)
   * is silent.
   *
   * @private
   * @param {string} methodName
   * @param {{ expectsBackupPush?: boolean }} opts
   */
  _maybeWarnLowLevel(methodName, opts) {
    if (!opts || opts.expectsBackupPush !== true) return;
    if (this._lowLevelWarned.has(methodName)) return;
    this._lowLevelWarned.add(methodName);
    const verdict = methodName === 'sendInstant'
      ? 'HTTP 200 ≠ delivery confirmation'
      : 'rejection ≠ delivery failure';
    console.warn(
      `[rei-standard-amsg-client] ${methodName} is a low-level transport — ${verdict} when the worker is configured with always-on backup Web Push (amsg-instant 0.9.0+ default). Prefer client.deliver() for a correct delivered / cancelled / timeout / send-failed verdict.`
    );
  }

  // ─── Crypto helpers (Web Crypto API) ────────────────────────────

  /**
   * Encrypt plaintext with AES-256-GCM.
   * @private
   * @param {string} plaintext
   * @returns {Promise<{ iv: string, authTag: string, encryptedData: string }>}
   */
  async _encrypt(plaintext) {
    if (!this._userKey) throw new Error('[rei-standard-amsg-client] Not initialised. Call init() first.');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', this._userKey, { name: 'AES-GCM' }, false, ['encrypt']);
    const encoded = TEXT_ENCODER.encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    // Web Crypto appends the 16-byte auth tag at the end of the ciphertext
    const cipherArr = new Uint8Array(cipherBuf);
    const encryptedData = cipherArr.slice(0, cipherArr.length - 16);
    const authTag = cipherArr.slice(cipherArr.length - 16);

    return {
      iv: this._toBase64(iv),
      authTag: this._toBase64(authTag),
      encryptedData: this._toBase64(encryptedData)
    };
  }

  /**
   * Decrypt an encrypted API payload.
   * @private
   * @param {{ iv: string, authTag: string, encryptedData: string }} encryptedPayload
   * @returns {Promise<Object>}
   */
  async _decrypt(encryptedPayload) {
    if (!this._userKey) throw new Error('[rei-standard-amsg-client] Not initialised. Call init() first.');

    const { iv, authTag, encryptedData } = encryptedPayload || {};
    if (typeof iv !== 'string' || typeof authTag !== 'string' || typeof encryptedData !== 'string') {
      throw new Error('[rei-standard-amsg-client] Invalid encrypted payload');
    }

    const ivBytes = this._fromBase64(iv);
    const authTagBytes = this._fromBase64(authTag);
    const encryptedBytes = this._fromBase64(encryptedData);
    const cipherBytes = new Uint8Array(encryptedBytes.length + authTagBytes.length);
    cipherBytes.set(encryptedBytes);
    cipherBytes.set(authTagBytes, encryptedBytes.length);

    const key = await crypto.subtle.importKey('raw', this._userKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, cipherBytes);
    return JSON.parse(new TextDecoder().decode(plainBuffer));
  }

  /** @private */
  _toBase64(uint8) {
    const binary = Array.from(uint8, byte => String.fromCharCode(byte)).join('');
    return btoa(binary);
  }

  /** @private */
  _fromBase64(base64) {
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  /** @private */
  _hexToUint8Array(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return arr;
  }

}

function normalizeMaxPayloadBytes(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('[rei-standard-amsg-client] maxPayloadBytes must be a positive integer when set');
  }
  return value;
}

export {
  MESSAGE_KIND,
  MESSAGE_TYPE,
  PUSH_SOURCE,
  buildContentPush,
  buildReasoningPush,
  buildToolRequestPush,
  buildErrorPush,
  isContentPush,
  isReasoningPush,
  isToolRequestPush,
  isErrorPush,
} from '@rei-standard/amsg-shared';
