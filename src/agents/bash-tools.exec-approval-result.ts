import type { ProcessGatewayAllowlistResult } from "./bash-tools.exec-host-gateway.types.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Retain the latched restriction when command results cross ordinary output paths. */
export function attachExecApprovalAuthorization(
  result: AgentToolResult<ExecToolDetails>,
  approval?: Pick<ProcessGatewayAllowlistResult, "approvalAuthorization" | "approvalRequesterOnly">,
): AgentToolResult<ExecToolDetails> {
  return approval?.approvalAuthorization || approval?.approvalRequesterOnly
    ? {
        ...result,
        details: {
          ...result.details,
          ...(approval.approvalAuthorization
            ? { approvalAuthorization: approval.approvalAuthorization }
            : {}),
          ...(approval.approvalRequesterOnly ? { approvalRequesterOnly: true as const } : {}),
        },
      }
    : result;
}
