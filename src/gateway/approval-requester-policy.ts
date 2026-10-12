import type { ApprovalDecision } from "../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ApprovalRequestAuthorization,
  ApprovalResolvingActor,
} from "../infra/approval-requester-binding.js";

export class ApprovalRequesterPolicyError extends Error {
  readonly code = "APPROVAL_REQUESTER_UNAVAILABLE";
  constructor(readonly reason: "missing" | "mixed" | "non-user" | "ineligible" | "stale") {
    super(`Approval requester unavailable: ${reason}`);
    this.name = "ApprovalRequesterPolicyError";
  }
}

/** Shared by transport adapters, the manager guard and the authoritative worker row. */
export function assertApprovalRequesterPolicy(
  authorization: ApprovalRequestAuthorization | undefined,
  actor: ApprovalResolvingActor | null | undefined,
  decision: ApprovalDecision,
  requireResolverMatch = false,
): void {
  if (!authorization?.policy.requireResolverMatch && !requireResolverMatch) {
    return;
  }
  const binding = authorization?.requesterBinding;
  if (!binding) {
    throw new ApprovalRequesterPolicyError("missing");
  }
  if (binding.state !== "bound") {
    throw new ApprovalRequesterPolicyError(
      binding.state === "unavailable" ? "missing" : binding.state,
    );
  }
  if (
    (decision !== "allow-once" &&
      decision !== "deny" &&
      !authorization?.policy.requireResolverMatch) ||
    (authorization?.policy.requireResolverMatch &&
      !authorization.policy.allowedDecisions.includes(decision)) ||
    actor?.kind !== "channel" ||
    actor.actorKind !== "human" ||
    actor.channel !== binding.channel ||
    actor.accountId !== binding.accountId ||
    actor.senderId !== binding.senderId
  ) {
    throw new ApprovalRequesterPolicyError("ineligible");
  }
}

/** Worker error transport retains the code even when the local class identity is lost. */
export function isApprovalRequesterPolicyError(
  error: unknown,
): error is Error & { code: "APPROVAL_REQUESTER_UNAVAILABLE"; reason?: string } {
  return (
    error instanceof Error && "code" in error && error.code === "APPROVAL_REQUESTER_UNAVAILABLE"
  );
}
