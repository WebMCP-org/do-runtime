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
});
