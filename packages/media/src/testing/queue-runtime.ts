/** Holder for the runtime the test queue consumer should use (set by `createMediaHarness`). Test-only. */
import type { MediaRuntime } from "../runtime.ts";

let current: MediaRuntime | null = null;

export function setQueueRuntime(rt: MediaRuntime | null): void {
  current = rt;
}

export function getQueueRuntime(): MediaRuntime | null {
  return current;
}
