import type { ApprovalWaitDecisionResult } from "../infra/approval-requester-binding.js";
import type { ApprovalScope } from "../infra/approval-scope.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals-core.js";

export const PluginApprovalResolutions = {
  ALLOW_ONCE: "allow-once",
  ALLOW_15M: "allow-15m",
  ALLOW_SESSION: "allow-session",
  ALLOW_ALWAYS: "allow-always",
  DENY: "deny",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
} as const;

export type PluginApprovalResolution =
  (typeof PluginApprovalResolutions)[keyof typeof PluginApprovalResolutions];

/** Host-provided decision evidence; does not prove the tool completed. */
export type PluginApprovalReceipt = Omit<ApprovalWaitDecisionResult, "id" | "authorization"> & {
  approvalId: string;
};

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    scope?: ApprovalScope;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    /**
     * @deprecated Unresolved approvals always deny; retained for plugin API
     * compatibility. The field will be removed after one deprecation release train.
     */
    timeoutBehavior?: "allow" | "deny";
    /** Override timeout text and return the timeout as a blocked tool result. */
    timeoutReason?: string;
    allowedDecisions?: ExecApprovalDecision[];
    /** Policy owns creating and matching grants; the host only carries the chosen decision. */
    grantEligible?: boolean;
    /** Reviewer-safe description of the exact delegation and permitted future changes. */
    grantScopeSummary?: string;
    pluginId?: string;
    onResolution?: (
      decision: PluginApprovalResolution,
      receipt?: PluginApprovalReceipt,
    ) => Promise<void> | void;
  };
};
