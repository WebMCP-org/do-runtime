---
"@mcp-b/do-runtime": patch
---

Serialize transformed await publication until the owning continuation resumes so overlapping actors cannot overwrite each other's ambient identity.
