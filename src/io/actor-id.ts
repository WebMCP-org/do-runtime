/**
 * ← workerd `src/workerd/io/actor-id.h` (74 lines, header-only — there is no
 * `actor-id.c++`).
 *
 * `api/actor.h` includes this file directly, and every type in it is named by
 * `api/actor.{h,c++}`: `ActorIdFactory` is `DurableObjectNamespace`'s member,
 * `ActorIdFactory::ActorId` is what a `DurableObjectId` wraps, and
 * `ActorGetMode` / `ActorRoutingMode` / `ActorVersion` are the three parameters
 * `getImpl` computes before handing them to an outgoing factory. Per the
 * package README's rule for a legitimate upstream include crossing a wall, the
 * reference widens to match upstream rather than the declarations being
 * relocated into `api/`.
 *
 * The whole file is ported. What is NOT here is the **implementation** —
 * upstream's is `server/actor-id-impl.{h,c++}`, a keyed SHA-256 construction —
 * because it is `server/`'s and because a faithful port of it needs a
 * synchronous digest, which the browser does not expose (`crypto.subtle` is
 * asynchronous and every method below is synchronous). That is Section 6's
 * problem to solve, and this interface is the seam it fills.
 *
 * Spec: §1.10 in docs/decisions.md.
 */

/**
 * ← `ActorGetMode`. "Behavior mode for getting an actor."
 *
 * A union of the upstream enumerator names rather than a TypeScript `enum`,
 * which is the shape every other discriminant in this package already takes.
 */
export type ActorGetMode = "GET_OR_CREATE" | "GET_EXISTING";

/** ← `ActorRoutingMode`. "Routing mode for actor requests when replicas are available." */
export type ActorRoutingMode = "DEFAULT" | "PRIMARY_ONLY";

/** ← `ActorVersion`. "Version information for an actor. Used to specify cohort." */
export type ActorVersion = {
  readonly cohort?: string;
};

/**
 * ← `ActorIdFactory::ActorId`. "Abstract actor ID."
 *
 * Upstream's comment, kept because it is the reason this is an interface rather
 * than a class: "This is NOT an I/O type. An ActorId created in one IoContext
 * can be used in other IoContexts."
 *
 * `clone()` is dropped: it exists so a `kj::Own<ActorId>` can be copied out of a
 * borrowed reference, and a JS value needs no such thing. Every upstream call
 * site (`DurableObjectId`'s constructor, `cloneId()`, the facet start info) is
 * satisfied by passing the same object.
 */
export interface ActorId {
  /** "Get the string that could be passed to `idFromString()` to recreate this ID." */
  toString(): string;

  /**
   * "If the ActorId was created using `idFromName()`, return a copy of the name
   * that was passed to it. Otherwise, returns null."
   */
  getName(): string | undefined;

  /** "Get the jurisdiction that was used when creating this ID." */
  getJurisdiction(): string | undefined;

  /**
   * "Compare with another ID. This is allowed to assume the other ID was created
   * by some other ActorIdFactory passed to one of the worker's other bindings."
   */
  equals(other: ActorId): boolean;
}

/**
 * ← `ActorIdFactory`. "An abstract class that implements generation of global
 * actor IDs in a particular namespace."
 */
export interface ActorIdFactory {
  newUniqueId(jurisdiction: string | undefined): ActorId;
  idFromName(name: string): ActorId;
  idFromString(str: string): ActorId;
  matchesJurisdiction(id: ActorId): boolean;
  cloneWithJurisdiction(maybeJurisdiction: string | undefined): ActorIdFactory;
}
