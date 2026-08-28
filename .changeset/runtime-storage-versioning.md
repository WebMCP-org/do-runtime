---
"@mcp-b/do-runtime": patch
---

Version runtime storage per database file. Every database the runtime opens — an actor's, the facet tree's, an alarm scheduler's — is stamped with `PRAGMA user_version` and brought forward through forward-only migration steps at open, before any event can enter (the Agents SDK's `_ensureSchema` pattern, one layer down). Pending steps and the stamp commit as one transaction, and a step that issues transaction control of its own is refused by name. A file stamped by a newer release refuses with the database and the remedy named, at open and again at `importSnapshot()`, so the operation that brought a too-new image in is the one that fails. The stamp itself is unreachable from application SQL (see the pragma allowlist change). Note for embedders constructing `AlarmScheduler` directly: the database you pass is now stamped too; host tables sharing that file are untouched — migration steps confine themselves to runtime-owned tables, and a test pins that.
