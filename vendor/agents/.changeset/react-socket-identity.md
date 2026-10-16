---
"agents": patch
---

Tie React connection identification to the PartySocket that received the native
identity frame. Custom base-path switches no longer expose the previous agent
as identified while its socket is being replaced, and ready waits for the
current socket. Preserve server identity-change callbacks when credentials
refresh at the same address.
