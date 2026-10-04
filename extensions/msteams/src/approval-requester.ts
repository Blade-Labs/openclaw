// Requester-only approval policy: identifies the single Teams user who triggered an approval and
// proves that a delivery destination is that user's own personal chat with the bot.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, "i");
// Complete direct-peer session grammars (dmScope per-channel-peer, per-account-channel-peer,
// per-peer). Anything else — main, cron, subagent, group, channel, thread-suffixed — does not
// identify exactly one Teams user and is rejected.
const DIRECT_SESSION_KEY_RES = [
  new RegExp(`^agent:[^:]+:msteams:direct:(${UUID_PATTERN})$`, "i"),
  new RegExp(`^agent:[^:]+:msteams:([^:]+):direct:(${UUID_PATTERN})$`, "i"),
  new RegExp(`^agent:[^:]+:direct:(${UUID_PATTERN})$`, "i"),
] as const;
// Bot Framework personal (1:1) conversation ids use the `a:` form; group chats and channels use
// `19:…@thread.*`.
const PERSONAL_CONVERSATION_ID_RE = /^a:[^\s;@]+$/i;

export type MSTeamsApprovalRequesterTarget =
  | { kind: "user"; userId: string }
  | { kind: "conversation"; conversationId: string };

export type MSTeamsApprovalRequester = {
  /** Lower-cased Microsoft Entra object id of the user whose turn raised the approval. */
  aadObjectId: string;
  /** The turn-source destination, still to be proven by the conversation store. */
  target: MSTeamsApprovalRequesterTarget;
};

export type MSTeamsApprovalRequesterRejection =
  | "turn-source-channel"
  | "turn-source-account"
  | "scheduled-job"
  | "identity-links"
  | "session-key"
  | "turn-source-target"
  | "not-a-user-turn"
  | "not-an-approver";

type MSTeamsRequesterTurnRun = {
  sessionKey: string;
  aadObjectId: string;
  expiresAtMs: number;
};

const REQUESTER_TURN_RUN_TTL_MS = 24 * 60 * 60_000;
const REQUESTER_TURN_RUN_MAX = 2_000;
// Shared through globalThis so every loaded copy of this module (bundle chunks, lazy runtime
// imports) sees the same provenance records.
const REQUESTER_TURN_RUNS_KEY = Symbol.for("openclaw.msteams.requesterTurnRuns");

function requesterTurnRuns(): Map<string, MSTeamsRequesterTurnRun> {
  const holder = globalThis as { [REQUESTER_TURN_RUNS_KEY]?: Map<string, MSTeamsRequesterTurnRun> };
  holder[REQUESTER_TURN_RUNS_KEY] ??= new Map();
  return holder[REQUESTER_TURN_RUNS_KEY];
}

/**
 * Records that an agent run was started by an inbound Teams 1:1 message from this user. Approval
 * requests carry their host-derived run id, so this is positive per-turn provenance: runs started
 * by scheduled jobs, heartbeats, subagents or other channels are never recorded and fail closed.
 */
export function recordMSTeamsRequesterTurnRun(params: {
  runId: string;
  sessionKey: string;
  aadObjectId: string;
  nowMs?: number;
}): void {
  const runId = params.runId.trim();
  const aadObjectId = normalizeMSTeamsAadObjectId(params.aadObjectId);
  const sessionKey = normalizeOptionalLowercaseString(params.sessionKey);
  if (!runId || !aadObjectId || !sessionKey) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  const runs = requesterTurnRuns();
  for (const [key, run] of runs) {
    if (run.expiresAtMs <= nowMs) {
      runs.delete(key);
    }
  }
  runs.delete(runId);
  runs.set(runId, { sessionKey, aadObjectId, expiresAtMs: nowMs + REQUESTER_TURN_RUN_TTL_MS });
  while (runs.size > REQUESTER_TURN_RUN_MAX) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    runs.delete(oldest);
  }
}

/** Test helper: forget all recorded Teams user-turn runs. */
export function clearMSTeamsRequesterTurnRuns(): void {
  requesterTurnRuns().clear();
}

function isRecordedRequesterTurnRun(params: {
  runId: unknown;
  sessionKey: string;
  aadObjectId: string;
}): boolean {
  const runId = typeof params.runId === "string" ? params.runId.trim() : "";
  if (!runId) {
    return false;
  }
  const run = requesterTurnRuns().get(runId);
  return Boolean(
    run &&
    run.expiresAtMs > Date.now() &&
    run.aadObjectId === params.aadObjectId &&
    run.sessionKey === normalizeOptionalLowercaseString(params.sessionKey),
  );
}

/** True only when `channels.msteams.approvals.requesterOnly` is exactly `true`. */
export function isMSTeamsRequesterOnlyApprovals(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.channels?.msteams?.approvals?.requesterOnly === true;
}

/** Normalizes an Entra object id; returns undefined for anything that is not a UUID. */
export function normalizeMSTeamsAadObjectId(value: unknown): string | undefined {
  const normalized =
    typeof value === "string" ? normalizeOptionalLowercaseString(value) : undefined;
  return normalized && UUID_RE.test(normalized) ? normalized : undefined;
}

function readRequestField(request: MSTeamsApprovalRequest, field: string): unknown {
  return (request.request as Record<string, unknown>)[field];
}

function parseDirectSessionPeer(sessionKey: unknown): string | undefined {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key) {
    return undefined;
  }
  const [perChannel, perAccount, perPeer] = DIRECT_SESSION_KEY_RES;
  const channelMatch = perChannel.exec(key);
  if (channelMatch) {
    return normalizeMSTeamsAadObjectId(channelMatch[1]);
  }
  const accountMatch = perAccount.exec(key);
  if (accountMatch) {
    return normalizeAccountId(accountMatch[1]) === DEFAULT_ACCOUNT_ID
      ? normalizeMSTeamsAadObjectId(accountMatch[2])
      : undefined;
  }
  const peerMatch = perPeer.exec(key);
  return peerMatch ? normalizeMSTeamsAadObjectId(peerMatch[1]) : undefined;
}

function parseTurnSourceTarget(
  raw: unknown,
  peer: string,
): MSTeamsApprovalRequesterTarget | undefined {
  const normalized = typeof raw === "string" ? normalizeMSTeamsMessagingTarget(raw) : undefined;
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("user:")) {
    const userId = normalizeMSTeamsAadObjectId(normalized.slice("user:".length));
    return userId === peer ? { kind: "user", userId } : undefined;
  }
  const bareUserId = normalizeMSTeamsAadObjectId(normalized);
  if (bareUserId) {
    return bareUserId === peer ? { kind: "user", userId: bareUserId } : undefined;
  }
  const conversationId = normalizeMSTeamsConversationId(
    normalized.startsWith("conversation:") ? normalized.slice("conversation:".length) : normalized,
  );
  return PERSONAL_CONVERSATION_ID_RE.test(conversationId)
    ? { kind: "conversation", conversationId }
    : undefined;
}

/**
 * Identifies the single Teams user whose own 1:1 turn raised the approval, or explains why the
 * request cannot be attributed to exactly one user. Pure and synchronous; destination ownership is
 * proven separately by {@link verifyMSTeamsRequesterConversation}.
 */
export function classifyMSTeamsApprovalRequester(params: {
  cfg: OpenClawConfig;
  request: MSTeamsApprovalRequest;
}):
  | { ok: true; requester: MSTeamsApprovalRequester }
  | { ok: false; reason: MSTeamsApprovalRequesterRejection } {
  const { cfg, request } = params;
  if (normalizeOptionalLowercaseString(request.request.turnSourceChannel) !== "msteams") {
    return { ok: false, reason: "turn-source-channel" };
  }
  const turnSourceAccountId = normalizeOptionalString(request.request.turnSourceAccountId);
  if (turnSourceAccountId && normalizeAccountId(turnSourceAccountId) !== DEFAULT_ACCOUNT_ID) {
    return { ok: false, reason: "turn-source-account" };
  }
  if (
    readRequestField(request, "cronExecutionSource") != null ||
    readRequestField(request, "cronOperationBinding") != null
  ) {
    return { ok: false, reason: "scheduled-job" };
  }
  // Identity links rewrite the direct-session peer to an arbitrary canonical name (which may even
  // be another user's UUID), so the session key would no longer carry the ingress identity.
  const identityLinks = cfg.session?.identityLinks;
  if (identityLinks && Object.keys(identityLinks).length > 0) {
    return { ok: false, reason: "identity-links" };
  }
  const sessionKey = readRequestField(request, "sessionKey");
  const peer = parseDirectSessionPeer(sessionKey);
  if (!peer) {
    return { ok: false, reason: "session-key" };
  }
  const target = parseTurnSourceTarget(request.request.turnSourceTo, peer);
  if (!target) {
    return { ok: false, reason: "turn-source-target" };
  }
  // Positive provenance: the request's host-derived run must have been started by this user's own
  // inbound 1:1 Teams message in this session. A scheduled job bound to the user's direct session
  // runs under a run id that was never recorded and is rejected here.
  if (
    !isRecordedRequesterTurnRun({
      runId: readRequestField(request, "runId"),
      sessionKey: String(sessionKey),
      aadObjectId: peer,
    })
  ) {
    return { ok: false, reason: "not-a-user-turn" };
  }
  // Requester-only narrows the approver set; it never widens it. An empty roster denies.
  if (!getMSTeamsApprovalApprovers({ cfg }).includes(peer)) {
    return { ok: false, reason: "not-an-approver" };
  }
  return { ok: true, requester: { aadObjectId: peer, target } };
}

export function resolveMSTeamsApprovalRequester(params: {
  cfg: OpenClawConfig;
  request: MSTeamsApprovalRequest;
}): MSTeamsApprovalRequester | null {
  const result = classifyMSTeamsApprovalRequester(params);
  return result.ok ? result.requester : null;
}

/** True when the sender is the requester and still an explicitly configured approver. */
export function isMSTeamsApprovalRequesterSender(params: {
  cfg: OpenClawConfig;
  requesterAadObjectId: string | undefined;
  senderId: unknown;
}): boolean {
  const requester = normalizeMSTeamsAadObjectId(params.requesterAadObjectId);
  const sender = normalizeMSTeamsAadObjectId(params.senderId);
  return Boolean(
    requester &&
    sender &&
    sender === requester &&
    getMSTeamsApprovalApprovers({ cfg: params.cfg }).includes(sender),
  );
}

function isPersonalConversationOwnedBy(
  reference: StoredConversationReference | null | undefined,
  aadObjectId: string,
): boolean {
  if (!reference) {
    return false;
  }
  // A missing conversation type is ambiguous (legacy rows); only an explicit personal chat counts.
  if (normalizeOptionalLowercaseString(reference.conversation?.conversationType) !== "personal") {
    return false;
  }
  const owner = normalizeMSTeamsAadObjectId(reference.aadObjectId ?? reference.user?.aadObjectId);
  return owner === aadObjectId;
}

/**
 * Proves the requester's destination: returns the id of a stored personal (1:1) conversation that
 * belongs to the requester, or null when that cannot be shown.
 */
export async function verifyMSTeamsRequesterConversation(params: {
  requester: MSTeamsApprovalRequester;
  store: Pick<MSTeamsConversationStore, "get" | "findPreferredDmByUserId">;
}): Promise<string | null> {
  const { requester, store } = params;
  if (requester.target.kind === "conversation") {
    const conversationId = requester.target.conversationId;
    const reference = await store.get(conversationId);
    return isPersonalConversationOwnedBy(reference, requester.aadObjectId) ? conversationId : null;
  }
  const entry = await store.findPreferredDmByUserId(requester.aadObjectId);
  if (!entry || !PERSONAL_CONVERSATION_ID_RE.test(entry.conversationId)) {
    return null;
  }
  return isPersonalConversationOwnedBy(entry.reference, requester.aadObjectId)
    ? entry.conversationId
    : null;
}

/** Re-checks at the send boundary that a target string is the requester's own personal chat. */
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
  if (!PERSONAL_CONVERSATION_ID_RE.test(conversationId)) {
    return false;
  }
  return isPersonalConversationOwnedBy(await params.store.get(conversationId), params.aadObjectId);
}
