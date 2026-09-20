---
"@cloudflare/think": patch
---

Render an explicit tool error when a previously read image or PDF becomes inaccessible, so later turns and recovery can continue. Preserve the saved read result so the file can be rendered again after access is restored.

Check current file metadata against the existing inline media limit before reading bytes, avoiding whole-file allocation for oversized PDFs and images. Keep the post-read check for files that change between metadata and content reads.
