import type { ApprovalChannelReviewer } from "../../packages/gateway-protocol/src/index.js";
import { readAdmittedChannelApprovalActor } from "../channels/message-access/approval-actor.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import type {
  ApprovalRequestAuthorization,
  ApprovalResolvingActor,
} from "../infra/approval-requester-binding.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { requiresApprovalRequesterMatch } from "./approval-request-policy.js";
import {
  assertApprovalRequesterPolicy,
  ApprovalRequesterPolicyError,
} from "./approval-requester-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

export function readApprovalChannelReviewer(
  client: GatewayClient | null | undefined,
  reviewer?: ApprovalChannelReviewer,
): ApprovalChannelReviewer | undefined {
  const admitted = client?.internal?.approvalActor;
  if (!admitted) {
    return reviewer;
  }
  try {
    const actor = readAdmittedChannelApprovalActor(admitted)?.actor;
    if (!actor) {
      throw new ApprovalRequesterPolicyError("stale");
    }
    return { channel: actor.channel, accountId: actor.accountId, senderId: actor.senderId };
  } catch {
    throw new ApprovalRequesterPolicyError("stale");
  }
}

export function prepareApprovalResolvingActor(params: {
  client: GatewayClient | null | undefined;
  context: GatewayRequestContext;
  approvalKind: ChannelApprovalKind;
  authorization?: ApprovalRequestAuthorization;
  decision: "allow-once" | "allow-15m" | "allow-session" | "allow-always" | "deny";
}): { actor: ApprovalResolvingActor; assertCurrent: () => void } {
  const channel = params.client?.internal?.approvalActor;
  let admitted: ReturnType<typeof readAdmittedChannelApprovalActor>;
  try {
    admitted = channel ? readAdmittedChannelApprovalActor(channel) : undefined;
  } catch {
    throw new ApprovalRequesterPolicyError("stale");
  }
  const actor: ApprovalResolvingActor =
    admitted?.actor ??
    (params.client?.internal?.syntheticClient
      ? { kind: "runtime", clientId: params.client.connect.client.id }
      : {
          kind: "operator",
          connectionId: params.client?.connId ?? "unknown",
          ...(params.client?.connect.device?.id
            ? { deviceId: params.client.connect.device.id }
            : {}),
          ...(params.client?.authenticatedUserProfile
            ? { profileId: params.client.authenticatedUserProfile.profileId }
            : {}),
        });
  const assertCurrent = () => {
    if (params.client?.invalidated) {
      throw new ApprovalRequesterPolicyError("stale");
    }
    try {
      admitted?.assertCurrent();
    } catch {
      throw new ApprovalRequesterPolicyError("stale");
    }
    const strict = requiresApprovalRequesterMatch(
      params.authorization,
      params.context.getRuntimeConfig(),
      params.approvalKind,
    );
    assertApprovalRequesterPolicy(params.authorization, actor, params.decision, strict);
    if (actor.kind === "channel") {
      const authorized = resolveChannelApprovalCapability(
        getLoadedChannelPlugin(actor.channel),
      )?.authorizeActorAction?.({
        cfg: params.context.getRuntimeConfig(),
        accountId: actor.accountId,
        senderId: actor.senderId,
        action: "approve",
        approvalKind: params.approvalKind,
        authorization: params.authorization,
      });
      if (authorized?.authorized !== true) {
        throw new ApprovalRequesterPolicyError("ineligible");
      }
    }
  };
  assertCurrent();
  return { actor: Object.freeze(actor), assertCurrent };
}
