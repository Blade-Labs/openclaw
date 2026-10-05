import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  classifyMSTeamsApprovalRequester,
  isMSTeamsRequesterDeliveryTarget,
  isMSTeamsRequesterOnlyApprovals,
  isMSTeamsRequesterOnlyRequest,
  verifyMSTeamsRequesterConversation,
} from "./approval-requester.js";
import { MSTeamsConfigSchema } from "./config-schema.js";
import type { StoredConversationReference } from "./conversation-store.js";

const REQUESTER_ID = "40a1a0ed-4ff2-4164-a219-55518990c197";
const OTHER_USER_ID = "b2d381f1-36dd-4120-b6fb-8dd37388ff11";
const PERSONAL_CONVERSATION_ID = "a:1requester-personal-chat";
const OTHER_PERSONAL_CONVERSATION_ID = "a:1other-personal-chat";
type Authorization = NonNullable<ExecApprovalRequest["request"]["authorization"]>;
type Binding = Authorization["requesterBinding"];

function createConfig(
  teams: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>> = {},
): OpenClawConfig {
  return {
    channels: {
      msteams: {
        allowFrom: [REQUESTER_ID, OTHER_USER_ID],
        approvals: { requesterOnly: true },
        ...teams,
      },
    },
  };
}

function createAuthorization(): Authorization {
  const message = {
    messageId: "message-1",
    conversationId: PERSONAL_CONVERSATION_ID,
    conversationKind: "direct" as const,
    eventKind: "message" as const,
  };
  return {
    version: 1,
    source: {
      version: 1,
      runId: "queued-follow-up",
      sessionKey: "agent:main:main",
      revision: 1,
      completeness: "complete",
      inputs: [
        {
          inputId: "input-1",
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
      sessionKey: "agent:main:main",
      runId: "queued-follow-up",
      sourceRevision: 1,
      sources: [message],
    },
    policy: {
      requireResolverMatch: true,
      delivery: "requester",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}

function createExecRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    id: "approval-1",
    request: { command: "echo hello", authorization: createAuthorization(), ...overrides },
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
  it("requires explicit configuration or a latched strict request", () => {
    expect(isMSTeamsRequesterOnlyApprovals(createConfig())).toBe(true);
    for (const approvals of [undefined, {}, { requesterOnly: false }]) {
      const cfg = createConfig({ approvals });
      expect(isMSTeamsRequesterOnlyApprovals(cfg)).toBe(false);
      expect(isMSTeamsRequesterOnlyRequest(cfg, createExecRequest())).toBe(true);
      expect(
        isMSTeamsRequesterOnlyRequest(cfg, createExecRequest({ authorization: undefined })),
      ).toBe(false);
    }
    expect(isMSTeamsRequesterOnlyApprovals(undefined)).toBe(false);
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

  it.each([undefined, "agent:main:main", "agent:main:direct:linked-identity"])(
    "uses the core actor binding independently of session routing %s",
    (sessionKey) => {
      const cfg = createConfig();
      cfg.session = { identityLinks: { shared: [`msteams:${OTHER_USER_ID}`] } };
      expect(
        classifyMSTeamsApprovalRequester({
          cfg,
          request: createExecRequest({ sessionKey }),
        }),
      ).toEqual({
        ok: true,
        requester: {
          aadObjectId: REQUESTER_ID,
          target: { kind: "conversation", conversationId: PERSONAL_CONVERSATION_ID },
        },
      });
    },
  );

  it.each<Binding>([
    { state: "mixed", reason: "different-actors" },
    { state: "mixed", reason: "mixed-origins" },
    { state: "non-user", origins: ["cron"] },
    { state: "unavailable", reason: "missing-source" },
  ])("fails closed for a $state core binding", (requesterBinding) => {
    const authorization = { ...createAuthorization(), requesterBinding };
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig(),
        request: createExecRequest({ authorization }),
      }),
    ).toMatchObject({ ok: false });
  });

  it.each([
    { channel: "slack" },
    { accountId: "work" },
    { senderId: "29:framework-id" },
    { sources: [] },
    {
      sources: [
        {
          messageId: "group-message",
          conversationId: "19:group@thread.v2",
          conversationKind: "group" as const,
          eventKind: "message" as const,
        },
      ],
    },
  ])("fails closed for an unsupported bound actor or source %j", (overrides) => {
    const authorization = createAuthorization();
    if (authorization.requesterBinding.state !== "bound") {
      throw new Error("Expected bound fixture");
    }
    const request = createExecRequest({
      authorization: {
        ...authorization,
        requesterBinding: { ...authorization.requesterBinding, ...overrides },
      },
    });
    expect(classifyMSTeamsApprovalRequester({ cfg: createConfig(), request })).toMatchObject({
      ok: false,
    });
  });

  it("rejects missing provenance and requires current explicit roster membership", () => {
    expect(
      classifyMSTeamsApprovalRequester({
        cfg: createConfig(),
        request: createExecRequest({ authorization: undefined }),
      }),
    ).toMatchObject({ ok: false });
    for (const allowFrom of [undefined, [], [OTHER_USER_ID]]) {
      expect(
        classifyMSTeamsApprovalRequester({
          cfg: createConfig({ allowFrom }),
          request: createExecRequest(),
        }),
      ).toMatchObject({ ok: false });
    }
  });

  it("uses the same core binding for plugin and system-agent approvals", () => {
    const shared = { authorization: createAuthorization() };
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
      expect(classifyMSTeamsApprovalRequester({ cfg: createConfig(), request })).toMatchObject({
        ok: true,
        requester: { aadObjectId: REQUESTER_ID },
      });
    }
  });

  it("prefers the bound personal chat, otherwise only the same sender's verified DM", async () => {
    const requester = {
      aadObjectId: REQUESTER_ID,
      target: { kind: "conversation" as const, conversationId: PERSONAL_CONVERSATION_ID },
    };
    const store = createStore({ [PERSONAL_CONVERSATION_ID]: personalReference(REQUESTER_ID) });
    await expect(verifyMSTeamsRequesterConversation({ requester, store })).resolves.toBe(
      PERSONAL_CONVERSATION_ID,
    );
    expect(store.findPreferredDmByUserId).not.toHaveBeenCalled();
    const fallbackStore = createStore({
      [PERSONAL_CONVERSATION_ID]: personalReference(OTHER_USER_ID),
      [OTHER_PERSONAL_CONVERSATION_ID]: personalReference(REQUESTER_ID, {
        conversation: { id: OTHER_PERSONAL_CONVERSATION_ID, conversationType: "personal" },
      }),
    });
    await expect(
      verifyMSTeamsRequesterConversation({
        requester,
        store: fallbackStore,
      }),
    ).resolves.toBe(OTHER_PERSONAL_CONVERSATION_ID);
    expect(fallbackStore.findPreferredDmByUserId).toHaveBeenCalledWith(REQUESTER_ID);
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
      verifyMSTeamsRequesterConversation({
        requester,
        store: createStore({}),
      }),
    ).resolves.toBeNull();
  });

  it("re-checks personal destination ownership at the send boundary", async () => {
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
