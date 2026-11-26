---
'@mosherw/sync-system-server': patch
---

A stalled Redis pub/sub link now costs one resync, even with `REDIS_COMMAND_TIMEOUT_MS` above the 5 s heartbeat: only one link probe is in flight at a time, and a late probe failure of a link that was already replaced is ignored. Before, such late results could replace the new, healthy link and close every session on the instance with 1001 again.
