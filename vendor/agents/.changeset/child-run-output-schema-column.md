---
"@cloudflare/think": patch
---

Recovering an agent-tool child whose child-run table was created without the
`output_schema_json` column no longer fails with "no such column". Think now
adds the column alongside its other child-run column migrations.
