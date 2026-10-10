---
"@cloudflare/shell": minor
---

`listArchive` and `extractArchive` now read ZIP archives, including Office
`.docx`, `.xlsx` and `.pptx` files, as well as gzip-compressed tar. They choose
the format from the file's leading bytes. ZIP entries may be stored or deflated
(inflated through the platform `DecompressionStream`), and each entry's CRC-32
is checked before anything is written. ZIP entry names join the destination the
same way tar entry names do.

Previously both methods parsed every file as plain tar. A ZIP, gzip or any other
file reported success and extracted a junk entry or nothing. Now any other
format is rejected with an error that names the expected formats, and the
detected format when it is a common non-archive such as PDF. Encrypted, ZIP64
or multi-disk ZIPs, and tar headers that fail their checksum, are rejected
before any entry is written.
