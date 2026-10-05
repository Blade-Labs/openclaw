import type {
  ApprovalDecision,
  ApprovalTerminalReason,
} from "../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ChannelSourceMessage,
  TurnInputOrigin,
  TurnSourceProvenance,
} from "./turn-source-provenance.js";

export type ApprovalRequesterBinding =
  | Readonly<{
      state: "bound";
      inputOrigin: "user";
      channel: string;
      accountId: string;
      senderId: string;
      sessionKey: string;
      runId: string;
      sourceRevision: number;
      sources: readonly ChannelSourceMessage[];
    }>
  | Readonly<{ state: "mixed"; reason: "different-actors" | "mixed-origins" }>
  | Readonly<{ state: "non-user"; origins: readonly Exclude<TurnInputOrigin, "user">[] }>
  | Readonly<{
      state: "unavailable";
      reason:
        | "missing-source"
        | "missing-message-identity"
        | "unverified-actor"
        | "legacy-recovery"
        | "invalid-recovery";
    }>;

export type ApprovalRequestPolicy =
  | Readonly<{ requireResolverMatch: false; delivery: "default" }>
  | Readonly<{
      requireResolverMatch: true;
      delivery: "requester";
      allowedDecisions: readonly ["allow-once", "deny"];
    }>;

export type ApprovalRequestAuthorization = Readonly<{
  version: 1;
  source: TurnSourceProvenance;
  requesterBinding: ApprovalRequesterBinding;
  policy: ApprovalRequestPolicy;
}>;

export type ApprovalResolvingActor =
  | Readonly<{
      kind: "channel";
      channel: string;
      accountId: string;
      senderId: string;
      actorKind: "human" | "bot" | "app" | "unknown";
      messageId?: string;
      interactionId?: string;
    }>
  | Readonly<{
      kind: "operator";
      deviceId?: string;
      profileId?: string;
      connectionId: string;
    }>
  | Readonly<{ kind: "runtime"; clientId: string }>
  | Readonly<{ kind: "system"; reason: string }>;

export type ApprovalWaitDecisionResult = Readonly<{
  id: string;
  decision: ApprovalDecision | null;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  terminalReason?: ApprovalTerminalReason | null;
  resolvedByActor?: ApprovalResolvingActor | null;
  authorization?: ApprovalRequestAuthorization;
}>;

/** Compare authenticated tuples, never display labels or session routing aliases. */
export function classifyApprovalRequester(source: TurnSourceProvenance): ApprovalRequesterBinding {
  const users = source.inputs.filter((input) => input.origin === "user");
  const others = source.inputs.filter((input) => input.origin !== "user");
  const first = users[0];
  if (users.length > 0 && others.length > 0) {
    return Object.freeze({ state: "mixed", reason: "mixed-origins" });
  }
  if (
    first &&
    users.some(
      ({ actor }) =>
        actor.channel !== first.actor.channel ||
        actor.accountId !== first.actor.accountId ||
        actor.senderId !== first.actor.senderId,
    )
  ) {
    return Object.freeze({ state: "mixed", reason: "different-actors" });
  }
  if (source.completeness !== "complete" || source.inputs.length === 0) {
    return Object.freeze({ state: "unavailable", reason: "missing-source" });
  }
  if (!first) {
    if (others.some((input) => input.origin === "unknown")) {
      return Object.freeze({ state: "unavailable", reason: "missing-source" });
    }
    return Object.freeze({
      state: "non-user",
      origins: Object.freeze([...new Set(others.map((input) => input.origin))]),
    });
  }
  if (
    users.some(
      ({ actor }) =>
        actor.actorKind !== "human" || !actor.channel || !actor.accountId || !actor.senderId,
    )
  ) {
    return Object.freeze({ state: "unavailable", reason: "unverified-actor" });
  }
  if (users.some(({ message }) => !message.messageId || !message.conversationId)) {
    return Object.freeze({ state: "unavailable", reason: "missing-message-identity" });
  }
  if (!source.runId || !source.sessionKey) {
    return Object.freeze({ state: "unavailable", reason: "missing-source" });
  }
  return Object.freeze({
    state: "bound",
    inputOrigin: "user",
    channel: first.actor.channel,
    accountId: first.actor.accountId,
    senderId: first.actor.senderId,
    sessionKey: source.sessionKey,
    runId: source.runId,
    sourceRevision: source.revision,
    sources: Object.freeze(users.map(({ message }) => message)),
  });
}
