import { expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import { createHostChannelTurnSource } from "../infra/host-turn-source.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withRequesterApprovalChannel } from "./approval-requester.test-support.js";
import { createTestApprovalFixture } from "./exec-approval-manager.test-support.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import {
  createApprovalRequestPolicy,
  createContext,
  createDemoPolicy,
  createNodeSession,
  createOperatorClient,
  DEMO_COMMAND,
  DEMO_PARAMS,
  expectApprovalResolution,
  expectSinglePendingApproval,
  invokeDemoPolicy,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";

export function registerNodePolicyApprovalDeliveryTests() {
  it("forwards plugin policy approvals to the originating turn source", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const getApprovalClientConnIds = vi.fn(() => new Set<string>());
      const delivered = createDeferredCore();
      const handlePluginApprovalRequested = vi.fn(async () => {
        delivered.resolve();
        return true;
      });
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { context } = createContext({
        pluginApprovalManager: manager,
        getApprovalClientConnIds,
        hasExecApprovalClients: vi.fn(() => false),
        forwardPluginApprovalRequest: handlePluginApprovalRequested,
        validateAgentRuntimeApprovalAuthority: () => true,
      });
      const operationalRunInstance = createOperationalRunInstanceRef("run-node-policy");
      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () =>
          fixture.track(
            applyPluginNodeInvokePolicy({
              context,
              client: {
                ...createOperatorClient(),
                internal: {
                  agentRuntimeIdentity: {
                    kind: "agentRuntime",
                    agentId: "main",
                    sessionKey: "agent:main:telegram:direct:alice",
                    operationalRunInstance,
                    delegatedAuthority: {
                      kind: "local",
                      operationalRunInstance,
                      lifecycleGeneration: "test-generation",
                      claimId: "test-claim",
                    },
                  },
                },
              },
              nodeSession: createNodeSession(),
              command: DEMO_COMMAND,
              params: DEMO_PARAMS,
              sessionKey: "agent:main:spoofed",
              turnSource: {
                channel: "tui",
                to: "terminal",
                accountId: "default",
                threadId: 7,
              },
            }),
          ),
      );
      await Promise.race([
        delivered.promise,
        resultPromise.then(() => {
          throw new Error("Approval request ended before delivery");
        }),
      ]);
      expect(record.request.turnSourceChannel).toBe("tui");
      expect(record.request.turnSourceTo).toBe("terminal");
      expect(record.request.turnSourceAccountId).toBe("default");
      expect(record.request.turnSourceThreadId).toBe(7);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id: record.id }),
        new Set<string>(),
        { dropIfSlow: true },
      );
      expect(handlePluginApprovalRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: record.id,
          request: expect.objectContaining({
            turnSourceChannel: "tui",
            turnSourceTo: "terminal",
            turnSourceAccountId: "default",
            turnSourceThreadId: 7,
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:alice",
          }),
        }),
      );

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("delivers plugin policy approvals to visible iOS reviewers", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const delivered = createDeferredCore();
      const handleRequested = vi.fn(
        async (
          _request: PluginApprovalRequest,
          _opts?: {
            isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
          },
        ) => {
          delivered.resolve();
          return true;
        },
      );
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { context } = createContext({
        pluginApprovalManager: manager,
        getApprovalClientConnIds: vi.fn(() => new Set<string>()),
        hasExecApprovalClients: vi.fn(() => false),
        pluginApprovalIosPushDelivery: { handleRequested },
      });

      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(invokeDemoPolicy(context, createOperatorClient())),
      );
      await Promise.race([
        delivered.promise,
        resultPromise.then(() => {
          throw new Error("Approval request ended before delivery");
        }),
      ]);

      expect(handleRequested).toHaveBeenCalledTimes(1);
      const deliveryOptions = handleRequested.mock.calls[0]?.[1];
      expect(
        deliveryOptions?.isTargetVisible?.({
          deviceId: "device-owner",
          scopes: ["operator.approvals", "operator.read"],
        }),
      ).toBe(true);
      expect(
        deliveryOptions?.isTargetVisible?.({
          deviceId: "device-other",
          scopes: ["operator.approvals", "operator.read"],
        }),
      ).toBe(false);

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("sends an iOS cleanup wake through the current delivery owner", async (testContext) => {
    const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      const delivered = createDeferredCore();
      const handleExpired = vi.fn(async () => {});
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { context } = createContext({
        pluginApprovalManager: manager,
        getApprovalClientConnIds: vi.fn(() => new Set<string>()),
        hasExecApprovalClients: vi.fn(() => false),
        pluginApprovalIosPushDelivery: {
          handleRequested: vi.fn(async () => {
            delivered.resolve();
            return true;
          }),
          handleExpired,
        },
      });

      const { record, pending: resultPromise } = await expectSinglePendingApproval(
        manager,
        context,
        () => fixture.track(invokeDemoPolicy(context, createOperatorClient())),
      );
      await Promise.race([
        delivered.promise,
        resultPromise.then(() => {
          throw new Error("Approval request ended before delivery");
        }),
      ]);
      const replacementExpired = vi.fn(async () => {});
      context.pluginApprovalIosPushDelivery = { handleExpired: replacementExpired };
      await manager.expire(record.id, "timeout");

      await expect(resultPromise).resolves.toStrictEqual({
        ok: true,
        payload: { id: record.id, decision: null },
      });
      expect(handleExpired).not.toHaveBeenCalled();
      expect(replacementExpired).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
      expect(replacementExpired.mock.contexts).toEqual([context.pluginApprovalIosPushDelivery]);
    });
  });
  it.for([false, true].flatMap((strict) => [false, true].map((revoke) => ({ strict, revoke }))))(
    "retains resolver eligibility across pairing recheck (strict=$strict, revoke=$revoke)",
    async ({ strict, revoke }, testContext) => {
      const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      await fixture.run(async () => {
        setDangerousDemoCommandRegistry([
          createDemoPolicy(async (policy) => {
            const approval = await policy.approvals?.request({
              title: "Synthetic node action",
              description: "Approve the declared synthetic command",
            });
            if (approval?.decision !== "allow-once") {
              return { ok: false, code: "APPROVAL_DENIED", message: "Synthetic action denied" };
            }
            return await policy.invokeNode();
          }),
        ]);
        let eligible = true;
        await withRequesterApprovalChannel(
          async () => {
            const operationalRunInstance =
              createOperationalRunInstanceRef("synthetic-node-pairing");
            const admission = prepareAgentRunAdmission({
              cfg: {},
              sessionKey: "agent:main:synthetic-node",
              facts: {
                runId: operationalRunInstance.runId,
                agentId: "main",
                ingress: { kind: "system", boundary: "synthetic-test", state: "present" },
              },
              operationalRunInstance,
              turnSource: createHostChannelTurnSource({
                actor: {
                  channel: "test",
                  accountId: "default",
                  senderId: "synthetic-requester",
                  actorKind: "human",
                },
                message: {
                  messageId: "synthetic-node-message",
                  conversationId: "synthetic-node-chat",
                  conversationKind: "direct",
                  eventKind: "message",
                },
              }),
            });
            const pairingEntered = createDeferredCore();
            const pairingRelease = createDeferredCore();
            try {
              const admitted = await admission.admit("plugin-harness");
              const authority = getAdmittedRunDelegatedAuthority(admitted);
              if (!authority) {
                throw new Error("Missing synthetic admission authority");
              }
              const delivered = createDeferredCore<string>();
              const { context, invoke } = createContext({
                pluginApprovalManager: fixture.manager,
                hasExecApprovalClients: () => true,
                validateAgentRuntimeApprovalAuthority: (identity) =>
                  validateAgentRunDelegatedAuthority(identity.delegatedAuthority),
              });
              context.approvalEvents = {
                publishRequested: async (_kind, request) => {
                  delivered.resolve((request as { id: string }).id);
                  return { deliveredCount: 1, originUnavailable: false };
                },
                publishResolved: vi.fn(),
                deliverRequester: async (_kind, request) => {
                  delivered.resolve((request as { id: string }).id);
                  return true;
                },
              };
              const pending = fixture.track(
                applyPluginNodeInvokePolicy({
                  context,
                  client: null,
                  agentRuntimeIdentity: {
                    kind: "agentRuntime",
                    agentId: "main",
                    sessionKey: "agent:main:synthetic-node",
                    operationalRunInstance,
                    delegatedAuthority: { ...authority, kind: "local" },
                    turnSourceChannel: "test",
                    turnSourceAccountId: "default",
                  },
                  nodeSession: createNodeSession(),
                  command: DEMO_COMMAND,
                  params: DEMO_PARAMS,
                  isInvocationCurrent: async () => {
                    pairingEntered.resolve();
                    await pairingRelease.promise;
                    return true;
                  },
                }),
              );
              const id = await Promise.race([
                delivered.promise,
                pending.then(() => {
                  throw new Error("Node policy ended before approval delivery");
                }),
              ]);
              expect(
                await fixture.manager.resolveDetailed(
                  id,
                  "allow-once",
                  {
                    kind: "channel",
                    id: "test:default",
                    actor: {
                      kind: "channel",
                      channel: "test",
                      accountId: "default",
                      senderId: "synthetic-requester",
                      actorKind: "human",
                    },
                  },
                  null,
                  "operator",
                  {
                    assertCurrent: () => {
                      if (!eligible) {
                        throw new Error("Synthetic resolver revoked");
                      }
                    },
                  },
                ),
              ).toMatchObject({ outcome: "resolved" });
              await Promise.race([
                pairingEntered.promise,
                pending.then(() => {
                  throw new Error("Node policy ended before pairing recheck");
                }),
              ]);
              expect((await fixture.manager.getSnapshot(id))?.consumedDecision).toBe("allow-once");
              eligible = !revoke;
              pairingRelease.resolve();
              await expect(pending).resolves.toMatchObject(
                revoke
                  ? {
                      ok: false,
                      code: "APPROVAL_AUTHORITY_CLOSED",
                      details: { nodeCommandDispatched: false },
                    }
                  : { ok: true },
              );
              expect(invoke).toHaveBeenCalledTimes(revoke ? 0 : 1);
              if (!revoke) {
                eligible = false;
                expect(invoke.mock.calls[0]?.[0]?.isDispatchAuthorized?.()).toBe(false);
              }
            } finally {
              pairingRelease.resolve();
              admission.close();
            }
          },
          { strict: () => strict, eligible: () => eligible },
        );
      });
    },
  );
}
