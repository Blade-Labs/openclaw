import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  ChannelApprovalResolutionRuntimeV2,
  ExecApprovalDecision,
} from "openclaw/plugin-sdk/approval-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import { maybeHandleMSTeamsApprovalCardSubmit } from "./approval-card-submit.js";
import { markMSTeamsReplayedActivity } from "./inbound.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const editAdaptiveCardMSTeams = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ editAdaptiveCardMSTeams }));

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());
const accountRuntime = vi.hoisted(() => ({
  current: undefined as ChannelApprovalResolutionRuntimeV2 | undefined,
}));
const resolveWithActor = vi.fn<ChannelApprovalResolutionRuntimeV2["resolve"]>();
const admitInteractionActor = vi.fn<ChannelApprovalResolutionRuntimeV2["admitInteractionActor"]>();

vi.mock("./runtime.js", () => ({
  getOptionalMSTeamsRuntime: () => ({
    channel: { runtimeContexts: { get: () => accountRuntime.current } },
  }),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));

const APPROVER_ID = "11111111-2222-4333-8444-555555555555";
const UNAUTHORIZED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONVERSATION_ID = "a:approval-chat";
const ACTIVITY_ID = "card-activity";
const testTokens = new Set<string>();

function createResolution(params: {
  approvalId: string;
  approvalKind?: ChannelApprovalKind;
  decision?: ExecApprovalDecision;
  applied?: boolean;
}): ApprovalResolveResult {
  const decision = params.decision ?? "allow-once";
  const common = {
    id: params.approvalId,
    urlPath: `/approve/${params.approvalId}`,
    createdAtMs: 1,
    expiresAtMs: 10_000,
    resolvedAtMs: 2,
    reason: "user" as const,
    presentation:
      params.approvalKind === "plugin"
        ? {
            kind: "plugin" as const,
            title: "Plugin request",
            description: "Allow the plugin action.",
            severity: "info" as const,
            allowedDecisions: ["allow-once" as const, "deny" as const],
          }
        : {
            kind: "exec" as const,
            commandText: "echo approved",
            commandPreview: null,
            allowedDecisions: ["allow-once" as const, "deny" as const],
          },
  };
  return decision === "deny"
    ? {
        applied: params.applied ?? true,
        approval: { ...common, status: "denied", decision: "deny" },
      }
    : {
        applied: params.applied ?? true,
        approval: { ...common, status: "allowed", decision },
      };
}

function createDeps(): MSTeamsMessageHandlerDeps {
  return createMSTeamsMessageHandlerDeps({
    cfg: { channels: { msteams: { allowFrom: [APPROVER_ID] } } },
  });
}

function createContext(params: {
  token?: string;
  senderId?: string;
  conversationId?: string;
  conversationType?: string;
  replyToId?: string;
  nested?: boolean;
  value?: unknown;
}): MSTeamsTurnContext {
  const approvalValue = {
    openclawAction: "approval",
    ...(params.token ? { token: params.token } : {}),
  };
  return {
    activity: {
      type: "message",
      id: "authenticated-click",
      from: { aadObjectId: params.senderId ?? APPROVER_ID },
      conversation: {
        id: params.conversationId ?? CONVERSATION_ID,
        conversationType: params.conversationType ?? "personal",
      },
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      value:
        params.value ??
        (params.nested
          ? { action: { type: "Action.Submit", data: approvalValue } }
          : approvalValue),
    },
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => undefined),
    updateActivity: vi.fn(async () => ({ id: ACTIVITY_ID })),
    deleteActivity: vi.fn(async () => undefined),
  };
}

function registerBinding(params: {
  token: string;
  accountId?: string;
  approvalKind?: ChannelApprovalKind;
  decision?: ExecApprovalDecision;
  allowedDecisions?: readonly ExecApprovalDecision[];
  conversationId?: string;
  requesterOnly?: boolean;
  approvalId?: string;
}): void {
  testTokens.add(params.token);
  msTeamsApprovalControls.register({
    token: params.token,
    accountId: params.accountId ?? "default",
    approvalId: params.approvalId ?? `approval-${params.token}`,
    approvalKind: params.approvalKind ?? "exec",
    decision: params.decision ?? "allow-once",
    allowedDecisions: params.allowedDecisions ?? ["allow-once", "deny"],
    conversationId: params.conversationId ?? CONVERSATION_ID,
    activityId: ACTIVITY_ID,
    expiresAtMs: Date.now() + 60_000,
    ...(params.requesterOnly ? { requesterOnly: true } : {}),
  });
}

describe("maybeHandleMSTeamsApprovalCardSubmit", () => {
  beforeEach(() => {
    editAdaptiveCardMSTeams.mockReset().mockResolvedValue({ conversationId: CONVERSATION_ID });
    accountRuntime.current = undefined;
    resolveApprovalOverGateway
      .mockReset()
      .mockImplementation(
        (params: {
          approvalId: string;
          approvalKind: ChannelApprovalKind;
          decision: ExecApprovalDecision;
        }) => Promise.resolve(createResolution(params)),
      );
  });

  afterEach(() => {
    msTeamsApprovalControls.unregister(Array.from(testTokens));
    testTokens.clear();
  });

  it("leaves unrelated Adaptive Card submits available to normal message dispatch", async () => {
    const context = createContext({ value: { intent: "deploy", environment: "prod" } });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context, deps: createDeps() }),
    ).resolves.toBe(false);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", token: undefined },
    { label: "unknown", token: "unknown-token" },
  ])("consumes approval submits with a $label token", async ({ token }) => {
    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token }),
        deps: createDeps(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "account",
      binding: { accountId: "another-account" },
      context: {},
    },
    {
      label: "conversation",
      binding: {},
      context: { conversationId: "19:another-conversation" },
    },
    {
      label: "activity",
      binding: {},
      context: { replyToId: "another-activity" },
    },
    {
      label: "decision",
      binding: { decision: "allow-always" as const },
      context: {},
    },
  ])("rejects a mismatched $label without consuming the token", async (scenario) => {
    const token = `mismatch-${scenario.label}`;
    registerBinding({ token, ...scenario.binding });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token, ...scenario.context }),
        deps: createDeps(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(msTeamsApprovalControls.get(token)).not.toBeNull();
  });

  it("requires an allowlisted AAD identity and preserves tokens for the authorized approver", async () => {
    const token = "authorization";
    registerBinding({ token, approvalKind: "plugin", decision: "deny" });
    const deps = createDeps();

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token, senderId: UNAUTHORIZED_ID }),
        deps,
      }),
    ).resolves.toBe(true);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

    const authorizedContext = createContext({ token, nested: true });
    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: authorizedContext, deps }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: deps.cfg,
      approvalId: `approval-${token}`,
      approvalKind: "plugin",
      decision: "deny",
      channel: "msteams",
      accountId: "default",
      senderId: APPROVER_ID,
    });
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg: deps.cfg,
      to: `conversation:${CONVERSATION_ID}`,
      activityId: ACTIVITY_ID,
      card: expect.objectContaining({ type: "AdaptiveCard" }),
    });
    expect(JSON.stringify(editAdaptiveCardMSTeams.mock.calls[0])).toContain("Denied");
    expect(msTeamsApprovalControls.get(token)).toBeNull();
  });

  it("normalizes Teams conversation message suffixes before matching their card", async () => {
    const token = "normalized-conversation";
    registerBinding({ token });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({
          token,
          conversationId: `${CONVERSATION_ID};messageid=thread-root`,
        }),
        deps: createDeps(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({ to: `conversation:${CONVERSATION_ID}`, activityId: ACTIVITY_ID }),
    );
  });

  it("allows only one gateway resolution while simultaneous clicks are in flight", async () => {
    const token = "in-flight";
    registerBinding({ token });
    const deferred = createDeferred<ApprovalResolveResult>();
    resolveApprovalOverGateway.mockReturnValueOnce(deferred.promise);
    const deps = createDeps();
    const first = maybeHandleMSTeamsApprovalCardSubmit({
      context: createContext({ token }),
      deps,
    });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).resolves.toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);

    deferred.resolve(createResolution({ approvalId: `approval-${token}` }));
    await expect(first).resolves.toBe(true);
  });

  it("releases the token after a recoverable gateway failure", async () => {
    const token = "gateway-retry";
    registerBinding({ token });
    resolveApprovalOverGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    const deps = createDeps();

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).rejects.toThrow("gateway unavailable");
    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
  });

  it("consumes the resolved token even when the terminal card edit fails", async () => {
    const token = "update-failed";
    registerBinding({ token });
    resolveApprovalOverGateway.mockResolvedValue(
      createResolution({ approvalId: `approval-${token}`, decision: "deny", applied: false }),
    );
    editAdaptiveCardMSTeams.mockRejectedValueOnce(new Error("update failed"));
    const deps = createDeps();

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).resolves.toBe(true);
    expect(msTeamsApprovalControls.get(token)).toBeNull();
    expect(deps.log.error).toHaveBeenCalledWith(
      "msteams approval resolved; display update failed",
      expect.objectContaining({ approvalId: `approval-${token}`, status: "denied" }),
    );
    const cardJson = JSON.stringify(editAdaptiveCardMSTeams.mock.calls[0]?.[0]);
    expect(cardJson).toContain("Exec Approval: Denied");
    expect(cardJson).toContain("Already resolved");

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({ context: createContext({ token }), deps }),
    ).resolves.toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledTimes(1);
  });

  it("retires permanently missing approvals and ignores subsequent clicks", async () => {
    const token = "not-found";
    registerBinding({ token });
    resolveApprovalOverGateway.mockRejectedValueOnce(
      Object.assign(new Error("approval no longer exists"), {
        gatewayCode: "APPROVAL_NOT_FOUND",
      }),
    );
    const deps = createDeps();
    const context = createContext({ token });

    await expect(maybeHandleMSTeamsApprovalCardSubmit({ context, deps })).resolves.toBe(true);
    expect(msTeamsApprovalControls.get(token)).toBeNull();
    expect(editAdaptiveCardMSTeams).not.toHaveBeenCalled();

    await expect(maybeHandleMSTeamsApprovalCardSubmit({ context, deps })).resolves.toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
  });
});

describe("maybeHandleMSTeamsApprovalCardSubmit with requester-only approvals", () => {
  const REQUESTER_ID = APPROVER_ID;
  const COLLEAGUE_ID = "99999999-2222-4333-8444-555555555555";

  function createRequesterOnlyDeps(requesterOnly = true): MSTeamsMessageHandlerDeps {
    return createMSTeamsMessageHandlerDeps({
      cfg: {
        channels: {
          msteams: {
            allowFrom: [REQUESTER_ID, COLLEAGUE_ID],
            approvals: { requesterOnly },
          },
        },
      },
    });
  }

  beforeEach(() => {
    editAdaptiveCardMSTeams.mockReset().mockResolvedValue({ conversationId: CONVERSATION_ID });
    resolveApprovalOverGateway.mockReset();
    const actor: ReturnType<ChannelApprovalResolutionRuntimeV2["admitInteractionActor"]> = {
      kind: "admitted-channel-actor",
    };
    admitInteractionActor.mockReset().mockReturnValue(actor);
    resolveWithActor.mockReset().mockImplementation(async (request) =>
      createResolution({
        approvalId: request.id,
        approvalKind: request.kind,
        decision: request.decision,
      }),
    );
    accountRuntime.current = { version: 2, admitInteractionActor, resolve: resolveWithActor };
  });

  afterEach(() => {
    accountRuntime.current = undefined;
    msTeamsApprovalControls.unregister(Array.from(testTokens));
    testTokens.clear();
  });

  it.each(["bot", "replay"] as const)(
    "preserves option-off %s resolution without admitting a human actor",
    async (source) => {
      const token = `default-${source}`;
      registerBinding({ token });
      const context = createContext({ token });
      if (source === "bot") {
        context.activity.from = { aadObjectId: REQUESTER_ID, role: "bot" };
      } else {
        markMSTeamsReplayedActivity(context.activity);
      }

      await maybeHandleMSTeamsApprovalCardSubmit({
        context,
        deps: createRequesterOnlyDeps(false),
      });

      expect(admitInteractionActor).toHaveBeenCalledWith({
        senderId: REQUESTER_ID,
        actorKind: source === "bot" ? "bot" : "unknown",
        interactionId: "authenticated-click",
      });
      expect(resolveWithActor).toHaveBeenCalledTimes(1);
      expect(editAdaptiveCardMSTeams).toHaveBeenCalledTimes(1);
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    },
  );

  it.each(["bot", "replay", "missing-id"] as const)(
    "preserves requester-only tokens for an unauthenticated %s click",
    async (source) => {
      const token = `strict-${source}`;
      registerBinding({ token, requesterOnly: true });
      const context = createContext({ token });
      if (source === "bot") {
        context.activity.from = { aadObjectId: REQUESTER_ID, role: "bot" };
      } else if (source === "replay") {
        markMSTeamsReplayedActivity(context.activity);
      } else {
        context.activity.id = undefined;
      }

      await maybeHandleMSTeamsApprovalCardSubmit({
        context,
        deps: createRequesterOnlyDeps(),
      });

      expect(resolveWithActor).not.toHaveBeenCalled();
      expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
      expect(editAdaptiveCardMSTeams).not.toHaveBeenCalled();
      expect(msTeamsApprovalControls.get(token)).not.toBeNull();
    },
  );

  it.each([
    {
      approvalKind: "exec" as const,
      conversationId: CONVERSATION_ID,
      conversationType: "personal",
    },
    {
      approvalKind: "plugin" as const,
      conversationId: "19:channel@thread.tacv2",
      conversationType: "channel",
    },
    {
      approvalKind: "system-agent" as const,
      conversationId: "19:group@thread.v2",
      conversationType: "groupChat",
    },
  ])(
    "rejects another approver's $approvalKind click in $conversationType without consuming the requester's card",
    async ({ approvalKind, conversationId, conversationType }) => {
      const token = `requester-only-${approvalKind}`;
      registerBinding({ token, approvalKind, conversationId, requesterOnly: true });
      const deps = createRequesterOnlyDeps();
      resolveWithActor.mockRejectedValueOnce(
        Object.assign(new Error("Approval requester unavailable: ineligible"), {
          code: "APPROVAL_REQUESTER_UNAVAILABLE",
        }),
      );

      await expect(
        maybeHandleMSTeamsApprovalCardSubmit({
          context: createContext({
            token,
            senderId: COLLEAGUE_ID,
            conversationId,
            conversationType,
          }),
          deps,
        }),
      ).rejects.toThrow("Approval requester unavailable");
      expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
      expect(admitInteractionActor).toHaveBeenLastCalledWith({
        senderId: COLLEAGUE_ID,
        actorKind: "human",
        interactionId: "authenticated-click",
      });
      expect(msTeamsApprovalControls.get(token)).not.toBeNull();

      const requesterContext = createContext({
        token,
        senderId: REQUESTER_ID.toUpperCase(),
        conversationId,
        conversationType,
      });
      await expect(
        maybeHandleMSTeamsApprovalCardSubmit({
          context: requesterContext,
          deps,
        }),
      ).resolves.toBe(true);
      expect(resolveWithActor).toHaveBeenLastCalledWith(
        {
          id: `approval-${token}`,
          kind: approvalKind,
          decision: "allow-once",
        },
        expect.objectContaining({ kind: "admitted-channel-actor" }),
      );
      expect(admitInteractionActor).toHaveBeenLastCalledWith({
        senderId: REQUESTER_ID,
        actorKind: "human",
        interactionId: "authenticated-click",
      });
      expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith(
        expect.objectContaining({ to: `conversation:${conversationId}`, activityId: ACTIVITY_ID }),
      );
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    },
  );

  it("renders the canonical winner for concurrent successful sibling decisions", async () => {
    registerBinding({
      token: "sibling-allow",
      requesterOnly: true,
      approvalId: "approval-siblings",
    });
    registerBinding({
      token: "sibling-deny",
      decision: "deny",
      requesterOnly: true,
      approvalId: "approval-siblings",
    });
    const deps = createRequesterOnlyDeps();
    const winner = createResolution({ approvalId: "approval-siblings", decision: "deny" });
    resolveWithActor
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce({ ...winner, applied: false });
    const first = createContext({ token: "sibling-allow", senderId: REQUESTER_ID });
    const second = createContext({ token: "sibling-deny", senderId: REQUESTER_ID });

    await Promise.all([
      maybeHandleMSTeamsApprovalCardSubmit({ context: first, deps }),
      maybeHandleMSTeamsApprovalCardSubmit({ context: second, deps }),
    ]);

    expect(resolveWithActor).toHaveBeenCalledTimes(2);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledTimes(2);
    for (const [update] of editAdaptiveCardMSTeams.mock.calls) {
      const cardJson = JSON.stringify(update.card);
      expect(cardJson).toContain("Exec Approval: Denied");
      expect(cardJson).not.toContain("Exec Approval: Allowed once");
    }
  });

  it("rejects cards without a bound requester while the option is on", async () => {
    const token = "requester-only-unbound";
    registerBinding({ token });
    resolveWithActor.mockRejectedValueOnce(new Error("Approval requester unavailable: missing"));

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token, senderId: REQUESTER_ID }),
        deps: createRequesterOnlyDeps(),
      }),
    ).rejects.toThrow("Approval requester unavailable: missing");
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(msTeamsApprovalControls.get(token)).not.toBeNull();
  });

  it("keeps requester-bound cards requester-only after the option is turned off", async () => {
    const token = "requester-only-sticky";
    registerBinding({ token, requesterOnly: true });
    const deps = createRequesterOnlyDeps(false);
    resolveWithActor.mockRejectedValueOnce(new Error("Approval requester unavailable: ineligible"));

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token, senderId: COLLEAGUE_ID }),
        deps,
      }),
    ).rejects.toThrow("Approval requester unavailable");
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

    await maybeHandleMSTeamsApprovalCardSubmit({
      context: createContext({ token, senderId: REQUESTER_ID }),
      deps,
    });
    expect(resolveWithActor).toHaveBeenCalledTimes(2);
    expect(msTeamsApprovalControls.get(token)).toBeNull();
  });

  it.each([false, true])(
    "rejects a card click after the approver roster is cleared (requesterOnly=%s)",
    async (requesterOnly) => {
      const token = `roster-cleared-${requesterOnly}`;
      const deps = createRequesterOnlyDeps(requesterOnly);
      registerBinding({ token, requesterOnly });
      deps.cfg.channels!.msteams!.allowFrom = [];

      await maybeHandleMSTeamsApprovalCardSubmit({
        context: createContext({ token, senderId: REQUESTER_ID.toUpperCase() }),
        deps,
      });
      expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
      expect(resolveWithActor).not.toHaveBeenCalled();
      expect(editAdaptiveCardMSTeams).not.toHaveBeenCalled();
      expect(msTeamsApprovalControls.get(token)).not.toBeNull();
    },
  );

  it("fails closed without the matched core runtime after requesterOnly is disabled", async () => {
    const token = "missing-runtime";
    registerBinding({ token, requesterOnly: true });
    accountRuntime.current = undefined;
    const context = createContext({ token });

    await expect(
      maybeHandleMSTeamsApprovalCardSubmit({
        context,
        deps: createRequesterOnlyDeps(false),
      }),
    ).resolves.toBe(true);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(editAdaptiveCardMSTeams).not.toHaveBeenCalled();
    expect(msTeamsApprovalControls.get(token)).not.toBeNull();
  });
});
