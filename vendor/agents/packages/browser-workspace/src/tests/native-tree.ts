import type { OpfsWorkspace } from "@mcp-b/browser-workspace";

/** Writes files straight into the workspace's native data tree, many at once,
 * so a test can seed thousands without a workspace write each. */
export async function seedFiles(
  ws: OpfsWorkspace,
  files: Iterable<[path: string, content: string]>
): Promise<void> {
  const data = await ws.getDataDirectory();
  await Promise.all(
    Array.from(files, async ([path, content]) => {
      const parts = path.split("/").filter(Boolean);
      let directory = data;
      for (const part of parts.slice(0, -1))
        directory = await directory.getDirectoryHandle(part, { create: true });
      const file = await directory.getFileHandle(parts.at(-1)!, {
        create: true
      });
      const writable = await file.createWritable();
      await writable.write(content);
      await writable.close();
    })
  );
}
