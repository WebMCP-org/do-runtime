---
"@cloudflare/think": patch
---

Restore upstream’s four-message read-time window. Remove the fork’s two-message
override so recent tool results stay intact through the preceding two exchanges.
Stored history, compaction floors and the hydration byte budget are unchanged.
