---
"agents": patch
---

Leave malformed persisted state unchanged when JSON decoding fails during
hydration. Report the decode error instead of silently replacing the row with
initial state or deleting it. Valid JSON still passes through
`migratePersistedState`, whose successful migration writes only its returned
current shape.
