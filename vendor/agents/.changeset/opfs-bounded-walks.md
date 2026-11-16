---
"@mcp-b/browser-workspace": minor
---

`OpfsWorkspace.getWorkspaceInfo()` totals the workspace in one walk that keeps
counts instead of an entry per file, and takes an optional `{ signal }` that
stops it before its next directory. `OpfsWorkspace.glob` lists only the
directories a pattern without `**` can reach and reads only its matches.
Results and their order are unchanged.
