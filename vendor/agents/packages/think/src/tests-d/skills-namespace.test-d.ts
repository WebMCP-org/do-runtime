import type * as agentSkills from "agents/skills";
import type { skills } from "../think";

// Think's `skills` namespace lists `agents/skills` exports by name. This
// fails to compile when `agents/skills` gains a value export Think misses.
// Vendor divergence: upstream also requires every `agents/skills/runner`
// value; the fork ships no runner, so the namespace must not carry it.
type MissingValues = Exclude<keyof typeof agentSkills, keyof typeof skills>;
const noMissingValues: [MissingValues] extends [never] ? true : MissingValues =
  true;
void noMissingValues;

const noRunner: "runner" extends keyof typeof skills ? false : true = true;
void noRunner;

// Types are reachable through the namespace too.
type SourceFromThink = skills.SkillSource;
type SourceFromAgents = agentSkills.SkillSource;
const sameSource: SourceFromThink extends SourceFromAgents ? true : false =
  true;
void sameSource;
