---
"@mcp-b/do-runtime": patch
---

SQL cursor iterators now match workerd's observable shape, not just its helpers. `sql.exec(...).raw()` and the cursor's own iterator sit on `%IteratorPrototype%` — so `raw().toArray()`, which Drizzle's `durable-sqlite` migrator and driver call, works as it does on Cloudflare — and, like upstream's jsg iterators, they expose `next` and nothing else: no `return`/`throw`, so an early exit (`break`, partial destructuring, `take()`) does not close a retained iterator; results are `{done, value}` in that key order with an own `value: undefined` when done; `Symbol.toStringTag` reads `RawIterator`/`RowIterator`/`Cursor`; and `columnNames` is a prototype accessor, so a cursor JSON-stringifies to `{}`. Pinned by two conformance rows on all three lanes and an end-to-end Drizzle migration test.
