import type { PluginHookHistoryEvidence } from "./hook-types.js";

/** Keep committed order available without certifying a message view or human reset. */
export function invalidateHookHistoryEvidence(
  evidence: PluginHookHistoryEvidence,
): PluginHookHistoryEvidence {
  return {
    ...(evidence.boundary ? { boundary: { seq: evidence.boundary.seq } } : {}),
    complete: false,
    turnsSinceBoundary: evidence.turnsSinceBoundary,
    ...(evidence.currentEntry ? { currentEntry: evidence.currentEntry } : {}),
  };
}
