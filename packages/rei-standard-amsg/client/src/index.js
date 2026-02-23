/**
 * ReiStandard Client SDK
 * v1.2.0
 *
 * Lightweight browser client that handles:
 *  - AES-256-GCM encryption using the Web Crypto API
 *  - Push subscription management via the Push API
 *  - Convenient request helpers for all 7 endpoints
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

/**
 * @typedef {Object} ReiClientConfig
 * @property {string} baseUrl  - Base URL of the API (e.g. https://host/api/v1).
 * @property {string} userId   - Current user identifier.
 */

export class ReiClient {
  /**
   * @param {ReiClientConfig} config
   */
  constructor(config) {
    if (!config || !config.baseUrl) throw new Error('[rei-standard-amsg-client] baseUrl is required');
    if (!config.userId) throw new Error('[rei-standard-amsg-client] userId is required');

    /** @private */
    this._baseUrl = config.baseUrl.replace(/\/+$/, '');
    /** @private */
    this._userId = config.userId;
    /** @private */
    this._userKey = null;
  }

  // ─── Initialisation ─────────────────────────────────────────────

  /**
   * Fetch the user-specific encryption key.
   * Must be called before any encrypted request.
   */
  async init() {
    const res = await fetch(`${this._baseUrl}/get-user-key`, {
      method: 'GET',
      headers: { 'X-User-Id': this._userId }
    });

    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to fetch user key');

    const userKey = json?.data?.userKey;
    if (typeof userKey !== 'string' || !/^[0-9a-f]{64}$/i.test(userKey)) {
      throw new Error('[rei-standard-amsg-client] Invalid user key format');
    }

    this._userKey = this._hexToUint8Array(userKey);
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Schedule (or instantly send) a message.
   * The payload is automatically encrypted before transmission.
   *
   * @param {Object} payload - Schedule message payload.
   * @returns {Promise<Object>} API response body.
   */
  async scheduleMessage(payload) {
    const encrypted = await this._encrypt(JSON.stringify(payload));

    const res = await fetch(`${this._baseUrl}/schedule-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': this._userId,
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1'
      },
      body: JSON.stringify(encrypted)
    });

    return res.json();
  }

  /**
   * Update an existing scheduled message.
   *
   * @param {string} uuid    - Task UUID.
   * @param {Object} updates - Fields to update.
   * @returns {Promise<Object>}
   */
  async updateMessage(uuid, updates) {
    const encrypted = await this._encrypt(JSON.stringify(updates));

    const res = await fetch(`${this._baseUrl}/update-message?id=${encodeURIComponent(uuid)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': this._userId,
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1'
      },
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
      headers: { 'X-User-Id': this._userId }
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
      headers: {
        'X-User-Id': this._userId,
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1'
      }
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
      applicationServerKey: this._urlBase64ToUint8Array(vapidPublicKey)
    });
    return subscription;
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
    const encoded = new TextEncoder().encode(plaintext);
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

  /** @private */
  _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
}
