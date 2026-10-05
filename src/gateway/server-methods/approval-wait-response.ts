import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import type { OperatorApprovalTerminalReason } from "../operator-approval-store.js";

export type WaitReasonResolver<TPayload> = (
  snapshot: ExecApprovalRecord<TPayload>,
) => OperatorApprovalTerminalReason | null | undefined;

export function buildWaitResponse<TPayload>(
  id: string,
  decision: ExecApprovalDecision | null,
  snapshot: ExecApprovalRecord<TPayload>,
  terminalReason?: OperatorApprovalTerminalReason | null,
) {
  const strict =
    snapshot.authorization?.policy.requireResolverMatch === true ||
    snapshot.requiresRequesterMatch?.() === true;
  const authorization =
    strict && snapshot.authorization && !snapshot.authorization.policy.requireResolverMatch
      ? {
          ...snapshot.authorization,
          policy: {
            requireResolverMatch: true as const,
            delivery: "requester" as const,
            allowedDecisions: ["allow-once", "deny"] as const,
          },
        }
      : snapshot.authorization;
  return {
    id,
    ...(authorization ? { authorization } : {}),
    ...(snapshot.resolvedByActor ? { resolvedByActor: snapshot.resolvedByActor } : {}),
    ...(snapshot.resolvedAtMs !== undefined ? { resolvedAtMs: snapshot.resolvedAtMs } : {}),
    decision: strict && decision !== "allow-once" ? "deny" : decision,
    createdAtMs: snapshot.createdAtMs,
    expiresAtMs: snapshot.expiresAtMs,
    terminalReason: terminalReason ?? snapshot.terminalReason,
  };
}
