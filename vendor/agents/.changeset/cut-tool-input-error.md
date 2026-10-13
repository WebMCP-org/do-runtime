---
"@cloudflare/think": patch
---

A model response that ends while a tool call's input is still streaming now
fails the turn with a stream error. When a provider's body ended without a
finish event, the AI SDK finished the partial step with reason `other`, so the
turn reported `completed` with no error frame, no `onError` callback, and a
tool call that never ran; a step cut off by the output token limit (`length`)
or a content filter did the same. Every finish reason except `tool-calls` now
fails such a turn. WebSocket clients receive the error frame and an `error`
outcome, and `chat()` callers receive `onError`, as for any other in-stream
error. The error is the new exported `UnfinishedToolInputError`, carrying the
unfinished `toolNames` and the step's `finishReason`, so a `classifyChatError`
override can return `transient` for a dropped connection (`other`) and get the
existing bounded recovery while a deterministic stop stays a visible error.
The partial tool call is still persisted and repaired on the next turn.
