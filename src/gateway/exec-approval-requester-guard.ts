import { getRuntimeConfig } from "../config/config.js";
import type { ApprovalResolvingActor } from "../infra/approval-requester-binding.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { requiresApprovalRequesterMatch } from "./approval-request-policy.js";
import {
  assertApprovalRequesterPolicy,
  ApprovalRequesterPolicyError,
  isApprovalRequesterPolicyError,
} from "./approval-requester-policy.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.types.js";
export class ApprovalMutationRefusedError extends Error {}

/** Durable verdicts do not substitute for live source and resolver authority. */
export function projectExecApprovalRequesterDecision<T>(params: {
  record: ExecApprovalRecord<T> | undefined;
  kind: ChannelApprovalKind;
  decision: ExecApprovalDecision | null;
  retained: boolean;
  runtimeActive: () => boolean;
  closeAuthority: () => void;
}): ExecApprovalDecision | null {
  const { record, decision } = params;
  const guard = prepareExecApprovalRequesterGuard(
    record,
    params.kind,
    record?.resolvedByActor,
    decision ?? "deny",
  );
  if (decision !== "allow-once" && decision !== "allow-always") {
    return decision ?? (guard.requireResolverMatch ? "deny" : null);
  }
  if (!params.retained || !record) {
    return guard.requireResolverMatch ? "deny" : null;
  }
  try {
    guard.assertCurrent();
    if (params.runtimeActive()) {
      return decision;
    }
  } catch (error) {
    if (isApprovalRequesterPolicyError(error) || error instanceof ApprovalMutationRefusedError) {
      return "deny";
    }
    throw error;
  }
  params.closeAuthority();
  return guard.requireResolverMatch ? "deny" : null;
}

/** Retains the local source owner and rechecks current policy at the commit boundary. */
export function prepareExecApprovalRequesterGuard<T>(
  record: ExecApprovalRecord<T> | undefined,
  kind: ChannelApprovalKind,
  actor: ApprovalResolvingActor | null | undefined,
  decision: ExecApprovalDecision,
) {
  const required = () =>
    record?.requiresRequesterMatch?.() === true ||
    requiresApprovalRequesterMatch(record?.authorization, getRuntimeConfig(), kind);
  const assertPolicy = () =>
    assertApprovalRequesterPolicy(record?.authorization, actor, decision, required());
  return {
    get requireResolverMatch() {
      return required();
    },
    assertPolicy,
    assertCurrent: (assertResolverCurrent?: () => void) => {
      try {
        assertResolverCurrent?.();
        record?.assertResolverCurrent?.();
        assertPolicy();
        record?.assertRequesterCurrent?.();
      } catch (error) {
        if (isApprovalRequesterPolicyError(error)) {
          throw error;
        }
        if (required()) {
          throw new ApprovalRequesterPolicyError("stale");
        }
        throw new ApprovalMutationRefusedError("approval resolver authority is no longer active", {
          cause: error,
        });
      }
    },
  };
}

/** Requester and delegated run authority must both remain live at use time. */
export function isExecApprovalRuntimeAuthorityActive<T>(
  record: ExecApprovalRecord<T>,
  validateDelegatedAuthority: import("./exec-approval-manager.types.js").ExecApprovalManagerOptions<T>["validateAgentRuntimeDelegatedAuthority"],
): boolean {
  const delegated = record.agentRuntimeDelegatedAuthority;
  if (
    (delegated && validateDelegatedAuthority?.(delegated) !== true) ||
    record.approvalSignals?.some((signal) => signal.aborted)
  ) {
    return false;
  }
  try {
    record.assertRequesterCurrent?.();
    return record.approvalAuthority?.() !== false;
  } catch {
    return false;
  }
}
