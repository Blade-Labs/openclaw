import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-client-runtime";
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalMessagingTargetResolvers,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMSTeamsApprovalApprovers, msTeamsApprovalAuth } from "./approval-auth.js";
import {
  classifyMSTeamsApprovalRequester,
  isMSTeamsRequesterOnlyApprovals,
  resolveMSTeamsApprovalRequester,
  verifyMSTeamsRequesterConversation,
} from "./approval-requester.js";
import { msteamsConfigAdapter, resolveMSTeamsAccount } from "./channel-config.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";

const log = createSubsystemLogger("msteams/approvals");

type MSTeamsApprovalRequest =
  | ExecApprovalRequest
  | PluginApprovalRequest
  | SystemAgentApprovalRequest;

function isMSTeamsApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  if (params.accountId && normalizeAccountId(params.accountId) !== DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const account = resolveMSTeamsAccount(params.cfg);
  return account.enabled && account.configured && account.tokenStatus === "available";
}

const msTeamsMessagingTargetResolvers = createNativeApprovalMessagingTargetResolvers({
  channel: "msteams",
  normalizeTo: normalizeMSTeamsMessagingTarget,
});

const msTeamsApprovalTargetResolvers = {
  ...msTeamsMessagingTargetResolvers,
  resolveTurnSourceTarget: (request: MSTeamsApprovalRequest) => {
    const target = msTeamsMessagingTargetResolvers.resolveTurnSourceTarget(request);
    return target ? { ...target, threadId: request.request.turnSourceThreadId ?? null } : null;
  },
  resolveSessionTarget: (
    sessionTarget: Parameters<typeof msTeamsMessagingTargetResolvers.resolveSessionTarget>[0],
  ) => {
    const target = msTeamsMessagingTargetResolvers.resolveSessionTarget(sessionTarget);
    return target ? { ...target, threadId: sessionTarget.threadId ?? null } : null;
  },
};

const msTeamsApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "msteams",
  defaultForwardingMode: "session",
  isTransportEnabled: isMSTeamsApprovalTransportEnabled,
  listAccountIds: msteamsConfigAdapter.listAccountIds,
  resolveDefaultAccountId: () => DEFAULT_ACCOUNT_ID,
  normalizeForwardTarget: msTeamsApprovalTargetResolvers.normalizeForwardTarget,
  resolveTurnSourceTarget: msTeamsApprovalTargetResolvers.resolveTurnSourceTarget,
});

export function isMSTeamsNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    msTeamsApprovalRouteGates.canAnyApprovalPotentiallyRouteToChannel({
      ...params,
      nativeSessionOnly: true,
    }) && getMSTeamsApprovalApprovers(params).length > 0
  );
}

function shouldHandleMSTeamsApprovalRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: MSTeamsApprovalRequest;
}): boolean {
  return (
    msTeamsApprovalRouteGates.shouldHandleApprovalRequest(params) &&
    getMSTeamsApprovalApprovers(params).length > 0 &&
    Boolean(msTeamsApprovalTargetResolvers.resolveTurnSourceTarget(params.request))
  );
}

export function shouldHandleMSTeamsNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: MSTeamsApprovalRequest;
}): boolean {
  return (
    shouldHandleMSTeamsApprovalRoute(params) &&
    // Requester-only: handle only requests raised by one identifiable user's own 1:1 turn.
    (!isMSTeamsRequesterOnlyApprovals(params.cfg) ||
      resolveMSTeamsApprovalRequester({ cfg: params.cfg, request: params.request }) !== null)
  );
}

export function shouldSuppressLocalMSTeamsExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  // Requester-only: text approval is not a Teams resolution path, so an approval-pending text
  // prompt would only disclose the request; never post it into a Teams chat.
  if (isMSTeamsRequesterOnlyApprovals(params.cfg) && getExecApprovalReplyMetadata(params.payload)) {
    return true;
  }
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isNativeDeliveryEnabled: isMSTeamsNativeApprovalClientEnabled,
  });
}

const resolveMSTeamsTurnSourceOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "msteams",
  shouldHandleRequest: shouldHandleMSTeamsNativeApprovalRequest,
  resolveTurnSourceTarget: msTeamsApprovalTargetResolvers.resolveTurnSourceTarget,
  resolveSessionTarget: msTeamsApprovalTargetResolvers.resolveSessionTarget,
  normalizeTarget: msTeamsApprovalTargetResolvers.normalizeTarget,
});

type MSTeamsOriginTargetParams = Parameters<typeof resolveMSTeamsTurnSourceOriginTarget>[0];

/**
 * Requester-only origin: the requester's own personal chat, proven against the conversation store
 * (explicit personal type and owner AAD id). Never a group/channel or another user's chat.
 */
async function resolveMSTeamsRequesterOriginTarget(params: MSTeamsOriginTargetParams) {
  if (!shouldHandleMSTeamsApprovalRoute(params)) {
    return null;
  }
  const classified = classifyMSTeamsApprovalRequester({
    cfg: params.cfg,
    request: params.request,
  });
  if (!classified.ok) {
    log.info(
      `msteams approvals: requester-only withheld the card for ${params.request.id} (${classified.reason})`,
    );
    return null;
  }
  const conversationId = await verifyMSTeamsRequesterConversation({
    requester: classified.requester,
    store: createMSTeamsConversationStoreState(),
  });
  if (!conversationId) {
    log.info(
      `msteams approvals: requester-only withheld the card for ${params.request.id} (no verified personal chat)`,
    );
    return null;
  }
  return {
    to: `conversation:${conversationId}`,
    accountId: normalizeOptionalString(params.accountId),
    threadId: null,
  };
}

function resolveMSTeamsOriginTarget(params: MSTeamsOriginTargetParams) {
  return isMSTeamsRequesterOnlyApprovals(params.cfg)
    ? resolveMSTeamsRequesterOriginTarget(params)
    : resolveMSTeamsTurnSourceOriginTarget(params);
}

const msTeamsLazyApprovalNativeRuntime = createLazyChannelApprovalNativeRuntimeAdapter({
  capabilityBoundary: true,
  eventKinds: ["exec", "plugin", "system-agent"],
  isConfigured: ({ cfg, accountId }) => isMSTeamsNativeApprovalClientEnabled({ cfg, accountId }),
  shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
    shouldHandleMSTeamsNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  load: async () => {
    const { msTeamsApprovalNativeRuntime } = await import("./approval-handler.runtime.js");
    return msTeamsApprovalNativeRuntime;
  },
});

const resolveMSTeamsAllApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleMSTeamsNativeApprovalRequest,
  resolveApprovers: getMSTeamsApprovalApprovers,
  mapApprover: (approver, params) => ({
    to: `user:${approver}`,
    accountId: normalizeOptionalString(params.accountId),
  }),
});

// Requester-only never fans a card out to the approver roster, not even as a fallback.
const resolveMSTeamsApproverDmTargets: typeof resolveMSTeamsAllApproverDmTargets = (params) =>
  isMSTeamsRequesterOnlyApprovals(params.cfg) ? [] : resolveMSTeamsAllApproverDmTargets(params);

const msTeamsNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "msteams",
  channelLabel: "Microsoft Teams",
  describeExecApprovalSetup: () =>
    "Approve it from the Web UI or terminal UI for now. Microsoft Teams supports native approvals when the bot is configured. Configure `channels.msteams.allowFrom` or `channels.msteams.defaultTo` with Microsoft Entra object ID approvers.",
  listAccountIds: msteamsConfigAdapter.listAccountIds,
  hasApprovers: ({ cfg, accountId }) => getMSTeamsApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    msTeamsApprovalAuth.authorizeActorAction?.({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind: "exec",
    })?.authorized ?? false,
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    msTeamsApprovalAuth.authorizeActorAction?.({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind: "plugin",
    })?.authorized ?? false,
  isNativeDeliveryEnabled: isMSTeamsNativeApprovalClientEnabled,
  resolveNativeDeliveryMode: () => "channel",
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  resolveOriginTarget: resolveMSTeamsOriginTarget,
  resolveApproverDmTargets: resolveMSTeamsApproverDmTargets,
  nativeRuntime: msTeamsLazyApprovalNativeRuntime,
});

const MSTEAMS_REQUESTER_ONLY_DENIAL =
  "❌ Microsoft Teams approvals are requester-only here: use the approval card sent to the person who asked.";

const msTeamsNativeDelivery = msTeamsNativeApprovalCapability.delivery;

export const msTeamsApprovalCapability: ChannelApprovalCapability = {
  ...msTeamsNativeApprovalCapability,
  // Preserve implicit same-chat authorization when no explicit approvers exist.
  // Requester-only: core's actor check carries no approval request, so it cannot tell the
  // requester from any other approver. Deny every Teams identity there; the plugin's own card
  // submit handler enforces requester == clicker and resolves without channel custody.
  authorizeActorAction: (params) =>
    isMSTeamsRequesterOnlyApprovals(params.cfg)
      ? { authorized: false, reason: MSTEAMS_REQUESTER_ONLY_DENIAL }
      : msTeamsApprovalAuth.authorizeActorAction?.(params),
  resolveApproveCommandBehavior: ({ cfg }) =>
    isMSTeamsRequesterOnlyApprovals(cfg)
      ? { kind: "reply", text: MSTEAMS_REQUESTER_ONLY_DENIAL }
      : undefined,
  ...(msTeamsNativeDelivery
    ? {
        delivery: {
          ...msTeamsNativeDelivery,
          // Requester-only: generic text forwarding into any Teams chat would disclose the
          // request to everyone in it, and Teams text approval is disabled; suppress it.
          shouldSuppressForwardingFallback: (input) =>
            isMSTeamsRequesterOnlyApprovals(input.cfg) &&
            normalizeOptionalString(input.target.channel)?.toLowerCase() === "msteams"
              ? true
              : (msTeamsNativeDelivery.shouldSuppressForwardingFallback?.(input) ?? false),
        },
      }
    : {}),
};
