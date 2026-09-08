---
"@cloudflare/shell": minor
---

Add `@cloudflare/shell/browser` with an OPFS-backed `OpfsWorkspace` implementing
the existing `WorkspaceFsLike` interface. Hosts choose the storage directory;
the backend coordinates native writes across Workers, stores symlinks separately,
and reuses Shell's path and glob behavior. Native writable streams preserve
existing contents when file writes, appends, or streamed downloads fail.

Browser regressions exercise the built package in Chromium Workers, including
binary files, pagination, symlinks, copy/move, corrupt metadata, failed writes,
and concurrent writers.
