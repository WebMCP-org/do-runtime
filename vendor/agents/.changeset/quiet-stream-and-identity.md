---
"agents": patch
---

Keep chat approval callbacks stable while messages stream, and reset reconnect
identity comparison when the requested Agent address changes. Existing server
approval notification and same-address identity checks remain intact.
