import {
  readSessionPendingInputTurnSource,
  type stageSessionPendingInput,
} from "../config/sessions/session-accessor.pending-inputs.js";
import type { HostTurnSource } from "../infra/host-turn-source.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

export const pendingInputReceipts = new WeakMap<
  UserTurnTranscriptRecorder,
  () => Awaited<ReturnType<typeof stageSessionPendingInput>>
>();
export const turnSources = new WeakMap<UserTurnTranscriptRecorder, HostTurnSource>();

export function bindUserTurnTranscriptTurnSource(
  recorder: UserTurnTranscriptRecorder,
  source: HostTurnSource,
): void {
  if (!turnSources.has(recorder)) {
    turnSources.set(recorder, source);
  }
}

export function readUserTurnTranscriptTurnSource(
  recorder: UserTurnTranscriptRecorder,
): HostTurnSource | undefined {
  const receipt = pendingInputReceipts.get(recorder)?.();
  return receipt ? readSessionPendingInputTurnSource(receipt) : turnSources.get(recorder);
}
