/// <reference types="vite/client" />
import * as skills from "agents/skills";
import type { SkillManifest, SkillManifestResource } from "agents/skills";
import { createSkillTools } from "agents/skills/tools/ai-sdk";
import { describe, expect, it } from "vitest";

// Skills on the do-runtime browser lane. The fork's `agents:skills` Vite
// import is gone (agents 0.32 throws on it), and the fork ships no skill
// script runner (fork-diff "Deliberate product omissions"). Browser hosts
// bundle skill directories themselves and serve them with `manifest()`.

type ExecutableTool = {
  execute(input: Record<string, unknown>): Promise<unknown> | unknown;
};

function executable(tool: unknown): ExecutableTool {
  // SAFETY: AI SDK tools expose `execute`; the test calls it directly with
  // inputs the tool schema accepts.
  return tool as ExecutableTool;
}

// What the 0.27 `agents:skills` plugin bundled: only files under these
// top-level folders of a skill, skipping these names at any depth.
const RESOURCE_ROOTS = new Set([
  "references",
  "scripts",
  "assets",
  "graphics",
  "fonts",
  "templates",
  "rendered-files",
  "illustrations"
]);
const IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "coverage",
  "node_modules"
]);

/** Whether a skill-relative path is `SKILL.md` or a resource 0.27 bundled. */
function isBundledSkillFile(segments: readonly string[]): boolean {
  if (segments.some((segment) => IGNORED_NAMES.has(segment))) return false;
  if (segments.length === 1) return segments[0] === "SKILL.md";
  return RESOURCE_ROOTS.has(segments[0] ?? "");
}

/**
 * Turn `import.meta.glob(..., { query: "?raw" })` output for a directory of
 * skill folders into a manifest: the replacement for `agents:skills/<dir>`.
 * Applies the 0.27 plugin's filter, so code beside `SKILL.md` (an `index.ts`)
 * or a stray folder never becomes a resource. Text files only; `?raw` would
 * corrupt binary assets.
 */
function bundledSkills(
  id: string,
  root: string,
  files: Record<string, string>
): SkillManifest {
  const folders = new Map<
    string,
    { markdown?: string; resources: SkillManifestResource[] }
  >();
  for (const [file, content] of Object.entries(files)) {
    const [folder, ...rest] = file.slice(root.length).split("/");
    if (!folder || rest.length === 0 || !isBundledSkillFile(rest)) continue;
    const entry = folders.get(folder) ?? { resources: [] };
    folders.set(folder, entry);
    const path = rest.join("/");
    if (path === "SKILL.md") entry.markdown = content;
    else entry.resources.push({ path, content });
  }

  const entries: SkillManifest["skills"][number][] = [];
  for (const [folder, { markdown, resources }] of folders) {
    if (markdown === undefined) continue;
    const parsed = skills.parseSkill(markdown, { directory: folder });
    if (!parsed.ok) continue;
    const skill = parsed.value;
    entries.push({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      metadata: skill.metadata,
      allowedTools: skill.allowedTools.join(" "),
      ...(skill.license === undefined ? {} : { license: skill.license }),
      ...(skill.compatibility === undefined
        ? {}
        : { compatibility: skill.compatibility }),
      resources
    });
  }
  return { id, skills: entries };
}

// The JSON the removed `agents:skills` plugin emitted (agents 0.27), with its
// now-deprecated `fingerprint`, `rawContent`, `size` and `precompiled`.
const compiled = JSON.parse(`{
  "id": "bundle:skills",
  "fingerprint": "${"0f".repeat(32)}",
  "skills": [{
    "name": "pdf-tools",
    "description": "Fill and read PDF forms.",
    "body": "\\nRead references/forms.md before filling a form.\\n",
    "rawContent": "---\\nname: pdf-tools\\ndescription: Fill and read PDF forms.\\n---\\n",
    "license": "MIT",
    "allowedTools": "read",
    "metadata": { "owner": "rook" },
    "resources": [
      { "path": "references/forms.md", "kind": "reference", "size": 45,
        "encoding": "text", "mimeType": "text/markdown",
        "content": "Form fields live in the AcroForm dictionary.\\n",
        "precompiled": false },
      { "path": "scripts/fill.js", "kind": "script", "size": 40,
        "encoding": "text", "mimeType": "text/javascript",
        "content": "export default async function fill() {}\\n",
        "precompiled": true }
    ]
  }]
}`) as SkillManifest;

const root = "./fixtures/skills/";
const globbed = bundledSkills(
  "bundle:skills",
  root,
  import.meta.glob<string>("./fixtures/skills/**/*", {
    query: "?raw",
    import: "default",
    eager: true
  })
);

describe("browser skills", () => {
  it.each([
    ["the 0.27 compiled manifest", compiled],
    ["import.meta.glob ?raw files", globbed]
  ])("serves %s through manifest()", async (_label, definition) => {
    const catalog = await skills.loadSkillCatalog([
      skills.manifest(definition)
    ]);
    expect(catalog.diagnostics).toEqual([]);
    const entry = catalog.find("pdf-tools");
    expect(entry?.sourceId).toBe("bundle:skills");
    expect(entry?.skill).toMatchObject({
      license: "MIT",
      allowedTools: ["read"],
      metadata: { owner: "rook" }
    });
    expect(
      entry?.resources.map((resource) => [resource.path, resource.kind])
    ).toEqual([
      ["references/forms.md", "reference"],
      ["scripts/fill.js", "script"]
    ]);

    const activated = catalog.activate("pdf-tools");
    expect(activated.ok && activated.value).toContain(
      "Read references/forms.md before filling a form."
    );

    const tools = createSkillTools(catalog);
    expect(Object.keys(tools).sort()).toEqual([
      "activate_skill",
      "read_skill_resource"
    ]);
    await expect(
      executable(tools.read_skill_resource).execute({
        path: "pdf-tools/references/forms.md"
      })
    ).resolves.toContain("Form fields live in the AcroForm dictionary.");
  });

  it("bundles only SKILL.md and the 0.27 resource roots", () => {
    const files = import.meta.glob<string>("./fixtures/skills/**/*", {
      query: "?raw",
      import: "default",
      eager: true
    });
    // The fixtures hold files the recipe must drop; the glob does see them.
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "./fixtures/skills/pdf-tools/index.ts",
        "./fixtures/skills/pdf-tools/notes/draft.md"
      ])
    );
    const bundled = bundledSkills("bundle:skills", root, {
      ...files,
      "./fixtures/skills/pdf-tools/references/node_modules/dep.md": "ignored",
      "./fixtures/skills/pdf-tools/assets/.DS_Store": "ignored"
    });
    expect(
      bundled.skills[0]?.resources?.map((resource) => resource.path).sort()
    ).toEqual(["references/forms.md", "scripts/fill.js"]);
  });

  it("ships no script runner from agents/skills", () => {
    expect(Object.keys(skills)).not.toContain("runner");
  });
});
