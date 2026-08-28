---
"@mcp-b/do-runtime": minor
---

`storage.put()` now reads its arguments the way JSG does, instead of silently dropping writes.

A non-string, non-object key previously fell into the multi-key overload, where `Object.entries` on a primitive is `[]` — so the call resolved having written nothing. It now stringifies the key as the `kj::String` alternative does: `put(123, v)` writes `"123"`, `put(null, v)` writes `"null"`, `put(undefined, v)` writes `"undefined"`, `put([["a", 1]], v)` writes `"a,1"`, and a symbol key throws V8's own conversion error.

Once the key does unwrap as a dictionary, a second argument that is a non-null primitive is now refused with upstream's own message rather than spread into the options — `put({a: 1}, "v")` wrote key `a` with `{0: "v"}` for options. The refusal models workerd's all-optional options struct exactly: `null`, arrays and functions all unwrap to default options and the write proceeds, as measured on real workerd. Functions take the dictionary alternative in the KEY position too, so `put(function f(){}, v)` is refused rather than writing a row keyed on the function's source text.

Measured on real workerd and pinned by a conformance row that runs on all three lanes.
