// Agent Skills (https://agentskills.io): parse `SKILL.md`, load skills from
// a Computer Workspace, R2, or a manifest, and expose them to a model.
//
// Vendor divergence: no script runner. Upstream also exports the
// `SkillScriptRunner` request/context types here for `agents/skills/runner`
// and `createSkillTools({ scriptRunner })`; the fork ships neither (fork-diff
// "Deliberate product omissions"). `runner.ts`, `script.ts` and
// `script-workspace.ts` stay upstream-identical so syncs stay mechanical, but
// no package entry point (`agents/skills`, `agents/skills/tools/ai-sdk`, or a
// `./skills/runner` export) reaches them.

export { formatSkill, parseSkill } from "./markdown";
export { isModelInvocable, parseSkillName, SkillParseError } from "./skill";
export type {
  ParseSkillOptions,
  Skill,
  SkillName,
  SkillParseErrorCode,
  SkillParseResult
} from "./skill";
export {
  InvalidSkillResourcePathError,
  parseSkillResourcePath
} from "./resource";
export type {
  SkillResource,
  SkillResourceInfo,
  SkillResourceKind,
  SkillResourcePath
} from "./resource";
export type { SkillResult } from "./result";
export { SkillResourceNotFoundError, SkillSourceError } from "./source";
export type {
  InvalidSkill,
  ListedSkill,
  SkillListing,
  SkillSource
} from "./source";
export { DEFAULT_WORKSPACE_SKILLS_ROOT, workspace } from "./workspace";
export type { SkillWorkspace, WorkspaceSkillSourceOptions } from "./workspace";
export { r2 } from "./r2";
export type { R2SkillSourceOptions } from "./r2";
export { fromManifest, manifest } from "./manifest";
export type {
  SkillManifest,
  SkillManifestEntry,
  SkillManifestResource
} from "./manifest";
export {
  formatSkillDiagnostic,
  loadSkillCatalog,
  renderSkillResource,
  UnknownSkillError
} from "./catalog";
export type {
  LoadSkillCatalogOptions,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogResource,
  SkillDiagnostic,
  SkillResourceError
} from "./catalog";
