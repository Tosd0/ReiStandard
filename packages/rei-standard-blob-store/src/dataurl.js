// data URL ⇄ Blob。base64 编解码优先走 Uint8Array.fromBase64 / toBase64
//（Safari 18.2+ / Firefox 133+ / Chrome 140+），老环境回退 atob/btoa 手编。
// Blob → data URL 在浏览器主线程优先 FileReader（原生高效、经消费者验证的路径）。

/**
 * `data:<mime>[;base64],<payload>` → Blob。非 data URL 抛错。
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) throw new Error('Invalid data URL');
  const header = dataUrl.slice(0, comma);
  const mimeMatch = header.match(/^data:([^;,]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  if (!/;base64/i.test(header)) {
    // 非 base64（如 utf8 编码的 svg），按 UTF-8 处理。
    return new Blob([decodeURIComponent(dataUrl.slice(comma + 1))], { type: mime });
  }
  const b64 = dataUrl.slice(comma + 1);
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
  // 无 FileReader（Worker / Node）或无 type（FileReader 会丢 MIME 头）时手编。
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
