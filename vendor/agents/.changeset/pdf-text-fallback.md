---
"@cloudflare/think": minor
---

Add a `pdfText` option to `createReadTool` and `createWorkspaceTools`, and a `workspacePdfText` knob on Think. When the model has no PDF input, a workspace `read` of a PDF renders as the extracted text of each page, line-numbered and windowed by `offset` and `limit`, instead of a note naming the file. Extraction results are cached by content digest, since every later request renders the read again.
