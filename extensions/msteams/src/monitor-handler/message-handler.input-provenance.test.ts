// Microsoft Teams marks only authenticated human personal-chat messages as external user input.
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { markMSTeamsAuthenticatedActivity, markMSTeamsReplayedActivity } from "../inbound.js";
import { type MSTeamsActivityHandler, registerMSTeamsHandlers } from "../monitor-handler.js";
import { createActivityHandler } from "../monitor-handler.test-helpers.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();
const SENDER_AAD_ID = "40a1a0ed-4ff2-4164-a219-55518990c197";
const PERSONAL_CHAT = "a:1personal-chat";

type Activity = MSTeamsTurnContext["activity"];

function lifecycle(): MSTeamsIngressLifecycle {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: async () => {},
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: async () => {},
  };
}

function context(activity: Activity): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

function personalActivity(
  overrides: Record<string, unknown> = {},
  options: { authenticated?: boolean } = {},
): Activity {
  const activity = buildChannelActivity({
    id: "activity-1",
    text: "remember that I prefer tea",
    channelId: "msteams",
    from: { id: "29:sender", aadObjectId: SENDER_AAD_ID, name: "Sender" },
    conversation: { id: PERSONAL_CHAT, conversationType: "personal" },
    channelData: {},
    entities: [],
    ...overrides,
  }) as Activity;
  // Mirrors the monitor's live, JWT-enforced SDK callback; the journal replay path never marks.
  if (options.authenticated !== false) {
    markMSTeamsAuthenticatedActivity(activity);
  }
  return activity;
}

function createConfig(): OpenClawConfig {
  return {
    session: { dmScope: "per-channel-peer" },
    channels: {
      msteams: {
        dmPolicy: "allowlist",
        allowFrom: [SENDER_AAD_ID],
        groupPolicy: "open",
        requireMention: false,
      },
    },
  } as OpenClawConfig;
}

type DispatchedCtx = {
  InputProvenance?: unknown;
  ChatType?: string;
  SenderId?: string;
  BodyForAgent?: string;
};

function dispatchedContexts(): DispatchedCtx[] {
  return runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock.calls.map(
    (call) => (call[0] as { ctx?: DispatchedCtx } | undefined)?.ctx ?? {},
  );
}

async function dispatchMessage(activity: Activity, cfg = createConfig()) {
  const { deps } = createMessageHandlerDeps(cfg);
  const handler = createMSTeamsMessageHandler(deps);
  await handler(context(activity), lifecycle());
  return dispatchedContexts();
}

describe("Microsoft Teams inbound input provenance", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("marks an authenticated human personal message as external user input", async () => {
    const [ctx] = await dispatchMessage(personalActivity());
    expect(ctx).toMatchObject({ ChatType: "direct", SenderId: SENDER_AAD_ID });
    expect(ctx?.InputProvenance).toEqual({ kind: "external_user", sourceChannel: "msteams" });
  });

  it.each([
    { label: "group chat", id: "19:group@thread.v2", type: "groupChat", chatType: "group" },
    { label: "channel", id: "19:channel@thread.tacv2", type: "channel", chatType: "channel" },
  ])("leaves a $label message without provenance", async ({ id, type, chatType }) => {
    const contexts = await dispatchMessage(
      personalActivity({
        conversation: { id, conversationType: type },
        ...(type === "channel" ? { channelData: { team: { id: "team-1" } } } : {}),
      }),
    );
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.ChatType).toBe(chatType);
    expect(contexts[0]?.InputProvenance).toBeUndefined();
  });

  it("leaves a bot-originated personal message without provenance", async () => {
    const contexts = await dispatchMessage(
      personalActivity({
        from: { id: "28:other-bot", aadObjectId: SENDER_AAD_ID, name: "Bot", role: "bot" },
      }),
    );
    for (const ctx of contexts) {
      expect(ctx.InputProvenance).toBeUndefined();
    }
  });

  it("leaves a personal message from the bot's own account without provenance", async () => {
    const contexts = await dispatchMessage(
      personalActivity({
        from: { id: "bot-id", aadObjectId: SENDER_AAD_ID, name: "Bot" },
      }),
    );
    for (const ctx of contexts) {
      expect(ctx.InputProvenance).toBeUndefined();
    }
  });

  it("leaves a sender without a verified Entra object id without provenance", async () => {
    const contexts = await dispatchMessage(
      personalActivity({ from: { id: "29:sender", aadObjectId: "not-a-uuid", name: "Sender" } }),
      {
        ...createConfig(),
        channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
      } as OpenClawConfig,
    );
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.InputProvenance).toBeUndefined();
  });

  it("does not mint an admission for a durable-ingress replay of a stored activity", async () => {
    // Replays rebuild a transport context from the raw journal row after a restart; the
    // original JWT is not re-verified, so the turn must not claim authenticated origin.
    const activity = personalActivity();
    markMSTeamsReplayedActivity(activity);
    const contexts = await dispatchMessage(activity);
    for (const ctx of contexts) {
      expect(ctx.InputProvenance).toBeUndefined();
    }
  });

  it("does not mark an adaptive card invoke rewritten as message text", async () => {
    const { deps } = createMessageHandlerDeps(createConfig());
    const registered = registerMSTeamsHandlers(
      createActivityHandler(),
      deps,
    ) as MSTeamsActivityHandler & { run: NonNullable<MSTeamsActivityHandler["run"]> };
    await registered.run(
      context(
        personalActivity({
          id: "invoke-1",
          type: "invoke",
          name: "adaptiveCard/action",
          text: undefined,
          value: { action: { type: "Action.Submit", data: { intent: "remember" } } },
        }),
      ),
    );
    const contexts = dispatchedContexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.InputProvenance).toBeUndefined();
  });

  it.each(["conversationUpdate", "event", "invoke", "messageUpdate", "messageReaction"])(
    "does not mark a %s activity even if it reaches the message handler",
    async (type) => {
      // monitor.ts routes only `message` activities here; the provenance gate still checks
      // the activity type itself so a routing change cannot widen the admission.
      const contexts = await dispatchMessage(
        personalActivity({ type, ...(type === "invoke" ? { name: "task/fetch" } : {}) }),
      );
      for (const ctx of contexts) {
        expect(ctx.InputProvenance).toBeUndefined();
      }
    },
  );

  it("withholds provenance when the activity lacks the transport authentication fact", async () => {
    // JWT bypass (private QA skipAuth or DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS) never
    // marks the activity, even though every identity field below is otherwise eligible.
    const contexts = await dispatchMessage(personalActivity({}, { authenticated: false }));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.ChatType).toBe("direct");
    expect(contexts[0]?.InputProvenance).toBeUndefined();
  });

  it.each([{ channelId: "directline" }, { channelId: "webchat" }, { channelId: undefined }])(
    "withholds provenance for a non-Teams Bot Framework channel ($channelId)",
    async ({ channelId }) => {
      const contexts = await dispatchMessage(personalActivity({ channelId }));
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.InputProvenance).toBeUndefined();
    },
  );

  it("marks a human message-form card submission in personal chat", async () => {
    // Message-form Action.Submit / imBack arrive as ordinary authenticated user messages; only
    // invoke-form actions are excluded. The payload stays untrusted data, not authorization.
    const [ctx] = await dispatchMessage(
      personalActivity({ text: undefined, value: { choice: "tea" } }),
    );
    expect(ctx?.InputProvenance).toEqual({ kind: "external_user", sourceChannel: "msteams" });
  });

  describe("debounced batches", () => {
    // The real debouncer with a window that never elapses in the test: each batch is released
    // by flushing its key and awaiting the debouncer's drain, so no timer or polling decides it.
    const BATCH_KEY = `msteams:test-app:${PERSONAL_CHAT}:${SENDER_AAD_ID}`;
    let debouncers: Array<ReturnType<typeof createInboundDebouncer>> = [];
    const batchingDebounce = {
      createInboundDebouncer: ((options: Parameters<typeof createInboundDebouncer>[0]) => {
        const debouncer = createInboundDebouncer(options);
        debouncers.push(debouncer);
        return debouncer;
      }) as typeof createInboundDebouncer,
      resolveInboundDebounceMs: () => 60_000,
    } as Parameters<typeof createMessageHandlerDeps>[1];

    beforeEach(() => {
      debouncers = [];
    });

    async function flushBatch() {
      expect(debouncers).toHaveLength(1);
      const [debouncer] = debouncers;
      expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      await debouncer?.flushKey(BATCH_KEY);
      await debouncer?.drain();
      return dispatchedContexts();
    }

    async function dispatchBatch(first: Activity, last: Activity) {
      const { deps } = createMessageHandlerDeps(createConfig(), batchingDebounce);
      const handler = createMSTeamsMessageHandler(deps);
      await handler(context(first), lifecycle());
      await handler(context(last), lifecycle());
      return await flushBatch();
    }

    function batchActivity(
      id: string,
      text: string,
      overrides: Record<string, unknown> = {},
      options: { authenticated?: boolean } = {},
    ) {
      return personalActivity({ id, text, ...overrides }, options);
    }

    it("marks a batch whose every constituent is eligible", async () => {
      const contexts = await dispatchBatch(
        batchActivity("a-1", "one"),
        batchActivity("a-2", "two"),
      );
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ BodyForAgent: expect.stringContaining("one\ntwo") });
      expect(contexts[0]?.InputProvenance).toEqual({
        kind: "external_user",
        sourceChannel: "msteams",
      });
    });

    it("withholds provenance when an earlier constituent is a journal replay", async () => {
      const replayed = batchActivity("r-1", "replayed");
      markMSTeamsReplayedActivity(replayed);
      const contexts = await dispatchBatch(replayed, batchActivity("r-2", "live"));
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        BodyForAgent: expect.stringContaining("replayed\nlive"),
      });
      expect(contexts[0]?.InputProvenance).toBeUndefined();
    });

    it("withholds provenance when an earlier constituent is unauthenticated", async () => {
      const contexts = await dispatchBatch(
        batchActivity("u-1", "bypassed", {}, { authenticated: false }),
        batchActivity("u-2", "live"),
      );
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.InputProvenance).toBeUndefined();
    });

    it("withholds provenance when an earlier constituent is a non-Teams channel", async () => {
      const contexts = await dispatchBatch(
        batchActivity("c-1", "directline", { channelId: "directline" }),
        batchActivity("c-2", "live"),
      );
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.InputProvenance).toBeUndefined();
    });

    it("withholds provenance when constituents carry different sender account ids", async () => {
      // Same Entra object id shares a debounce key, but a different Bot Framework account id
      // is a different transport principal; do not let the last one vouch for the first.
      const contexts = await dispatchBatch(
        batchActivity("p-1", "other account", {
          from: { id: "29:other-account", aadObjectId: SENDER_AAD_ID, name: "Sender" },
        }),
        batchActivity("p-2", "live"),
      );
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.InputProvenance).toBeUndefined();
    });

    it("withholds provenance when an earlier constituent is a rewritten card invoke", async () => {
      const { deps } = createMessageHandlerDeps(createConfig(), batchingDebounce);
      let onMessage: Parameters<MSTeamsActivityHandler["onMessage"]>[0] | undefined;
      const handler: MSTeamsActivityHandler & {
        run: NonNullable<MSTeamsActivityHandler["run"]>;
      } = {
        ...createActivityHandler(),
        onMessage: (callback) => {
          onMessage = callback;
          return handler;
        },
      };
      const registered = registerMSTeamsHandlers(handler, deps);
      await registered.run!(
        context(
          personalActivity({
            id: "i-1",
            type: "invoke",
            name: "adaptiveCard/action",
            text: undefined,
            value: { action: { type: "Action.Submit", data: { intent: "remember" } } },
          }),
        ),
        lifecycle(),
      );
      await onMessage?.(context(batchActivity("i-2", "live")), async () => {}, lifecycle());
      const contexts = await flushBatch();
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ BodyForAgent: expect.stringContaining("live") });
      expect(contexts[0]?.BodyForAgent).toContain("remember");
      expect(contexts[0]?.InputProvenance).toBeUndefined();
    });

    it.each([
      {
        label: "conversation.isGroup",
        overrides: {
          conversation: { id: PERSONAL_CHAT, conversationType: "personal", isGroup: true },
        },
      },
      { label: "channelData.team", overrides: { channelData: { team: { id: "team-1" } } } },
      { label: "channelData.channel", overrides: { channelData: { channel: { id: "19:c" } } } },
    ])(
      "withholds provenance when an earlier constituent carries a conflicting $label scope",
      async ({ overrides }) => {
        // Admission drops this activity alone (conflicting conversation scope) but only judges
        // the last activity of a merged batch, so the batch check must apply it per constituent.
        const contexts = await dispatchBatch(
          batchActivity("s-1", "conflicting", overrides),
          batchActivity("s-2", "live"),
        );
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toMatchObject({
          BodyForAgent: expect.stringContaining("conflicting\nlive"),
        });
        expect(contexts[0]?.InputProvenance).toBeUndefined();
      },
    );

    it.each([
      {
        label: "conversation.isGroup",
        overrides: {
          conversation: { id: PERSONAL_CHAT, conversationType: "personal", isGroup: true },
        },
      },
      { label: "channelData.team", overrides: { channelData: { team: { id: "team-1" } } } },
      { label: "channelData.channel", overrides: { channelData: { channel: { id: "19:c" } } } },
    ])(
      "admission drops a lone personal activity with a conflicting $label scope",
      async ({ overrides }) => {
        const contexts = await dispatchMessage(personalActivity(overrides));
        expect(contexts).toHaveLength(0);
      },
    );
  });
});
