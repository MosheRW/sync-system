---
'@mosherw/sync-system-client': patch
---

`forgetAllGroups()` with storage that can neither delete nor read: the cut-off for other tabs' tokens is never lowered by a later failed call, and has a 60 second margin for a device clock behind the server.
