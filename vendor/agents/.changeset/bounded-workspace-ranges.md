---
"@cloudflare/shell": minor
---

Add optional bounded byte reads to WorkspaceFsLike and FileSystem. OPFS reads
native File slices under its existing locks; WorkspaceFileSystem validates ranges
and preserves compatibility with backends that only implement whole-file reads.
