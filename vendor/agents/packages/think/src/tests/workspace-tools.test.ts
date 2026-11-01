import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { getWorkspace, type WorkspaceHandle } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import type { ThinkWorkspaceToolsAgent } from "./agents/workspace-tools";

const FILE_TOOLS = ["delete", "edit", "find", "grep", "ls", "read", "write"];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0];

async function freshAgent() {
  return getAgentByName(
    env.ThinkWorkspaceToolsAgent as unknown as DurableObjectNamespace<ThinkWorkspaceToolsAgent>,
    `workspace-tools-${crypto.randomUUID()}`
  );
}

describe("Think workspace tools", () => {
  it("adds the file tools, and no exec, to a default agent", async () => {
    const agent = await freshAgent();
    const { toolNames, system } = await agent.captureTurn();
    expect(toolNames).toEqual(expect.arrayContaining(FILE_TOOLS));
    expect(toolNames).not.toContain("exec");
    expect(system).toContain(
      "You can inspect and edit the agent workspace using the available file tools."
    );
  });

  it("lets a same-name tool from getTools() replace a built-in", async () => {
    const agent = await freshAgent();
    await agent.overrideRead();
    await agent.captureTurn();
    expect(await agent.toolDescription("read")).toBe(
      "The agent's own read tool."
    );
    expect(await agent.callTool("read", { path: "/a" })).toContain(
      "custom read of /a"
    );
  });

  it("writes and reads files through the tools", async () => {
    const agent = await freshAgent();
    await agent.captureTurn();
    await agent.callTool("write", {
      path: "/workspace/notes/today.md",
      content: "ship it\n"
    });
    const read = JSON.parse(
      await agent.callTool("read", { path: "/workspace/notes/today.md" })
    );
    expect(JSON.stringify(read)).toContain("ship it");
  });

  it("adds exec when the Workspace has a backend", async () => {
    const agent = await freshAgent();
    await agent.addJavaScriptBackend();
    const { toolNames } = await agent.captureTurn();
    expect(toolNames).toContain("exec");
  });

  it("runs code on the Workspace's backend through exec", async () => {
    const agent = await freshAgent();
    await agent.addJavaScriptBackend();
    await agent.captureTurn();
    const output = await agent.callTool("exec", {
      command: "export default async function () { return 6 * 7; }"
    });
    expect(output).toContain("42");
  });

  it("lets code run with exec import the agent's tools from ws:tools", async () => {
    const agent = await freshAgent();
    await agent.addJavaScriptBackend();
    await agent.captureTurn();
    const output = await agent.callTool("exec", {
      command: [
        'import { shout } from "ws:tools";',
        "export default async function () {",
        '  return (await shout({ text: "hello" })).text;',
        "}"
      ].join("\n")
    });
    expect(output).toContain("HELLO");
  });

  it("reads files through node:fs, not ws:tools", async () => {
    const agent = await freshAgent();
    await agent.addJavaScriptBackend();
    await agent.captureTurn();
    const withRead = await agent.callTool("exec", {
      command: [
        'import { read } from "ws:tools";',
        "export default async () => read;"
      ].join("\n")
    });
    expect(withRead).toContain("does not provide an export named 'read'");

    const withFs = await agent.callTool("exec", {
      command: [
        'import { writeFile, readFile } from "node:fs/promises";',
        "export default async function () {",
        '  await writeFile("/workspace/fs.txt", "via node:fs");',
        '  return readFile("/workspace/fs.txt", "utf8");',
        "}"
      ].join("\n")
    });
    expect(withFs).toContain("via node:fs");
  });

  it("sends a captured image read to the model by default", async () => {
    const agent = await freshAgent();
    await agent.writeBytes("/workspace/shot.png", [...PNG]);
    await agent.captureTurn();
    expect(
      JSON.parse(
        await agent.renderTool("read", { path: "/workspace/shot.png" })
      )
    ).toMatchObject({
      type: "content",
      value: [
        {
          type: "text",
          text: "Read /workspace/shot.png (image/png, 9 bytes)."
        },
        { type: "file", mediaType: "image/png", filename: "shot.png" }
      ]
    });
  });

  it("renders an image read as a note for a model without image input", async () => {
    const agent = await freshAgent();
    await agent.writeBytes("/workspace/shot.png", [...PNG]);
    await agent.setMediaCapabilities({ images: false, pdfs: true });
    await agent.captureTurn();
    expect(
      JSON.parse(
        await agent.renderTool("read", { path: "/workspace/shot.png" })
      )
    ).toEqual({
      type: "error-text",
      value:
        "Read /workspace/shot.png (image/png, 9 bytes). This model has no image input, so the picture was not sent."
    });
  });

  it("renders a PDF read as workspacePdfText's pages for a model without PDF input", async () => {
    const agent = await freshAgent();
    await agent.writeBytes("/workspace/filing.pdf", [
      ...new TextEncoder().encode("%PDF-1.4\n")
    ]);
    await agent.setMediaCapabilities({
      images: true,
      pdfs: false,
      pdfPages: ["Claim 7"]
    });
    await agent.captureTurn();
    expect(
      JSON.parse(
        await agent.renderTool("read", { path: "/workspace/filing.pdf" })
      )
    ).toEqual({
      type: "text",
      value:
        "Read /workspace/filing.pdf (application/pdf, 9 bytes). This model has no PDF input, " +
        "so this is the text of its 1 page, without layout or images.\n" +
        "1\t--- Page 1 ---\n2\tClaim 7"
    });
  });

  // Vendor divergence tests ("Early model preparation and media") record the
  // relative-path default without changing it: a Computer Workspace resolves
  // a relative tool path under /workspace, and so does Think's host bridge,
  // even for a Workspace rooted at `/`.
  it("resolves a relative tool path under /workspace on a Computer Workspace", async () => {
    const agent = await freshAgent();
    await agent.captureTurn();
    await agent.callTool("write", { path: "notes/rel.md", content: "rel\n" });
    expect(
      await agent.callTool("read", { path: "/workspace/notes/rel.md" })
    ).toContain("rel");
  });

  it("resolves the host bridge's relative paths under /workspace on a host Workspace", async () => {
    const agent = await freshAgent();
    await agent.useHostWorkspace({
      "notes.md": "as given",
      "/workspace/notes.md": "under /workspace"
    });
    expect(await agent.hostReadFile("notes.md")).toBe("under /workspace");
    await agent.hostWriteFile("out.md", "x");
    expect(await agent.hostPaths()).toEqual([
      "/workspace/notes.md",
      "/workspace",
      "/workspace/out.md"
    ]);
  });

  it("hands its Workspace to getWorkspace(stub)", async () => {
    const agent = await freshAgent();
    // SAFETY: Think implements `__getWorkspaceStub()`. The DO stub types its
    // result as `Stub<WorkspaceStub>`, which TypeScript cannot relate to
    // WorkspaceHandle's `WorkspaceStub`.
    using workspace = await getWorkspace(agent as unknown as WorkspaceHandle);
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile(
      "/workspace/from-outside.txt",
      new TextEncoder().encode("hello")
    );

    await agent.captureTurn();
    const read = await agent.callTool("read", {
      path: "/workspace/from-outside.txt"
    });
    expect(read).toContain("hello");
  });
});
