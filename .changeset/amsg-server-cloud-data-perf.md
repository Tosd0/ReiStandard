---
'@rei-standard/amsg-server': patch
---

Fix Cloudflare Worker memory and CPU exhaustion (`exceededResources`) during cloud data inventory and cleanup:

- Omit inline `client_state.value` and `message_outbox.payload` blobs larger than 1 KB in `D1Adapter.listCloudResourceRows`, returning byte size and prefix/suffix snapshots instead, and match those snapshots in `D1Adapter.deleteCloudResourceRows`.
- Check encrypted `cloud_resource_metadata` sidecars before decrypting large `client_state` chunks or `message_outbox` payloads in `buildCloudDataInventory`, and avoid full-row `TextEncoder.encode` allocations when computing `byteSize`.
- Cache imported Web Crypto `AES-GCM` keys in `encryption.js` to avoid repeated `crypto.subtle.importKey` calls per row.
- Reuse the retirement inventory before batch deletion and persist cleanup operation state once per batch in `advanceCleanup`.
