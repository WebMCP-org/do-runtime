// `.js`: see the import of this file in src/vite.ts.
import type { ActorScopeBindings } from "./global-scope.js";

/**
 * The names `installActorScope` writes. A facet bundle that binds its own scope must bind all
 * of them: a name it leaves out resolves to the root actor's installed global.
 *
 * A module of its own so the Vite plugin reads it without loading the runtime.
 */
export const ACTOR_SCOPE_GLOBALS = Object.freeze([
  "scheduler",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "fetch",
  "crypto",
  "WebSocket",
  "WebSocketPair",
  "WebSocketRequestResponsePair",
  "ReadableStream",
  "TransformStream",
] as const satisfies readonly (keyof ActorScopeBindings)[]);
