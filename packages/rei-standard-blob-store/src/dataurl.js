// data URL ⇄ Blob。base64 编解码优先走 Uint8Array.fromBase64 / toBase64
//（Safari 18.2+ / Firefox 133+ / Chrome 140+），老环境回退 atob/btoa 手编。
// Blob → data URL 优先走 FileReader（原生高效、经消费者验证的路径，Window / Worker 都支持）。

/**
 * `data:<mime>[;base64],<payload>` → Blob。非 data URL 抛错。
 * 只取媒体类型，`;charset=` 等参数丢弃。
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string') throw new TypeError('Invalid data URL');
  const comma = dataUrl.indexOf(',');
  // scheme 大小写不敏感（RFC 2397）：DATA:image/png 浏览器照常渲染
  if (!/^data:/i.test(dataUrl) || comma < 0) throw new TypeError('Invalid data URL');
  const header = dataUrl.slice(0, comma);
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  if (!/;base64$/i.test(header)) {
    // 宽容解码：合法的 %XX 段照常解码，坏转义段（如 SVG 里的 width="100%"）原样保留，
    // 这与浏览器对 data URL 的 percent-decode 行为一致，但仅限文本内容——非 UTF-8
    // 的字节转义（如 %FF）不在这条文本向分支的覆盖范围内：浏览器会还原出原始字节，
    // 这里选择保留字面量。
    const text = dataUrl.slice(comma + 1).replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
      try { return decodeURIComponent(m); } catch { return m; }
    });
    return new Blob([text], { type: mime });
  }
  // 浏览器处理 data URL 是先 percent-decode 再 forgiving-base64（URL 标准）：
  // 经过 URL 编码上下文的 payload（padding 变 %3D、+ 变 %2B）浏览器照常渲染，
  // 这里也要先还原。宽容策略与上面文本分支一致：坏转义段原样保留。
  const b64 = dataUrl.slice(comma + 1).replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try { return decodeURIComponent(m); } catch { return m; }
  });
  let bytes;
  if (typeof Uint8Array.fromBase64 === 'function') {
    bytes = Uint8Array.fromBase64(b64);
  } else {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Blob → `data:<mime>;base64,xxxx`。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToDataUrl(blob) {
  if (typeof FileReader !== 'undefined' && blob.type) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(reader.error || new Error('blobToDataUrl failed'));
      reader.readAsDataURL(blob);
    });
  }
  // 无 FileReader（Node 等非浏览器环境）或无 type（FileReader 会丢 MIME 头）时手编。
  const mime = blob.type || 'application/octet-stream';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let b64;
  if (typeof bytes.toBase64 === 'function') {
    b64 = bytes.toBase64();
  } else {
    let binary = '';
    const CHUNK = 0x8000; // 分块拼串，避开 String.fromCharCode 参数上限
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    b64 = btoa(binary);
  }
  return `data:${mime};base64,${b64}`;
}
