// @rei-standard/blob-store 公共出口。
export { DEFAULT_PREFIX, extractRefs } from './token.js';
export { dataUrlToBlob, blobToDataUrl } from './dataurl.js';
export { createBlobStore } from './store.js';

/** @typedef {import('./store.js').StorageAdapter} StorageAdapter */
