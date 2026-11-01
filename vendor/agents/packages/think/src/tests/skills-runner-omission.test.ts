import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { skills } from "../think";
import type { ThinkWorkspaceSkillsAgent } from "./agents/think-session";

// Vendor divergence: upstream Think exposes `run_skill_script` when
// `getSkillScriptRunner()` returns a runner, and re-exports `skills.runner()`.
// The fork ships no skill script runner (fork-diff "Deliberate product
// omissions"); these cases pin that a skill with bundled scripts still gets
// only the activation and resource tools.

describe("Think skills without a script runner", () => {
  it("does not re-export the runner through the skills namespace", () => {
    expect(Object.keys(skills)).not.toContain("runner");
    expect(Object.keys(skills)).toEqual(
      expect.arrayContaining([
        "manifest",
        "workspace",
        "r2",
        "loadSkillCatalog"
      ])
    );
  });

  it("offers activate_skill and read_skill_resource, never run_skill_script", async () => {
    const stub = await getAgentByName(
      env.ThinkWorkspaceSkillsAgent as unknown as DurableObjectNamespace<ThinkWorkspaceSkillsAgent>,
      `skills-no-runner-${crypto.randomUUID()}`
    );
    await stub.writeSkill("pdf-tools", "Fill and read PDF forms.");
    await runInDurableObject(stub, async (agent: ThinkWorkspaceSkillsAgent) => {
      await agent.workspace.fs.mkdir(
        "/workspace/.agents/skills/pdf-tools/scripts",
        { recursive: true }
      );
      await agent.workspace.fs.writeFile(
        "/workspace/.agents/skills/pdf-tools/scripts/fill.js",
        new TextEncoder().encode("export default async function fill() {}\n")
      );
    });

    await stub.testChat("Fill the form");
    const names = await stub.getTurnToolNames();
    expect(names.filter((name) => name.includes("skill"))).toEqual([
      "activate_skill",
      "read_skill_resource"
    ]);
    expect(names).not.toContain("run_skill_script");
  });
});
