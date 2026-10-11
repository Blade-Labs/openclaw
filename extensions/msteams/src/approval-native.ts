import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-client-runtime";
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createNativeApprovalChannelRouteGates,
  createNativeApprovalMessagingTargetResolvers,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ChannelApprovalResolutionRuntimeV2,
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
  isMSTeamsRequesterOnlyRequest,
  normalizeMSTeamsAadObjectId,
  resolveMSTeamsApprovalNoticeRequester,
  resolveMSTeamsApprovalRequester,
  verifyMSTeamsRequesterConversation,
} from "./approval-requester.js";
import { msteamsConfigAdapter, resolveMSTeamsAccount } from "./channel-config.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { getOptionalMSTeamsRuntime } from "./runtime.js";

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

const msTeamsApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "msteams",
  defaultForwardingMode: "session",
  isTransportEnabled: isMSTeamsApprovalTransportEnabled,
  listAccountIds: msteamsConfigAdapter.listAccountIds,
  resolveDefaultAccountId: () => DEFAULT_ACCOUNT_ID,
  normalizeForwardTarget: msTeamsMessagingTargetResolvers.normalizeForwardTarget,
  resolveTurnSourceTarget: msTeamsMessagingTargetResolvers.resolveTurnSourceTarget,
});

export function isMSTeamsNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  // Blocked requests still need a registered personal-chat notice route without approvers.
  if (isMSTeamsRequesterOnlyApprovals(params.cfg)) {
    return isMSTeamsApprovalTransportEnabled(params);
  }
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
  const requester = resolveMSTeamsApprovalRequester(params);
  if (!requester || getMSTeamsApprovalApprovers(params).length === 0) {
    return false;
  }
  // Forwarding policy consumes the admitted route, never mutable session/turn destinations.
  const request = { ...params.request };
  request.request = {
    ...request.request,
    turnSourceChannel: "msteams",
    turnSourceAccountId: DEFAULT_ACCOUNT_ID,
    turnSourceTo: `conversation:${requester.target.conversationId}`,
    turnSourceThreadId: requester.target.threadId,
  };
  return msTeamsApprovalRouteGates.shouldHandleApprovalRequest({
    ...params,
    request,
  });
}

export function shouldHandleMSTeamsNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: MSTeamsApprovalRequest;
}): boolean {
  return isMSTeamsRequesterOnlyRequest(params.cfg, params.request)
    ? isMSTeamsApprovalTransportEnabled(params) && resolveMSTeamsApprovalRequester(params) !== null
    : shouldHandleMSTeamsApprovalRoute(params);
}

export function shouldSuppressLocalMSTeamsExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  // Generic pending prompts do not establish the verified private requester destination.
  if (isMSTeamsRequesterOnlyApprovals(params.cfg) && getExecApprovalReplyMetadata(params.payload)) {
    return true;
  }
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isNativeDeliveryEnabled: isMSTeamsNativeApprovalClientEnabled,
  });
}

type MSTeamsOriginTargetParams = Parameters<
  NonNullable<NonNullable<ChannelApprovalCapability["native"]>["resolveOriginTarget"]>
>[0];

/** Resolve the admitted origin without consulting mutable session routing. */
async function resolveMSTeamsRequesterOriginTarget(params: MSTeamsOriginTargetParams) {
  if (!shouldHandleMSTeamsNativeApprovalRequest(params)) {
    return null;
  }
  const classified = classifyMSTeamsApprovalRequester({
    cfg: params.cfg,
    request: params.request,
  });
  if (!classified.ok) {
    log.info(
      `msteams approvals: withheld the card for ${params.request.id} (${classified.reason})`,
    );
    return null;
  }
  const conversationId = await verifyMSTeamsRequesterConversation({
    requester: classified.requester,
    store: createMSTeamsConversationStoreState(),
  });
  if (!conversationId || !shouldHandleMSTeamsNativeApprovalRequest(params)) {
    log.info(
      `msteams approvals: withheld the card for ${params.request.id} (no verified origin conversation)`,
    );
    return null;
  }
  return {
    to: `conversation:${conversationId}`,
    accountId: DEFAULT_ACCOUNT_ID,
    threadId: classified.requester.target.threadId ?? null,
  };
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

// Native cards stay in the origin conversation; never probe the roster's DMs.
const resolveMSTeamsApproverDmTargets = () => [];

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
  requireMatchingTurnSourceChannel: false,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  resolveOriginTarget: resolveMSTeamsRequesterOriginTarget,
  resolveApproverDmTargets: resolveMSTeamsApproverDmTargets,
  nativeRuntime: msTeamsLazyApprovalNativeRuntime,
});

const msTeamsNativeDelivery = msTeamsNativeApprovalCapability.delivery;
const msTeamsNativeAdapter = msTeamsNativeApprovalCapability.native;

export const msTeamsApprovalCapability: ChannelApprovalCapability = {
  ...msTeamsNativeApprovalCapability,
  resolveRequestPolicy: ({ cfg }) =>
    isMSTeamsRequesterOnlyApprovals(cfg)
      ? {
          requireResolverMatch: true,
          delivery: "requester",
          allowedDecisions: ["allow-once", "deny"],
        }
      : undefined,
  // Core enforces requester equality on the authenticated actor; Teams owns live roster policy.
  authorizeActorAction: (params) => {
    const strict =
      isMSTeamsRequesterOnlyApprovals(params.cfg) ||
      params.authorization?.policy.requireResolverMatch === true;
    const senderId = normalizeMSTeamsAadObjectId(params.senderId);
    if (!senderId || !getMSTeamsApprovalApprovers(params).includes(senderId)) {
      return {
        authorized: false,
        reason: `❌ You are not authorized to approve ${params.approvalKind} requests on Microsoft Teams.`,
      };
    }
    if (strict && params.accountId != null && params.accountId !== DEFAULT_ACCOUNT_ID) {
      return {
        authorized: false,
        reason:
          "Microsoft Teams requester approvals require an explicit approver roster on the default account.",
      };
    }
    if (
      strict &&
      !params.authorization &&
      getOptionalMSTeamsRuntime()?.channel.runtimeContexts?.get<ChannelApprovalResolutionRuntimeV2>(
        {
          channelId: "msteams",
          accountId: DEFAULT_ACCOUNT_ID,
          capability: "approval.gateway",
        },
      )?.version !== 2
    ) {
      return {
        authorized: false,
        reason:
          "Microsoft Teams requester approvals require a matching OpenClaw core version. Upgrade the core and Teams plugin together, then restart the channel.",
      };
    }
    if (
      strict &&
      params.authorization &&
      !classifyMSTeamsApprovalRequester({
        cfg: params.cfg,
        authorization: params.authorization,
      }).ok
    ) {
      return {
        authorized: false,
        reason: "Microsoft Teams requester approvals require a bound conversation source.",
      };
    }
    return msTeamsApprovalAuth.authorizeActorAction?.(params) ?? { authorized: false };
  },
  ...(msTeamsNativeAdapter
    ? {
        native: {
          ...msTeamsNativeAdapter,
          resolveRequesterTarget: resolveMSTeamsRequesterOriginTarget,
          resolveRequesterNoticeTarget: async (params) => {
            if (!isMSTeamsApprovalTransportEnabled(params)) {
              return null;
            }
            const requester = resolveMSTeamsApprovalNoticeRequester(params.request);
            if (!requester) {
              return null;
            }
            const conversationId = await verifyMSTeamsRequesterConversation({
              requester,
              store: createMSTeamsConversationStoreState(),
            });
            return conversationId ? { to: `conversation:${conversationId}`, threadId: null } : null;
          },
        },
      }
    : {}),
  ...(msTeamsNativeDelivery
    ? {
        delivery: {
          ...msTeamsNativeDelivery,
          // Generic forwarding does not prove the requester's origin destination.
          shouldSuppressForwardingFallback: (input) =>
            normalizeOptionalString(input.target.channel)?.toLowerCase() === "msteams",
        },
      }
    : {}),
};
