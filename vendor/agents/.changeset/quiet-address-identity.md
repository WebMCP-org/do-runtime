---
"agents": patch
---

Reset reconnect identity comparison when useAgent deliberately changes its
requested address. Switching conversations no longer reports an unexpected
identity change; reconnects to the same address still detect server changes.
