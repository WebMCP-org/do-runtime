---
"@mcp-b/browser-workspace": minor
---

Add an OPFS-backed `OpfsWorkspace` implementing Shell's `WorkspaceFsLike`
interface (first shipped as `@cloudflare/shell/browser`, now this package). Hosts choose the storage directory;
the backend coordinates native writes across Workers, stores symlinks separately,
and reuses Shell's path and glob behavior. Native writable streams preserve
existing contents when file writes, appends, or streamed downloads fail.

Browser regressions exercise the built package in Chromium Workers, including
binary files, pagination, symlinks, copy/move, corrupt metadata, failed writes,
and concurrent writers.
