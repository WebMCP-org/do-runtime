---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
"@cloudflare/voice": patch
"@cloudflare/shell": patch
"@cloudflare/codemode": patch
---

Preserve class and function names in the built SDK packages. Agent constructor
names participate in durable sub-agent identity, so a consumer bundle must see
the same names as the original SDK source. Keep native async functions in every
package so browser hosts can apply their actor-await transform to built code.
