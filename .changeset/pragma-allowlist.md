---
"@mcp-b/do-runtime": minor
---

`sql.exec()` and `sql.ingest()` now enforce workerd's pragma allowlist. Every pragma outside `util/sqlite.c++`'s `ALLOWED_PRAGMAS` — `user_version`, `writable_schema`, `journal_mode`, `max_page_count`, and the rest — refuses with workerd's message, `not authorized: SQLITE_AUTH`, and the `pragma_*` table-valued functions follow the same list. Previously every pragma passed straight through, which no code written for Cloudflare could have relied on, and which let application SQL overwrite the runtime's storage version stamp or rewrite `sqlite_master` via `writable_schema`. The allowlist, including argument-signature rules, is pinned by a conformance row that runs against real workerd.
