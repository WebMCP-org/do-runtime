import { InMemoryFs } from "../fs/in-memory-fs";
import { describe, expect, it } from "vitest";
import { buildTar } from "../extras";
import { createMemoryStateBackend } from "../memory";
import { StateBatchOperationError } from "../index";

describe("MemoryStateBackend", () => {
  it("reads, writes, and appends text content", async () => {
    const backend = createMemoryStateBackend();

    await backend.writeFile("/notes/todo.txt", "hello");
    await backend.appendFile("/notes/todo.txt", "\nworld");

    await expect(backend.readFile("/notes/todo.txt")).resolves.toBe(
      "hello\nworld"
    );
  });

  it("reads and writes JSON content", async () => {
    const backend = createMemoryStateBackend();

    await backend.writeJson("/config.json", {
      name: "demo",
      flags: ["a", "b"]
    });

    await expect(backend.readJson("/config.json")).resolves.toEqual({
      name: "demo",
      flags: ["a", "b"]
    });
    await expect(backend.readFile("/config.json")).resolves.toBe(
      '{\n  "name": "demo",\n  "flags": [\n    "a",\n    "b"\n  ]\n}\n'
    );
  });

  it("throws a helpful error for invalid JSON", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/broken.json": "{ nope"
      }
    });

    await expect(backend.readJson("/broken.json")).rejects.toThrow(
      "Invalid JSON in /broken.json"
    );
  });

  it("supports host-side globbing and unified diffs", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": "export const a = 1;\n",
        "/src/b.ts": "export const b = 2;\n"
      }
    });

    await expect(backend.glob("/src/*.ts")).resolves.toEqual([
      "/src/a.ts",
      "/src/b.ts"
    ]);

    const diff = await backend.diffContent(
      "/src/a.ts",
      "export const a = 3;\n"
    );
    expect(diff).toContain("--- /src/a.ts");
    expect(diff).toContain("+++ /src/a.ts");
    expect(diff).toContain("-export const a = 1;");
    expect(diff).toContain("+export const a = 3;");
  });

  it("supports text search with plain text, regex, and word boundaries", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/notes.txt": "foo food\nFoo foo42\nfoo\n"
      }
    });

    await expect(backend.searchText("/notes.txt", "foo")).resolves.toEqual([
      { line: 1, column: 1, match: "foo", lineText: "foo food" },
      { line: 1, column: 5, match: "foo", lineText: "foo food" },
      { line: 2, column: 5, match: "foo", lineText: "Foo foo42" },
      { line: 3, column: 1, match: "foo", lineText: "foo" }
    ]);

    await expect(
      backend.searchText("/notes.txt", "foo", { caseSensitive: false })
    ).resolves.toEqual([
      { line: 1, column: 1, match: "foo", lineText: "foo food" },
      { line: 1, column: 5, match: "foo", lineText: "foo food" },
      { line: 2, column: 1, match: "Foo", lineText: "Foo foo42" },
      { line: 2, column: 5, match: "foo", lineText: "Foo foo42" },
      { line: 3, column: 1, match: "foo", lineText: "foo" }
    ]);

    await expect(
      backend.searchText("/notes.txt", "foo", { wholeWord: true })
    ).resolves.toEqual([
      { line: 1, column: 1, match: "foo", lineText: "foo food" },
      { line: 3, column: 1, match: "foo", lineText: "foo" }
    ]);

    await expect(
      backend.searchText("/notes.txt", "foo\\d+", { regex: true })
    ).resolves.toEqual([
      { line: 2, column: 5, match: "foo42", lineText: "Foo foo42" }
    ]);
  });

  it("supports richer search context and max match limits", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/search.txt": "zero\none foo\ntwo\nthree foo\nfour\n"
      }
    });

    await expect(
      backend.searchText("/search.txt", "foo", {
        contextBefore: 1,
        contextAfter: 1,
        maxMatches: 1
      })
    ).resolves.toEqual([
      {
        line: 2,
        column: 5,
        match: "foo",
        lineText: "one foo",
        beforeLines: ["zero"],
        afterLines: ["two"]
      }
    ]);
  });

  it("supports structured file discovery via find", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": "a",
        "/src/nested/b.ts": "bb",
        "/src/nested/c.txt": "ccc",
        "/empty.txt": ""
      }
    });

    await expect(
      backend.find("/src", { type: "file", pathPattern: "/src/**/*.ts" })
    ).resolves.toEqual([
      {
        path: "/src/a.ts",
        name: "a.ts",
        type: "file",
        depth: 1,
        size: 1,
        mtime: expect.any(Date)
      },
      {
        path: "/src/nested/b.ts",
        name: "b.ts",
        type: "file",
        depth: 2,
        size: 2,
        mtime: expect.any(Date)
      }
    ]);

    await expect(
      backend.find("/", { empty: true, type: "file" })
    ).resolves.toEqual([
      {
        path: "/empty.txt",
        name: "empty.txt",
        type: "file",
        depth: 1,
        size: 0,
        mtime: expect.any(Date)
      }
    ]);
  });

  it("supports JSON query and update operations", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/config.json": '{ "app": { "name": "demo", "flags": ["a", "b"] } }\n'
      }
    });

    await expect(
      backend.queryJson("/config.json", ".app.flags[1]")
    ).resolves.toBe("b");

    const updated = await backend.updateJson("/config.json", [
      { op: "set", path: ".app.name", value: "demo-2" },
      { op: "set", path: ".app.flags[2]", value: "c" },
      { op: "delete", path: ".app.flags[0]" }
    ]);

    expect(updated.operationsApplied).toBe(3);
    expect(updated.value).toEqual({
      app: { name: "demo-2", flags: ["b", "c"] }
    });
    await expect(backend.readJson("/config.json")).resolves.toEqual({
      app: { name: "demo-2", flags: ["b", "c"] }
    });
  });

  it("supports in-file replacement without touching unmatched content", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/replace.txt": "foo food foo\n"
      }
    });

    await expect(
      backend.replaceInFile("/replace.txt", "foo", "bar", {
        wholeWord: true
      })
    ).resolves.toEqual({
      replaced: 2,
      content: "bar food bar\n"
    });

    await expect(backend.readFile("/replace.txt")).resolves.toBe(
      "bar food bar\n"
    );
  });

  it("supports multi-file search across glob matches", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const alpha = "foo";\n',
        "/src/b.ts": 'export const beta = "bar";\n',
        "/src/c.ts": 'export const gamma = "foo";\n'
      }
    });

    await expect(backend.searchFiles("/src/*.ts", "foo")).resolves.toEqual([
      {
        path: "/src/a.ts",
        matches: [
          {
            line: 1,
            column: 23,
            match: "foo",
            lineText: 'export const alpha = "foo";'
          }
        ]
      },
      {
        path: "/src/c.ts",
        matches: [
          {
            line: 1,
            column: 23,
            match: "foo",
            lineText: 'export const gamma = "foo";'
          }
        ]
      }
    ]);
  });

  it("supports multi-file replacement with dry-run previews", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const alpha = "foo";\n',
        "/src/b.ts": 'export const beta = "foo";\n'
      }
    });

    const preview = await backend.replaceInFiles("/src/*.ts", "foo", "bar", {
      dryRun: true
    });

    expect(preview).toEqual({
      dryRun: true,
      files: [
        {
          path: "/src/a.ts",
          replaced: 1,
          content: 'export const alpha = "bar";\n',
          diff: '--- /src/a.ts\n+++ /src/a.ts\n@@ -1,2 +1,2 @@\n-export const alpha = "foo";\n+export const alpha = "bar";\n '
        },
        {
          path: "/src/b.ts",
          replaced: 1,
          content: 'export const beta = "bar";\n',
          diff: '--- /src/b.ts\n+++ /src/b.ts\n@@ -1,2 +1,2 @@\n-export const beta = "foo";\n+export const beta = "bar";\n '
        }
      ],
      totalFiles: 2,
      totalReplacements: 2
    });

    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "foo";\n'
    );
  });

  it("applies multi-file replacements when not in dry-run mode", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const alpha = "foo";\n',
        "/src/b.ts": 'export const beta = "foo";\n',
        "/src/c.ts": 'export const gamma = "nope";\n'
      }
    });

    const result = await backend.replaceInFiles("/src/*.ts", "foo", "bar");

    expect(result.totalFiles).toBe(2);
    expect(result.totalReplacements).toBe(2);
    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "bar";\n'
    );
    await expect(backend.readFile("/src/b.ts")).resolves.toBe(
      'export const beta = "bar";\n'
    );
    await expect(backend.readFile("/src/c.ts")).resolves.toBe(
      'export const gamma = "nope";\n'
    );
  });

  it("applies batches of edits with dry-run and no-op tracking", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": "a\n",
        "/src/b.ts": "b\n"
      }
    });

    const preview = await backend.applyEdits(
      [
        { path: "/src/a.ts", content: "aa\n" },
        { path: "/src/b.ts", content: "b\n" },
        { path: "/src/c.ts", content: "c\n" }
      ],
      { dryRun: true }
    );

    expect(preview.totalChanged).toBe(2);
    expect(preview.edits[0].changed).toBe(true);
    expect(preview.edits[1].changed).toBe(false);
    expect(preview.edits[2].changed).toBe(true);
    await expect(backend.exists("/src/c.ts")).resolves.toBe(false);

    const applied = await backend.applyEdits([
      { path: "/src/a.ts", content: "aa\n" },
      { path: "/src/b.ts", content: "b\n" },
      { path: "/src/c.ts", content: "c\n" }
    ]);

    expect(applied.totalChanged).toBe(2);
    await expect(backend.readFile("/src/a.ts")).resolves.toBe("aa\n");
    await expect(backend.readFile("/src/b.ts")).resolves.toBe("b\n");
    await expect(backend.readFile("/src/c.ts")).resolves.toBe("c\n");
  });

  it("plans structured edits by intent and applies the resulting plan", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const a = "foo";\n',
        "/src/data.json": '{ "count": 1 }\n'
      }
    });

    const plan = await backend.planEdits([
      {
        kind: "replace",
        path: "/src/a.ts",
        search: "foo",
        replacement: "bar"
      },
      {
        kind: "writeJson",
        path: "/src/data.json",
        value: { count: 2 }
      },
      {
        kind: "write",
        path: "/src/new.ts",
        content: "export const created = true;\n"
      }
    ]);

    expect(plan.totalInstructions).toBe(3);
    expect(plan.totalChanged).toBe(3);
    expect(plan.edits[0]).toEqual({
      instruction: {
        kind: "replace",
        path: "/src/a.ts",
        search: "foo",
        replacement: "bar"
      },
      path: "/src/a.ts",
      changed: true,
      content: 'export const a = "bar";\n',
      diff: expect.stringContaining("--- /src/a.ts")
    });
    expect(plan.edits[1]).toEqual({
      instruction: {
        kind: "writeJson",
        path: "/src/data.json",
        value: { count: 2 }
      },
      path: "/src/data.json",
      changed: true,
      content: '{\n  "count": 2\n}\n',
      diff: expect.stringContaining("--- /src/data.json")
    });
    expect(plan.edits[2]).toEqual({
      instruction: {
        kind: "write",
        path: "/src/new.ts",
        content: "export const created = true;\n"
      },
      path: "/src/new.ts",
      changed: true,
      content: "export const created = true;\n",
      diff: expect.stringContaining("--- /src/new.ts")
    });

    await expect(
      backend.applyEditPlan(plan, { dryRun: true })
    ).resolves.toMatchObject({
      dryRun: true,
      totalChanged: 3
    });
    await expect(backend.exists("/src/new.ts")).resolves.toBe(false);

    const applied = await backend.applyEditPlan(plan);
    expect(applied.totalChanged).toBe(3);
    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const a = "bar";\n'
    );
    await expect(backend.readFile("/src/data.json")).resolves.toBe(
      '{\n  "count": 2\n}\n'
    );
    await expect(backend.readFile("/src/new.ts")).resolves.toBe(
      "export const created = true;\n"
    );
  });

  it("fails planning when a replace instruction targets a missing file", async () => {
    const backend = createMemoryStateBackend();

    await expect(
      backend.planEdits([
        {
          kind: "replace",
          path: "/src/missing.ts",
          search: "foo",
          replacement: "bar"
        }
      ])
    ).rejects.toThrow("ENOENT: no such file: /src/missing.ts");
  });

  it("rolls back multi-file replacements when a later write fails", async () => {
    const backend = createMemoryStateBackend({
      fs: new FailingWriteFs(
        new InMemoryFs({
          "/src/a.ts": 'export const alpha = "foo";\n',
          "/src/b.ts": 'export const beta = "foo";\n'
        }),
        "/src/b.ts"
      )
    });

    await expect(
      backend.replaceInFiles("/src/*.ts", "foo", "bar")
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "replaceInFiles",
      rolledBack: true
    } satisfies Partial<StateBatchOperationError>);

    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "foo";\n'
    );
    await expect(backend.readFile("/src/b.ts")).resolves.toBe(
      'export const beta = "foo";\n'
    );
  });

  it("can leave partial writes in place when rollback is disabled", async () => {
    const backend = createMemoryStateBackend({
      fs: new FailingWriteFs(
        new InMemoryFs({
          "/src/a.ts": 'export const alpha = "foo";\n',
          "/src/b.ts": 'export const beta = "foo";\n'
        }),
        "/src/b.ts"
      )
    });

    await expect(
      backend.replaceInFiles("/src/*.ts", "foo", "bar", {
        rollbackOnError: false
      })
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "replaceInFiles",
      rolledBack: false
    } satisfies Partial<StateBatchOperationError>);

    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "bar";\n'
    );
    await expect(backend.readFile("/src/b.ts")).resolves.toBe(
      'export const beta = "foo";\n'
    );
  });

  it("rolls back applied edits when a later edit write fails", async () => {
    const backend = createMemoryStateBackend({
      fs: new FailingWriteFs(
        new InMemoryFs({
          "/src/a.ts": "a\n",
          "/src/b.ts": "b\n"
        }),
        "/src/b.ts"
      )
    });

    await expect(
      backend.applyEdits([
        { path: "/src/a.ts", content: "aa\n" },
        { path: "/src/b.ts", content: "bb\n" },
        { path: "/src/c.ts", content: "cc\n" }
      ])
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "applyEdits",
      rolledBack: true
    } satisfies Partial<StateBatchOperationError>);

    await expect(backend.readFile("/src/a.ts")).resolves.toBe("a\n");
    await expect(backend.readFile("/src/b.ts")).resolves.toBe("b\n");
    await expect(backend.exists("/src/c.ts")).resolves.toBe(false);
  });

  it("supports recursive copy and move helpers", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/project/src/index.ts": "export const value = 1;\n"
      }
    });

    await backend.copyTree("/project", "/project-copy");
    await backend.moveTree("/project-copy", "/archive/project-copy");

    await expect(
      backend.readFile("/archive/project-copy/src/index.ts")
    ).resolves.toBe("export const value = 1;\n");
    await expect(backend.exists("/project-copy")).resolves.toBe(false);
  });

  it("supports tree walking and directory summaries", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/tree/a.txt": "a",
        "/tree/nested/b.txt": "bb",
        "/tree/nested/deeper/c.txt": "ccc"
      }
    });

    const tree = await backend.walkTree("/tree", { maxDepth: 2 });
    expect(tree).toEqual({
      path: "/tree",
      name: "tree",
      type: "directory",
      size: 0,
      children: [
        {
          path: "/tree/a.txt",
          name: "a.txt",
          type: "file",
          size: 1
        },
        {
          path: "/tree/nested",
          name: "nested",
          type: "directory",
          size: 0,
          children: [
            {
              path: "/tree/nested/b.txt",
              name: "b.txt",
              type: "file",
              size: 2
            },
            {
              path: "/tree/nested/deeper",
              name: "deeper",
              type: "directory",
              size: 0
            }
          ]
        }
      ]
    });

    await expect(backend.summarizeTree("/tree")).resolves.toEqual({
      files: 3,
      directories: 3,
      symlinks: 0,
      totalBytes: 6,
      maxDepth: 3
    });
  });

  it("supports archive creation, listing, extraction, compression, hashing, and file detection", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/archive-src/a.txt": "hello",
        "/archive-src/nested/b.txt": "world"
      }
    });

    const archive = await backend.createArchive("/bundle.tar", [
      "/archive-src"
    ]);
    expect(archive.path).toBe("/bundle.tar");
    expect(archive.entries).toEqual([
      { path: "archive-src", type: "directory", size: 0 },
      { path: "archive-src/a.txt", type: "file", size: 5 },
      { path: "archive-src/nested", type: "directory", size: 0 },
      { path: "archive-src/nested/b.txt", type: "file", size: 5 }
    ]);

    await expect(backend.listArchive("/bundle.tar")).resolves.toEqual(
      archive.entries
    );

    const extracted = await backend.extractArchive("/bundle.tar", "/restored");
    expect(extracted.destination).toBe("/restored");
    await expect(backend.readFile("/restored/archive-src/a.txt")).resolves.toBe(
      "hello"
    );
    await expect(
      backend.readFile("/restored/archive-src/nested/b.txt")
    ).resolves.toBe("world");

    const compressed = await backend.compressFile("/archive-src/a.txt");
    expect(compressed.destination).toBe("/archive-src/a.txt.gz");
    const decompressed = await backend.decompressFile(
      "/archive-src/a.txt.gz",
      "/archive-src/a-restored.txt"
    );
    expect(decompressed.destination).toBe("/archive-src/a-restored.txt");
    await expect(backend.readFile("/archive-src/a-restored.txt")).resolves.toBe(
      "hello"
    );

    await expect(
      backend.hashFile("/archive-src/a.txt", { algorithm: "sha256" })
    ).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );

    await expect(backend.detectFile("/archive-src/a.txt")).resolves.toEqual({
      mime: "text/plain",
      extension: "txt",
      binary: false,
      description: "text/plain (txt)"
    });
  });
});

describe("MemoryStateBackend archive formats", () => {
  const documentXml = `<?xml version="1.0"?><w:document>${"<w:p>quarterly revenue</w:p>".repeat(40)}</w:document>`;
  const rawBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

  it("lists and extracts stored and deflated ZIP entries", async () => {
    const backend = createMemoryStateBackend();
    await backend.writeFileBytes(
      "/report.docx",
      await buildZip([
        { name: "[Content_Types].xml", content: "<Types/>", method: 8 },
        { name: "word/" },
        { name: "word/document.xml", content: documentXml, method: 8 },
        { name: "media/raw.bin", content: rawBytes, method: 0 }
      ])
    );

    await expect(backend.listArchive("/report.docx")).resolves.toEqual([
      { path: "[Content_Types].xml", type: "file", size: 8 },
      { path: "media/raw.bin", type: "file", size: 256 },
      { path: "word", type: "directory", size: 0 },
      { path: "word/document.xml", type: "file", size: documentXml.length }
    ]);

    await expect(
      backend.extractArchive("/report.docx", "/unpacked")
    ).resolves.toEqual({
      destination: "/unpacked",
      entries: [
        { path: "[Content_Types].xml", type: "file", size: 8 },
        { path: "word", type: "directory", size: 0 },
        { path: "word/document.xml", type: "file", size: documentXml.length },
        { path: "media/raw.bin", type: "file", size: 256 }
      ]
    });
    await expect(backend.readFile("/unpacked/word/document.xml")).resolves.toBe(
      documentXml
    );
    await expect(
      backend.readFile("/unpacked/[Content_Types].xml")
    ).resolves.toBe("<Types/>");
    await expect(
      backend.readFileBytes("/unpacked/media/raw.bin")
    ).resolves.toEqual(rawBytes);
    expect((await backend.stat("/unpacked/word"))?.type).toBe("directory");
  });

  it("reads ZIP sizes from the central directory when a data descriptor follows the entry", async () => {
    const backend = createMemoryStateBackend();
    await backend.writeFileBytes(
      "/streamed.xlsx",
      await buildZip(
        [
          { name: "xl/workbook.xml", content: documentXml, method: 8 },
          { name: "notes.txt", content: "plain", method: 0 }
        ],
        { dataDescriptor: true }
      )
    );

    await backend.extractArchive("/streamed.xlsx", "/sheet");

    await expect(backend.readFile("/sheet/xl/workbook.xml")).resolves.toBe(
      documentXml
    );
    await expect(backend.readFile("/sheet/notes.txt")).resolves.toBe("plain");
  });

  it("rejects a file that is not a tar, gzip-compressed tar or ZIP archive", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/notes.txt": "just some notes, not an archive",
        "/paper.pdf": "%PDF-1.7\n%binary"
      }
    });

    await expect(backend.extractArchive("/notes.txt", "/out")).rejects.toThrow(
      "/notes.txt is not a tar, gzip-compressed tar or ZIP archive"
    );
    await expect(backend.listArchive("/notes.txt")).rejects.toThrow(
      "/notes.txt is not a tar, gzip-compressed tar or ZIP archive"
    );
    await expect(backend.extractArchive("/paper.pdf", "/out")).rejects.toThrow(
      "/paper.pdf is a PDF document, not a tar, gzip-compressed tar or ZIP archive"
    );
    await expect(backend.exists("/out")).resolves.toBe(false);
  });

  it("rejects a gzip file that does not contain a tar archive", async () => {
    const backend = createMemoryStateBackend({
      files: { "/notes.txt": "just some notes" }
    });
    await backend.compressFile("/notes.txt");

    await expect(
      backend.extractArchive("/notes.txt.gz", "/out")
    ).rejects.toThrow(
      "/notes.txt.gz is gzip-compressed but does not contain a tar archive"
    );
  });

  it("rejects a ZIP entry whose content does not match its checksum without writing any entry", async () => {
    const backend = createMemoryStateBackend();
    await backend.writeFileBytes(
      "/corrupt.zip",
      await buildZip([
        { name: "first.txt", content: "intact", method: 0 },
        { name: "second.txt", content: "damaged", method: 0, badCrc: true }
      ])
    );

    await expect(
      backend.extractArchive("/corrupt.zip", "/out")
    ).rejects.toThrow(
      "/corrupt.zip: ZIP entry second.txt failed its CRC-32 check"
    );
    await expect(backend.exists("/out")).resolves.toBe(false);
  });

  it("rejects encrypted ZIP entries and compression methods other than stored and deflate", async () => {
    const backend = createMemoryStateBackend();
    await backend.writeFileBytes(
      "/locked.zip",
      await buildZip([
        { name: "secret.txt", content: "x", method: 0, encrypted: true }
      ])
    );
    await backend.writeFileBytes(
      "/bzip2.zip",
      await buildZip([{ name: "data.txt", content: "x", method: 12 }])
    );

    await expect(backend.extractArchive("/locked.zip", "/out")).rejects.toThrow(
      "/locked.zip: ZIP entry secret.txt is encrypted"
    );
    await expect(backend.extractArchive("/bzip2.zip", "/out")).rejects.toThrow(
      "/bzip2.zip: ZIP entry data.txt uses compression method 12; only stored (0) and deflate (8) are supported"
    );
  });

  it("extracts a gzip-compressed tar archive", async () => {
    const backend = createMemoryStateBackend({
      files: { "/src/a.txt": "hello", "/src/nested/b.txt": "world" }
    });
    await backend.createArchive("/bundle.tar", ["/src"]);
    await backend.compressFile("/bundle.tar", "/bundle.tgz");

    await expect(backend.listArchive("/bundle.tgz")).resolves.toEqual(
      await backend.listArchive("/bundle.tar")
    );
    await backend.extractArchive("/bundle.tgz", "/restored");

    await expect(backend.readFile("/restored/src/nested/b.txt")).resolves.toBe(
      "world"
    );
  });

  it("joins ZIP entry names onto the destination the same way as tar entry names", async () => {
    const backend = createMemoryStateBackend();
    await backend.writeFileBytes(
      "/entries.tar",
      buildTar([
        { path: "../tar-parent.txt", type: "file", bytes: encode("tar") },
        { path: "/tar-rooted.txt", type: "file", bytes: encode("tar") }
      ])
    );
    await backend.writeFileBytes(
      "/entries.zip",
      await buildZip([
        { name: "../zip-parent.txt", content: "zip" },
        { name: "/zip-rooted.txt", content: "zip" }
      ])
    );

    await backend.extractArchive("/entries.tar", "/restored/inner");
    await backend.extractArchive("/entries.zip", "/restored/inner");

    await expect(backend.readFile("/restored/tar-parent.txt")).resolves.toBe(
      "tar"
    );
    await expect(backend.readFile("/restored/zip-parent.txt")).resolves.toBe(
      "zip"
    );
    await expect(
      backend.readFile("/restored/inner/tar-rooted.txt")
    ).resolves.toBe("tar");
    await expect(
      backend.readFile("/restored/inner/zip-rooted.txt")
    ).resolves.toBe("zip");
  });
});

type ZipFixtureEntry = {
  name: string;
  content?: string | Uint8Array;
  method?: 0 | 8 | 12;
  encrypted?: boolean;
  badCrc?: boolean;
};

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Writes a ZIP the way common archivers do: local headers, central directory, end record. */
async function buildZip(
  entries: ZipFixtureEntry[],
  options: { dataDescriptor?: boolean } = {}
): Promise<Uint8Array> {
  const local: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const name = encode(entry.name);
    const content =
      typeof entry.content === "string"
        ? encode(entry.content)
        : (entry.content ?? new Uint8Array());
    const method = entry.method ?? 0;
    const data = method === 8 ? await deflateRaw(content) : content;
    const crc = crc32(content) ^ (entry.badCrc ? 1 : 0);
    const flags =
      (entry.encrypted ? 0x1 : 0) | (options.dataDescriptor ? 0x8 : 0) | 0x800;
    const offset = local.length;
    const headerSizes = options.dataDescriptor
      ? [0, 0, 0]
      : [crc, data.byteLength, content.byteLength];
    pushLe(local, 0x04034b50, 4);
    pushLe(local, 20, 2);
    pushLe(local, flags, 2);
    pushLe(local, method, 2);
    pushLe(local, 0, 4);
    pushLe(local, headerSizes[0], 4);
    pushLe(local, headerSizes[1], 4);
    pushLe(local, headerSizes[2], 4);
    pushLe(local, name.byteLength, 2);
    pushLe(local, 0, 2);
    local.push(...name, ...data);
    if (options.dataDescriptor) {
      pushLe(local, 0x08074b50, 4);
      pushLe(local, crc, 4);
      pushLe(local, data.byteLength, 4);
      pushLe(local, content.byteLength, 4);
    }
    pushLe(central, 0x02014b50, 4);
    pushLe(central, 0x031e, 2);
    pushLe(central, 20, 2);
    pushLe(central, flags, 2);
    pushLe(central, method, 2);
    pushLe(central, 0, 4);
    pushLe(central, crc, 4);
    pushLe(central, data.byteLength, 4);
    pushLe(central, content.byteLength, 4);
    pushLe(central, name.byteLength, 2);
    pushLe(central, 0, 2);
    pushLe(central, 0, 2);
    pushLe(central, 0, 2);
    pushLe(central, 0, 2);
    pushLe(central, 0, 4);
    pushLe(central, offset, 4);
    central.push(...name);
  }
  const end: number[] = [];
  pushLe(end, 0x06054b50, 4);
  pushLe(end, 0, 2);
  pushLe(end, 0, 2);
  pushLe(end, entries.length, 2);
  pushLe(end, entries.length, 2);
  pushLe(end, central.length, 4);
  pushLe(end, local.length, 4);
  pushLe(end, 0, 2);
  return Uint8Array.from([...local, ...central, ...end]);
}

function pushLe(target: number[], value: number, byteLength: 2 | 4): void {
  for (let index = 0; index < byteLength; index++) {
    target.push((value >>> (index * 8)) & 0xff);
  }
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("InMemoryFs — symlinks", () => {
  it("stat follows symlinks, lstat does not", async () => {
    const fs = new InMemoryFs({ "/target.txt": "hello" });
    await fs.symlink("/target.txt", "/link.txt");

    const stat = await fs.stat("/link.txt");
    expect(stat.type).toBe("file");
    expect(stat.size).toBe(5);

    const lstat = await fs.lstat("/link.txt");
    expect(lstat.type).toBe("symlink");
  });

  it("readlink returns the symlink target", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/a.txt", "a");
    await fs.symlink("/a.txt", "/link");

    await expect(fs.readlink("/link")).resolves.toBe("/a.txt");
  });

  it("readlink throws on non-symlink", async () => {
    const fs = new InMemoryFs({ "/plain.txt": "x" });
    await expect(fs.readlink("/plain.txt")).rejects.toThrow("EINVAL");
  });

  it("realpath resolves through symlinks", async () => {
    const fs = new InMemoryFs({ "/dir/file.txt": "content" });
    await fs.symlink("/dir", "/link");

    await expect(fs.realpath("/link/file.txt")).resolves.toBe("/dir/file.txt");
  });

  it("resolves intermediate symlinks when reading files", async () => {
    const fs = new InMemoryFs({ "/actual/data.txt": "payload" });
    await fs.symlink("/actual", "/shortcut");

    await expect(fs.readFile("/shortcut/data.txt")).resolves.toBe("payload");
  });

  it("resolves chained symlinks", async () => {
    const fs = new InMemoryFs({ "/root.txt": "end" });
    await fs.symlink("/root.txt", "/hop1");
    await fs.symlink("/hop1", "/hop2");
    await fs.symlink("/hop2", "/hop3");

    await expect(fs.readFile("/hop3")).resolves.toBe("end");
    await expect(fs.realpath("/hop3")).resolves.toBe("/root.txt");
  });

  it("resolves relative symlinks", async () => {
    const fs = new InMemoryFs({ "/dir/target.txt": "found" });
    await fs.symlink("target.txt", "/dir/link");

    await expect(fs.readFile("/dir/link")).resolves.toBe("found");
  });

  it("throws ELOOP on circular symlinks", async () => {
    const fs = new InMemoryFs();
    await fs.symlink("/b", "/a");
    await fs.symlink("/a", "/b");

    await expect(fs.readFile("/a")).rejects.toThrow("ELOOP");
  });

  it("cp preserves symlinks instead of following them", async () => {
    const fs = new InMemoryFs({ "/target.txt": "data" });
    await fs.symlink("/target.txt", "/link");
    await fs.cp("/link", "/copied");

    const lstat = await fs.lstat("/copied");
    expect(lstat.type).toBe("symlink");
    await expect(fs.readlink("/copied")).resolves.toBe("/target.txt");
  });

  it("mv preserves symlinks", async () => {
    const fs = new InMemoryFs({ "/target.txt": "data" });
    await fs.symlink("/target.txt", "/link");
    await fs.mv("/link", "/moved");

    await expect(fs.readlink("/moved")).resolves.toBe("/target.txt");
    await expect(fs.exists("/link")).resolves.toBe(false);
  });

  it("readdirWithFileTypes reports symlinks", async () => {
    const fs = new InMemoryFs({ "/dir/file.txt": "x" });
    await fs.symlink("/dir/file.txt", "/dir/link");

    const entries = await fs.readdirWithFileTypes("/dir");
    const linkEntry = entries.find((e) => e.name === "link");
    expect(linkEntry?.type).toBe("symlink");
  });
});

describe("InMemoryFs — hard links", () => {
  it("link creates a file sharing the source content", async () => {
    const fs = new InMemoryFs({ "/original.txt": "shared" });
    await fs.link("/original.txt", "/hardlink.txt");

    await expect(fs.readFile("/hardlink.txt")).resolves.toBe("shared");
  });

  it("link throws EEXIST when destination exists", async () => {
    const fs = new InMemoryFs({
      "/a.txt": "a",
      "/b.txt": "b"
    });
    await expect(fs.link("/a.txt", "/b.txt")).rejects.toThrow("EEXIST");
  });

  it("link throws EPERM on directories", async () => {
    const fs = new InMemoryFs({ "/dir/child.txt": "c" });
    await expect(fs.link("/dir", "/link")).rejects.toThrow("EPERM");
  });
});

describe("InMemoryFs — chmod and utimes", () => {
  it("chmod changes file mode", async () => {
    const fs = new InMemoryFs({ "/f.txt": "x" });
    await fs.chmod("/f.txt", 0o755);

    const stat = await fs.stat("/f.txt");
    expect(stat.mode).toBe(0o755);
  });

  it("utimes changes modification time", async () => {
    const fs = new InMemoryFs({ "/f.txt": "x" });
    const past = new Date("2020-01-01T00:00:00Z");
    await fs.utimes("/f.txt", past, past);

    const stat = await fs.stat("/f.txt");
    expect(stat.mtime).toEqual(past);
  });

  it("chmod throws ENOENT on missing path", async () => {
    const fs = new InMemoryFs();
    await expect(fs.chmod("/nope", 0o644)).rejects.toThrow("ENOENT");
  });
});

describe("InMemoryFs — root path guards", () => {
  it("symlink to root path throws", async () => {
    const fs = new InMemoryFs();
    await expect(fs.symlink("/target", "/")).rejects.toThrow("EEXIST");
  });

  it("link to root path throws", async () => {
    const fs = new InMemoryFs({ "/f.txt": "x" });
    await expect(fs.link("/f.txt", "/")).rejects.toThrow("EEXIST");
  });

  it("cp to root path throws", async () => {
    const fs = new InMemoryFs({ "/f.txt": "x" });
    await expect(fs.cp("/f.txt", "/")).rejects.toThrow("EISDIR");
  });
});

class FailingWriteFs {
  constructor(
    private readonly inner: InMemoryFs,
    private readonly failPath: string
  ) {}

  async readFile(path: string) {
    return this.inner.readFile(path);
  }

  async readFileBytes(path: string) {
    return this.inner.readFileBytes(path);
  }

  async writeFile(path: string, content: string) {
    if (path === this.failPath) {
      throw new Error(`simulated write failure: ${path}`);
    }
    return this.inner.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array) {
    if (path === this.failPath) {
      throw new Error(`simulated write failure: ${path}`);
    }
    return this.inner.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array) {
    return this.inner.appendFile(path, content);
  }

  async exists(path: string) {
    return this.inner.exists(path);
  }

  async stat(path: string) {
    return this.inner.stat(path);
  }

  async lstat(path: string) {
    return this.inner.lstat(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    return this.inner.mkdir(path, options);
  }

  async readdir(path: string) {
    return this.inner.readdir(path);
  }

  async readdirWithFileTypes(path: string) {
    return this.inner.readdirWithFileTypes(path);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return this.inner.rm(path, options);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }) {
    return this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string) {
    return this.inner.mv(src, dest);
  }

  resolvePath(base: string, path: string) {
    return this.inner.resolvePath(base, path);
  }

  async glob(pattern: string) {
    return this.inner.glob(pattern);
  }

  async chmod(path: string, mode: number) {
    return this.inner.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string) {
    return this.inner.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string) {
    return this.inner.link(existingPath, newPath);
  }

  async readlink(path: string) {
    return this.inner.readlink(path);
  }

  async realpath(path: string) {
    return this.inner.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date) {
    return this.inner.utimes(path, atime, mtime);
  }
}
