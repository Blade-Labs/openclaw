import { isApprovalNotFoundError } from "../../infra/approval-errors.js";
import type { ApprovalWaitDecisionResult } from "../../infra/approval-requester-binding.js";
import { callGatewayTool } from "../tools/gateway.js";
import type { NativeHookRelayRegistration } from "./native-hook-relay-types.js";

export async function waitForNativeHookRelayApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
  timeoutMs: number;
  approvalHost?: NativeHookRelayRegistration["approvalHost"];
}): Promise<Partial<ApprovalWaitDecisionResult> | undefined> {
  const pending = params.approvalHost
    ? params.approvalHost
        .waitForApproval({
          approvalId: params.approvalId,
          timeoutMs: params.timeoutMs,
          transportTimeoutMs: params.timeoutMs + 10_000,
          signal: params.signal,
        })
        .then((result) => (result ? { id: params.approvalId, ...result } : undefined))
    : callGatewayTool<Partial<ApprovalWaitDecisionResult>>(
        "plugin.approval.waitDecision",
        { timeoutMs: params.timeoutMs + 10_000 },
        { id: params.approvalId },
        { signal: params.signal },
      );
  return pending.catch((error: unknown) => {
    if (isApprovalNotFoundError(error)) {
      return undefined;
    }
    throw error;
  });
}
