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
  isMSTeamsRequesterOnlyApprovals,
  resolveMSTeamsApprovalRequester,
} from "./approval-requester.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import { extractMSTeamsConversationMessageId } from "./inbound.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { editAdaptiveCardMSTeams, sendAdaptiveCardMSTeams, sendMessageMSTeams } from "./send.js";
import { inferMSTeamsTargetChatType } from "./session-route.js";

const log = createSubsystemLogger("msteams/approvals");

type MSTeamsPendingDelivery = ReturnType<typeof buildMSTeamsPendingApprovalCard>;

type MSTeamsPendingEntry = {
  accountId: string;
  conversationId: string;
  activityId: string;
  actionTokens: readonly MSTeamsApprovalActionToken[];
  /** Requester-only: the only Entra object id allowed to act on this card. */
  requesterAadObjectId?: string;
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
      let requesterAadObjectId: string | undefined;
      if (isMSTeamsRequesterOnlyApprovals(cfg)) {
        // Send boundary: deliver only into the requester's own, store-verified personal chat.
        const requester = resolveMSTeamsApprovalRequester({ cfg, request });
        if (
          !requester ||
          !(await isMSTeamsRequesterDeliveryTarget({
            to: preparedTarget.to,
            aadObjectId: requester.aadObjectId,
            store: createMSTeamsConversationStoreState(),
          }))
        ) {
          log.warn(
            `msteams approvals: requester-only refused delivery of ${request.id} to an unverified target`,
          );
          return null;
        }
        requesterAadObjectId = requester.aadObjectId;
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
        ...(requesterAadObjectId ? { requesterAadObjectId } : {}),
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await editAdaptiveCardMSTeams({
        cfg,
        to: entry.conversationId,
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
            ...(entry.requesterAadObjectId
              ? { requesterAadObjectId: entry.requesterAadObjectId }
              : {}),
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
    onDeliveryError: ({ cfg, error, plannedTarget, request, approvalKind, pendingPayload }) => {
      log.error(`msteams approvals: failed to deliver request ${request.id}: ${String(error)}`);
      // The active native route suppressed the local text prompt, so a failed
      // card send must still surface a visible approval path (#130040 tracks
      // the shared-boundary fix); losing both prompts is a silent failure.
      const decisions = pendingPayload.allowedDecisions.join("|");
      if (isMSTeamsRequesterOnlyApprovals(cfg)) {
        // Requester-only disables Teams text approval, so do not advertise /approve, and only
        // notify a destination that is still provably the requester's own personal chat.
        void (async () => {
          const requester = resolveMSTeamsApprovalRequester({ cfg, request });
          if (
            !requester ||
            !(await isMSTeamsRequesterDeliveryTarget({
              to: plannedTarget.target.to,
              aadObjectId: requester.aadObjectId,
              store: createMSTeamsConversationStoreState(),
            }))
          ) {
            log.warn(
              `msteams approvals: requester-only skipped the fallback notice for ${request.id}`,
            );
            return;
          }
          await sendMessageMSTeams({
            cfg,
            to: plannedTarget.target.to,
            text: `⚠️ Could not deliver the ${approvalKind} approval card for ${request.id}. It has not been approved; ask again or have an operator resolve it.`,
          });
        })().catch((fallbackError: unknown) => {
          log.error(
            `msteams approvals: fallback notice for ${request.id} failed: ${String(fallbackError)}`,
          );
        });
        return;
      }
      void sendMessageMSTeams({
        cfg,
        to: plannedTarget.target.to,
        text: `⚠️ Could not deliver the ${approvalKind} approval card for ${request.id}. Reply "/approve ${request.id} <${decisions}>" to resolve it.`,
      }).catch((fallbackError: unknown) => {
        log.error(
          `msteams approvals: fallback prompt for ${request.id} also failed: ${String(fallbackError)}`,
        );
      });
    },
  },
});
