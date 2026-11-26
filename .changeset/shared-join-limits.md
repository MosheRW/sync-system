---
'@mosherw/sync-system-server': patch
---

Several instances on Redis now share the per-app join-attempt budget (600 attempts per app per minute for `group.joinByCode` and `group.joinByQr`): it is counted once in Redis instead of once per instance, so the code-guessing budget no longer multiplies by the number of instances. A join attempt whose budget step cannot reach Redis closes with `1001` like other storage failures. One instance without Redis is unchanged.
