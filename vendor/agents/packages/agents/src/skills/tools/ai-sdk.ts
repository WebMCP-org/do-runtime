import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { renderSkillResource, type SkillCatalog } from "../catalog";

/**
 * AI SDK tools for Agent Skills, exported as `agents/skills/tools/ai-sdk`.
 *
 * Kept out of the `agents/skills` entry so the parser and sources do not
 * pull in `ai` or `zod`.
 *
 * @module
 */

// Vendor divergence: no `SkillToolsOptions.scriptRunner` and no
// `run_skill_script` tool. The fork ships no skill script runner (fork-diff
// "Deliberate product omissions"): its browser host has no Worker Loader to
// run one. Passing an options object is a type error, so an upstream sync
// that reintroduces the injection fails to compile instead of shipping it.

/**
 * Build AI SDK tools for a catalog: `activate_skill` and
 * `read_skill_resource`.
 *
 * Failures (an unknown skill, a missing file) are thrown, so the AI SDK
 * returns them to the model as tool errors.
 *
 * @param catalog - The catalog to expose. Build tools again after reloading it.
 * @returns The tools, or an empty set when the catalog has no skills.
 */
export function createSkillTools(catalog: SkillCatalog): ToolSet {
  const names = catalog.skills.map((entry) => entry.skill.name);
  const [first, ...rest] = names;
  if (first === undefined) return {};
  const nameSchema = z.enum([first, ...rest]);

  return {
    activate_skill: tool({
      description:
        "Activate a skill by name. Use this when the user's task matches one of the available skills.",
      inputSchema: z.object({ name: nameSchema }),
      execute: async ({ name }) => {
        const activated = catalog.activate(name);
        // Thrown errors reach the model as a tool error, with this message.
        if (!activated.ok) throw activated.error;
        return activated.value;
      }
    }),
    read_skill_resource: tool({
      description:
        "Read a bundled resource from an available skill by relative path. Pass name and path, or use a qualified path like skill-name/references/file.md.",
      inputSchema: z.object({
        name: nameSchema.optional(),
        path: z.string().min(1)
      }),
      execute: async ({ name, path }) => {
        const read = await catalog.readResource(
          name === undefined ? { path } : { name, path }
        );
        if (!read.ok) throw read.error;
        return renderSkillResource(read.value);
      }
    })
  };
}
