// Microsoft Teams marks authenticated human personal, group, and channel messages as external user input.
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMSTeamsAadObjectId } from "../approval-requester.js";
import {
  isMSTeamsAuthenticatedActivity,
  isMSTeamsReplayedActivity,
  isMSTeamsSynthesizedInvokeMessage,
  normalizeMSTeamsConversationId,
} from "../inbound.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type MSTeamsInputProvenance = NonNullable<MsgContext["InputProvenance"]>;
type MSTeamsActivity = MSTeamsTurnContext["activity"];

/** Bot Framework's channel id for the Microsoft Teams channel itself. */
const MSTEAMS_BOT_FRAMEWORK_CHANNEL_ID = "msteams";

function isLiveAuthenticatedMSTeamsMessage(activity: MSTeamsActivity): boolean {
  if (
    !isMSTeamsAuthenticatedActivity(activity) ||
    isMSTeamsReplayedActivity(activity) ||
    activity.channelId !== MSTEAMS_BOT_FRAMEWORK_CHANNEL_ID ||
    activity.type !== "message" ||
    isMSTeamsSynthesizedInvokeMessage(activity)
  ) {
    return false;
  }
  const scope = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  if (scope !== "personal" && scope !== "groupchat" && scope !== "channel") {
    return false;
  }
  // Access sees only the last activity of a merged batch; apply its scope fence per activity.
  return !(
    scope === "personal" &&
    (activity.conversation?.isGroup === true ||
      activity.channelData?.team !== undefined ||
      activity.channelData?.channel !== undefined)
  );
}

/** Memory-consumed source classification requires authentication of this exact activity. */
export function resolveMSTeamsActorKind(activity: MSTeamsActivity): "human" | "bot" | "unknown" {
  if (!isLiveAuthenticatedMSTeamsMessage(activity)) {
    return "unknown";
  }
  if (
    activity.from?.role === "bot" ||
    (activity.from?.id && activity.from.id === activity.recipient?.id)
  ) {
    return "bot";
  }
  return normalizeMSTeamsAadObjectId(activity.from?.aadObjectId) ? "human" : "unknown";
}

/**
 * Activity-level facts for one constituent of a turn. Each is transport-owned or a Teams
 * transport assertion the authenticated connector vouches for:
 * - the monitor marked this exact object as delivered by a JWT-enforcing SDK callback (never
 *   set for private QA, the SDK's unauthenticated-request bypass, or journal replays);
 * - the Bot Framework channel is Teams itself, so identity fields are Teams assertions;
 * - a live `message` (not a rewritten card invoke) in an explicit personal/group/channel scope;
 *   personal conversations must have no contradictory group/team/channel marker;
 * - a human Entra sender that is not the bot's own account.
 */
function isMSTeamsExternalUserActivity(activity: MSTeamsActivity): boolean {
  if (resolveMSTeamsActorKind(activity) !== "human") {
    return false;
  }
  const senderId = activity.from?.id;
  return Boolean(senderId) && senderId !== activity.recipient?.id;
}

function principalScopeKey(activity: MSTeamsActivity): string {
  return JSON.stringify([
    normalizeMSTeamsAadObjectId(activity.from?.aadObjectId) ?? null,
    activity.from?.id ?? null,
    activity.recipient?.id ?? null,
    normalizeMSTeamsConversationId(activity.conversation?.id ?? ""),
    normalizeOptionalLowercaseString(activity.conversation?.conversationType) ?? null,
  ]);
}

/**
 * Debounce batches merge several activities into one turn and keep only the last context.
 * The batch is external user input only when every constituent independently qualifies and
 * all share the final activity's principal and conversation.
 */
export function areMSTeamsBatchConstituentsExternalUser(
  activities: readonly MSTeamsActivity[],
): boolean {
  const last = activities.at(-1);
  if (!last) {
    return false;
  }
  const key = principalScopeKey(last);
  return activities.every(
    (activity) => isMSTeamsExternalUserActivity(activity) && principalScopeKey(activity) === key,
  );
}

/**
 * Called after the SDK callback (JWT) and sender admission for this turn. Bots, rewritten
 * card invokes, non-Teams channels, unauthenticated transport, mixed batches and replays
 * stay unmarked. The authenticated actor is always activity.from, never a quoted author.
 * Native Teams Forward has no transport signal here: authentication cannot prove its absence.
 */
export function resolveMSTeamsInboundInputProvenance(params: {
  activity: MSTeamsActivity;
  senderAdmitted: boolean;
  /** False when a debounce batch contained an ineligible or foreign constituent. */
  batchEligible?: boolean;
}): MSTeamsInputProvenance | undefined {
  if (
    params.batchEligible === false ||
    !params.senderAdmitted ||
    !isMSTeamsExternalUserActivity(params.activity)
  ) {
    return undefined;
  }
  return { kind: "external_user", sourceChannel: "msteams" };
}
