/**
 * §1.10 — a facet is a separate actor with its own gates.
 *
 * The re-entrancy row is the one the serialised tail cannot express, and the
 * reason upstream published a facet RPC surface for alternate-runtime adapters.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";

it("§1.10 a facet has its own durable storage", async () => {
  const probe = await host.spawn("facet-storage");
  expect(await probe.call("facetBump")).toEqual([1, 2]);
});

it("§1.10 overlapping facets resume async work in their own contexts", async () => {
  const probe = await host.spawn("facet-async-context");
  expect(await probe.call("facetScopesSurviveOverlappingWaits")).toEqual(["a", "b"]);
});

it("§1.10 facets.abort kills the instance and leaves the storage", async () => {
  const probe = await host.spawn("facet-abort");
  expect(await probe.call("facetSurvivesAbort")).toEqual([1, 2]);
});

/**
 * The same abort, issued before the facet has finished starting — the row above
 * awaits a call on the stub first, so it never reaches that window.
 *
 * This is the AFTERMATH, not the window. Whether an abort arriving mid-start
 * reaches the thing it aborts is a question only a runtime whose placement is a
 * separate component can be asked; upstream's placement resolves a class and an
 * id and starts nothing, so it has no such window to be wrong about. What all
 * three lanes can be asked is what the actor is left with, and this is it: the
 * name is usable again, and the facet behind it counts its own storage from 1.
 */
it("§1.10 a facet aborted before it finished starting leaves a usable name", async () => {
  const probe = await host.spawn("facet-abort-mid-start");
  expect(await probe.call("facetAbortDuringStart")).toEqual({ first: 1, second: 2 });
});

/**
 * Depth 2 of the four §1.10 says a tree may have. Nothing asserted this before,
 * on any lane: the node lane WIRED it — it hands every facet container the
 * root's `FacetTree` — but no row exercised it, because the probe's `Child` had
 * no facets of its own.
 */
it("§1.10 a facet may have facets of its own", async () => {
  const probe = await host.spawn("facet-nesting");
  // The grandchild counts from 1 while the child, bumped once by the same call,
  // counts separately: two facets, two databases, one tree.
  expect(await probe.call("facetNesting")).toEqual([1, 2, 1]);
});

it("§1.10 deleting a facet deletes its descendant storage", async () => {
  const probe = await host.spawn("facet-delete-tree");
  expect(await probe.call("facetDeleteCascades")).toEqual([
    [1, 2, 1],
    [1, 2, 1],
  ]);
});

/**
 * What a facet that never starts does, which nothing asserted before on any
 * lane. Measured on workerd 1.20260722.1 (`@cloudflare/vitest-pool-workers`
 * 0.18.8) before it was written: `facets.get()` returns its stub as usual, the
 * failure arrives at the first call carrying the constructor's own message, and
 * the parent is NOT broken by it. The row below asserts the same of a facet that
 * DID run and then broke; this one is about a facet that never became anything.
 *
 * The cause this runtime met first was storage that could not be opened, which
 * workerd has no way to express. It is the same placement, so this row covers
 * it; naming that cause is the unit lane's job.
 */
it("§1.10 a facet whose start fails reports at the first call, and the parent lives", async () => {
  const probe = await host.spawn("facet-start-fails");
  const result = await probe.call<Record<string, unknown>>("facetStartFails");

  expect(result.got).toBe("object");
  expect(String(result.call)).toContain("conformance: this facet refuses to start");
  // Neither half of the parent noticed: its own storage answers, and a sibling facet starts.
  expect(result.parentStorage).toBe(1);
  expect(result.sibling).toBe(1);
});

/**
 * The other half, and the one an implementation is likeliest to get wrong by
 * caching the failure: a facet that failed to start is not running, so the
 * startup callback runs again on the next `facets.get()` and a working class
 * takes the same name with no intervening `abort()`.
 */
it("§1.10 a facet that failed to start is retried under the same name", async () => {
  const probe = await host.spawn("facet-start-retry");
  const result = await probe.call<Record<string, unknown>>("facetStartRetries");

  expect(String(result.first)).toContain("conformance: this facet refuses to start");
  expect(result.retry).toBe(1);
});

/**
 * The direction breakage travels, which nothing asserted before on any lane —
 * and the one place a divergence can hide is behaviour the oracle is never asked
 * about. Upstream propagates DOWN and only down: `ActorContainer::abort`
 * (`server.c++:2565-2589`) loops `for (auto& facet: facets)`, `monitorOnBroken`
 * (`:2767-2800`) does the same and then erases the broken container from its
 * PARENT's map (`:2794-2798`) without touching the parent. A broken child takes
 * itself and its own subtree; nothing above it notices.
 *
 * This runtime used to escalate — a broken facet aborted its parent — which is a
 * rule the port invented and decision 14 has now withdrawn.
 */
it("§1.10 a facet that breaks on its own leaves the parent and its siblings alive", async () => {
  const probe = await host.spawn("facet-self-break");
  const result = await probe.call<Record<string, unknown>>("facetSelfBreak");

  // Both were running before the break; see the probe for why the breaking call's own outcome is
  // not asserted here.
  expect(result.breakerBefore).toBe(1);
  expect(result.siblingBefore).toBe(1);
  expect(result.grandchildBefore).toBe(1);
  // The parent's own storage answers, and the sibling is the same facet it was.
  expect(result.parentStorage).toBe(1);
  expect(result.siblingAfter).toBe(2);
  // The broken name is reusable at its stable id, while every in-memory descendant was torn down.
  expect(result.breakerAfter).toBe(2);
  expect(result.grandchildAfter).toBe(1);
});

it("§1.10 a facet may call back into a parent that is awaiting it", async () => {
  const probe = await host.spawn("reentry");
  const result = await probe.call<{
    out: unknown;
    trace: string[];
  }>("facetReentrancy");
  expect(result.out).toBe("pong");
  // The parent's own method ran DURING the parent's await on the child.
  expect(result.trace).toEqual(["parent:enter", "parent:ping", "parent:exit"]);
});
