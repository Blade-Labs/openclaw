import {
  getLoadedChannelPlugin,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ApprovalRequestAuthorization } from "../infra/approval-requester-binding.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";

/** Current account policy may strengthen a frozen request, but cannot relax its restriction. */
export function requiresApprovalRequesterMatch(
  authorization: ApprovalRequestAuthorization | undefined,
  cfg: OpenClawConfig,
  approvalKind: ChannelApprovalKind,
): boolean {
  if (authorization?.policy.requireResolverMatch) {
    return true;
  }
  return (
    authorization?.source.inputs.some(
      (input) =>
        input.origin === "user" &&
        resolveChannelApprovalCapability(
          getLoadedChannelPlugin(input.actor.channel),
        )?.resolveRequestPolicy?.({ cfg, accountId: input.actor.accountId, approvalKind })
          ?.requireResolverMatch === true,
    ) ?? false
  );
}
