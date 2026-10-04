import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyMSTeamsApprovalRequester,
  clearMSTeamsRequesterTurnRuns,
  isMSTeamsApprovalRequesterSender,
  isMSTeamsRequesterDeliveryTarget,
  isMSTeamsRequesterOnlyApprovals,
  recordMSTeamsRequesterTurnRun,
  verifyMSTeamsRequesterConversation,
} from "./approval-requester.js";
import { MSTeamsConfigSchema } from "./config-schema.js";
import type { StoredConversationReference } from "./conversation-store.js";

const REQUESTER_ID = "40a1a0ed-4ff2-4164-a219-55518990c197";
const OTHER_USER_ID = "b2d381f1-36dd-4120-b6fb-8dd37388ff11";
const PERSONAL_CONVERSATION_ID = "a:1requester-personal-chat";
const OTHER_PERSONAL_CONVERSATION_ID = "a:1other-personal-chat";

function createConfig(
  teams: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>> = {},
  extra: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  return {
    ...extra,
    channels: {
      msteams: {
        allowFrom: [REQUESTER_ID, OTHER_USER_ID],
        approvals: { requesterOnly: true },
        ...teams,
      },
    },
  };
}

function createExecRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    id: "approval-1",
    request: {
      command: "echo hello",
      runId: "run-1",
      sessionKey: `agent:main:msteams:direct:${REQUESTER_ID}`,
      turnSourceChannel: "msteams",
      turnSourceTo: `conversation:${PERSONAL_CONVERSATION_ID}`,
      turnSourceAccountId: "default",
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
}

function personalReference(
  aadObjectId: string,
  overrides: Partial<StoredConversationReference> = {},
): StoredConversationReference {
  return {
    user: { id: `29:${aadObjectId}`, aadObjectId },
    aadObjectId,
    conversation: { id: PERSONAL_CONVERSATION_ID, conversationType: "personal" },
    ...overrides,
  };
}

function createStore(entries: Record<string, StoredConversationReference>) {
  return {
    get: vi.fn(async (conversationId: string) => entries[conversationId] ?? null),
    findPreferredDmByUserId: vi.fn(async (userId: string) => {
      const match = Object.entries(entries).find(
        ([, reference]) => reference.aadObjectId === userId,
      );
      return match ? { conversationId: match[0], reference: match[1] } : null;
    }),
  };
}

describe("Microsoft Teams requester-only approval policy", () => {
  beforeEach(() => {
    clearMSTeamsRequesterTurnRuns();
    recordMSTeamsRequesterTurnRun({
      runId: "run-1",
      sessionKey: `agent:main:msteams:direct:${REQUESTER_ID}`,
      aadObjectId: REQUESTER_ID,
    });
  });

  it("is enabled only by an explicit true", () => {
    expect(isMSTeamsRequesterOnlyApprovals(createConfig())).toBe(true);
    expect(isMSTeamsRequesterOnlyApprovals(createConfig({ approvals: {} }))).toBe(false);
    expect(
      isMSTeamsRequesterOnlyApprovals(createConfig({ approvals: { requesterOnly: false } })),
    ).toBe(false);
    expect(isMSTeamsRequesterOnlyApprovals(createConfig({ approvals: undefined }))).toBe(false);
    expect(isMSTeamsRequesterOnlyApprovals(undefined)).toBe(false);
  });

  it("accepts the approvals block in the strict channel schema", () => {
    expect(MSTeamsConfigSchema.parse({ approvals: { requesterOnly: true } })).toMatchObject({
      approvals: { requesterOnly: true },
    });
    expect(MSTeamsConfigSchema.safeParse({ approvals: { requesterOnly: "yes" } }).success).toBe(
      false,
    );
    expect(
      MSTeamsConfigSchema.safeParse({ approvals: { approvers: [REQUESTER_ID] } }).success,
    ).toBe(false);
  });

  it.each([
    `agent:main:msteams:direct:${REQUESTER_ID}`,
    `agent:main:msteams:direct:${REQUESTER_ID.toUpperCase()}`,
    `agent:ops:msteams:default:direct:${REQUESTER_ID}`,
    `agent:main:direct:${REQUESTER_ID}`,
  ])("identifies the requester from the direct session %s", (sessionKey) => {
    recordMSTeamsRequesterTurnRun({
      runId: "run-variant",
      sessionKey,
      aadObjectId: REQUESTER_ID,
    });
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig(),
        request: createExecRequest({ sessionKey, runId: "run-variant" }),
      }),
    ).toEqual({
      ok: true,
      requester: {
        aadObjectId: REQUESTER_ID,
        target: { kind: "conversation", conversationId: PERSONAL_CONVERSATION_ID },
      },
    });
  });

  it.each([
    { name: "dmScope main", sessionKey: "agent:main:main" },
    { name: "isolated cron run", sessionKey: "agent:main:cron:nightly:run:1" },
    { name: "subagent", sessionKey: `agent:main:subagent:${REQUESTER_ID}` },
    { name: "group chat", sessionKey: "agent:main:msteams:group:19:abc@thread.v2" },
    { name: "channel", sessionKey: "agent:main:msteams:channel:19:abc@thread.tacv2" },
    {
      name: "thread suffix",
      sessionKey: `agent:main:msteams:direct:${REQUESTER_ID}:thread:123`,
    },
    {
      name: "embedded direct segment",
      sessionKey: `agent:main:cron:x:msteams:direct:${REQUESTER_ID}`,
    },
    { name: "other account", sessionKey: `agent:main:msteams:work:direct:${REQUESTER_ID}` },
    { name: "non-uuid peer", sessionKey: "agent:main:msteams:direct:29:bot-framework-id" },
    { name: "missing session", sessionKey: undefined },
  ])("rejects a $name session key", ({ sessionKey }) => {
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig(),
        request: createExecRequest({ sessionKey }),
      }),
    ).toEqual({ ok: false, reason: "session-key" });
  });

  it.each([
    { name: "a user alias for the same person", to: `user:${REQUESTER_ID.toUpperCase()}` },
    { name: "a bare user id for the same person", to: REQUESTER_ID },
  ])("accepts $name as the turn source", ({ to }) => {
    const result = classifyMSTeamsApprovalRequester({
      cfg: createConfig(),
      request: createExecRequest({ turnSourceTo: to }),
    });
    expect(result).toEqual({
      ok: true,
      requester: { aadObjectId: REQUESTER_ID, target: { kind: "user", userId: REQUESTER_ID } },
    });
  });

  it.each([
    { name: "another user", to: `user:${OTHER_USER_ID}` },
    { name: "another bare user id", to: OTHER_USER_ID },
    { name: "a group chat", to: "conversation:19:abc@thread.v2" },
    { name: "a channel", to: "conversation:19:abc@thread.tacv2" },
    { name: "an unknown conversation form", to: "conversation:8:orgid:someone" },
    { name: "an email alias", to: "user:someone@example.com" },
    { name: "a missing turn source", to: undefined },
  ])("rejects $name as the turn source", ({ to }) => {
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig(),
        request: createExecRequest({ turnSourceTo: to }),
      }),
    ).toEqual({ ok: false, reason: "turn-source-target" });
  });

  it("rejects other channels, other accounts and scheduled exec provenance", () => {
    const cfg = createConfig();
    expect(
      classifyMSTeamsApprovalRequester({
        cfg,
        request: createExecRequest({ turnSourceChannel: "slack" }),
      }),
    ).toEqual({ ok: false, reason: "turn-source-channel" });
    expect(
      classifyMSTeamsApprovalRequester({
        cfg,
        request: createExecRequest({ turnSourceAccountId: "work" }),
      }),
    ).toEqual({ ok: false, reason: "turn-source-account" });
    expect(
      classifyMSTeamsApprovalRequester({
        cfg,
        request: createExecRequest({
          cronExecutionSource: { jobId: "nightly", jobConfigRevision: "1" },
        }),
      }),
    ).toEqual({ ok: false, reason: "scheduled-job" });
    expect(
      classifyMSTeamsApprovalRequester({
        cfg,
        request: createExecRequest({ cronOperationBinding: "binding" }),
      }),
    ).toEqual({ ok: false, reason: "scheduled-job" });
  });

  it.each([
    {
      name: "a run no Teams message started (scheduled job in the user's session)",
      runId: "cron:nightly:1",
    },
    { name: "a missing run id", runId: undefined },
  ])("rejects $name", ({ runId }) => {
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig(),
        request: createExecRequest({ runId }),
      }),
    ).toEqual({ ok: false, reason: "not-a-user-turn" });
  });

  it("rejects runs recorded for another user, another session, or after expiry", () => {
    recordMSTeamsRequesterTurnRun({
      runId: "run-other-user",
      sessionKey: `agent:main:msteams:direct:${REQUESTER_ID}`,
      aadObjectId: OTHER_USER_ID,
    });
    recordMSTeamsRequesterTurnRun({
      runId: "run-other-session",
      sessionKey: `agent:main:msteams:direct:${OTHER_USER_ID}`,
      aadObjectId: REQUESTER_ID,
    });
    recordMSTeamsRequesterTurnRun({
      runId: "run-expired",
      sessionKey: `agent:main:msteams:direct:${REQUESTER_ID}`,
      aadObjectId: REQUESTER_ID,
      nowMs: Date.now() - 25 * 60 * 60_000,
    });
    for (const runId of ["run-other-user", "run-other-session", "run-expired"]) {
      expect(
        classifyMSTeamsApprovalRequester({
          cfg: createConfig(),
          request: createExecRequest({ runId }),
        }),
      ).toEqual({ ok: false, reason: "not-a-user-turn" });
    }
  });

  it("fails closed when identity links can rewrite the direct-session peer", () => {
    // A link can make another person's Teams identity resolve to the requester's UUID.
    const cfg = createConfig(
      {},
      { session: { identityLinks: { [REQUESTER_ID]: [`msteams:${OTHER_USER_ID}`] } } },
    );
    expect(classifyMSTeamsApprovalRequester({ cfg, request: createExecRequest() })).toEqual({
      ok: false,
      reason: "identity-links",
    });
  });

  it("requires the requester to be an explicitly configured approver", () => {
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig({ allowFrom: [OTHER_USER_ID] }),
        request: createExecRequest(),
      }),
    ).toEqual({ ok: false, reason: "not-an-approver" });
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig({ allowFrom: undefined }),
        request: createExecRequest(),
      }),
    ).toEqual({ ok: false, reason: "not-an-approver" });
  });

  it("identifies requesters for plugin and system-agent approvals", () => {
    const cfg = createConfig();
    const shared = {
      runId: "run-1",
      sessionKey: `agent:main:msteams:direct:${REQUESTER_ID}`,
      turnSourceChannel: "msteams",
      turnSourceTo: `conversation:${PERSONAL_CONVERSATION_ID}`,
    };
    const plugin: PluginApprovalRequest = {
      id: "plugin:1",
      request: { title: "Plugin", description: "Do it", ...shared },
      createdAtMs: 0,
      expiresAtMs: 1,
    };
    const systemAgent: SystemAgentApprovalRequest = {
      id: "system:1",
      request: {
        title: "System",
        description: "Do it",
        command: "x",
        proposalHash: "h",
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "s",
        ...shared,
      },
      createdAtMs: 0,
      expiresAtMs: 1,
    };
    for (const request of [plugin, systemAgent]) {
      expect(classifyMSTeamsApprovalRequester({ cfg, request })).toMatchObject({
        ok: true,
        requester: { aadObjectId: REQUESTER_ID },
      });
    }
  });

  it("accepts only the requester, while still an approver, as the acting sender", () => {
    const cfg = createConfig();
    expect(
      isMSTeamsApprovalRequesterSender({
        cfg,
        requesterAadObjectId: REQUESTER_ID,
        senderId: REQUESTER_ID.toUpperCase(),
      }),
    ).toBe(true);
    expect(
      isMSTeamsApprovalRequesterSender({
        cfg,
        requesterAadObjectId: REQUESTER_ID,
        senderId: OTHER_USER_ID,
      }),
    ).toBe(false);
    expect(
      isMSTeamsApprovalRequesterSender({
        cfg,
        requesterAadObjectId: undefined,
        senderId: REQUESTER_ID,
      }),
    ).toBe(false);
    expect(
      isMSTeamsApprovalRequesterSender({
        cfg: createConfig({ allowFrom: [OTHER_USER_ID] }),
        requesterAadObjectId: REQUESTER_ID,
        senderId: REQUESTER_ID,
      }),
    ).toBe(false);
  });

  it("verifies that the destination is the requester's own personal conversation", async () => {
    const requester = {
      aadObjectId: REQUESTER_ID,
      target: { kind: "conversation" as const, conversationId: PERSONAL_CONVERSATION_ID },
    };
    await expect(
      verifyMSTeamsRequesterConversation({
        requester,
        store: createStore({ [PERSONAL_CONVERSATION_ID]: personalReference(REQUESTER_ID) }),
      }),
    ).resolves.toBe(PERSONAL_CONVERSATION_ID);

    for (const reference of [
      personalReference(OTHER_USER_ID),
      personalReference(REQUESTER_ID, {
        conversation: { id: PERSONAL_CONVERSATION_ID, conversationType: "groupChat" },
      }),
      personalReference(REQUESTER_ID, { conversation: { id: PERSONAL_CONVERSATION_ID } }),
    ]) {
      await expect(
        verifyMSTeamsRequesterConversation({
          requester,
          store: createStore({ [PERSONAL_CONVERSATION_ID]: reference }),
        }),
      ).resolves.toBeNull();
    }
    await expect(
      verifyMSTeamsRequesterConversation({ requester, store: createStore({}) }),
    ).resolves.toBeNull();
  });

  it("resolves user turn sources to the requester's preferred personal conversation", async () => {
    const store = createStore({
      [OTHER_PERSONAL_CONVERSATION_ID]: personalReference(OTHER_USER_ID),
      [PERSONAL_CONVERSATION_ID]: personalReference(REQUESTER_ID),
    });
    await expect(
      verifyMSTeamsRequesterConversation({
        requester: { aadObjectId: REQUESTER_ID, target: { kind: "user", userId: REQUESTER_ID } },
        store,
      }),
    ).resolves.toBe(PERSONAL_CONVERSATION_ID);
    expect(store.findPreferredDmByUserId).toHaveBeenCalledWith(REQUESTER_ID);
  });

  it("re-checks delivery targets at the send boundary", async () => {
    const store = createStore({ [PERSONAL_CONVERSATION_ID]: personalReference(REQUESTER_ID) });
    await expect(
      isMSTeamsRequesterDeliveryTarget({
        to: `conversation:${PERSONAL_CONVERSATION_ID}`,
        aadObjectId: REQUESTER_ID,
        store,
      }),
    ).resolves.toBe(true);
    await expect(
      isMSTeamsRequesterDeliveryTarget({
        to: `conversation:${PERSONAL_CONVERSATION_ID}`,
        aadObjectId: OTHER_USER_ID,
        store,
      }),
    ).resolves.toBe(false);
    for (const to of [`user:${REQUESTER_ID}`, "conversation:19:abc@thread.v2"]) {
      await expect(
        isMSTeamsRequesterDeliveryTarget({ to, aadObjectId: REQUESTER_ID, store }),
      ).resolves.toBe(false);
    }
  });
});
