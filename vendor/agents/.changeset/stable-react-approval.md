---
"agents": patch
---

Keep the approval response command stable while streamed messages change. Reuse
React useCallback over the existing command dependencies so consumers do not
rebuild controls for every streamed chunk. The native streaming regression
checks command identity through a complete replay.
