// Covers exact delegated approval authority and closure fences.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { createHostChannelTurnSource } from "../../infra/host-turn-source.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { withRequesterApprovalChannel } from "../approval-requester.test-support.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import { prepareDelegatedSystemAgentApproval } from "./system-agent-approval.js";
import * as systemAgentExecution from "./system-agent-execution.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => {
  resetAgentRunRegistryForTest();
});

async function resolveTestProposal(
  params: Parameters<typeof prepareDelegatedSystemAgentApproval>[0] & {
    proposal: NonNullable<
      ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>
    >;
  },
) {
  const resolveProposal = await prepareDelegatedSystemAgentApproval(params);
  return await resolveProposal(params.proposal);
}

async function queueDelegatedApproval(
  params: Parameters<typeof resolveTestProposal>[0],
): Promise<string> {
  const resolution = await resolveTestProposal(params);
  if (resolution.kind !== "approval") {
    throw new Error("expected a human approval request");
  }
  return resolution.id;
}

describe("prepareDelegatedSystemAgentApproval", () => {
  const workerTurnClaim = (claimId: string): WorkerSessionTurnClaim => ({
    sessionId: "delegate-worker",
    claimId,
    runId: "delegated-worker-run",
    placementGeneration: 1,
    owner: { kind: "worker", environmentId: "worker-1", ownerEpoch: 1 },
  });

  it.for(["queue", "config preparation"] as const)(
    "refuses a system-agent write when its resolver is revoked during %s",
    async (phase, testContext) => {
      let eligible = true;
      await withRequesterApprovalChannel(
        async () => {
          const instance = createOperationalRunInstanceRef("synthetic-system-write");
          const admission = prepareAgentRunAdmission({
            cfg: {},
            facts: {
              runId: instance.runId,
              agentId: "main",
              ingress: { kind: "system", boundary: "synthetic-test", state: "present" },
            },
            operationalRunInstance: instance,
            sessionKey: "agent:main:synthetic-write",
            turnSource: createHostChannelTurnSource({
              actor: {
                channel: "test",
                accountId: "default",
                senderId: "synthetic-requester",
                actorKind: "human",
              },
              message: {
                messageId: "synthetic-message",
                conversationId: "synthetic-dm",
                conversationKind: "direct",
                eventKind: "message",
              },
            }),
          });
          await admission.admit("plugin-harness");
          const held = createDeferred();
          const entered = createDeferred();
          const applicationQueued = createDeferred();
          const write = vi.fn();
          const proposal = {
            operation: { kind: "config-set" as const, path: "logging.level", value: "debug" },
            hash: "d".repeat(64),
          };
          const session = {
            engine: {
              historyLength: () => 0,
              historySince: () => [],
              noteAssistantMessage: vi.fn(),
              getPendingOperatorProposal: () => proposal,
              resolveOperatorApproval: async (
                decision: ExecApprovalDecision | null,
                _hash: string,
                guard?: () => void,
              ) => {
                if (decision !== "allow-once") {
                  return null;
                }
                if (phase === "config preparation") {
                  entered.resolve();
                  await held.promise;
                }
                guard?.();
                write();
                return { text: "Synthetic applied", action: "none" as const, applied: true };
              },
            },
            lastUsedAt: 1,
            ownerKey: "agent:main:synthetic-write",
          } as unknown as SystemAgentChatSession;
          const sessions = new Map([["synthetic-system-session", session]]);
          const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(
            testContext,
            {
              approvalKind: "system-agent",
              resolveAllowedDecisions: (request) => request.allowedDecisions,
              validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
            },
          );
          const context = {
            systemAgentApprovalManager: manager,
            getRuntimeConfig: () => ({}),
            broadcast: vi.fn(),
            approvalEvents: {
              deliverRequester: async () => true,
              publishRequested: vi.fn(),
              publishResolved: vi.fn(),
            },
          } as unknown as GatewayRequestContext;
          let queued: Promise<void> | undefined;
          let restoreQueueSpy: (() => void) | undefined;
          try {
            const resolution = await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "agent:main:synthetic-write",
                operationalRunInstance: instance,
              },
              () =>
                resolveTestProposal({
                  context,
                  sessions,
                  session,
                  sessionId: "synthetic-system-session",
                  delegation: {},
                  proposal,
                }),
            );
            if (resolution.kind !== "approval") {
              throw new Error("Expected pending approval");
            }
            if (phase === "queue") {
              queued = systemAgentExecution.runSystemAgentGatewayTask(async () => {
                entered.resolve();
                await held.promise;
              });
              await entered.promise;
              const runTask = systemAgentExecution.runSystemAgentGatewayTask;
              const spy = vi
                .spyOn(systemAgentExecution, "runSystemAgentGatewayTask")
                .mockImplementation((task) => {
                  const application = runTask(task);
                  applicationQueued.resolve();
                  return application;
                });
              restoreQueueSpy = () => spy.mockRestore();
            }
            expect(
              (
                await manager.resolveDetailed(
                  resolution.id,
                  "allow-once",
                  {
                    kind: "channel",
                    id: "synthetic-requester",
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
                )
              ).outcome,
            ).toBe("resolved");
            await Promise.race([
              phase === "config preparation" ? entered.promise : applicationQueued.promise,
              resolution.completion.then(() => {
                throw new Error("Application finished before config preparation");
              }),
            ]);
            eligible = false;
            held.resolve();
            await expect(resolution.completion).resolves.toMatchObject({ applied: false });
            expect(write).not.toHaveBeenCalled();
          } finally {
            held.resolve();
            await queued;
            restoreQueueSpy?.();
            admission.close();
          }
        },
        { eligible: () => eligible },
      );
    },
  );

  it("terminally rejects a strict delegated request without admitted source and clears its proposal", async (testContext) => {
    await withRequesterApprovalChannel(async () => {
      const proposal = { operation: { kind: "gateway-restart" as const }, hash: "c".repeat(64) };
      const deniedReply = { text: "Synthetic change denied", action: "none", applied: false };
      const resolveOperatorApproval = vi.fn().mockResolvedValue(deniedReply);
      const session = {
        engine: {
          historyLength: () => 0,
          historySince: () => [],
          noteAssistantMessage: vi.fn(),
          getPendingOperatorProposal: () => proposal,
          resolveOperatorApproval,
        },
        lastUsedAt: 1,
        ownerKey: "agent:main:synthetic",
      } as unknown as SystemAgentChatSession;
      const sessions = new Map([["synthetic-delegation", session]]);
      const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const broadcast = vi.fn();
      const reportBlockedRequest = vi.fn(async () => "no-unique-chat" as const);
      const context = {
        systemAgentApprovalManager: manager,
        getRuntimeConfig: () => ({}),
        broadcast,
        logGateway: { error: vi.fn() },
        approvalEvents: { reportBlockedRequest },
      } as unknown as GatewayRequestContext;
      const operationalRunInstance = createOperationalRunInstanceRef("synthetic-delegated-run");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      try {
        await expect(
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:synthetic",
              operationalRunInstance,
              turnSourceChannel: "test",
              turnSourceAccountId: "default",
            },
            () =>
              resolveTestProposal({
                context,
                sessions,
                session,
                sessionId: "synthetic-delegation",
                delegation: { agentId: "main", sessionKey: "agent:main:synthetic" },
                proposal,
              }),
          ),
        ).rejects.toMatchObject({
          code: "APPROVAL_REQUESTER_UNAVAILABLE",
          terminalReason: "requester-unavailable",
        });
        expect(session.pendingApproval).toBeUndefined();
        expect(resolveOperatorApproval).toHaveBeenCalledWith(
          "deny",
          proposal.hash,
          expect.any(Function),
          undefined,
        );
        expect(await manager.listPendingRecords()).toEqual([]);
        expect(broadcast).not.toHaveBeenCalled();
        expect(reportBlockedRequest).toHaveBeenCalledOnce();
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
      }
    });
  });

  it("refuses to apply a delegated change after its run authority closes", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "a".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue(null);
    const session = {
      engine: {
        historyLength: () => 0,
        historySince: () => [],
        noteAssistantMessage: vi.fn(),
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-closed", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const context = {
      getRuntimeConfig: () => ({}),
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-closed");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-closed",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);

    expect(approvalId).toBeTruthy();
    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(false);
    expect((await manager.getSnapshot(approvalId!))?.status).toBe("cancelled");
    await vi.waitFor(() =>
      expect(resolveOperatorApproval).toHaveBeenCalledWith(
        null,
        proposal.hash,
        expect.any(Function),
        "cancelled",
      ),
    );
  });

  it("rechecks authority after queued approval work before the final effect", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "b".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        if (_decision === null) {
          return null;
        }
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = {
      engine: {
        historyLength: () => 0,
        historySince: () => [],
        noteAssistantMessage: vi.fn(),
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-race", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      getRuntimeConfig: () => ({}),
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-race");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-race",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
  });

  it.each(["run", "tool", "gateway", "worker", "session"] as const)(
    "fences Full Access when its %s closes during apply preparation",
    async (owner) => {
      const started = createDeferred();
      const release = createDeferred();
      const effect = vi.fn();
      const proposal = { operation: { kind: "gateway-restart" as const }, hash: "f".repeat(64) };
      const session = {
        engine: {
          resolveOperatorApproval: async (
            decision: ExecApprovalDecision | null,
            _hash: string,
            assertCurrent?: () => void,
          ) => {
            if (decision === null) {
              return null;
            }
            started.resolve();
            await release.promise;
            assertCurrent?.();
            effect();
            return { text: "Applied", action: "none" as const, applied: true };
          },
        },
        ownerKey: "agent:main:main",
        lastUsedAt: 1,
      } as unknown as SystemAgentChatSession;
      const sessions = new Map([["delegate-full", session]]);
      let workerActive = true;
      const context = {
        systemAgentSessions: sessions,
        validateAgentRuntimeApprovalAuthority: () => workerActive,
      } as unknown as GatewayRequestContext;
      let liveContext = context;
      const operationalRunInstance = createOperationalRunInstanceRef("full-access-run");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const controller = new AbortController();
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          approvalAuthority: authority,
          fullPermission: true,
          gatewayContextResolver: () => liveContext,
          approvalSignals: [controller.signal],
          ...(owner === "worker" ? { workerTurnClaim: workerTurnClaim("full-turn") } : {}),
        },
        () =>
          resolveTestProposal({
            context,
            sessions,
            session,
            sessionId: "delegate-full",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          }),
      );
      await started.promise;
      if (owner === "run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else if (owner === "tool") {
        controller.abort();
      } else if (owner === "gateway") {
        liveContext = { ...context };
      } else if (owner === "worker") {
        workerActive = false;
      } else {
        sessions.set("delegate-full", { ...session });
      }
      release.resolve();

      await expect(pending).rejects.toThrow("system-agent approval authority is no longer active");
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("publishes the channel completion after the delegated change is applied", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "c".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue({
      text: "Applied",
      action: "none" as const,
      applied: true,
    });
    const session = {
      engine: {
        historyLength: () => 0,
        historySince: () => [],
        noteAssistantMessage: vi.fn(),
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-applied", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      getRuntimeConfig: () => ({}),
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-applied");
    claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-applied",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "applied" }),
      ),
    );
  });

  it("fences a delegated worker turn before the persistent effect", async (testContext) => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "d".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    let workerTurnActive = true;
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        if (_decision === null) {
          return null;
        }
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = {
      engine: {
        historyLength: () => 0,
        historySince: () => [],
        noteAssistantMessage: vi.fn(),
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-worker", session]]);
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: (authority) =>
        validateAgentRunDelegatedAuthority(authority) && workerTurnActive,
    });
    const context = {
      getRuntimeConfig: () => ({}),
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved: vi.fn() },
      validateAgentRuntimeApprovalAuthority: () => workerTurnActive,
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
    claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = workerTurnClaim("turn-1");

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        workerTurnClaim: turnClaim,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-worker",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(await manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    workerTurnActive = false;
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
  });

  it.for([false, true])(
    "reuses the exact worker approval with Full Access=%s",
    async (fullPermission, testContext) => {
      const proposal = {
        operation: { kind: "gateway-restart" as const },
        hash: "e".repeat(64),
      };
      const session = {
        engine: {
          historyLength: () => 0,
          historySince: () => [],
          noteAssistantMessage: vi.fn(),
          getPendingOperatorProposal: () => proposal,
          resolveOperatorApproval: vi.fn().mockResolvedValue(null),
        },
        lastUsedAt: 1,
        ownerKey: "agent:main:main",
      } as unknown as SystemAgentChatSession;
      const sessions = new Map([["delegate-worker", session]]);
      const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const context = {
        getRuntimeConfig: () => ({}),
        systemAgentApprovalManager: manager,
        broadcast: vi.fn(),
        validateAgentRuntimeApprovalAuthority: () => true,
      } as unknown as GatewayRequestContext;
      const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
      claimAgentRunDelegatedAuthority(operationalRunInstance);

      const firstClaim = workerTurnClaim("turn-2");
      let firstApprovalId: string | undefined;
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          workerTurnClaim: firstClaim,
        },
        async () => {
          firstApprovalId = await queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegate-worker",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          });
        },
      );
      const secondClaim = workerTurnClaim("turn-2");
      let secondApprovalId: string | undefined;
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          workerTurnClaim: secondClaim,
          fullPermission,
        },
        async () => {
          secondApprovalId = await queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegate-worker",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          });
        },
      );

      expect(secondApprovalId).toBe(firstApprovalId);
      expect(await manager.listPendingRecords()).toHaveLength(1);
      expect(session.engine.resolveOperatorApproval).not.toHaveBeenCalled();
      const completion = session.pendingApproval?.completion;
      await manager.expire(firstApprovalId!);
      await completion;
    },
  );
});
