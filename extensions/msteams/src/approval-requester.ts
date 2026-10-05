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
import { normalizeMSTeamsConversationId } from "./inbound.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";

type MSTeamsApprovalRequest =
  | ExecApprovalRequest
  | PluginApprovalRequest
  | SystemAgentApprovalRequest;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bot Framework personal conversation ids use the a: form; shared chats use 19:.
const PERSONAL_CONVERSATION_ID_RE = /^a:[^\s;@]+$/i;

export type MSTeamsApprovalRequester = {
  aadObjectId: string;
  target: { kind: "conversation"; conversationId: string };
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
  const first = binding.sources[0];
  if (
    !first ||
    binding.sources.some(
      (source) =>
        source.conversationKind !== "direct" ||
        !PERSONAL_CONVERSATION_ID_RE.test(source.conversationId),
    )
  ) {
    return { ok: false, reason: "turn-source-target" };
  }
  if (!getMSTeamsApprovalApprovers({ cfg: params.cfg }).includes(aadObjectId)) {
    return { ok: false, reason: "not-an-approver" };
  }
  return {
    ok: true,
    requester: {
      aadObjectId,
      target: { kind: "conversation", conversationId: first.conversationId },
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
    target: { kind: "conversation", conversationId: first.message.conversationId },
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

/** Prefer the admitted personal chat, then only the same sender's verified personal DM. */
export async function verifyMSTeamsRequesterConversation(params: {
  requester: MSTeamsApprovalRequester;
  store: Pick<MSTeamsConversationStore, "get" | "findPreferredDmByUserId">;
}): Promise<string | null> {
  const { requester, store } = params;
  const conversationId = requester.target.conversationId;
  if (isPersonalConversationOwnedBy(await store.get(conversationId), requester.aadObjectId)) {
    return conversationId;
  }
  const entry = await store.findPreferredDmByUserId(requester.aadObjectId);
  return entry &&
    PERSONAL_CONVERSATION_ID_RE.test(entry.conversationId) &&
    isPersonalConversationOwnedBy(entry.reference, requester.aadObjectId)
    ? entry.conversationId
    : null;
}

/** Re-check destination ownership at the send boundary. */
export async function isMSTeamsRequesterDeliveryTarget(params: {
  to: string;
  aadObjectId: string;
  store: Pick<MSTeamsConversationStore, "get">;
}): Promise<boolean> {
  const normalized = normalizeMSTeamsMessagingTarget(params.to);
  if (!normalized?.startsWith("conversation:")) {
    return false;
  }
  const conversationId = normalizeMSTeamsConversationId(normalized.slice("conversation:".length));
  return (
    PERSONAL_CONVERSATION_ID_RE.test(conversationId) &&
    isPersonalConversationOwnedBy(await params.store.get(conversationId), params.aadObjectId)
  );
}
