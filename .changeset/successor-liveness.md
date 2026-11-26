---
'@mosherw/sync-system-server': patch
---

**A just-started instance can take over a group (#42):** when a grace period
ends, a member attached to an instance that started in the last few seconds
(before its peers' next heartbeat) is now a successor; before, the group could
stay paused until the leader came back or the frozen bound ended it, most
often during a rolling deploy. A take-back now also tells the current leader
on such an instance that it lost the lead. A cache miss is confirmed with one
Redis read per grace end or take-back.
