import { Type, type Static } from "typebox";

const object = <T extends Record<string, import("typebox").TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
const actorKind = Type.Union(
  (["human", "bot", "app", "unknown"] as const).map((kind) => Type.Literal(kind)),
);
const nonUserOrigin = Type.Union(
  (["system", "cross-session", "cron", "heartbeat", "subagent", "unknown"] as const).map((origin) =>
    Type.Literal(origin),
  ),
);
export const ChannelSourceMessageSchema = object({
  messageId: Type.String(),
  conversationId: Type.String(),
  conversationKind: Type.Union(
    (["direct", "group", "channel", "unknown"] as const).map((kind) => Type.Literal(kind)),
  ),
  threadId: Type.Optional(Type.String()),
  eventKind: Type.Union(
    (["message", "reply", "edit", "interaction", "unknown"] as const).map((kind) =>
      Type.Literal(kind),
    ),
  ),
  edited: Type.Optional(Type.Boolean()),
  teamId: Type.Optional(Type.String()),
  enterpriseId: Type.Optional(Type.String()),
});
export const TurnSourceProvenanceSchema = object({
  version: Type.Literal(1),
  runId: Type.Union([Type.String(), Type.Null()]),
  sessionKey: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer({ minimum: 0 }),
  completeness: Type.Union([Type.Literal("complete"), Type.Literal("unavailable")]),
  inputs: Type.Array(
    Type.Union([
      object({
        inputId: Type.String({ minLength: 1 }),
        origin: Type.Literal("user"),
        actor: object({
          channel: Type.String(),
          accountId: Type.String(),
          senderId: Type.String(),
          actorKind,
        }),
        message: ChannelSourceMessageSchema,
      }),
      object({
        inputId: Type.String({ minLength: 1 }),
        origin: nonUserOrigin,
        parentRunId: Type.Optional(Type.String()),
      }),
    ]),
    { maxItems: 128 },
  ),
});
export const ApprovalRequestAuthorizationSchema = object({
  version: Type.Literal(1),
  source: TurnSourceProvenanceSchema,
  requesterBinding: Type.Union([
    object({
      state: Type.Literal("bound"),
      inputOrigin: Type.Literal("user"),
      channel: Type.String(),
      accountId: Type.String(),
      senderId: Type.String(),
      sessionKey: Type.String(),
      runId: Type.String(),
      sourceRevision: Type.Integer({ minimum: 0 }),
      sources: Type.Array(ChannelSourceMessageSchema, { maxItems: 128 }),
    }),
    object({
      state: Type.Literal("mixed"),
      reason: Type.Union([Type.Literal("different-actors"), Type.Literal("mixed-origins")]),
    }),
    object({
      state: Type.Literal("non-user"),
      origins: Type.Array(nonUserOrigin, { maxItems: 128 }),
    }),
    object({
      state: Type.Literal("unavailable"),
      reason: Type.Union(
        (
          [
            "missing-source",
            "missing-message-identity",
            "unverified-actor",
            "legacy-recovery",
            "invalid-recovery",
          ] as const
        ).map((reason) => Type.Literal(reason)),
      ),
    }),
  ]),
  policy: Type.Union([
    object({ requireResolverMatch: Type.Literal(false), delivery: Type.Literal("default") }),
    object({
      requireResolverMatch: Type.Literal(true),
      delivery: Type.Literal("requester"),
      allowedDecisions: Type.Array(
        Type.Union([
          Type.Literal("allow-once"),
          Type.Literal("allow-15m"),
          Type.Literal("allow-session"),
          Type.Literal("allow-always"),
          Type.Literal("deny"),
        ]),
        { minItems: 2, maxItems: 5, uniqueItems: true, contains: Type.Literal("deny") },
      ),
    }),
  ]),
});
export const ApprovalResolvingActorSchema = Type.Union([
  object({
    kind: Type.Literal("channel"),
    channel: Type.String(),
    accountId: Type.String(),
    senderId: Type.String(),
    actorKind,
    messageId: Type.Optional(Type.String()),
    interactionId: Type.Optional(Type.String()),
  }),
  object({
    kind: Type.Literal("operator"),
    connectionId: Type.String(),
    deviceId: Type.Optional(Type.String()),
    profileId: Type.Optional(Type.String()),
  }),
  object({ kind: Type.Literal("runtime"), clientId: Type.String() }),
  object({ kind: Type.Literal("system"), reason: Type.String() }),
]);
export type ApprovalRequestAuthorization = Static<typeof ApprovalRequestAuthorizationSchema>;
export type ApprovalResolvingActor = Static<typeof ApprovalResolvingActorSchema>;
