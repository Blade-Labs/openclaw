import type { ApprovalRequestAuthorization } from "../../infra/approval-requester-binding.js";
import { PluginApprovalResolutions } from "../../plugins/types.js";
import { prepareNativeApprovalExecution } from "../approval-execution.js";
import { callGatewayTool } from "../tools/gateway.js";
import { formatNativeHookRelayApprovalPresentation } from "./native-hook-relay-approval-presentation.js";
import { waitForNativeHookRelayApprovalDecision } from "./native-hook-relay-approval-wait.js";
import type {
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalResult,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

export async function requestNativeHookRelayPermissionApproval(
  request: NativeHookRelayPermissionApprovalRequest,
  approvalHost?: NativeHookRelayRegistration["approvalHost"],
): Promise<NativeHookRelayPermissionApprovalResult> {
  const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;
  const approvalRequest = {
    ...formatNativeHookRelayApprovalPresentation(request),
    severity: "warning" as const,
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    allowedDecisions: approvalHost?.requiresRequesterMatch?.()
      ? [PluginApprovalResolutions.ALLOW_ONCE, PluginApprovalResolutions.DENY]
      : [
          PluginApprovalResolutions.ALLOW_ONCE,
          PluginApprovalResolutions.ALLOW_ALWAYS,
          PluginApprovalResolutions.DENY,
        ],
    timeoutMs,
  };
  const requestResult = approvalHost
    ? await approvalHost.requestApproval({
        ...approvalRequest,
        transportTimeoutMs: timeoutMs + 10_000,
        signal: request.signal,
      })
    : await callGatewayTool<{
        id?: string;
        decision?: string | null;
        authorization?: ApprovalRequestAuthorization;
      }>(
        "plugin.approval.request",
        { timeoutMs: timeoutMs + 10_000 },
        {
          ...approvalRequest,
          pluginId: `openclaw-native-hook-relay-${request.provider}`,
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          twoPhase: true,
        },
        { expectFinal: false, signal: request.signal },
      );
  request.signal?.throwIfAborted();
  const approvalId = requestResult?.id;
  let strict =
    approvalHost?.requiresRequesterMatch?.() === true ||
    requestResult?.authorization?.policy.requireResolverMatch === true;
  if (!approvalId) {
    return strict ? "deny" : "defer";
  }
  let decision: string | null | undefined;
  let authorization = requestResult?.authorization;
  if (Object.hasOwn(requestResult ?? {}, "decision")) {
    decision = requestResult.decision;
  } else {
    const waitResult = await waitForNativeHookRelayApprovalDecision({
      approvalId,
      signal: request.signal,
      timeoutMs,
      approvalHost,
    });
    strict ||= waitResult?.authorization?.policy.requireResolverMatch === true;
    authorization = waitResult?.authorization ?? authorization;
    // Bind the verdict to the request that parked this call. A stale or
    // misrouted reply must never release a different tool gate.
    if (!waitResult || waitResult.id !== approvalId) {
      return strict ? "deny" : "defer";
    }
    decision = waitResult.decision;
  }
  if (decision === PluginApprovalResolutions.ALLOW_ONCE) {
    return {
      decision: "allow",
      execution: await prepareNativeApprovalExecution(approvalHost?.requestApproval, {
        id: approvalId,
        kind: "plugin",
        authorization,
        requireRequesterMatch: strict,
        consumeAllowOnce: true,
      }),
    };
  }
  if (strict) {
    return "deny";
  }
  if (decision === PluginApprovalResolutions.ALLOW_ALWAYS) {
    return "allow-always";
  }
  if (decision === PluginApprovalResolutions.DENY) {
    return "deny";
  }
  return decision == null ? "timed-out" : "defer";
}
