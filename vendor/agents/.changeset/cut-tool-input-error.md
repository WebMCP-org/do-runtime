---
"@cloudflare/think": patch
---

A model response that ends while a tool call's input is still streaming now
fails the turn with a stream error. When a provider's body ended without a
finish event, the AI SDK finished the partial step with reason `other`, so the
turn reported `completed` with no error frame, no `onError` callback, and a
tool call that never ran. WebSocket clients now receive the error frame and an
`error` outcome, and `chat()` callers receive `onError`, as for any other
in-stream error. The partial tool call is still persisted and repaired on the
next turn. An app whose `classifyChatError` returns `transient` for this error
gets the existing bounded recovery instead.
