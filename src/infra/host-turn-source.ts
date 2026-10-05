import { randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { z } from "zod";
import type { ApprovalRequestPolicy } from "./approval-requester-binding.js";
import type {
  ChannelSourceActor,
  ChannelSourceMessage,
  TurnInputOrigin,
  TurnSourceInput,
  TurnSourceProvenance,
} from "./turn-source-provenance.js";

export const MAX_TURN_SOURCE_INPUTS = 128;

export type HostTurnSource = Readonly<{ kind: "host-turn-source" }>;

type SourceFacts = Readonly<{
  inputs: readonly TurnSourceInput[];
  completeness: TurnSourceProvenance["completeness"];
  requireResolverMatch: boolean;
  accounts: readonly Readonly<{ channel: string; accountId: string }>[];
}>;

const sourceEnvelopeSchema = z.object({
  version: z.literal(1),
  completeness: z.enum(["complete", "unavailable"]),
  requireResolverMatch: z.boolean(),
  accounts: z
    .array(z.object({ channel: z.string(), accountId: z.string() }))
    .max(MAX_TURN_SOURCE_INPUTS),
  inputs: z
    .array(
      z.discriminatedUnion("origin", [
        z.object({
          inputId: z.string().min(1),
          origin: z.literal("user"),
          actor: z.object({
            channel: z.string(),
            accountId: z.string(),
            senderId: z.string(),
            actorKind: z.enum(["human", "bot", "app", "unknown"]),
          }),
          message: z.object({
            messageId: z.string(),
            conversationId: z.string(),
            conversationKind: z.enum(["direct", "group", "channel", "unknown"]),
            threadId: z.string().optional(),
            eventKind: z.enum(["message", "reply", "edit", "interaction", "unknown"]),
            edited: z.boolean().optional(),
            teamId: z.string().optional(),
            enterpriseId: z.string().optional(),
          }),
        }),
        z.object({
          inputId: z.string().min(1),
          origin: z.enum(["system", "cross-session", "cron", "heartbeat", "subagent", "unknown"]),
          parentRunId: z.string().optional(),
        }),
      ]),
    )
    .max(MAX_TURN_SOURCE_INPUTS),
});

class TurnSource implements HostTurnSource {
  readonly kind = "host-turn-source";
  #facts: SourceFacts;
  constructor(facts: SourceFacts) {
    this.#facts = Object.freeze({
      ...facts,
      inputs: Object.freeze(
        facts.inputs.map((input) =>
          Object.freeze(
            input.origin === "user"
              ? {
                  ...input,
                  actor: Object.freeze({ ...input.actor }),
                  message: Object.freeze({ ...input.message }),
                }
              : { ...input },
          ),
        ),
      ),
      accounts: Object.freeze(facts.accounts.map((account) => Object.freeze({ ...account }))),
    });
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
  static read(value: HostTurnSource | undefined): SourceFacts | undefined {
    return value && typeof value === "object" && #facts in value ? value.#facts : undefined;
  }
}

/** Called only after the account-owned ingress handoff validates the exact transport event. */
export function createHostChannelTurnSource(params: {
  actor: ChannelSourceActor;
  message?: ChannelSourceMessage;
  policy?: ApprovalRequestPolicy;
}): HostTurnSource {
  const complete = Boolean(params.actor.senderId && params.message?.messageId);
  return new TurnSource({
    inputs: params.message
      ? [{ inputId: randomUUID(), origin: "user", actor: params.actor, message: params.message }]
      : [],
    completeness: complete ? "complete" : "unavailable",
    requireResolverMatch: params.policy?.requireResolverMatch === true,
    accounts: [{ channel: params.actor.channel, accountId: params.actor.accountId }],
  });
}

/** Non-user producers can classify origin; they can never mint a user actor from routing. */
export function createHostNonUserTurnSource(
  origin: Exclude<TurnInputOrigin, "user">,
  parentRunId?: string,
): HostTurnSource {
  return new TurnSource({
    inputs: [{ inputId: randomUUID(), origin, ...(parentRunId ? { parentRunId } : {}) }],
    completeness: origin === "unknown" ? "unavailable" : "complete",
    requireResolverMatch: false,
    accounts: [],
  });
}

export function readHostTurnSource(source: HostTurnSource | undefined): SourceFacts {
  return (
    TurnSource.read(source) ??
    Object.freeze({
      inputs: Object.freeze([]),
      completeness: "unavailable",
      requireResolverMatch: false,
      accounts: Object.freeze([]),
    })
  );
}

/** Canonical facts only; durable bytes never contain a live capability or run authority. */
export function serializeHostTurnSource(source: HostTurnSource | undefined): string | null {
  const facts = TurnSource.read(source);
  return facts ? JSON.stringify({ version: 1, ...facts }) : null;
}

/** Undefined means retained facts are unavailable; a replay never replaces those facts. */
export function matchesHostTurnSourceEnvelope(
  envelope: string | null,
  source: HostTurnSource,
): boolean | undefined {
  const facts = TurnSource.read(source);
  if (!facts) {
    return false;
  }
  if (envelope === null) {
    return undefined;
  }
  const canonicalFacts = (value: SourceFacts) => ({
    completeness: value.completeness,
    accounts: value.accounts,
    inputs: value.inputs.map((input) =>
      input.origin === "user"
        ? { origin: input.origin, actor: input.actor, message: input.message }
        : { origin: input.origin, parentRunId: input.parentRunId },
    ),
  });
  try {
    const stored = sourceEnvelopeSchema.safeParse(JSON.parse(envelope));
    return stored.success
      ? stableStringify(canonicalFacts(stored.data)) === stableStringify(canonicalFacts(facts))
      : undefined;
  } catch {
    return undefined;
  }
}

/** Recovery callers must hold their exact current custody claim before restoring facts. */
export function restoreHostTurnSource(
  envelope: string | null,
  assertCurrent: () => void,
): HostTurnSource {
  assertCurrent();
  if (envelope === null) {
    return latchHostTurnSourcePolicy(undefined, false);
  }
  try {
    const result = sourceEnvelopeSchema.safeParse(JSON.parse(envelope));
    if (result.success) {
      return new TurnSource(result.data);
    }
  } catch {
    // Invalid durable facts cannot establish a human requester or relax a retained restriction.
  }
  return latchHostTurnSourcePolicy(undefined, true);
}

export function latchHostTurnSourcePolicy(
  source: HostTurnSource | undefined,
  strict: boolean,
): HostTurnSource {
  const facts = readHostTurnSource(source);
  return new TurnSource({ ...facts, requireResolverMatch: facts.requireResolverMatch || strict });
}

export function canCombineHostTurnSources(
  sources: readonly (HostTurnSource | undefined)[],
): boolean {
  return (
    new Set(
      sources.flatMap((source) => readHostTurnSource(source).inputs.map(({ inputId }) => inputId)),
    ).size <= MAX_TURN_SOURCE_INPUTS
  );
}

/** Receipt identity deduplicates copies, while edits of one provider message remain distinct. */
export function combineHostTurnSources(
  sources: readonly (HostTurnSource | undefined)[],
  overflow?: "unavailable",
): HostTurnSource {
  const withinBound = canCombineHostTurnSources(sources);
  if (!withinBound && overflow !== "unavailable") {
    throw new Error("turn source collection exceeds the supported input bound");
  }
  const facts = sources.map(readHostTurnSource);
  return new TurnSource({
    // Concurrent descriptive steering may already be exposed before its receipts
    // exceed the bound. Retain bounded facts, but never classify them as complete.
    inputs: [
      ...new Map(
        facts.flatMap(({ inputs }) => inputs).map((input) => [input.inputId, input]),
      ).values(),
    ].slice(0, MAX_TURN_SOURCE_INPUTS),
    completeness:
      withinBound && facts.length > 0 && facts.every((source) => source.completeness === "complete")
        ? "complete"
        : "unavailable",
    requireResolverMatch: facts.some((source) => source.requireResolverMatch),
    accounts: [
      ...new Map(
        facts
          .flatMap(({ accounts }) => accounts)
          .map((account) => [JSON.stringify(account), account]),
      ).values(),
    ],
  });
}

export function projectHostTurnSource(
  source: HostTurnSource | undefined,
  runId: string | null,
  sessionKey: string | null,
  revision = 0,
): TurnSourceProvenance {
  const facts = readHostTurnSource(source);
  return Object.freeze({
    version: 1,
    runId,
    sessionKey,
    revision,
    completeness: facts.completeness,
    inputs: facts.inputs,
  });
}
