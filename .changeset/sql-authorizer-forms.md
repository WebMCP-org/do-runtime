---
"@mcp-b/do-runtime": minor
---

`sql.exec()` and `sql.ingest()` now refuse the SQL forms workerd's authorizer refuses but its regulator never sees. SQL that uses them throws where it previously ran.

`ATTACH`, `DETACH`, the temp-schema creations, and virtual-table modules outside upstream's four reach SQLite action codes rather than `SqlStorageRegulator` callbacks, so porting the regulator whole left them unguarded. Each refuses with workerd's own message, `not authorized: SQLITE_AUTH`, except `VACUUM`, which carries SQLite's `cannot VACUUM from within a transaction: SQLITE_ERROR` because upstream refuses it by the transaction a Durable Object always has open.

`ATTACH` was an isolation boundary and not only a fidelity gap: both backends open a real database file, so application SQL could attach another actor's database and read every application table in it — the reserved-name scan sees only the submitted statement — and `VACUUM INTO` could write any file the process can. The temp schema is refused by both of its spellings, `CREATE TEMP TABLE` and `CREATE TABLE temp.t`; the second was the live gap, where the table was created, written and read back. Of the virtual-table modules, `dbstat` is the one that mattered: it reports a row per table, so it enumerated the runtime's own `_cf_` tables and their sizes without the statement ever naming them. The table name and the module accept every quoting SQLite does — double quotes, backticks, brackets, and the misquoting feature's single-quoted string — with the module resolved before the allowlist, exactly as workerd's authorizer sees it; a `CREATE VIRTUAL TABLE` whose module cannot be read is refused outright.

A leading `;` now counts as trivia for every leading-keyword refusal in the file, including the pre-existing transaction-control and pragma checks. `node:sqlite` reports an empty first statement as part of the span it compiled, so `;ATTACH …` read as a statement whose keyword was `;` and passed all three.

`PRAGMA page_size` is now allowed with no argument, as upstream's allowlist has it for the R*Tree module's own internal read; `PRAGMA page_size = N` is still refused. That was a false refusal — code that runs on Cloudflare failed here.

Every form, refused and allowed alike, was measured on real workerd and is pinned by a conformance row that runs on all three lanes.
