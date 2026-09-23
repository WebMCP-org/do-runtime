import { describe, expect, it, vi } from "vitest";
import { OffscreenDocumentCoordinator } from "./offscreen-document";

describe("OffscreenDocumentCoordinator", () => {
  it("coalesces concurrent creation", async () => {
    const creation = Promise.withResolvers<void>();
    const create = vi.fn(() => creation.promise);
    const coordinator = new OffscreenDocumentCoordinator({
      close: vi.fn(),
      create,
      exists: vi.fn(async () => false),
      isOccupiedError: vi.fn(() => false),
    });

    const first = coordinator.ensure();
    const second = coordinator.ensure();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    creation.resolve();

    await Promise.all([first, second]);
    expect(create).toHaveBeenCalledOnce();
  });

  it("does nothing when the document already exists", async () => {
    const create = vi.fn();
    const coordinator = new OffscreenDocumentCoordinator({
      close: vi.fn(),
      create,
      exists: vi.fn(async () => true),
      isOccupiedError: vi.fn(() => false),
    });

    await coordinator.ensure();

    expect(create).not.toHaveBeenCalled();
  });

  it("clears one stale document slot and retries creation once", async () => {
    const occupied = new Error("single offscreen document");
    const create = vi.fn().mockRejectedValueOnce(occupied).mockResolvedValueOnce(undefined);
    const close = vi.fn();
    const coordinator = new OffscreenDocumentCoordinator({
      close,
      create,
      exists: vi.fn(async () => false),
      isOccupiedError: (error) => error === occupied,
    });

    await coordinator.ensure();

    expect(close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("propagates a real creation failure without closing anything", async () => {
    const failure = new Error("permission denied");
    const close = vi.fn();
    const coordinator = new OffscreenDocumentCoordinator({
      close,
      create: vi.fn(async () => {
        throw failure;
      }),
      exists: vi.fn(async () => false),
      isOccupiedError: vi.fn(() => false),
    });

    await expect(coordinator.ensure()).rejects.toBe(failure);
    expect(close).not.toHaveBeenCalled();
  });

  it("probes readiness once inside the shared flight", async () => {
    const probe = Promise.withResolvers<void>();
    const ready = vi.fn(() => probe.promise);
    const coordinator = new OffscreenDocumentCoordinator({
      close: vi.fn(),
      create: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      isOccupiedError: vi.fn(() => false),
      ready,
    });
    let settled = false;
    const callers = Promise.all([coordinator.ensure(), coordinator.ensure()]).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    probe.resolve();
    await callers;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("replaces an existing document that never answers, once", async () => {
    const mute = new Error("the document did not answer");
    const calls: string[] = [];
    const coordinator = new OffscreenDocumentCoordinator({
      close: async () => {
        calls.push("close");
      },
      create: async () => {
        calls.push("create");
      },
      exists: async () => true,
      isOccupiedError: () => false,
      ready: async () => {
        calls.push("ready");
        if (calls.length === 1) throw mute;
      },
      replaceUnready: async (error) => {
        calls.push(error === mute ? "replace" : "replace?");
        return true;
      },
    });

    await coordinator.ensure();

    expect(calls).toEqual(["ready", "replace", "close", "create", "ready"]);
  });

  it("propagates a readiness failure after its one replacement", async () => {
    const replacementMute = new Error("the replacement did not answer either");
    const ready = vi
      .fn()
      .mockRejectedValueOnce(new Error("the document did not answer"))
      .mockRejectedValueOnce(replacementMute);
    const replaceUnready = vi.fn(() => true);
    const create = vi.fn(async () => {});
    const coordinator = new OffscreenDocumentCoordinator({
      close: vi.fn(async () => {}),
      create,
      exists: vi.fn(async () => true),
      isOccupiedError: vi.fn(() => false),
      ready,
      replaceUnready,
    });

    await expect(coordinator.ensure()).rejects.toBe(replacementMute);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(replaceUnready).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });

  it("rethrows a readiness failure the host declines to replace", async () => {
    const mute = new Error("the document is still booting");
    const close = vi.fn();
    const create = vi.fn();
    const replaceUnready = vi.fn(async () => false);
    const coordinator = new OffscreenDocumentCoordinator({
      close,
      create,
      exists: vi.fn(async () => true),
      isOccupiedError: vi.fn(() => false),
      ready: vi.fn(async () => {
        throw mute;
      }),
      replaceUnready,
    });

    await expect(coordinator.ensure()).rejects.toBe(mute);
    expect(replaceUnready).toHaveBeenCalledWith(mute);
    expect(close).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
