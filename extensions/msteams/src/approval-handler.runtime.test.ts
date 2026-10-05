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
  return view.approvalKind === "plugin"
    ? {
        id: view.approvalId,
        request: {
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
        request: { command: view.commandText },
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

  it("sends a visible text fallback when card delivery fails", async () => {
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

    await vi.waitFor(() => expect(sendMessageMSTeams).toHaveBeenCalledTimes(1));
    const fallback = sendMessageMSTeams.mock.calls[0]?.[0];
    expect(fallback?.to).toBe("msteams:conversation:19:channel@thread.tacv2");
    expect(fallback?.text).toContain("/approve exec-approval-1 <allow-once|deny>");
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
      to: "19:channel@thread.tacv2",
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

  async function createRequesterScenario(to = `conversation:${REQUESTER_CHAT}`) {
    const view = createExecPendingView();
    const base = createRequest(view) as ExecApprovalRequest;
    const request: ExecApprovalRequest = {
      ...base,
      request: {
        ...base.request,
        runId: "queued-follow-up",
        sessionKey: "agent:main:main",
        turnSourceChannel: "msteams",
        turnSourceTo: `conversation:${REQUESTER_CHAT}`,
        authorization: {
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
                message: {
                  messageId: "follow-up-message",
                  conversationId: REQUESTER_CHAT,
                  conversationKind: "direct",
                  eventKind: "message",
                },
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
            sources: [
              {
                messageId: "follow-up-message",
                conversationId: REQUESTER_CHAT,
                conversationKind: "direct",
                eventKind: "message",
              },
            ],
          },
          policy: {
            requireResolverMatch: true,
            delivery: "requester",
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      },
    };
    const pendingPayload = await msTeamsApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: requesterOnlyCfg,
      accountId: "default",
      request,
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    });
    const plannedTarget = {
      surface: "origin" as const,
      target: { to, threadId: null },
      reason: "preferred" as const,
    };
    const prepared = await msTeamsApprovalNativeRuntime.transport.prepareTarget({
      cfg: requesterOnlyCfg,
      accountId: "default",
      plannedTarget,
      request,
      approvalKind: "exec",
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
    msTeamsApprovalControls.unregister(binding ?? []);
  });

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

  it("keeps stamped delivery private when the option is disabled", async () => {
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
