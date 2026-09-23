/** NO upstream test file: `platform.ts` has no upstream twin. This pins the `Timer` contract. */

import { expect, test } from "vitest";
import { platformTimer } from "./platform";

test("platformTimer resolves a delay and never resolves one whose signal was already aborted", async () => {
  await expect(platformTimer.afterDelay(1)).resolves.toBeUndefined();
  let settled = false;
  void platformTimer.afterDelay(0, AbortSignal.abort()).finally(() => {
    settled = true;
  });
  await platformTimer.afterDelay(10);
  expect(settled).toBe(false);
});
