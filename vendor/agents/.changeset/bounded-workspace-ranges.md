---
"@mcp-b/browser-workspace": minor
---

Add optional bounded byte reads (`RangeWorkspaceFsLike`) and `FileSystem.readFileRange`. OPFS reads
native File slices under its existing locks; WorkspaceFileSystem validates ranges
and preserves compatibility with backends that only implement whole-file reads.
