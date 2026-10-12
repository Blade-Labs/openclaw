import { isScopedPluginGrantApproval } from "../infra/plugin-approvals.js";
import { EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS } from "./exec-approval-lifecycle.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
} from "./exec-approval-manager.types.js";
import {
  prepareExecApprovalRequesterGuard,
  ApprovalMutationRefusedError,
} from "./exec-approval-requester-guard.js";
import { prepareExecApprovalRedemptionWindow } from "./exec-approval-results.js";
import {
  consumeOperatorApprovalAllowOnce,
  type OperatorApprovalKind,
} from "./operator-approval-store.js";

/** Redemption uses the manager's retained binding and the store's authoritative one-use CAS. */
export async function consumeExecApprovalOnce<T>(params: {
  record: ExecApprovalRecord<T>;
  consumerId: string;
  kind: OperatorApprovalKind;
  persistence: ExecApprovalManagerOptions<T>["persistence"];
  isCurrent: () => boolean;
  runtimeActive: () => boolean;
  graceAnchorMs: () => number | null;
  closeAuthority: () => Promise<unknown>;
}): Promise<boolean> {
  const { record, persistence } = params;
  const requester = prepareExecApprovalRequesterGuard(
    record,
    params.kind,
    record.resolvedByActor,
    record.decision ?? "deny",
  );
  requester.assertCurrent();
  if (!params.runtimeActive()) {
    await params.closeAuthority();
    return false;
  }
  const nowMs = Date.now();
  const redemptionWindowMs = prepareExecApprovalRedemptionWindow(
    record,
    params.graceAnchorMs(),
    nowMs,
    params.kind,
  );
  if (redemptionWindowMs === null) {
    return false;
  }
  const result = await consumeOperatorApprovalAllowOnce({
    id: record.id,
    nowMs,
    consumerId: params.consumerId,
    requireResolverMatch: requester.requireResolverMatch,
    expectedKind: params.kind,
    runtimeEpoch: persistence.runtimeEpoch,
    redemptionWindowMs,
    databaseOptions: persistence.databaseOptions,
    assertCurrent: () => {
      requester.assertCurrent();
      const graceAnchorMs = params.graceAnchorMs();
      if (
        !params.isCurrent() ||
        !params.runtimeActive() ||
        graceAnchorMs === null ||
        Date.now() - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
      ) {
        throw new ApprovalMutationRefusedError("approval authority is no longer active");
      }
    },
  }).catch((error: unknown) => {
    if (error instanceof ApprovalMutationRefusedError) {
      return null;
    }
    throw error;
  });
  if (!result || result.outcome !== "consumed" || !params.isCurrent()) {
    return false;
  }
  record.consumedDecision = record.decision;
  record.consumedAtMs = result.record.consumedAtMs;
  record.consumedBy = result.record.consumedBy;
  return params.runtimeActive();
}

/** The capability preserves the exact winning record through one-use redemption. */
export function prepareExecApprovalOnceExecution<T>(
  manager: Pick<
    ExecApprovalManager<T>,
    "approvalKind" | "getLiveSnapshot" | "projectDecisionIfActive" | "consumeAllowOnce"
  >,
  recordId: string,
  consumerId: string,
) {
  const record = manager.getLiveSnapshot(recordId);
  let redeemed = false;
  const assertCurrent = () => {
    if (
      !record ||
      (record.decision !== "allow-once" &&
        !(
          manager.approvalKind === "plugin" &&
          isScopedPluginGrantApproval(record.request) &&
          record.decision &&
          record.decision !== "deny"
        )) ||
      record.status !== "allowed" ||
      record.terminalReason !== "user" ||
      manager.getLiveSnapshot(recordId) !== record ||
      manager.projectDecisionIfActive(recordId, record.decision) !== record.decision ||
      (redeemed &&
        (record.consumedDecision !== record.decision || record.consumedBy !== consumerId))
    ) {
      throw new Error("Approval execution authority is no longer active");
    }
  };
  return {
    assertCurrent,
    redeem: async () => {
      assertCurrent();
      if (redeemed || !(await manager.consumeAllowOnce(recordId, consumerId))) {
        throw new Error("Approval allow-once has already been consumed or is unavailable");
      }
      redeemed = true;
      assertCurrent();
    },
  };
}
