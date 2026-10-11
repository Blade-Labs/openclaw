import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import {
  buildMSTeamsExpiredApprovalCard,
  buildMSTeamsPendingApprovalCard,
  buildMSTeamsResolvedApprovalCard,
  type MSTeamsApprovalActionToken,
} from "./approval-card.js";
import {
  isMSTeamsNativeApprovalClientEnabled,
  shouldHandleMSTeamsNativeApprovalRequest,
} from "./approval-native.js";
import {
  isMSTeamsRequesterDeliveryTarget,
  isMSTeamsRequesterOnlyRequest,
  resolveMSTeamsApprovalRequester,
} from "./approval-requester.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import { extractMSTeamsConversationMessageId } from "./inbound.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { editAdaptiveCardMSTeams, sendAdaptiveCardMSTeams } from "./send.js";
import { inferMSTeamsTargetChatType } from "./session-route.js";

const log = createSubsystemLogger("msteams/approvals");

type MSTeamsPendingDelivery = ReturnType<typeof buildMSTeamsPendingApprovalCard>;

type MSTeamsPendingEntry = {
  accountId: string;
  conversationId: string;
  activityId: string;
  actionTokens: readonly MSTeamsApprovalActionToken[];
  requesterOnly?: boolean;
};

export const msTeamsApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  MSTeamsPendingDelivery,
  { to: string },
  MSTeamsPendingEntry,
  readonly string[],
  Record<string, unknown>
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: ({ cfg, accountId }) => isMSTeamsNativeApprovalClientEnabled({ cfg, accountId }),
    shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
      shouldHandleMSTeamsNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  },
  presentation: {
    buildPendingPayload: ({ view, nowMs }) => buildMSTeamsPendingApprovalCard({ view, nowMs }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: buildMSTeamsResolvedApprovalCard(view),
    }),
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: buildMSTeamsExpiredApprovalCard(view),
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => {
      const normalizedTarget = normalizeMSTeamsMessagingTarget(plannedTarget.target.to);
      if (!normalizedTarget) {
        throw new Error("Microsoft Teams approval delivery target is missing");
      }
      const threadId = plannedTarget.target.threadId;
      const to =
        threadId != null &&
        inferMSTeamsTargetChatType(normalizedTarget) === "channel" &&
        !extractMSTeamsConversationMessageId(normalizedTarget)
          ? `${normalizedTarget};messageid=${threadId}`
          : normalizedTarget;
      return {
        dedupeKey: buildChannelApprovalNativeTargetKey({
          ...plannedTarget.target,
          to: normalizedTarget,
        }),
        target: { to },
      };
    },
    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload, request }) => {
      const requesterOnly = isMSTeamsRequesterOnlyRequest(cfg, request);
      if (accountId != null && accountId !== DEFAULT_ACCOUNT_ID) {
        return null;
      }
      // Both policies revalidate the exact admitted origin before the send.
      const requester = resolveMSTeamsApprovalRequester({ cfg, request });
      if (
        !requester ||
        !(await isMSTeamsRequesterDeliveryTarget({
          to: preparedTarget.to,
          requester,
          store: createMSTeamsConversationStoreState(),
        })) ||
        !shouldHandleMSTeamsNativeApprovalRequest({ cfg, accountId, request })
      ) {
        log.warn(`msteams approvals: refused delivery of ${request.id} to an unverified target`);
        return null;
      }
      const sent = await sendAdaptiveCardMSTeams({
        cfg,
        to: preparedTarget.to,
        card: pendingPayload.card,
      });
      if (!sent.messageId || sent.messageId === "unknown" || !sent.conversationId) {
        return null;
      }
      return {
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        conversationId: sent.conversationId,
        activityId: sent.messageId,
        actionTokens: pendingPayload.actionTokens,
        ...(requesterOnly ? { requesterOnly: true } : {}),
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await editAdaptiveCardMSTeams({
        cfg,
        to: `conversation:${entry.conversationId}`,
        activityId: entry.activityId,
        card: payload,
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, approvalKind, view, pendingPayload }) => {
      const tokens: string[] = [];
      for (const actionToken of entry.actionTokens) {
        if (
          msTeamsApprovalControls.register({
            token: actionToken.token,
            accountId: entry.accountId,
            approvalId: request.id,
            approvalKind,
            decision: actionToken.decision,
            allowedDecisions: pendingPayload.allowedDecisions,
            conversationId: entry.conversationId,
            activityId: entry.activityId,
            expiresAtMs: view.expiresAtMs,
            ...(entry.requesterOnly ? { requesterOnly: true } : {}),
          })
        ) {
          tokens.push(actionToken.token);
        }
      }
      return tokens.length > 0 ? tokens : null;
    },
    unbindPending: ({ binding }) => msTeamsApprovalControls.unregister(binding),
    cancelDelivered: ({ entry }) =>
      msTeamsApprovalControls.unregister(entry.actionTokens.map(({ token }) => token)),
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`msteams approvals: failed to deliver request ${request.id}: ${String(error)}`);
      // Core owns failed-delivery and private blocked notices, including zero targets.
    },
  },
});
