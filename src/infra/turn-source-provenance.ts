/** Data-only projections of host-admitted inputs; these facts do not grant run authority. */
export type TurnInputOrigin =
  | "user"
  | "system"
  | "cross-session"
  | "cron"
  | "heartbeat"
  | "subagent"
  | "unknown";

export type ChannelSourceActor = Readonly<{
  channel: string;
  accountId: string;
  senderId: string;
  actorKind: "human" | "bot" | "app" | "unknown";
}>;

export type ChannelSourceMessage = Readonly<{
  messageId: string;
  conversationId: string;
  conversationKind: "direct" | "group" | "channel" | "unknown";
  threadId?: string;
  eventKind: "message" | "reply" | "edit" | "interaction" | "unknown";
  edited?: boolean;
  teamId?: string;
  enterpriseId?: string;
}>;

export type TurnSourceInput =
  | Readonly<{
      inputId: string;
      origin: "user";
      actor: ChannelSourceActor;
      message: ChannelSourceMessage;
    }>
  | Readonly<{
      inputId: string;
      origin: Exclude<TurnInputOrigin, "user">;
      parentRunId?: string;
    }>;

export type TurnSourceProvenance = Readonly<{
  version: 1;
  runId: string | null;
  sessionKey: string | null;
  revision: number;
  completeness: "complete" | "unavailable";
  inputs: readonly TurnSourceInput[];
}>;
