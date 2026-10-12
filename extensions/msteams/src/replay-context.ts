// Microsoft Teams plugin reconstructs transport context for durable ingress replay.
import type { MSTeamsSdkCloudOptions } from "./cloud.js";
import {
  extractMSTeamsConversationMessageId,
  markMSTeamsAuthenticatedActivity,
  markMSTeamsReplayedActivity,
  normalizeMSTeamsConversationId,
} from "./inbound.js";
import {
  deleteMSTeamsActivityWithReference,
  sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference,
} from "./sdk-proactive.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";

export function createMSTeamsReplayContext(
  activity: MSTeamsTurnContext["activity"],
  app: MSTeamsApp,
  serviceUrlBoundary: MSTeamsSdkCloudOptions,
): MSTeamsTurnContext {
  markMSTeamsReplayedActivity(activity);
  const rawConversationId = activity.conversation?.id ?? "";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const conversationType = activity.conversation?.conversationType ?? "personal";
  const normalizedConversationType = conversationType.toLowerCase();
  const threadActivityId =
    normalizedConversationType === "channel"
      ? (extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId)
      : undefined;
  const quoteActivityId =
    normalizedConversationType === "channel" || normalizedConversationType === "groupchat"
      ? activity.id
      : undefined;
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId;
  const reference = {
    activityId: activity.id,
    user: activity.from,
    agent: activity.recipient,
    conversation: {
      id: conversationId,
      conversationType,
      ...(tenantId ? { tenantId } : {}),
    },
    channelId: activity.channelId,
    serviceUrl: activity.serviceUrl,
    locale: activity.locale,
    ...(tenantId ? { tenantId } : {}),
    ...(activity.from?.aadObjectId ? { aadObjectId: activity.from.aadObjectId } : {}),
  };
  const proactiveOptions = {
    ...(quoteActivityId ? { quoteActivityId } : {}),
    ...(threadActivityId ? { threadActivityId } : {}),
    serviceUrlBoundary,
  };
  const sendActivity: MSTeamsTurnContext["sendActivity"] = (outbound) =>
    sendMSTeamsActivityWithReference(app, reference, outbound, proactiveOptions);
  return {
    activity,
    sendActivity,
    sendActivities: async (activities) => {
      const results: unknown[] = [];
      for (const outbound of activities) {
        results.push(await sendActivity(outbound));
      }
      return results;
    },
    updateActivity: async (outbound) => {
      const result = await updateMSTeamsActivityWithReference(
        app,
        reference,
        typeof outbound.id === "string" ? outbound.id : "",
        outbound,
        proactiveOptions,
      );
      // SAFETY: the SDK update result exposes only the optional activity id used by this adapter.
      return result as { id?: string } | void;
    },
    deleteActivity: async (activityId) => {
      await deleteMSTeamsActivityWithReference(app, reference, activityId, proactiveOptions);
    },
    getTeamDetails: (teamId) => app.api.teams.getById(teamId),
  };
}

/**
 * Pick the transport surface for a drained ingress row. The journaled activity is always the
 * payload; a live context only exists when an SDK callback accepted the request. The activity is
 * marked as authenticated transport input only when that App enforces Bot Framework JWT
 * validation and the ingress owner proved the stored bytes are the ones that callback carried.
 * Replays, and live contexts bound by id to an older retained row, are never marked.
 */
export function resolveMSTeamsIngressDispatchContext(params: {
  activity: MSTeamsTurnContext["activity"];
  liveContext?: MSTeamsTurnContext;
  /** From the ingress owner: the claimed row holds exactly the bytes this callback accepted. */
  payloadMatchesLiveCallback: boolean;
  app: MSTeamsApp;
  jwtEnforced: boolean;
  serviceUrlBoundary: MSTeamsSdkCloudOptions;
}): MSTeamsTurnContext {
  const { activity, liveContext } = params;
  if (!liveContext) {
    return createMSTeamsReplayContext(activity, params.app, params.serviceUrlBoundary);
  }
  // A duplicate delivery's context must not swap in its own (possibly mutated) activity object.
  liveContext.activity = activity;
  if (params.jwtEnforced && params.payloadMatchesLiveCallback) {
    markMSTeamsAuthenticatedActivity(activity);
  }
  return liveContext;
}
