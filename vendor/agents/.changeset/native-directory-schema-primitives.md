---
"@cloudflare/shell": patch
"@cloudflare/codemode": patch
---

Expose browser-safe filesystem paths and native metadata helpers, and add a
DirectoryHandleWorkspace backend for existing File System Access directories.
The host supplies handle persistence, permissions, and the shared lock identity;
the backend owns traversal, byte operations, atomic writes, copy/move and globbing.

Expose the existing JSON Schema printer as a framework-free type-expression
entry point. Share that printer across declaration generation, print arrays as
`Array<T>` and parenthesize intersection operands so unions keep their
precedence, and give objects that allow additional properties an index
signature that also admits their named and optional properties. Malformed and
recursive schemas degrade to unknown without failing the remaining
declarations.

Preserve TanStack AI's inferred code-tool schema and literal name instead of
annotating it with the schema-less ServerTool default. Include Codemode's
production and Node compiler/type regressions in the SDK check/test gates.

Expose the existing WorkspaceFileSystem adapter from the browser entry without
loading the state-backend factory or Node-only archive/hash utilities. Resolve
intermediate symlinks, consume complete directory listings (stopping when a
backend that ignores `offset` repeats a page), and use a backend's optional
native binary append so concurrent appends retain all accepted bytes.
