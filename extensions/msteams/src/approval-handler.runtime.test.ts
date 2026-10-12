import { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  ExecApprovalPendingView,
  ExpiredApprovalView,
  PendingApprovalView,
  PluginApprovalPendingView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import { msTeamsApprovalCapability } from "./approval-native.js";

const routeGateway = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ ok: true })));
const blockedLog = vi.hoisted(() => vi.fn());
// Exercise core routing through the public SDK with a secretless Gateway transport.
vi.mock("../../../src/gateway/call.js", () => ({ callGatewayLeastPrivilege: routeGateway }));
vi.mock("../../../src/gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: async (params: {
    onHelloOk?: (hello: unknown) => void;
  }) => {
    queueMicrotask(() => params.onHelloOk?.({ type: "hello-ok" }));
    return { request: vi.fn(async () => []), stop: vi.fn() };
  },
}));
vi.mock("../../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: async () => ({ ready: true, aborted: false }),
}));
vi.mock("../../../src/logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      error: blockedLog,
    }),
  };
});

const sendAdaptiveCardMSTeams = vi.hoisted(() => vi.fn());
const editAdaptiveCardMSTeams = vi.hoisted(() => vi.fn());
const sendMessageMSTeams = vi.hoisted(() => vi.fn());

vi.mock("./send.js", async () => ({
  ...(await vi.importActual<typeof import("./send.js")>("./send.js")),
  sendAdaptiveCardMSTeams,
  editAdaptiveCardMSTeams,
  sendMessageMSTeams,
}));

const storedConversations = vi.hoisted(
  () => new Map<string, import("./conversation-store.js").StoredConversationReference>(),
);

vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => ({
    get: async (conversationId: string) => storedConversations.get(conversationId) ?? null,
    findPreferredDmByUserId: async () => null,
  }),
}));

const { msTeamsApprovalNativeRuntime } = await import("./approval-handler.runtime.js");

const cfg: OpenClawConfig = {
  approvals: { exec: { enabled: true }, plugin: { enabled: true } },
  channels: {
    msteams: {
      enabled: true,
      appId: "teams-app",
      appPassword: "test-password",
      tenantId: "teams-tenant",
      allowFrom: ["00000000-0000-4000-8000-000000000001"],
    },
  },
};

function createExecPendingView(): ExecApprovalPendingView {
  return {
    approvalId: "exec-approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [
      { label: "Agent", value: "operations" },
      { label: "Host", value: "gateway" },
    ],
    commandText: "deploy --production",
    cwd: "/srv/service",
    actions: [
      {
        decision: "allow-once",
        label: "Approve once",
        style: "success",
        command: "/approve exec-approval-1 allow-once",
      },
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve exec-approval-1 deny",
      },
    ],
    expiresAtMs: Date.now() + 60_000,
  };
}

function createPluginPendingView(): PluginApprovalPendingView {
  return {
    approvalId: "plugin-approval-1",
    approvalKind: "plugin",
    phase: "pending",
    title: "Deploy production service",
    description: "The deployment plugin requests access.",
    metadata: [
      { label: "Plugin", value: "deployments" },
      { label: "Tool", value: "deploy_service" },
    ],
    pluginId: "deployments",
    toolName: "deploy_service",
    severity: "critical",
    actions: [
      {
        decision: "allow-once",
        label: "Approve once",
        style: "success",
        command: "/approve plugin-approval-1 allow-once",
      },
    ],
    expiresAtMs: Date.now() + 60_000,
  };
}

function createRequest(view: PendingApprovalView): ExecApprovalRequest | PluginApprovalRequest {
  const message = {
    messageId: "source-message",
    conversationId: "19:channel@thread.tacv2",
    conversationKind: "channel" as const,
    threadId: "thread-root",
    eventKind: "message" as const,
  };
  const actor = {
    channel: "msteams",
    accountId: "default",
    senderId: "00000000-0000-4000-8000-000000000001",
    actorKind: "human" as const,
  };
  const authorization: NonNullable<ExecApprovalRequest["request"]["authorization"]> = {
    version: 1,
    source: {
      version: 1,
      runId: "run",
      sessionKey: "agent:main:main",
      revision: 1,
      completeness: "complete",
      inputs: [{ inputId: "input", origin: "user", actor, message }],
    },
    requesterBinding: {
      state: "bound",
      inputOrigin: "user",
      ...actor,
      runId: "run",
      sessionKey: "agent:main:main",
      sourceRevision: 1,
      sources: [message],
    },
    policy: { requireResolverMatch: false, delivery: "default" },
  };
  return view.approvalKind === "plugin"
    ? {
        id: view.approvalId,
        request: {
          authorization,
          title: view.title,
          description: view.description ?? "",
          severity: view.severity,
          pluginId: view.pluginId ?? undefined,
          toolName: view.toolName ?? undefined,
        },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      }
    : {
        id: view.approvalId,
        request: { command: view.commandText, authorization },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      };
}

async function createPendingScenario(view: PendingApprovalView = createExecPendingView()) {
  const request = createRequest(view);
  const pendingPayload = await msTeamsApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg,
    accountId: "default",
    request,
    approvalKind: view.approvalKind,
    nowMs: Date.now(),
    view,
  });
  const plannedTarget = {
    surface: "origin" as const,
    target: { to: "msteams:conversation:19:channel@thread.tacv2", threadId: "thread-root" },
    reason: "preferred" as const,
  };
  const prepared = await msTeamsApprovalNativeRuntime.transport.prepareTarget({
    cfg,
    accountId: "default",
    plannedTarget,
    request,
    approvalKind: view.approvalKind,
    view,
    pendingPayload,
  });
  if (!prepared) {
    throw new Error("Expected prepared Microsoft Teams approval target");
  }
  return { view, request, pendingPayload, plannedTarget, prepared };
}

describe("msTeamsApprovalNativeRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedConversations.clear();
    storedConversations.set("19:channel@thread.tacv2", {
      conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
    });
    sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "approval-activity-1",
      conversationId: "19:channel@thread.tacv2",
    });
    editAdaptiveCardMSTeams.mockResolvedValue({ conversationId: "19:channel@thread.tacv2" });
  });

  it.each([
    {
      name: "exec command and scope",
      createView: createExecPendingView,
      expectedContent: ["Exec Approval Required", "deploy --production", "operations", "gateway"],
      expectedDecisions: ["allow-once", "deny"],
    },
    {
      name: "plugin action and scope",
      createView: createPluginPendingView,
      expectedContent: [
        "Plugin Approval Required",
        "Deploy production service",
        "deployments",
        "deploy_service",
      ],
      expectedDecisions: ["allow-once"],
    },
  ])("renders the pending $name with only its authorized actions", async (testCase) => {
    const { pendingPayload } = await createPendingScenario(testCase.createView());
    const serializedCard = JSON.stringify(pendingPayload.card);
    for (const expectedText of testCase.expectedContent) {
      expect(serializedCard).toContain(expectedText);
    }
    expect(pendingPayload.allowedDecisions).toEqual(testCase.expectedDecisions);
    expect(pendingPayload.card.actions).toEqual(
      pendingPayload.actionTokens.map(({ token }, index) => ({
        type: "Action.Submit",
        title: testCase.createView().actions[index]?.label,
        data: { openclawAction: "approval", token },
      })),
    );
    expect(serializedCard).not.toContain("/approve");
  });

  it("normalizes destinations and preserves thread roots only for channel conversations", async () => {
    const { view, request, pendingPayload } = await createPendingScenario();
    for (const testCase of [
      {
        to: "msteams:conversation:19:channel@thread.tacv2",
        expected: "conversation:19:channel@thread.tacv2;messageid=thread-root",
      },
      {
        to: "conversation:19:channel@thread.tacv2;messageid=existing-root",
        expected: "conversation:19:channel@thread.tacv2;messageid=existing-root",
      },
      { to: "conversation:19:group@thread.v2", expected: "conversation:19:group@thread.v2" },
      {
        to: "user:00000000-0000-4000-8000-000000000001",
        expected: "user:00000000-0000-4000-8000-000000000001",
      },
    ]) {
      const prepared = await msTeamsApprovalNativeRuntime.transport.prepareTarget({
        cfg,
        accountId: "default",
        plannedTarget: {
          surface: "origin",
          target: { to: testCase.to, threadId: "thread-root" },
          reason: "preferred",
        },
        request,
        approvalKind: "exec",
        view,
        pendingPayload,
      });
      expect(prepared?.target.to).toBe(testCase.expected);
    }
  });

  it("leaves delivery-error notices to the core coordinator", async () => {
    const { view, request, pendingPayload, plannedTarget } = await createPendingScenario();
    sendMessageMSTeams.mockResolvedValue({
      messageId: "fallback-1",
      conversationId: "19:channel@thread.tacv2",
    });

    msTeamsApprovalNativeRuntime.observe?.onDeliveryError?.({
      cfg,
      accountId: "default",
      error: new Error("card send failed"),
      plannedTarget,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    expect(sendMessageMSTeams).not.toHaveBeenCalled();
  });

  it("delivers and binds pending cards, then replaces resolved cards without actions", async () => {
    const { view, request, pendingPayload, plannedTarget, prepared } =
      await createPendingScenario();
    const entry = await msTeamsApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      plannedTarget,
      preparedTarget: prepared.target,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    if (!entry) {
      throw new Error("Expected delivered Microsoft Teams approval card");
    }
    expect(sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:19:channel@thread.tacv2;messageid=thread-root",
      card: pendingPayload.card,
    });

    const binding = await msTeamsApprovalNativeRuntime.interactions?.bindPending?.({
      cfg,
      accountId: "default",
      entry,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    if (!binding) {
      throw new Error("Expected native approval action bindings");
    }
    expect(binding).toHaveLength(2);
    for (const [index, token] of binding.entries()) {
      expect(msTeamsApprovalControls.get(token)).toEqual({
        token,
        accountId: "default",
        approvalId: "exec-approval-1",
        approvalKind: "exec",
        decision: pendingPayload.actionTokens[index]?.decision,
        allowedDecisions: ["allow-once", "deny"],
        conversationId: "19:channel@thread.tacv2",
        activityId: "approval-activity-1",
        expiresAtMs: view.expiresAtMs,
      });
    }

    const resolvedView: ResolvedApprovalView = {
      ...view,
      phase: "resolved",
      decision: "allow-once",
      resolvedBy: "00000000-0000-4000-8000-000000000001",
    };
    const final = await msTeamsApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg,
      accountId: "default",
      request,
      resolved: {
        id: request.id,
        decision: "allow-once",
        resolvedBy: "00000000-0000-4000-8000-000000000001",
        ts: Date.now(),
      },
      view: resolvedView,
      entry,
    });
    if (final.kind !== "update") {
      throw new Error("Expected resolved Microsoft Teams approval card update");
    }
    await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
      cfg,
      accountId: "default",
      entry,
      request,
      approvalKind: "exec",
      payload: final.payload,
      phase: "resolved",
    });
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg,
      to: "conversation:19:channel@thread.tacv2",
      activityId: "approval-activity-1",
      card: final.payload,
    });
    expect(JSON.stringify(final.payload)).toContain("Allowed once");
    expect(final.payload).not.toHaveProperty("actions");

    await msTeamsApprovalNativeRuntime.interactions?.unbindPending?.({
      cfg,
      accountId: "default",
      entry,
      binding,
      request,
      approvalKind: "exec",
    });
    for (const token of binding) {
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    }
  });

  it("retires controls after a failed terminal edit and ignores duplicate resolution events", async () => {
    vi.useFakeTimers();
    const request = createRequest(createExecPendingView());
    const handler = await createChannelApprovalHandlerFromCapability({
      label: "msteams/test-terminal-edit",
      clientDisplayName: "Test",
      channel: "msteams",
      channelLabel: "Microsoft Teams",
      accountId: "default",
      cfg,
      capability: {
        native: msTeamsApprovalCapability.native,
        nativeRuntime: msTeamsApprovalCapability.nativeRuntime,
      },
    });
    if (!handler) {
      throw new Error("Expected registered approval handler");
    }
    try {
      await handler.start();
      await handler.handleRequested(request);
      const tokens = Array.from(msTeamsApprovalControls.values())
        .filter((binding) => binding.approvalId === request.id)
        .map((binding) => binding.token);
      expect(tokens.length).toBeGreaterThan(0);
      editAdaptiveCardMSTeams.mockRejectedValueOnce(new Error("HTTP 429 exhausted"));
      const resolved = { id: request.id, decision: "allow-once" as const, ts: Date.now() };
      await handler.handleResolved(resolved);
      for (const token of tokens) {
        expect(msTeamsApprovalControls.get(token)).toBeNull();
      }
      expect(blockedLog).toHaveBeenCalledWith(
        expect.stringContaining("resolved; display update failed"),
      );
      await handler.handleResolved(resolved);
      expect(editAdaptiveCardMSTeams).toHaveBeenCalledTimes(1);
      expect(sendAdaptiveCardMSTeams).toHaveBeenCalledTimes(1);
    } finally {
      await handler.stop();
      vi.useRealTimers();
    }
  });

  it.each(["unknown", ""])(
    "rejects an unaddressable approval activity id: %s",
    async (messageId) => {
      sendAdaptiveCardMSTeams.mockResolvedValue({
        messageId,
        conversationId: "19:channel@thread.tacv2",
      });
      const { view, request, pendingPayload, plannedTarget, prepared } =
        await createPendingScenario();

      await expect(
        msTeamsApprovalNativeRuntime.transport.deliverPending({
          cfg,
          accountId: "default",
          plannedTarget,
          preparedTarget: prepared.target,
          request,
          approvalKind: "exec",
          view,
          pendingPayload,
        }),
      ).resolves.toBeNull();
      for (const { token } of pendingPayload.actionTokens) {
        expect(msTeamsApprovalControls.get(token)).toBeNull();
      }
    },
  );

  it("replaces expired approvals without actions and releases canceled deliveries", async () => {
    const { view, request, pendingPayload, plannedTarget, prepared } =
      await createPendingScenario(createPluginPendingView());
    const entry = await msTeamsApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      plannedTarget,
      preparedTarget: prepared.target,
      request,
      approvalKind: "plugin",
      view,
      pendingPayload,
    });
    if (!entry) {
      throw new Error("Expected delivered plugin approval card");
    }
    const binding = await msTeamsApprovalNativeRuntime.interactions?.bindPending?.({
      cfg,
      accountId: "default",
      entry,
      request,
      approvalKind: "plugin",
      view,
      pendingPayload,
    });
    if (!binding) {
      throw new Error("Expected plugin approval action bindings");
    }

    const expiredView: ExpiredApprovalView = { ...view, phase: "expired" };
    const final = await msTeamsApprovalNativeRuntime.presentation.buildExpiredResult({
      cfg,
      accountId: "default",
      request,
      view: expiredView,
      entry,
    });
    if (final.kind !== "update") {
      throw new Error("Expected expired Microsoft Teams approval card update");
    }
    await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
      cfg,
      accountId: "default",
      entry,
      request,
      approvalKind: "plugin",
      payload: final.payload,
      phase: "expired",
    });
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        activityId: "approval-activity-1",
        card: final.payload,
      }),
    );
    expect(JSON.stringify(final.payload)).toContain("Plugin Approval Expired");
    expect(final.payload).not.toHaveProperty("actions");

    await msTeamsApprovalNativeRuntime.interactions?.cancelDelivered?.({
      cfg,
      accountId: "default",
      entry,
      request,
      approvalKind: "plugin",
    });
    for (const token of binding) {
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    }
    msTeamsApprovalControls.unregister(binding);
  });
});

describe("Teams native approval delivery and forwarding suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedConversations.clear();
    sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "origin-card",
      conversationId: "19:channel@thread.tacv2",
    });
  });

  it.each([
    "origin-drift",
    "missing-origin",
    "mixed-private-source",
    "missing-provenance",
  ] as const)(
    "completes the registered %s delivery flow without forwarding to misleading targets",
    async (scenario) => {
      vi.useFakeTimers();
      const request = createRequest(createExecPendingView());
      request.id = `flow-${scenario}`;
      request.request.turnSourceChannel = "msteams";
      request.request.turnSourceAccountId = "default";
      request.request.turnSourceTo = "user:00000000-0000-4000-8000-000000000002";
      request.request.turnSourceThreadId = "wrong-thread";
      const authorization = request.request.authorization;
      if (!authorization) {
        throw new Error("Expected admitted source");
      }
      if (scenario === "origin-drift") {
        storedConversations.set("19:channel@thread.tacv2", {
          conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
        });
      } else if (scenario === "missing-provenance") {
        request.request.authorization = undefined;
      } else if (scenario === "mixed-private-source") {
        const privateId = "a:source-private";
        const senderId = "00000000-0000-4000-8000-000000000001";
        storedConversations.set(privateId, {
          aadObjectId: senderId,
          conversation: { id: privateId, conversationType: "personal" },
        });
        request.request.authorization = {
          ...authorization,
          requesterBinding: { state: "mixed", reason: "mixed-origins" },
          source: {
            ...authorization.source,
            inputs: [
              {
                inputId: "user",
                origin: "user",
                actor: { channel: "msteams", accountId: "default", senderId, actorKind: "human" },
                message: {
                  messageId: "private-input",
                  conversationId: privateId,
                  conversationKind: "direct",
                  eventKind: "message",
                },
              },
              { inputId: "system", origin: "system" },
            ],
          },
        };
      }
      expect(
        msTeamsApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
          cfg,
          approvalKind: "exec",
          request,
          target: { channel: "msteams", to: request.request.turnSourceTo },
        }),
      ).toBe(true);
      const handler = await createChannelApprovalHandlerFromCapability({
        label: "msteams/test-flow",
        clientDisplayName: "Test",
        channel: "msteams",
        channelLabel: "Microsoft Teams",
        accountId: "default",
        cfg,
        capability: {
          native: msTeamsApprovalCapability.native,
          nativeRuntime: msTeamsApprovalCapability.nativeRuntime,
        },
      });
      if (!handler) {
        throw new Error("Expected registered approval handler");
      }
      try {
        const blockedNotice = Promise.withResolvers<void>();
        if (scenario !== "origin-drift") {
          blockedLog.mockImplementationOnce(() => blockedNotice.resolve());
        }
        await handler.start();
        await handler.handleRequested(request);
        if (scenario === "origin-drift") {
          expect(sendAdaptiveCardMSTeams).toHaveBeenCalledWith(
            expect.objectContaining({
              to: "conversation:19:channel@thread.tacv2;messageid=thread-root",
            }),
          );
          expect(routeGateway).not.toHaveBeenCalled();
        } else {
          // Skipped requests report their private notice asynchronously; join its outcome.
          await blockedNotice.promise;
          expect(sendAdaptiveCardMSTeams).not.toHaveBeenCalled();
          expect(blockedLog).toHaveBeenCalledWith(
            `approval ${request.id}: native delivery blocked; notice outcome=${scenario === "mixed-private-source" ? "sent" : "no-unique-chat"}`,
          );
          if (scenario === "mixed-private-source") {
            expect(routeGateway).toHaveBeenCalledWith(
              expect.objectContaining({
                method: "send",
                params: expect.objectContaining({
                  to: "conversation:a:source-private",
                  idempotencyKey: `approval-route-notice:delivery-failed:${request.id}`,
                  message:
                    "The native approval card could not be delivered. Check the request's status in Control UI or terminal UI.",
                }),
              }),
            );
          } else {
            expect(routeGateway).not.toHaveBeenCalled();
          }
        }
        expect(sendMessageMSTeams).not.toHaveBeenCalled();
        expect(JSON.stringify(routeGateway.mock.calls)).not.toMatch(
          /wrong-thread|00000000-0000-4000-8000-000000000002|deploy --production/,
        );
      } finally {
        await handler.stop();
        vi.useRealTimers();
      }
    },
  );
});

describe("msTeamsApprovalNativeRuntime with requester-only approvals", () => {
  const REQUESTER_ID = "00000000-0000-4000-8000-000000000001";
  const COLLEAGUE_ID = "00000000-0000-4000-8000-000000000002";
  const REQUESTER_CHAT = "a:1requester-chat";
  const requesterOnlyCfg: OpenClawConfig = {
    channels: {
      msteams: {
        ...cfg.channels?.msteams,
        allowFrom: [REQUESTER_ID, COLLEAGUE_ID],
        approvals: { requesterOnly: true },
      },
    },
  };

  async function createRequesterScenario(
    to = `conversation:${REQUESTER_CHAT}`,
    source?: { conversationId: string; conversationKind: "group" | "channel"; threadId?: string },
    view: PendingApprovalView = createExecPendingView(),
  ) {
    const request = createRequest(view);
    const message = {
      messageId: "follow-up-message",
      conversationId: REQUESTER_CHAT,
      conversationKind: "direct" as const,
      eventKind: "message" as const,
      ...source,
    };
    const authorization: NonNullable<ExecApprovalRequest["request"]["authorization"]> = {
      version: 1,
      source: {
        version: 1,
        runId: "queued-follow-up",
        sessionKey: "agent:main:main",
        revision: 1,
        completeness: "complete",
        inputs: [
          {
            inputId: "queued-input",
            origin: "user",
            actor: {
              channel: "msteams",
              accountId: "default",
              senderId: REQUESTER_ID,
              actorKind: "human",
            },
            message,
          },
        ],
      },
      requesterBinding: {
        state: "bound",
        inputOrigin: "user",
        channel: "msteams",
        accountId: "default",
        senderId: REQUESTER_ID,
        runId: "queued-follow-up",
        sessionKey: "agent:main:main",
        sourceRevision: 1,
        sources: [message],
      },
      policy: {
        requireResolverMatch: true,
        delivery: "requester",
        allowedDecisions: ["allow-once", "deny"],
      },
    };
    request.request.authorization = authorization;
    const pendingPayload = await msTeamsApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: requesterOnlyCfg,
      accountId: "default",
      request,
      approvalKind: view.approvalKind,
      nowMs: Date.now(),
      view,
    });
    const plannedTarget = {
      surface: "origin" as const,
      target: { to, threadId: source?.threadId ?? null },
      reason: "preferred" as const,
    };
    const prepared = await msTeamsApprovalNativeRuntime.transport.prepareTarget({
      cfg: requesterOnlyCfg,
      accountId: "default",
      plannedTarget,
      request,
      approvalKind: view.approvalKind,
      view,
      pendingPayload,
    });
    if (!prepared) {
      throw new Error("Expected prepared Microsoft Teams approval target");
    }
    return { view, request, pendingPayload, plannedTarget, prepared };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storedConversations.clear();
    storedConversations.set(REQUESTER_CHAT, {
      aadObjectId: REQUESTER_ID,
      user: { aadObjectId: REQUESTER_ID },
      conversation: { id: REQUESTER_CHAT, conversationType: "personal" },
    });
    sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "approval-activity-1",
      conversationId: REQUESTER_CHAT,
    });
  });

  it("delivers a queued follow-up card from the core binding and binds its controls", async () => {
    const { view, request, pendingPayload, plannedTarget, prepared } =
      await createRequesterScenario();
    const entry = await msTeamsApprovalNativeRuntime.transport.deliverPending({
      cfg: requesterOnlyCfg,
      accountId: "default",
      plannedTarget,
      preparedTarget: prepared.target,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    expect(sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg: requesterOnlyCfg,
      to: `conversation:${REQUESTER_CHAT}`,
      card: pendingPayload.card,
    });
    expect(entry).toMatchObject({ requesterOnly: true });
    if (!entry) {
      throw new Error("Expected delivered Microsoft Teams approval card");
    }
    const binding = await msTeamsApprovalNativeRuntime.interactions?.bindPending?.({
      cfg: requesterOnlyCfg,
      accountId: "default",
      entry,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    expect(binding).toHaveLength(2);
    for (const token of binding ?? []) {
      expect(msTeamsApprovalControls.get(token)).toMatchObject({
        approvalId: request.id,
        requesterOnly: true,
      });
    }
    await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
      cfg: requesterOnlyCfg,
      accountId: "default",
      request,
      approvalKind: "exec",
      entry,
      payload: { type: "AdaptiveCard" },
      phase: "resolved",
    });
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        to: `conversation:${REQUESTER_CHAT}`,
        activityId: "approval-activity-1",
      }),
    );
    msTeamsApprovalControls.unregister(binding ?? []);
  });

  it.each(
    [true, false].flatMap((requesterOnly) => [
      {
        requesterOnly,
        conversationKind: "channel" as const,
        conversationId: "19:channel@thread.tacv2",
        type: "channel",
        threadId: "thread-root",
        phase: "resolved" as const,
      },
      {
        requesterOnly,
        conversationKind: "channel" as const,
        conversationId: "19:channel@thread.tacv2",
        type: "channel",
        threadId: "thread-root",
        phase: "expired" as const,
      },
      {
        requesterOnly,
        conversationKind: "group" as const,
        conversationId: "19:group@thread.v2",
        type: "groupChat",
        threadId: undefined,
        phase: "resolved" as const,
      },
    ]),
  )(
    "delivers and updates the same origin card in $conversationKind ($phase, requesterOnly=$requesterOnly)",
    async ({ requesterOnly, conversationKind, conversationId, type, threadId, phase }) => {
      storedConversations.set(conversationId, {
        conversation: { id: conversationId, conversationType: type },
        aadObjectId: COLLEAGUE_ID,
      });
      sendAdaptiveCardMSTeams.mockResolvedValue({ messageId: "shared-card", conversationId });
      const scenario = await createRequesterScenario(
        `conversation:${conversationId}`,
        { conversationKind, conversationId, threadId },
        createPluginPendingView(),
      );
      const deliveryCfg = {
        ...cfg,
        channels: {
          msteams: { ...requesterOnlyCfg.channels?.msteams, approvals: { requesterOnly } },
        },
      };
      if (!requesterOnly && scenario.request.request.authorization) {
        scenario.request.request.authorization = {
          ...scenario.request.request.authorization,
          policy: { requireResolverMatch: false, delivery: "default" },
        };
      }
      const entry = await msTeamsApprovalNativeRuntime.transport.deliverPending({
        ...scenario,
        cfg: deliveryCfg,
        accountId: "default",
        approvalKind: "plugin",
        preparedTarget: scenario.prepared.target,
      });
      expect(sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
        cfg: deliveryCfg,
        to: `conversation:${conversationId}${threadId ? `;messageid=${threadId}` : ""}`,
        card: scenario.pendingPayload.card,
      });
      expect(sendAdaptiveCardMSTeams).toHaveBeenCalledTimes(1);
      if (!entry) {
        throw new Error("Expected origin card");
      }
      const terminal =
        phase === "expired"
          ? await msTeamsApprovalNativeRuntime.presentation.buildExpiredResult({
              ...scenario,
              cfg: deliveryCfg,
              accountId: "default",
              entry,
              view: { ...scenario.view, phase: "expired" },
            })
          : await msTeamsApprovalNativeRuntime.presentation.buildResolvedResult({
              ...scenario,
              cfg: deliveryCfg,
              accountId: "default",
              entry,
              view: { ...scenario.view, phase: "resolved", decision: "allow-once" },
              resolved: { id: scenario.request.id, decision: "allow-once", ts: Date.now() },
            });
      if (terminal.kind !== "update") {
        throw new Error("Expected card update");
      }
      await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
        ...scenario,
        cfg: deliveryCfg,
        accountId: "default",
        approvalKind: "plugin",
        entry,
        payload: terminal.payload,
        phase,
      });
      expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith({
        cfg: deliveryCfg,
        to: `conversation:${conversationId}`,
        activityId: "shared-card",
        card: terminal.payload,
      });
      expect(terminal.payload).not.toHaveProperty("actions");
      for (const badReference of [
        null,
        { conversation: { id: conversationId, conversationType: "personal" } },
        { conversation: { id: "19:other@thread.v2", conversationType: type } },
      ]) {
        if (badReference) {
          storedConversations.set(conversationId, badReference);
        } else {
          storedConversations.delete(conversationId);
        }
        await expect(
          msTeamsApprovalNativeRuntime.transport.deliverPending({
            ...scenario,
            cfg: deliveryCfg,
            accountId: "default",
            approvalKind: "plugin",
            preparedTarget: scenario.prepared.target,
          }),
        ).resolves.toBeNull();
      }
      expect(sendAdaptiveCardMSTeams).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: "a group chat", to: "conversation:19:team@thread.v2" },
    { name: "a user alias", to: `user:${REQUESTER_ID}` },
  ])("refuses to send to $name at the send boundary", async ({ to }) => {
    const { view, request, pendingPayload, plannedTarget, prepared } =
      await createRequesterScenario(to);
    await expect(
      msTeamsApprovalNativeRuntime.transport.deliverPending({
        cfg: requesterOnlyCfg,
        accountId: "default",
        plannedTarget,
        preparedTarget: prepared.target,
        request,
        approvalKind: "exec",
        view,
        pendingPayload,
      }),
    ).resolves.toBeNull();
    expect(sendAdaptiveCardMSTeams).not.toHaveBeenCalled();
  });

  it("refuses to send into a personal chat owned by someone else", async () => {
    storedConversations.set(REQUESTER_CHAT, {
      aadObjectId: COLLEAGUE_ID,
      conversation: { id: REQUESTER_CHAT, conversationType: "personal" },
    });
    const { view, request, pendingPayload, plannedTarget, prepared } =
      await createRequesterScenario();
    await expect(
      msTeamsApprovalNativeRuntime.transport.deliverPending({
        cfg: requesterOnlyCfg,
        accountId: "default",
        plannedTarget,
        preparedTarget: prepared.target,
        request,
        approvalKind: "exec",
        view,
        pendingPayload,
      }),
    ).resolves.toBeNull();
    expect(sendAdaptiveCardMSTeams).not.toHaveBeenCalled();
  });

  it("rechecks the live roster after awaiting personal-chat ownership", async () => {
    const { view, request, pendingPayload, plannedTarget, prepared } =
      await createRequesterScenario();
    const currentTeams = { ...requesterOnlyCfg.channels?.msteams };
    const currentCfg: OpenClawConfig = { channels: { msteams: currentTeams } };
    const delivery = msTeamsApprovalNativeRuntime.transport.deliverPending({
      cfg: currentCfg,
      accountId: "default",
      plannedTarget,
      preparedTarget: prepared.target,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    currentTeams.allowFrom = [COLLEAGUE_ID];
    await expect(delivery).resolves.toBeNull();
    expect(sendAdaptiveCardMSTeams).not.toHaveBeenCalled();
  });

  it("leaves a failed strict card's blocked notice to core, including repeated callbacks", async () => {
    const { view, request, pendingPayload, plannedTarget, prepared } =
      await createRequesterScenario();
    const deliveryError = {
      cfg: requesterOnlyCfg,
      accountId: "default",
      error: new Error("card send failed"),
      plannedTarget,
      request,
      approvalKind: "exec" as const,
      view,
      pendingPayload,
    };
    sendAdaptiveCardMSTeams.mockRejectedValueOnce(deliveryError.error);
    await expect(
      msTeamsApprovalNativeRuntime.transport.deliverPending({
        ...deliveryError,
        preparedTarget: prepared.target,
      }),
    ).rejects.toThrow("card send failed");
    msTeamsApprovalNativeRuntime.observe?.onDeliveryError?.(deliveryError);
    msTeamsApprovalNativeRuntime.observe?.onDeliveryError?.(deliveryError);
    expect(sendMessageMSTeams).not.toHaveBeenCalled();
  });

  it("keeps stamped delivery bound to its origin when the option is disabled", async () => {
    const { view, request, pendingPayload, prepared } = await createRequesterScenario();
    const optionOffCfg: OpenClawConfig = {
      channels: {
        msteams: { ...requesterOnlyCfg.channels?.msteams, approvals: { requesterOnly: false } },
      },
    };
    await expect(
      msTeamsApprovalNativeRuntime.transport.deliverPending({
        cfg: optionOffCfg,
        accountId: "default",
        plannedTarget: {
          surface: "approver-dm",
          target: { to: `user:${COLLEAGUE_ID}` },
          reason: "preferred",
        },
        preparedTarget: { ...prepared.target, to: `user:${COLLEAGUE_ID}` },
        request,
        approvalKind: "exec",
        view,
        pendingPayload,
      }),
    ).resolves.toBeNull();
    expect(sendAdaptiveCardMSTeams).not.toHaveBeenCalled();
  });
});

describe("msTeamsApprovalNativeRuntime requester-only delivery-error notices", () => {
  const REQUESTER_ID = "00000000-0000-4000-8000-000000000001";
  const requesterOnlyCfg: OpenClawConfig = {
    channels: {
      msteams: {
        ...cfg.channels?.msteams,
        allowFrom: [REQUESTER_ID],
        approvals: { requesterOnly: true },
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storedConversations.clear();
  });

  it("sends no notice when the destination cannot be re-verified", async () => {
    const { view, request, pendingPayload } = await createPendingScenario();
    msTeamsApprovalNativeRuntime.observe?.onDeliveryError?.({
      cfg: requesterOnlyCfg,
      accountId: "default",
      error: new Error("card send failed"),
      plannedTarget: {
        surface: "origin",
        target: { to: "conversation:19:team@thread.v2", threadId: null },
        reason: "preferred",
      },
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    expect(sendMessageMSTeams).not.toHaveBeenCalled();
  });
});
