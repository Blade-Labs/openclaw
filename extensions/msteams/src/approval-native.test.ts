import path from "node:path";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { StoredConversationReference } from "./conversation-store.js";

const storedConversations = vi.hoisted(() => new Map<string, StoredConversationReference>());
const approvalRuntimeVersion = vi.hoisted(() => ({ current: 2 as number | undefined }));

vi.mock("./runtime.js", () => ({
  getOptionalMSTeamsRuntime: () => ({
    channel: {
      runtimeContexts: {
        get: () =>
          approvalRuntimeVersion.current == null
            ? undefined
            : { version: approvalRuntimeVersion.current },
      },
    },
  }),
}));

vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => ({
    get: async (conversationId: string) => storedConversations.get(conversationId) ?? null,
    findPreferredDmByUserId: async (userId: string) => {
      for (const [conversationId, reference] of storedConversations) {
        if (reference.aadObjectId === userId) {
          return { conversationId, reference };
        }
      }
      return null;
    },
  }),
}));

import {
  isMSTeamsNativeApprovalClientEnabled,
  msTeamsApprovalCapability,
  shouldHandleMSTeamsNativeApprovalRequest,
  shouldSuppressLocalMSTeamsExecApprovalPrompt,
} from "./approval-native.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const APPROVER_ID = "40a1a0ed-4ff2-4164-a219-55518990c197";
const OTHER_USER_ID = "b2d381f1-36dd-4120-b6fb-8dd37388ff11";
const CONVERSATION_ID = "19:channel@thread.tacv2";

function createConfig(
  overrides: {
    approvals?: OpenClawConfig["approvals"];
    teams?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>>;
  } = {},
): OpenClawConfig {
  return {
    approvals: overrides.approvals ?? { exec: { enabled: true } },
    channels: {
      msteams: {
        appId: "app-id",
        appPassword: "app-password",
        tenantId: "tenant-id",
        allowFrom: [APPROVER_ID],
        ...overrides.teams,
      },
    },
  };
}

beforeEach(() => {
  storedConversations.clear();
  storedConversations.set(CONVERSATION_ID, {
    conversation: { id: CONVERSATION_ID, conversationType: "channel" },
  });
});

function createExecRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  const to = overrides.turnSourceTo ?? `conversation:${CONVERSATION_ID}`;
  const message = {
    conversationId: to.replace(/^teams:/, "").replace(/^conversation:/, ""),
    conversationKind: "channel" as const,
    messageId: "source-root",
    threadId: overrides.turnSourceThreadId?.toString(),
    eventKind: "message" as const,
  };
  const actor = {
    channel: overrides.turnSourceChannel ?? "msteams",
    accountId: "default",
    senderId: APPROVER_ID,
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
  return {
    id: "approval-1",
    request: {
      command: "echo hello",
      authorization,
      turnSourceChannel: "msteams",
      turnSourceTo: `conversation:${CONVERSATION_ID}`,
      turnSourceAccountId: "default",
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
}

const pendingExecPayload: ReplyPayload = {
  text: "Approval required.",
  channelData: {
    execApproval: {
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalSlug: "12345678",
      approvalKind: "exec",
      agentId: "main",
      sessionKey: "agent:main:msteams:channel:example",
    },
  },
};

const activeExecApprovalHint: ChannelOutboundPayloadHint = {
  kind: "approval-pending",
  approvalKind: "exec",
  nativeRouteActive: true,
};

describe("Microsoft Teams native approval capability", () => {
  it("subscribes to exec, plugin, and system-agent approvals for a configured bot and approver", () => {
    const runtime = msTeamsApprovalCapability.nativeRuntime;

    expect(runtime?.eventKinds).toEqual(["exec", "plugin", "system-agent"]);
    expect(runtime?.availability.isConfigured({ cfg: createConfig() })).toBe(true);
    expect(
      runtime?.availability.isConfigured({
        cfg: createConfig({ approvals: { plugin: { enabled: true } } }),
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "approval forwarding is absent",
      cfg: { channels: createConfig().channels } satisfies OpenClawConfig,
    },
    {
      name: "exec forwarding is disabled",
      cfg: createConfig({ approvals: { exec: { enabled: false } } }),
    },
    {
      name: "forwarding only targets another channel",
      cfg: createConfig({
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "slack", to: "channel:C123" }],
          },
        },
      }),
    },
    {
      name: "the Teams account is disabled",
      cfg: createConfig({ teams: { enabled: false } }),
    },
    {
      name: "the bot credentials are incomplete",
      cfg: createConfig({ teams: { appPassword: undefined } }),
    },
    {
      name: "no approvers are configured",
      cfg: createConfig({ teams: { allowFrom: undefined } }),
    },
    {
      name: "allowlist entries are not stable Entra object IDs",
      cfg: createConfig({ teams: { allowFrom: ["someone@example.com", "*"] } }),
    },
  ])("does not enable native approvals when $name", ({ cfg }) => {
    expect(isMSTeamsNativeApprovalClientEnabled({ cfg })).toBe(false);
  });

  it("accepts a valid default destination as the configured approver", () => {
    const cfg = createConfig({
      teams: { allowFrom: undefined, defaultTo: `user:${APPROVER_ID.toUpperCase()}` },
    });

    expect(isMSTeamsNativeApprovalClientEnabled({ cfg })).toBe(true);
    expect(
      msTeamsApprovalCapability.authorizeActorAction?.({
        cfg,
        senderId: APPROVER_ID,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("keeps authorization available when native forwarding is disabled", () => {
    const cfg = createConfig({ approvals: { exec: { enabled: false } } });

    expect(
      msTeamsApprovalCapability.getActionAvailabilityState?.({
        cfg,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      msTeamsApprovalCapability.authorizeActorAction?.({
        cfg,
        senderId: APPROVER_ID.toUpperCase(),
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("rejects unlisted actors for both approval kinds", () => {
    for (const approvalKind of ["exec", "plugin"] as const) {
      expect(
        msTeamsApprovalCapability.authorizeActorAction?.({
          cfg: createConfig(),
          senderId: OTHER_USER_ID,
          action: "approve",
          approvalKind,
        }),
      ).toEqual({
        authorized: false,
        reason: `❌ You are not authorized to approve ${approvalKind} requests on Microsoft Teams.`,
      });
    }
  });

  it.each([false, true])(
    "rejects /approve after the approver roster is cleared (requesterOnly=%s)",
    (requesterOnly) => {
      const cfg = createConfig({ teams: { approvals: { requesterOnly } } });
      const authorization = createExecRequest().request.authorization;
      const input = {
        cfg,
        authorization,
        senderId: APPROVER_ID.toUpperCase(),
        accountId: "default",
        action: "approve" as const,
        approvalKind: "exec" as const,
      };
      expect(msTeamsApprovalCapability.authorizeActorAction?.(input)).toEqual({ authorized: true });

      cfg.channels!.msteams!.allowFrom = [];

      expect(msTeamsApprovalCapability.authorizeActorAction?.(input)).toMatchObject({
        authorized: false,
      });
      expect(
        msTeamsApprovalCapability.authorizeActorAction?.({ ...input, authorization: undefined }),
      ).toMatchObject({ authorized: false });
    },
  );

  it("restricts routing to the single Teams account and originating channel", () => {
    const cfg = createConfig();
    const request = createExecRequest();

    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        accountId: "other",
        approvalKind: "exec",
        request,
      }),
    ).toBe(false);
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        approvalKind: "exec",
        request: createExecRequest({ turnSourceChannel: "slack" }),
      }),
    ).toBe(false);
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        approvalKind: "exec",
        request: createExecRequest({ turnSourceTo: "  " }),
      }),
    ).toBe(false);
  });

  it("does not handle exec approvals when only plugin forwarding is enabled", () => {
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg: createConfig({ approvals: { plugin: { enabled: true } } }),
        approvalKind: "exec",
        request: createExecRequest(),
      }),
    ).toBe(false);
  });

  it.each([
    { to: `teams:conversation:${CONVERSATION_ID}`, threadId: "thread-root-123" },
    { to: `conversation:${CONVERSATION_ID};messageid=thread-root-123`, threadId: undefined },
  ])("preserves normalized channel-thread delivery for $to", async ({ to, threadId }) => {
    const request = createExecRequest({ turnSourceTo: to, turnSourceThreadId: threadId });

    expect(
      await msTeamsApprovalCapability.native?.resolveOriginTarget?.({
        cfg: createConfig(),
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: `conversation:${CONVERSATION_ID}`,
      accountId: "default",
      threadId: "thread-root-123",
    });
  });

  it.each([
    {
      sourceSuffix: "",
      sourceThread: "thread-root",
      storedSuffix: ";messageid=thread-root",
      storedThread: undefined,
    },
    {
      sourceSuffix: ";messageid=thread-root",
      sourceThread: undefined,
      storedSuffix: "",
      storedThread: "thread-root",
    },
  ])(
    "matches equivalent turn and stored channel-thread targets ($sourceSuffix/$storedSuffix)",
    async ({ sourceSuffix, sourceThread, storedSuffix, storedThread }) => {
      const cfg = createConfig();
      const storePath = path.join(
        tempDirs.make("openclaw-msteams-approval-origin-"),
        "sessions.sqlite",
      );
      cfg.session = { store: storePath };
      const sessionKey = "agent:main:msteams:channel:approval-thread";
      const to = `conversation:${CONVERSATION_ID}${storedSuffix}`;
      await patchSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
        skipMaintenance: true,
        fallbackEntry: { sessionId: "approval-session", updatedAt: 1 },
        update: () => ({
          delivery: {
            kind: "external",
            route: {
              channel: "msteams",
              accountId: "default",
              target: { to },
              ...(storedThread ? { thread: { id: storedThread } } : {}),
            },
            context: { channel: "msteams", accountId: "default", to, threadId: storedThread },
            origin: { provider: "msteams", accountId: "default", to, threadId: storedThread },
          },
        }),
      });
      const request = createExecRequest({
        sessionKey,
        turnSourceTo: `conversation:${CONVERSATION_ID}${sourceSuffix}`,
        turnSourceThreadId: sourceThread,
      });
      const input = { cfg, accountId: "default", approvalKind: "exec" as const, request };
      expect(await msTeamsApprovalCapability.native?.resolveOriginTarget?.(input)).toEqual({
        to: `conversation:${CONVERSATION_ID}`,
        accountId: "default",
        threadId: "thread-root",
      });
      request.request.turnSourceTo = `conversation:${CONVERSATION_ID}`;
      request.request.turnSourceThreadId = "different-thread";
      expect(await msTeamsApprovalCapability.native?.resolveOriginTarget?.(input)).toMatchObject({
        threadId: "thread-root",
      });
      expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
    },
  );

  it.each([
    { state: "non-user", origins: ["cron"] },
    { state: "non-user", origins: ["heartbeat"] },
    { state: "non-user", origins: ["subagent"] },
    { state: "unavailable", reason: "missing-source" },
  ] satisfies NonNullable<ExecApprovalRequest["request"]["authorization"]>["requesterBinding"][])(
    "withholds default-mode cards for $state provenance ($origins)",
    async (requesterBinding) => {
      const request = createExecRequest();
      request.request.authorization = { ...request.request.authorization!, requesterBinding };
      const input = {
        cfg: createConfig(),
        accountId: "default",
        approvalKind: "exec" as const,
        request,
      };
      expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(false);
      await expect(
        msTeamsApprovalCapability.native?.resolveOriginTarget?.(input),
      ).resolves.toBeNull();
      expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
    },
  );

  it.each([undefined, "root-thread"])(
    "uses the default-mode bound root/thread despite misleading user routing (%s)",
    async (threadId) => {
      const request = createExecRequest({ turnSourceThreadId: threadId });
      request.request.turnSourceTo = `user:${OTHER_USER_ID}`;
      request.request.turnSourceThreadId = "wrong-thread";
      const input = {
        cfg: createConfig({
          teams: { allowFrom: [OTHER_USER_ID], approvals: { requesterOnly: false } },
        }),
        accountId: "default",
        approvalKind: "exec" as const,
        request,
      };
      expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(true);
      await expect(msTeamsApprovalCapability.native?.resolveOriginTarget?.(input)).resolves.toEqual(
        {
          to: `conversation:${CONVERSATION_ID}`,
          accountId: "default",
          threadId: threadId ?? "source-root",
        },
      );
    },
  );

  it("rejects default-mode user aliases and channel sources with no root identity", async () => {
    for (const request of [
      createExecRequest({ turnSourceTo: `user:${APPROVER_ID}` }),
      createExecRequest(),
    ]) {
      const binding = request.request.authorization?.requesterBinding;
      if (binding?.state === "bound" && request.request.turnSourceTo?.startsWith("conversation:")) {
        request.request.authorization = {
          ...request.request.authorization!,
          requesterBinding: {
            ...binding,
            sources: binding.sources.map((source) => ({ ...source, messageId: "" })),
          },
        };
      }
      await expect(
        msTeamsApprovalCapability.native?.resolveOriginTarget?.({
          cfg: createConfig(),
          request,
          accountId: "default",
          approvalKind: "exec",
        }),
      ).resolves.toBeNull();
    }
  });

  it("suppresses unsafe forwarding even when the bound origin has zero delivery targets", async () => {
    const request = createExecRequest();
    storedConversations.clear();
    const input = {
      cfg: createConfig(),
      accountId: "default",
      approvalKind: "exec" as const,
      request,
    };
    expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(true);
    await expect(
      msTeamsApprovalCapability.native?.resolveOriginTarget?.(input),
    ).resolves.toBeNull();
    expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
    for (const to of [
      `user:${APPROVER_ID}`,
      `conversation:${CONVERSATION_ID}`,
      "conversation:19:other@thread.v2",
    ]) {
      expect(
        msTeamsApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
          ...input,
          target: { channel: "msteams", to },
        }),
      ).toBe(true);
    }
  });

  it("never fans native cards out to the approver roster", () => {
    expect(
      msTeamsApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg: createConfig(),
        accountId: "default",
        approvalKind: "exec",
        request: createExecRequest(),
      }),
    ).toEqual([]);
  });

  it("suppresses the duplicate text prompt only while native exec delivery owns it", () => {
    expect(
      shouldSuppressLocalMSTeamsExecApprovalPrompt({
        cfg: createConfig(),
        payload: pendingExecPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalMSTeamsExecApprovalPrompt({
        cfg: createConfig(),
        payload: pendingExecPayload,
        hint: { ...activeExecApprovalHint, nativeRouteActive: false },
      }),
    ).toBe(false);

    expect(
      shouldSuppressLocalMSTeamsExecApprovalPrompt({
        cfg: createConfig({ approvals: { exec: { enabled: false } } }),
        payload: pendingExecPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(false);
  });

  it("describes the existing Teams allowlist and default destination setup", () => {
    const guidance = msTeamsApprovalCapability.describeExecApprovalSetup?.({
      channel: "msteams",
      channelLabel: "Microsoft Teams",
    });

    expect(guidance).toContain("`channels.msteams.allowFrom`");
    expect(guidance).toContain("`channels.msteams.defaultTo`");
  });
});

describe("Microsoft Teams requester-only native approvals", () => {
  const REQUESTER_ID = APPROVER_ID;
  const COLLEAGUE_ID = OTHER_USER_ID;
  const REQUESTER_CHAT = "a:1requester-chat";
  const COLLEAGUE_CHAT = "a:1colleague-chat";

  function createRequesterOnlyConfig(
    teams: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>> = {},
  ): OpenClawConfig {
    return createConfig({
      approvals: { exec: { enabled: true }, plugin: { enabled: true } },
      teams: {
        allowFrom: [REQUESTER_ID, COLLEAGUE_ID],
        approvals: { requesterOnly: true },
        ...teams,
      },
    });
  }

  function createDirectRequest(
    overrides: Partial<ExecApprovalRequest["request"]> = {},
  ): ExecApprovalRequest {
    const message = {
      messageId: "message-1",
      conversationId: REQUESTER_CHAT,
      conversationKind: "direct" as const,
      eventKind: "message" as const,
    };
    return createExecRequest({
      runId: "queued-follow-up",
      sessionKey: "agent:main:main",
      turnSourceTo: `conversation:${REQUESTER_CHAT}`,
      authorization: {
        version: 1,
        source: {
          version: 1,
          runId: "queued-follow-up",
          sessionKey: "agent:main:main",
          revision: 2,
          completeness: "complete",
          inputs: [
            {
              inputId: "input-queued",
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
          sourceRevision: 2,
          sources: [message],
        },
        policy: {
          requireResolverMatch: true,
          delivery: "requester",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
      ...overrides,
    });
  }

  function personal(aadObjectId: string, conversationId: string): StoredConversationReference {
    return {
      user: { aadObjectId },
      aadObjectId,
      conversation: { id: conversationId, conversationType: "personal" },
    };
  }

  beforeEach(() => {
    approvalRuntimeVersion.current = 2;
    storedConversations.clear();
    storedConversations.set(REQUESTER_CHAT, personal(REQUESTER_ID, REQUESTER_CHAT));
    storedConversations.set(COLLEAGUE_CHAT, personal(COLLEAGUE_ID, COLLEAGUE_CHAT));
  });

  it("delivers queued follow-up approvals from the core binding without roster fanout", async () => {
    const cfg = createRequesterOnlyConfig();
    const request = createDirectRequest();
    const input = { cfg, accountId: "default", approvalKind: "exec" as const, request };

    expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(true);
    await expect(
      msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
    ).resolves.toEqual({
      to: `conversation:${REQUESTER_CHAT}`,
      accountId: "default",
      threadId: null,
    });
    expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
  });

  it.each([
    {
      kind: "channel" as const,
      id: CONVERSATION_ID,
      type: "channel",
      threadId: "thread-root",
      messageId: "reply",
    },
    {
      kind: "channel" as const,
      id: CONVERSATION_ID,
      type: "channel",
      threadId: undefined,
      messageId: "new-root",
    },
    {
      kind: "group" as const,
      id: "19:group@thread.v2",
      type: "groupChat",
      threadId: undefined,
      messageId: "group-message",
    },
  ])(
    "routes a bound $kind request to its origin independently of session targets",
    async ({ kind, id, type, threadId, messageId }) => {
      const cfg = createRequesterOnlyConfig();
      const request = createDirectRequest({
        turnSourceTo: `user:${COLLEAGUE_ID}`,
        turnSourceThreadId: "wrong-routing-thread",
      });
      const authorization = request.request.authorization;
      if (!authorization || authorization.requesterBinding.state !== "bound") {
        throw new Error("Expected bound fixture");
      }
      const message = {
        conversationId: id,
        conversationKind: kind,
        threadId,
        messageId,
        eventKind: "message" as const,
      };
      request.request.authorization = {
        ...authorization,
        requesterBinding: { ...authorization.requesterBinding, sources: [message] },
        source: {
          ...authorization.source,
          inputs: authorization.source.inputs.map((input) =>
            input.origin === "user" ? { ...input, message } : input,
          ),
        },
      };
      const reference = { conversation: { id, conversationType: type }, aadObjectId: COLLEAGUE_ID };
      storedConversations.set(id, reference);
      const input = { cfg, accountId: "default", approvalKind: "exec" as const, request };
      expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(true);
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
      ).resolves.toEqual({
        to: `conversation:${id}`,
        accountId: "default",
        threadId: kind === "channel" ? (threadId ?? messageId) : null,
      });
      await expect(
        msTeamsApprovalCapability.native?.resolveOriginTarget?.(input),
      ).resolves.toMatchObject({ to: `conversation:${id}` });
      expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
      // Blocked notices must never disclose approval details in shared conversations.
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterNoticeTarget?.(input),
      ).resolves.toBeNull();
      for (const conversation of [
        { id, conversationType: "personal" },
        { id: "19:wrong@thread.v2", conversationType: type },
      ]) {
        storedConversations.set(id, { ...reference, conversation });
        await expect(
          msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
        ).resolves.toBeNull();
        expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
      }
      storedConversations.delete(id);
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
      ).resolves.toBeNull();
    },
  );

  it("does not deliver when the stored chat is not the requester's personal chat", async () => {
    const cfg = createRequesterOnlyConfig();
    for (const reference of [
      personal(COLLEAGUE_ID, REQUESTER_CHAT),
      { ...personal(REQUESTER_ID, REQUESTER_CHAT), conversation: { id: REQUESTER_CHAT } },
    ]) {
      storedConversations.set(REQUESTER_CHAT, reference);
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterTarget?.({
          cfg,
          accountId: "default",
          approvalKind: "exec",
          request: createDirectRequest(),
        }),
      ).resolves.toBeNull();
    }
    storedConversations.delete(REQUESTER_CHAT);
    await expect(
      msTeamsApprovalCapability.native?.resolveRequesterTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: createDirectRequest(),
      }),
    ).resolves.toBeNull();
  });

  it.each<NonNullable<ExecApprovalRequest["request"]["authorization"]>["requesterBinding"]>([
    { state: "non-user", origins: ["cron"] },
    { state: "mixed", reason: "mixed-origins" },
    { state: "mixed", reason: "different-actors" },
    { state: "unavailable", reason: "missing-source" },
  ])("fails closed for a $state binding: no card to anyone", async (requesterBinding) => {
    const cfg = createRequesterOnlyConfig();
    const request = createDirectRequest();
    const authorization = request.request.authorization;
    if (!authorization) {
      throw new Error("Expected authorization fixture");
    }
    const input = {
      cfg,
      accountId: "default",
      approvalKind: "exec" as const,
      request: {
        ...request,
        request: { ...request.request, authorization: { ...authorization, requesterBinding } },
      },
    };

    expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(false);
    await expect(
      msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
    ).resolves.toBeNull();
    expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
  });

  it.each(["cron", "heartbeat"] as const)(
    "withholds all card and shared-notice targets for a genuine %s run",
    async (origin) => {
      const request = createDirectRequest();
      const authorization = request.request.authorization;
      if (!authorization) {
        throw new Error("Expected authorization fixture");
      }
      request.request.authorization = {
        ...authorization,
        source: {
          ...authorization.source,
          inputs: [{ inputId: "scheduled-input", origin }],
        },
        requesterBinding: { state: "non-user", origins: [origin] },
      };
      const input = {
        cfg: createRequesterOnlyConfig(),
        accountId: "default",
        approvalKind: "exec" as const,
        request,
      };
      expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(false);
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
      ).resolves.toBeNull();
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterNoticeTarget?.(input),
      ).resolves.toBeNull();
      expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
    },
  );

  it("admits roster actors to core custody and leaves /approve to the central requester check", () => {
    const cfg = createRequesterOnlyConfig();
    for (const approvalKind of ["exec", "plugin", "system-agent"] as const) {
      for (const senderId of [REQUESTER_ID, COLLEAGUE_ID]) {
        expect(
          msTeamsApprovalCapability.authorizeActorAction?.({
            cfg,
            senderId,
            action: "approve",
            approvalKind,
          }),
        ).toEqual({ authorized: true });
      }
    }
    for (const approvalKind of ["exec", "plugin"] as const) {
      expect(
        msTeamsApprovalCapability.resolveApproveCommandBehavior?.({
          cfg,
          senderId: REQUESTER_ID,
          approvalKind,
        }),
      ).toBeUndefined();
    }
  });

  it.each([undefined, 1])(
    "denies requester-only /approve without the matched V2 core runtime (version=%s)",
    (version) => {
      const cfg = createRequesterOnlyConfig();
      approvalRuntimeVersion.current = version;
      try {
        const result = msTeamsApprovalCapability.authorizeActorAction?.({
          cfg,
          senderId: REQUESTER_ID,
          accountId: "default",
          action: "approve",
          approvalKind: "exec",
        });
        expect(result).toMatchObject({ authorized: false });
        expect(result?.reason).toMatch(/upgrade|matched/i);
        expect(
          msTeamsApprovalCapability.authorizeActorAction?.({
            cfg,
            authorization: createDirectRequest().request.authorization,
            senderId: REQUESTER_ID,
            accountId: "default",
            action: "approve",
            approvalKind: "exec",
          }),
        ).toEqual({ authorized: true });
      } finally {
        approvalRuntimeVersion.current = 2;
      }
    },
  );

  it("requires an explicit roster for config and stamped requester-only requests", () => {
    const authorization = createDirectRequest().request.authorization;
    for (const approvals of [{ requesterOnly: true }, { requesterOnly: false }]) {
      expect(
        msTeamsApprovalCapability.authorizeActorAction?.({
          cfg: createRequesterOnlyConfig({ approvals, allowFrom: undefined }),
          authorization,
          senderId: REQUESTER_ID,
          action: "approve",
          approvalKind: "exec",
        }),
      ).toMatchObject({ authorized: false });
    }
  });

  it("registers blocked notices with no roster or forwarding while denying card delivery", async () => {
    const cfg = createConfig({
      approvals: { exec: { enabled: false }, plugin: { enabled: false } },
      teams: { approvals: { requesterOnly: true }, allowFrom: [] },
    });
    const input = {
      cfg,
      accountId: "default",
      approvalKind: "exec" as const,
      request: createDirectRequest(),
    };
    expect(isMSTeamsNativeApprovalClientEnabled({ cfg })).toBe(true);
    expect(
      msTeamsApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
      }),
    ).toBe(true);
    expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(false);
    await expect(
      msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
    ).resolves.toBeNull();
    await expect(
      msTeamsApprovalCapability.native?.resolveRequesterNoticeTarget?.(input),
    ).resolves.toMatchObject({
      to: `conversation:${REQUESTER_CHAT}`,
    });
    expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
  });

  it("revalidates stamped conversation scope during resolution after the option is disabled", () => {
    const cfg = createRequesterOnlyConfig({ approvals: { requesterOnly: false } });
    const authorization = createDirectRequest().request.authorization;
    if (!authorization || authorization.requesterBinding.state !== "bound") {
      throw new Error("Expected bound authorization fixture");
    }
    const input = {
      cfg,
      accountId: "default",
      senderId: REQUESTER_ID,
      action: "approve" as const,
      approvalKind: "exec" as const,
    };
    expect(
      msTeamsApprovalCapability.authorizeActorAction?.({
        ...input,
        authorization,
      }),
    ).toEqual({ authorized: true });
    const groupMessage = {
      messageId: "group-message",
      conversationId: "19:group@thread.v2",
      conversationKind: "group" as const,
      eventKind: "message" as const,
    };
    const groupAuthorization: NonNullable<ExecApprovalRequest["request"]["authorization"]> = {
      ...authorization,
      source: {
        ...authorization.source,
        inputs: authorization.source.inputs.map((sourceInput) =>
          sourceInput.origin === "user" ? { ...sourceInput, message: groupMessage } : sourceInput,
        ),
      },
      requesterBinding: { ...authorization.requesterBinding, sources: [groupMessage] },
    };
    expect(
      msTeamsApprovalCapability.authorizeActorAction?.({
        ...input,
        authorization: groupAuthorization,
      }),
    ).toEqual({ authorized: true });
  });

  it("keeps a stamped request strict after the option is disabled", async () => {
    const cfg = createRequesterOnlyConfig({ approvals: { requesterOnly: false } });
    const input = {
      cfg,
      accountId: "default",
      approvalKind: "exec" as const,
      request: createDirectRequest(),
    };
    await expect(
      msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
    ).resolves.toMatchObject({
      to: `conversation:${REQUESTER_CHAT}`,
    });
    expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
  });

  it.each([
    { state: "mixed" as const, reason: "mixed-origins" as const },
    { state: "unavailable" as const, reason: "missing-message-identity" as const },
  ])(
    "supplies only a verified personal target for a $state blocked notice",
    async (requesterBinding) => {
      const request = createDirectRequest();
      const authorization = request.request.authorization;
      if (!authorization) {
        throw new Error("Expected authorization fixture");
      }
      const userInput = authorization.source.inputs[0];
      if (userInput?.origin !== "user") {
        throw new Error("Expected user fixture");
      }
      const mixedRequest = {
        ...request,
        request: {
          ...request.request,
          authorization: {
            ...authorization,
            source: {
              ...authorization.source,
              inputs:
                requesterBinding.state === "mixed"
                  ? [
                      ...authorization.source.inputs,
                      { inputId: "system-1", origin: "system" as const },
                    ]
                  : [{ ...userInput, message: { ...userInput.message, messageId: "" } }],
            },
            requesterBinding,
          },
        },
      };
      const input = {
        cfg: createRequesterOnlyConfig(),
        accountId: "default",
        approvalKind: "exec" as const,
        request: mixedRequest,
      };
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterTarget?.(input),
      ).resolves.toBeNull();
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterNoticeTarget?.(input),
      ).resolves.toMatchObject({
        to: `conversation:${REQUESTER_CHAT}`,
      });
      storedConversations.set(REQUESTER_CHAT, personal(COLLEAGUE_ID, REQUESTER_CHAT));
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterNoticeTarget?.(input),
      ).resolves.toBeNull();
    },
  );

  it("withholds blocked notices for unavailable provenance or different senders", async () => {
    const request = createDirectRequest();
    const authorization = request.request.authorization;
    const userInput = authorization?.source.inputs[0];
    if (!authorization || userInput?.origin !== "user") {
      throw new Error("Expected user fixture");
    }
    for (const source of [
      { ...authorization.source, completeness: "unavailable" as const },
      {
        ...authorization.source,
        inputs: [
          userInput,
          {
            ...userInput,
            inputId: "other-user",
            actor: { ...userInput.actor, senderId: COLLEAGUE_ID },
          },
        ],
      },
    ]) {
      await expect(
        msTeamsApprovalCapability.native?.resolveRequesterNoticeTarget?.({
          cfg: createRequesterOnlyConfig(),
          accountId: "default",
          approvalKind: "exec",
          request: {
            ...request,
            request: {
              ...request.request,
              authorization: {
                ...authorization,
                source,
                requesterBinding: { state: "unavailable", reason: "missing-source" },
              },
            },
          },
        }),
      ).resolves.toBeNull();
    }
  });

  it("suppresses generic text forwarding and local prompts into Teams chats", () => {
    const cfg = createRequesterOnlyConfig();
    const shouldSuppress = msTeamsApprovalCapability.delivery?.shouldSuppressForwardingFallback;
    for (const request of [
      createDirectRequest(),
      createDirectRequest({ turnSourceChannel: "slack" }),
    ]) {
      expect(
        shouldSuppress?.({
          cfg,
          approvalKind: "exec",
          target: { channel: "msteams", to: "conversation:19:team@thread.v2" },
          request,
        }),
      ).toBe(true);
    }
    expect(
      shouldSuppress?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "slack", to: "channel:C1" },
        request: createDirectRequest(),
      }),
    ).toBe(false);
    expect(
      shouldSuppressLocalMSTeamsExecApprovalPrompt({
        cfg,
        payload: pendingExecPayload,
        hint: { ...activeExecApprovalHint, nativeRouteActive: false },
      }),
    ).toBe(true);
  });

  it("keeps roster authorization and origin delivery without DM fan-out when the option is absent or false", async () => {
    for (const approvals of [undefined, {}, { requesterOnly: false }]) {
      const cfg = createConfig({
        teams: { allowFrom: [REQUESTER_ID, COLLEAGUE_ID], approvals },
      });
      storedConversations.set(CONVERSATION_ID, {
        conversation: { id: CONVERSATION_ID, conversationType: "channel" },
      });
      const request = createExecRequest();
      const input = { cfg, accountId: "default", approvalKind: "exec" as const, request };
      expect(shouldHandleMSTeamsNativeApprovalRequest(input)).toBe(true);
      expect(await msTeamsApprovalCapability.native?.resolveOriginTarget?.(input)).toEqual({
        to: `conversation:${CONVERSATION_ID}`,
        accountId: "default",
        threadId: "source-root",
      });
      expect(msTeamsApprovalCapability.native?.resolveApproverDmTargets?.(input)).toEqual([]);
      expect(
        msTeamsApprovalCapability.authorizeActorAction?.({
          cfg,
          senderId: COLLEAGUE_ID,
          action: "approve",
          approvalKind: "exec",
        }),
      ).toEqual({ authorized: true });
      expect(
        msTeamsApprovalCapability.resolveApproveCommandBehavior?.({
          cfg,
          senderId: COLLEAGUE_ID,
          approvalKind: "exec",
        }),
      ).toBeUndefined();
    }
  });
});
