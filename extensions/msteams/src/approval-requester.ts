import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type {
  ApprovalRequestAuthorization,
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMSTeamsApprovalApprovers } from "./approval-auth.js";
import type {
  MSTeamsConversationStore,
  StoredConversationReference,
} from "./conversation-store.js";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { inferMSTeamsTargetChatType } from "./session-route.js";

type MSTeamsApprovalRequest =
  | ExecApprovalRequest
  | PluginApprovalRequest
  | SystemAgentApprovalRequest;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bot Framework personal conversation ids use the a: form; shared chats use 19:.
const PERSONAL_CONVERSATION_ID_RE = /^a:[^\s;@]+$/i;

export type MSTeamsApprovalRequester = {
  aadObjectId: string;
  target: {
    kind: "conversation";
    conversationId: string;
    conversationKind: "direct" | "group" | "channel";
    threadId?: string;
  };
};

export type MSTeamsApprovalRequesterRejection =
  | "not-a-user-turn"
  | "turn-source-channel"
  | "turn-source-account"
  | "unverified-actor"
  | "turn-source-target"
  | "not-an-approver";

export function isMSTeamsRequesterOnlyApprovals(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.channels?.msteams?.approvals?.requesterOnly === true;
}

/** Frozen request policy survives configuration changes. */
export function isMSTeamsRequesterOnlyRequest(
  cfg: OpenClawConfig,
  request: MSTeamsApprovalRequest,
): boolean {
  return (
    isMSTeamsRequesterOnlyApprovals(cfg) ||
    request.request.authorization?.policy.requireResolverMatch === true
  );
}

export function normalizeMSTeamsAadObjectId(value: unknown): string | undefined {
  const normalized =
    typeof value === "string" ? normalizeOptionalLowercaseString(value) : undefined;
  return normalized && UUID_RE.test(normalized) ? normalized : undefined;
}

/** Classify core's immutable binding; routing fields and session aliases carry no authority. */
export function classifyMSTeamsApprovalRequester(
  params: { cfg: OpenClawConfig } & (
    | { request: MSTeamsApprovalRequest }
    | { authorization: ApprovalRequestAuthorization }
  ),
):
  | { ok: true; requester: MSTeamsApprovalRequester }
  | { ok: false; reason: MSTeamsApprovalRequesterRejection } {
  const binding =
    "request" in params
      ? params.request.request.authorization?.requesterBinding
      : params.authorization.requesterBinding;
  if (binding?.state !== "bound" || binding.inputOrigin !== "user") {
    return { ok: false, reason: "not-a-user-turn" };
  }
  if (binding.channel !== "msteams") {
    return { ok: false, reason: "turn-source-channel" };
  }
  if (binding.accountId !== DEFAULT_ACCOUNT_ID) {
    return { ok: false, reason: "turn-source-account" };
  }
  const aadObjectId = normalizeMSTeamsAadObjectId(binding.senderId);
  if (!aadObjectId) {
    return { ok: false, reason: "unverified-actor" };
  }
  const targets = binding.sources.map((source) => {
    const conversationId = normalizeMSTeamsConversationId(source.conversationId);
    const embeddedThreadId = extractMSTeamsConversationMessageId(source.conversationId);
    const kind = source.conversationKind;
    if (kind === "unknown") {
      return null;
    }
    if (
      (kind === "direct"
        ? !PERSONAL_CONVERSATION_ID_RE.test(source.conversationId)
        : inferMSTeamsTargetChatType(conversationId) !== kind) ||
      (embeddedThreadId && source.threadId && embeddedThreadId !== source.threadId) ||
      (kind !== "channel" && (source.threadId || embeddedThreadId)) ||
      (kind === "channel" && !(source.threadId ?? embeddedThreadId ?? source.messageId)?.trim())
    ) {
      return null;
    }
    return {
      kind: "conversation" as const,
      conversationId,
      conversationKind: kind,
      ...(kind === "channel"
        ? { threadId: source.threadId ?? embeddedThreadId ?? source.messageId }
        : {}),
    };
  });
  const first = targets[0];
  if (
    !first ||
    targets.some(
      (target) =>
        !target ||
        target.conversationId !== first.conversationId ||
        target.conversationKind !== first.conversationKind ||
        target.threadId !== first.threadId,
    )
  ) {
    return { ok: false, reason: "turn-source-target" };
  }
  const authorization =
    "request" in params ? params.request.request.authorization : params.authorization;
  if (
    (isMSTeamsRequesterOnlyApprovals(params.cfg) || authorization?.policy.requireResolverMatch) &&
    !getMSTeamsApprovalApprovers({ cfg: params.cfg }).includes(aadObjectId)
  ) {
    return { ok: false, reason: "not-an-approver" };
  }
  return {
    ok: true,
    requester: {
      aadObjectId,
      target: first,
    },
  };
}

export function resolveMSTeamsApprovalRequester(params: {
  cfg: OpenClawConfig;
  request: MSTeamsApprovalRequest;
}): MSTeamsApprovalRequester | null {
  const result = classifyMSTeamsApprovalRequester(params);
  return result.ok ? result.requester : null;
}

/** Notice routing cannot establish requester authority, even for user-plus-system input. */
export function resolveMSTeamsApprovalNoticeRequester(
  request: MSTeamsApprovalRequest,
): MSTeamsApprovalRequester | null {
  const source = request.request.authorization?.source;
  const users = source?.inputs.filter((input) => input.origin === "user") ?? [];
  const first = users[0];
  if (source?.completeness !== "complete" || !first) {
    return null;
  }
  const aadObjectId = normalizeMSTeamsAadObjectId(first.actor.senderId);
  if (
    !aadObjectId ||
    users.some(
      (input) =>
        input.actor.channel !== "msteams" ||
        input.actor.accountId !== DEFAULT_ACCOUNT_ID ||
        input.actor.actorKind !== "human" ||
        input.actor.senderId !== first.actor.senderId ||
        input.message.conversationKind !== "direct" ||
        input.message.conversationId !== first.message.conversationId ||
        !PERSONAL_CONVERSATION_ID_RE.test(input.message.conversationId),
    )
  ) {
    return null;
  }
  return {
    aadObjectId,
    target: {
      kind: "conversation",
      conversationId: first.message.conversationId,
      conversationKind: "direct",
    },
  };
}

function isPersonalConversationOwnedBy(
  reference: StoredConversationReference | null | undefined,
  aadObjectId: string,
): boolean {
  if (
    !reference ||
    normalizeOptionalLowercaseString(reference.conversation?.conversationType) !== "personal"
  ) {
    return false;
  }
  return (
    normalizeMSTeamsAadObjectId(reference.aadObjectId ?? reference.user?.aadObjectId) ===
    aadObjectId
  );
}

function matchesConversationReference(
  reference: StoredConversationReference | null | undefined,
  conversationId: string,
  conversationKind: MSTeamsApprovalRequester["target"]["conversationKind"],
): boolean {
  return Boolean(
    reference?.conversation?.id &&
    normalizeMSTeamsConversationId(reference.conversation.id) === conversationId &&
    normalizeOptionalLowercaseString(reference.conversation.conversationType) ===
      (conversationKind === "direct"
        ? "personal"
        : conversationKind === "group"
          ? "groupchat"
          : "channel"),
  );
}

/**
 * Shared references identify a conversation, not its owner: their user is the last sender.
 * Core's binding proves the requester; only personal references prove destination ownership.
 */
export async function verifyMSTeamsRequesterConversation(params: {
  requester: MSTeamsApprovalRequester;
  store: Pick<MSTeamsConversationStore, "get">;
}): Promise<string | null> {
  const { requester, store } = params;
  const conversationId = requester.target.conversationId;
  const reference = await store.get(conversationId);
  if (reference) {
    return matchesConversationReference(
      reference,
      conversationId,
      requester.target.conversationKind,
    ) &&
      (requester.target.conversationKind !== "direct" ||
        isPersonalConversationOwnedBy(reference, requester.aadObjectId))
      ? conversationId
      : null;
  }
  return null;
}

/** Re-check destination ownership at the send boundary. */
export async function isMSTeamsRequesterDeliveryTarget(params: {
  to: string;
  requester: MSTeamsApprovalRequester;
  store: Pick<MSTeamsConversationStore, "get">;
}): Promise<boolean> {
  const normalized = normalizeMSTeamsMessagingTarget(params.to);
  if (!normalized?.startsWith("conversation:")) {
    return false;
  }
  const conversationId = normalizeMSTeamsConversationId(normalized.slice("conversation:".length));
  const { requester } = params;
  const threadId = extractMSTeamsConversationMessageId(normalized);
  if (
    conversationId !== requester.target.conversationId ||
    threadId !== requester.target.threadId
  ) {
    return false;
  }
  const reference = await params.store.get(conversationId);
  return (
    matchesConversationReference(reference, conversationId, requester.target.conversationKind) &&
    (requester.target.conversationKind !== "direct" ||
      (PERSONAL_CONVERSATION_ID_RE.test(conversationId) &&
        !threadId &&
        isPersonalConversationOwnedBy(reference, requester.aadObjectId)))
  );
}
