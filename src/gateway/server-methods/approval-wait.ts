import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import { ApprovalMutationRefusedError } from "../exec-approval-requester-guard.js";
import {
  sameWorkerSessionTurnClaim,
  serializeWorkerSessionTurnClaim,
} from "../worker-environments/placement-record.js";
import {
  isApprovalRecordVisibleToClient,
  respondUnknownOrExpiredApproval,
} from "./approval-record-lookup.js";
import { buildWaitResponse, type WaitReasonResolver } from "./approval-wait-response.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export async function handleApprovalWaitDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: unknown;
  client?: GatewayClient | null;
  cfg?: OpenClawConfig;
  getCfg?: () => OpenClawConfig;
  context?: Pick<GatewayRequestContext, "validateAgentRuntimeApprovalAuthority">;
  consumeAllowOnce?: unknown;
  validateConsumed?: unknown;
  respond: RespondFn;
  resolveTerminalReason?: WaitReasonResolver<TPayload>;
}): Promise<void> {
  const id = normalizeOptionalString(params.inputId) ?? "";
  if (!id) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
    return;
  }
  const snapshot = await params.manager.getSnapshot(id);
  const consume = params.consumeAllowOnce === true;
  const validateConsumed = params.validateConsumed === true;
  const executionRequest = consume || validateConsumed;
  const identity = params.client?.internal?.agentRuntimeIdentity;
  const authority = snapshot?.agentRuntimeDelegatedAuthority;
  const assertExecutionOwner = () => {
    const currentIdentity = params.client?.internal?.agentRuntimeIdentity;
    const currentAuthority = currentIdentity?.delegatedAuthority;
    if (
      !snapshot ||
      !identity ||
      !authority ||
      snapshot.agentRuntimeDelegatedAuthority !== authority ||
      consume === validateConsumed ||
      params.client?.invalidated ||
      currentIdentity !== identity ||
      !currentAuthority ||
      currentAuthority.kind !== authority.kind ||
      currentAuthority.claimId !== authority.claimId ||
      currentAuthority.lifecycleGeneration !== authority.lifecycleGeneration ||
      currentAuthority.operationalRunInstance.instanceId !==
        authority.operationalRunInstance.instanceId ||
      currentAuthority.operationalRunInstance.runId !== authority.operationalRunInstance.runId ||
      identity.operationalRunInstance.instanceId !== authority.operationalRunInstance.instanceId ||
      identity.operationalRunInstance.runId !== authority.operationalRunInstance.runId ||
      (currentAuthority.kind === "worker" &&
        authority.kind === "worker" &&
        !sameWorkerSessionTurnClaim(currentAuthority.turnClaim, authority.turnClaim)) ||
      params.manager.getLiveSnapshot(id) !== snapshot ||
      params.resolveTerminalReason?.(snapshot) === "run-aborted" ||
      params.context?.validateAgentRuntimeApprovalAuthority?.(identity) !== true
    ) {
      throw new ApprovalMutationRefusedError("approval execution owner is no longer active");
    }
  };
  const visible = (record: ExecApprovalRecord<TPayload>) => {
    if (executionRequest) {
      try {
        assertExecutionOwner();
        return true;
      } catch {
        return false;
      }
    }
    const cfg = params.getCfg?.() ?? params.cfg;
    return (
      !params.client?.invalidated &&
      isApprovalRecordVisibleToClient({
        record,
        client: params.client ?? null,
        ...(cfg ? { cfg } : {}),
      })
    );
  };
  if (!snapshot || !visible(snapshot)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
    );
    return;
  }
  const decisionPromise = params.manager.awaitDecision(id);
  if (!decisionPromise) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
    );
    return;
  }
  const recordedDecision = await decisionPromise;
  const terminalSnapshot = (await params.manager.getSnapshot(id)) ?? snapshot;
  if (!visible(terminalSnapshot)) {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  const decision = params.manager.projectDecisionIfActive(id, recordedDecision);
  if (executionRequest) {
    try {
      assertExecutionOwner();
      if (
        !authority ||
        decision !== "allow-once" ||
        snapshot.decision !== "allow-once" ||
        snapshot.status !== "allowed" ||
        snapshot.terminalReason !== "user"
      ) {
        throw new ApprovalMutationRefusedError("approval execution was not allowed once");
      }
      const consumerId = JSON.stringify([
        authority.kind,
        authority.claimId,
        authority.lifecycleGeneration,
        authority.operationalRunInstance.instanceId,
        authority.operationalRunInstance.runId,
        authority.kind === "worker" ? serializeWorkerSessionTurnClaim(authority.turnClaim) : null,
      ]);
      if (
        validateConsumed
          ? snapshot.consumedDecision !== "allow-once" || snapshot.consumedBy !== consumerId
          : !(await params.manager.consumeAllowOnce(id, consumerId, {
              assertCurrent: assertExecutionOwner,
            }))
      ) {
        throw new ApprovalMutationRefusedError(
          "approval execution has already been consumed or is unavailable",
        );
      }
      assertExecutionOwner();
      if (params.manager.projectDecisionIfActive(id, snapshot.decision) !== "allow-once") {
        throw new ApprovalMutationRefusedError("approval execution authority is no longer active");
      }
      params.respond(
        true,
        { ...buildWaitResponse(id, "allow-once", snapshot), consumed: true },
        undefined,
      );
    } catch {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "approval execution authority is no longer active"),
      );
    }
    return;
  }
  const terminalReason = params.resolveTerminalReason?.(terminalSnapshot);
  params.respond(
    true,
    buildWaitResponse(id, decision, terminalSnapshot, terminalReason),
    undefined,
  );
}
