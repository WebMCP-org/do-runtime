---
"@cloudflare/think": patch
---

Persist assistant messages before announcing completion and retain terminal stream evidence until the next turn so a cold restart cannot continue an already-completed answer.
