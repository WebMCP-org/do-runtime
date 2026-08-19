/**
 * The suite imports `conformance:host`; each lane's vitest config aliases it to
 * that lane's implementation. This declaration is what makes the shared suite
 * typecheck without knowing which lane will run it.
 */
declare module "conformance:host" {
  export const host: import("./host").ConformanceHost;
}
