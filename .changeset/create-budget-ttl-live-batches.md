---
'@mosherw/sync-system-server': patch
---

The per-app create budget (Redis key `lb:<ns>`) now ends 1 ms after the app's latest group instead of when it would be full again, so it never outlives the app's groups; with a burst above the sustained rate times the group's life, the full burst is back once every group of the app has ended. Expired live groups are freed from Redis in batches of 64, so a large backlog after an outage no longer blocks Redis in one script call.
