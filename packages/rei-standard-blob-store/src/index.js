// @rei-standard/blob-store 公共出口。
export { DEFAULT_PREFIX, extractRefs } from './token.js';
export { dataUrlToBlob, blobToDataUrl } from './dataurl.js';
export { createBlobStore } from './store.js';
export { createIdbAdapter } from './idb-adapter.js';
export { hashBlob } from './content-scan.js';

/** @typedef {import('./store.js').StorageAdapter} StorageAdapter */
/** @typedef {import('./gc.js').GcOptions} GcOptions */
/** @typedef {import('./gc.js').GcResult} GcResult */
/** @typedef {import('./content-scan.js').ContentScanOptions} ContentScanOptions */
/** @typedef {import('./content-scan.js').ContentScanResult} ContentScanResult */
/** @typedef {import('./content-scan.js').DuplicateGroup} DuplicateGroup */
