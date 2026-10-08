---
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-client": patch
---

Prevent idle D1 cron ticks from exhausting the free row-read quota: delete metadata atomically with resources, resume only indexed due cleanup operations, reclaim expired records in bounded batches, and repair legacy metadata once with persistent cursors. Include snapshot summaries in resource pages so clients can avoid duplicate inventory scans.
