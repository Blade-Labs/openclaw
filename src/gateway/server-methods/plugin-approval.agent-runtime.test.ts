import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  getAdmittedRunDelegatedAuthority,
} from "../../agents/admitted-run-context.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { createHostChannelTurnSource } from "../../infra/host-turn-source.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  createPreparedTestApprovalManager,
  createTestApprovalFixture,
} from "../exec-approval-manager.test-support.js";
import { waitForApprovalRequested } from "./approval-request.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function executionIdentity() {
  return {
    tokenVersion: 1 as const,
    createdAt: 1,
    runId: "run-1",
    contextId: "context-1",
    executionId: "execution-1",
  };
}

function identityWithoutExecution(): AgentRuntimeIdentity {
  const operationalRunInstance = { instanceId: "instance-run-1", runId: "run-1" };
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: "generation-1",
      claimId: "claim-1",
    },
  };
}

function requestOptions(params: {
  request: Record<string, unknown>;
  identity: AgentRuntimeIdentity;
  validateAuthority?: () => boolean;
}): GatewayRequestHandlerOptions {
  return {
    req: { method: "plugin.approval.request", params: params.request, id: "req-1" },
    params: params.request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: params.identity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: params.validateAuthority ?? (() => true),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function requestHandler(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
): NonNullable<ReturnType<typeof createPluginApprovalHandlers>["plugin.approval.request"]> {
  const handler = createPluginApprovalHandlers(manager)["plugin.approval.request"];
  if (!handler) {
    throw new Error("plugin approval request handler is unavailable");
  }
  return handler;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin approval signed agent runtime", () => {
  it("freezes approval authorization from the admitted run rather than request routing", async (testContext) => {
    const admission = prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId: "synthetic-approval-run",
        agentId: "main",
        ingress: { kind: "system", boundary: "approval-test", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef("synthetic-approval-run"),
      sessionKey: "agent:main:synthetic-source",
      turnSource: createHostChannelTurnSource({
        actor: {
          channel: "test",
          accountId: "default",
          senderId: "synthetic-requester",
          actorKind: "human",
        },
        message: {
          messageId: "synthetic-message",
          conversationId: "synthetic-personal-chat",
          conversationKind: "direct",
          eventKind: "message",
        },
        policy: {
          requireResolverMatch: true,
          delivery: "requester",
          allowedDecisions: ["allow-once", "deny"],
        },
      }),
    });
    const admitted = await admission.admit("plugin-harness", "synthetic-plugin");
    const authority = getAdmittedRunDelegatedAuthority(admitted);
    if (!authority) {
      throw new Error("Missing admitted test authority");
    }
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    try {
      await fixture.run(async () => {
        const opts = requestOptions({
          request: {
            title: "Synthetic action",
            description: "Synthetic approval",
            twoPhase: true,
            turnSourceChannel: "synthetic-forged-channel",
            turnSourceTo: "synthetic-forged-chat",
            turnSourceAccountId: "synthetic-forged-account",
          },
          identity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:synthetic-source",
            operationalRunInstance: { ...admitted.operationalRunInstance },
            delegatedAuthority: { ...authority, kind: "local" },
            approvalOwnerPluginId: "synthetic-plugin",
          },
        });
        const delivered = createDeferredCore();
        opts.context.approvalEvents = {
          publishRequested: vi.fn(() => 1),
          publishResolved: vi.fn(),
          deliverRequester: vi.fn(async () => {
            delivered.resolve();
            return true;
          }),
        };
        const pending = fixture.track(Promise.resolve(requestHandler(fixture.manager)(opts)));
        await delivered.promise;
        const record = (await fixture.manager.listPendingRecords())[0];
        expect(record?.authorization).toMatchObject({
          requesterBinding: {
            state: "bound",
            channel: "test",
            accountId: "default",
            senderId: "synthetic-requester",
          },
          policy: { requireResolverMatch: true },
        });
        expect(Object.isFrozen(record?.authorization)).toBe(true);
        expect(opts.context.broadcast).not.toHaveBeenCalled();
        if (!record) {
          throw new Error("Expected pending approval");
        }
        await fixture.manager.forceDenyDetailed(record.id, "requester-unavailable", {
          kind: "system",
          id: null,
        });
        await pending;
        expect(await fixture.manager.getSnapshot(record.id)).toMatchObject({
          authorization: record.authorization,
          terminalReason: "requester-unavailable",
        });
      });
    } finally {
      admission.close();
    }
  });

  it("rejects closed authority before creating a plugin approval", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { title: "Sensitive action", description: "D" },
        identity: {
          ...identityWithoutExecution(),
          approvalOwnerPluginId: "codex",
        },
        validateAuthority: () => false,
      });

      await requestHandler(manager)(opts);

      expect(await manager.listPendingRecords()).toHaveLength(0);
      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining("no longer active"),
      });
    });
  });

  it("cancels a plugin approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { title: "Sensitive action", description: "D", twoPhase: true },
        identity: {
          ...identityWithoutExecution(),
          approvalOwnerPluginId: "codex",
        },
        validateAuthority: () => active,
      });
      const { pending } = await waitForApprovalRequested(
        opts.context,
        "plugin.approval.requested",
        () => fixture.track(Promise.resolve(requestHandler(manager)(opts))),
      );
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = (await manager.listPendingRecords())[0]!;
      active = false;

      await expect(manager.awaitDecision(record.id)).resolves.toBeNull();
      await pending;
      expect(await manager.getSnapshot(record.id)).toMatchObject({ status: "cancelled" });
    });
  });

  it("rejects a signed runtime without a host-resolved approval owner", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { pluginId: "forged", title: "Sensitive action", description: "D" },
        identity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:session-1",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
        },
      });

      await requestHandler(manager)(opts);

      expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
        message: expect.stringContaining("signed plugin approval owner is unavailable"),
      });
    });
  });

  it("uses signed runtime owner and route instead of forged request metadata", async (testContext) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(
      testContext,
      {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: () => true,
      },
    );
    const { manager, databaseOptions: options } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: {
          pluginId: "forged-plugin",
          title: "Sensitive action",
          description: "D",
          agentId: "forged-agent",
          sessionKey: "forged-session",
          turnSourceChannel: "forged-channel",
          turnSourceTo: "forged-target",
          twoPhase: true,
        },
        identity: {
          kind: "agentRuntime",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
          executionIdentity: executionIdentity(),
          approvalOwnerPluginId: "codex",
          agentId: "main",
          sessionKey: "agent:main:session-1",
          turnSourceChannel: "telegram",
          turnSourceTo: "chat-1",
          turnSourceAccountId: "default",
          turnSourceThreadId: "thread-1",
        },
      });

      const { pending } = await waitForApprovalRequested(
        opts.context,
        "plugin.approval.requested",
        () => fixture.track(Promise.resolve(requestHandler(manager)(opts))),
      );
      expect(opts.context.broadcast).toHaveBeenCalled();
      const broadcastPayload = vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as
        | { id?: unknown }
        | undefined;
      const approvalId = String(broadcastPayload?.id);
      expect((await manager.getSnapshot(approvalId))?.request).toMatchObject({
        pluginId: "codex",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "default",
        turnSourceThreadId: "thread-1",
      });
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
          )
          .get(approvalId),
      ).toEqual({
        approval_id: approvalId,
        source_context_id: "context-1",
        source_execution_id: "execution-1",
      });
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });

  it("does not create execution identity storage when collection is disabled", async (testContext) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(
      testContext,
      {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: () => true,
      },
    );
    const { manager, databaseOptions: options } = fixture;
    await fixture.run(async () => {
      const opts = requestOptions({
        request: { title: "Sensitive action", description: "D", twoPhase: true },
        identity: {
          kind: "agentRuntime",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
          approvalOwnerPluginId: "codex",
          agentId: "main",
          sessionKey: "agent:main:session-1",
        },
      });

      const { pending } = await waitForApprovalRequested(
        opts.context,
        "plugin.approval.requested",
        () => fixture.track(Promise.resolve(requestHandler(manager)(opts))),
      );
      expect(opts.context.broadcast).toHaveBeenCalled();
      const approvalId = String(
        (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id,
      );
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
          )
          .get(),
      ).toBeUndefined();
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });
});
