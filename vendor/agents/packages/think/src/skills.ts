/**
 * The `skills` namespace Think re-exports: `agents/skills`.
 *
 * Vendor divergence: upstream also re-exports the experimental script runner
 * (`runner`, `WorkerSkillScriptRunnerOptions` from `agents/skills/runner`) and
 * the `SkillScript*` types, so `skills.runner()` feeds
 * `getSkillScriptRunner()`. The fork ships no runner (fork-diff "Deliberate
 * product omissions"); importing it here would pull Codemode's
 * `DynamicWorkerExecutor`, `just-bash` and a Worker Loader dependency into
 * every Think bundle.
 *
 * The exports are listed by name: the declaration bundler drops
 * `export * from` an external package inside a namespace.
 *
 * @module
 */
export {
  DEFAULT_WORKSPACE_SKILLS_ROOT,
  formatSkill,
  formatSkillDiagnostic,
  fromManifest,
  InvalidSkillResourcePathError,
  isModelInvocable,
  loadSkillCatalog,
  manifest,
  parseSkill,
  parseSkillName,
  parseSkillResourcePath,
  r2,
  renderSkillResource,
  SkillParseError,
  SkillResourceNotFoundError,
  SkillSourceError,
  UnknownSkillError,
  workspace
} from "agents/skills";
export type {
  InvalidSkill,
  ListedSkill,
  LoadSkillCatalogOptions,
  ParseSkillOptions,
  R2SkillSourceOptions,
  Skill,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogResource,
  SkillDiagnostic,
  SkillListing,
  SkillManifest,
  SkillManifestEntry,
  SkillManifestResource,
  SkillName,
  SkillParseErrorCode,
  SkillParseResult,
  SkillResource,
  SkillResourceError,
  SkillResourceInfo,
  SkillResourceKind,
  SkillResourcePath,
  SkillResult,
  SkillSource,
  SkillWorkspace,
  WorkspaceSkillSourceOptions
} from "agents/skills";
