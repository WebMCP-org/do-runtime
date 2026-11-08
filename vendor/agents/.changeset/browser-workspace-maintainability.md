---
"@mcp-b/browser-workspace": patch
---

`OpfsWorkspace` copy and move failures now report the same errno as `DirectoryHandleWorkspace` (for example, a quota failure is ENOSPC rather than EIO). A moved symlink keeps its original `createdAt`, now written in a single manifest update.
