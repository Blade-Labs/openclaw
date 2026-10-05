// Covers gateway waitDecision id binding for native hook relay permission approvals.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requesterAuthorization } from "../../gateway/approval-requester.test-support.js";
import { createTestApprovalManager } from "../../gateway/exec-approval-manager.test-support.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import {
  createHostNonUserTurnSource,
  createHostChannelTurnSource,
} from "../../infra/host-turn-source.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  appendAdmittedRunSource,
  closeAdmittedRunDelegatedAuthority,
} from "../admitted-run-context.js";
import { consumeSourceForToolCall } from "../agent-tools.before-tool-call.state.js";
import { prepareApprovalExecution, retainApprovalExecutions } from "../approval-execution.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  testing,
} from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/gateway.js")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(async () => {
  resetGlobalHookRunner();
  // restoreAllMocks does not clear call history on module-mock vi.fn()s.
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  await testing.clearNativeHookRelaysForTests();
});

function mockGatewayApproval(waitResult: { id?: string; decision?: string | null }) {
  mockCallGatewayTool.mockImplementation(async (method: string) => {
    if (method === "plugin.approval.request") {
      return { id: "approval-1", status: "accepted" };
    }
    if (method === "plugin.approval.waitDecision") {
      return waitResult;
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
}

async function invokePermissionRequest(
  relayId: string,
  options: { command?: string; cwd?: string } = {},
) {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      cwd: options.cwd ?? "/repo",
      tool_name: "Bash",
      tool_use_id: "native-binding-call-1",
      tool_input: { command: options.command ?? "printf binding" },
    },
  });
}

async function createResolvedNativeExecutionFixture(
  test: Parameters<typeof createTestApprovalManager>[0],
) {
  const manager = createTestApprovalManager<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
  });
  const record = manager.create(
    { title: "Synthetic native tool", description: "Synthetic input" },
    60_000,
    "synthetic-pre-approval",
  );
  record.authorization = requesterAuthorization();
  await manager.register(record, 60_000);
  let current = true;
  await manager.resolveDetailed(
    record.id,
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
        if (!current) {
          throw new Error("Synthetic resolver revoked");
        }
      },
    },
  );
  const context = createGatewayRequestContext(
    makeContextParams({ pluginApprovalManager: manager }),
  );
  const prepare = () =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:synthetic",
        gatewayContextResolver: () => context,
      },
      () =>
        prepareApprovalExecution({
          id: record.id,
          kind: "plugin",
          authorization: record.authorization,
        }),
    );
  return {
    manager,
    record,
    prepare,
    revoke: () => {
      current = false;
    },
  };
}

describe("native hook relay approval id binding", () => {
  it.for([false, true])(
    "redeems immediate native consent once and rejects revocation at admission=%s",
    async (revokeAtAdmission, test) => {
      const { manager, record, prepare, revoke } = await createResolvedNativeExecutionFixture(test);
      const admitted = vi.fn(() => {
        if (revokeAtAdmission) {
          revoke();
        }
      });
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        relayId: "synthetic-pre-approval-relay",
        sessionId: "synthetic-session",
        runId: "synthetic-run",
        runBeforeToolCall: async (request) => ({
          blocked: false,
          params: request.params,
          approvalExecutions: [await prepare()],
        }),
        executionAdmission: { toolNames: ["exec"], admit: admitted },
      });
      const invoke = () =>
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload: {
            tool_name: "Bash",
            tool_use_id: "synthetic-pre-call",
            tool_input: { command: "true" },
          },
        });
      try {
        const first = await invoke();
        expect(admitted).toHaveBeenCalledOnce();
        if (revokeAtAdmission) {
          expect(JSON.parse(first.stdout)).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
          });
          expect((await manager.getSnapshot(record.id))?.consumedAtMs).toBeNull();
        } else {
          expect(first).toEqual({ stdout: "", stderr: "", exitCode: 0 });
          expect((await manager.getSnapshot(record.id))?.consumedDecision).toBe("allow-once");
          const replay = await invoke();
          expect(JSON.parse(replay.stdout)).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
          });
        }
      } finally {
        relay.unregister();
      }
    },
  );

  it.for([false, true])(
    "claims a deferred native capability once until final consumer redemption (revoke=%s)",
    async (revoked, test) => {
      const { manager, record, prepare, revoke } = await createResolvedNativeExecutionFixture(test);
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: async () => ({
              requireApproval: {
                title: "Synthetic consent",
                description: "Synthetic native input",
              },
            }),
          },
        ]),
      );
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "synthetic-deferred-relay",
        sessionId: "synthetic-session",
        runId: "synthetic-deferred-run",
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const execution = await prepare();
      const requester = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return retainApprovalExecutions(
          {
            blocked: false as const,
            params: { command: "true" },
            approvalResolution: "allow-once" as const,
          },
          [execution],
        );
      });
      testing.setNativeHookRelayDeferredToolApprovalRequesterForTests(requester);
      try {
        await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload: {
            openclaw_approval_mode: "report",
            tool_name: "Bash",
            tool_use_id: "synthetic-deferred-call",
            tool_input: { command: "true" },
          },
        });
        const resolve = () =>
          resolveNativeHookRelayDeferredToolApproval({
            relayId: relay.relayId,
            toolUseId: "synthetic-deferred-call",
          });
        const first = resolve();
        const duplicate = resolve();
        await entered.promise;
        expect(requester).toHaveBeenCalledOnce();
        release.resolve();
        const [winner, loser] = await Promise.all([first, duplicate]);
        expect(winner).toMatchObject({ handled: true, outcome: "approved-once" });
        expect(loser).toMatchObject({ handled: true, outcome: "denied" });
        expect((await manager.getSnapshot(record.id))?.consumedAtMs).toBeNull();
        if (!winner || winner.outcome !== "approved-once") {
          throw new Error("Synthetic deferred approval did not transfer execution custody");
        }
        expect(winner.approvalExecutions).toEqual([execution]);
        if (revoked) {
          revoke();
          await expect(execution.redeem()).rejects.toThrow();
          expect(() => execution.assertCurrent()).toThrow();
          expect((await manager.getSnapshot(record.id))?.consumedAtMs).toBeNull();
        } else {
          await execution.redeem();
          await execution.revalidate();
          expect(() => execution.assertCurrent()).not.toThrow();
          expect((await manager.getSnapshot(record.id))?.consumedDecision).toBe("allow-once");
          await expect(execution.redeem()).rejects.toThrow();
        }
      } finally {
        release.resolve();
        relay.unregister();
      }
    },
  );

  it("denies a default one-shot verdict when requester policy strengthens during the wait", async () => {
    const fixture = await createAdmittedHostCapabilityTestFixture({
      runId: "synthetic-strengthened-run",
    });
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: "synthetic-strengthened-relay",
      sessionId: "synthetic-session",
      runId: "synthetic-strengthened-run",
      approvalHost: fixture.hostCapabilities,
    });
    mockCallGatewayTool.mockImplementationOnce(async () => {
      appendAdmittedRunSource(
        fixture.admittedRunContext,
        createHostChannelTurnSource({
          actor: {
            channel: "test",
            accountId: "default",
            senderId: "synthetic-requester",
            actorKind: "human",
          },
          message: {
            messageId: "synthetic-message",
            conversationId: "synthetic-chat",
            conversationKind: "direct",
            eventKind: "message",
          },
          policy: {
            requireResolverMatch: true,
            delivery: "requester",
            allowedDecisions: ["allow-once", "deny"],
          },
        }),
      );
      return { id: "synthetic-default-approval", decision: "allow-once" };
    });
    try {
      const response = await invokePermissionRequest(relay.relayId);
      expect(JSON.parse(response.stdout)).toMatchObject({
        hookSpecificOutput: { decision: { behavior: "deny" } },
      });
    } finally {
      relay.unregister();
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });

  it.each([null, "allow-always", "defer"])(
    "denies strict native permission result %s instead of provider fallback",
    async (decision) => {
      const fixture = await createAdmittedHostCapabilityTestFixture({
        runId: "synthetic-strict-run",
      });
      appendAdmittedRunSource(
        fixture.admittedRunContext,
        createHostChannelTurnSource({
          actor: {
            channel: "test",
            accountId: "default",
            senderId: "synthetic-requester",
            actorKind: "human",
          },
          message: {
            messageId: "synthetic-message",
            conversationId: "synthetic-chat",
            conversationKind: "direct",
            eventKind: "message",
          },
          policy: {
            requireResolverMatch: true,
            delivery: "requester",
            allowedDecisions: ["allow-once", "deny"],
          },
        }),
      );
      mockCallGatewayTool.mockResolvedValueOnce({ id: "synthetic-strict-approval", decision });
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        relayId: "synthetic-strict-relay",
        sessionId: "synthetic-session",
        runId: "synthetic-strict-run",
        approvalHost: fixture.hostCapabilities,
      });
      try {
        const response = await invokePermissionRequest(relay.relayId);
        expect(JSON.parse(response.stdout)).toMatchObject({
          hookSpecificOutput: { decision: { behavior: "deny" } },
        });
        expect(mockCallGatewayTool).toHaveBeenCalledWith(
          "plugin.approval.request",
          expect.anything(),
          expect.objectContaining({ allowedDecisions: ["allow-once", "deny"] }),
          expect.anything(),
        );
      } finally {
        relay.unregister();
        fixture.closeHost();
        fixture.closeAdmission();
      }
    },
  );

  it("denies a typed requester failure even when local policy has not become strict", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(
      Object.assign(new Error("Requester unavailable"), {
        gatewayCode: "INVALID_REQUEST",
        details: { code: "APPROVAL_REQUESTER_UNAVAILABLE", reason: "missing" },
      }),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "synthetic-typed-denial",
      sessionId: "synthetic-session",
      runId: "synthetic-run",
    });
    const response = await invokePermissionRequest(relay.relayId);
    expect(JSON.parse(response.stdout)).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
  });

  it.each(["matching-before", "after-only", "broader-after"] as const)(
    "retains admitted tool source through source changes with %s observers",
    async (observers) => {
      const fixture = await createAdmittedHostCapabilityTestFixture({
        runId: "synthetic-source-run",
        sessionKey: "agent:main:synthetic",
      });
      const before = vi.fn();
      const after = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          ...(observers === "after-only"
            ? []
            : [
                {
                  hookName: "before_tool_call" as const,
                  handler: before,
                  matcher: [observers === "broader-after" ? "apply_patch" : "exec"],
                },
              ]),
          { hookName: "after_tool_call", handler: after, matcher: ["apply_patch", "exec"] },
        ]),
      );
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        relayId: "synthetic-source-relay",
        sessionId: "synthetic-session",
        runId: "synthetic-source-run",
        approvalHost: fixture.hostCapabilities,
        preToolUseLoopDetection: false,
      });
      const rawPayload = {
        tool_name: "Bash",
        tool_use_id: "synthetic-call",
        tool_input: { command: "true" },
        source: { inputs: [{ origin: "user" }] },
      };
      try {
        expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
        expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(["apply_patch", "exec"]);
        const source = fixture.hostCapabilities.readSource?.();
        await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload,
        });
        expect(consumeSourceForToolCall("synthetic-call", "synthetic-source-run")).toBeUndefined();
        expect(source).toMatchObject({ revision: 0, inputs: [{ origin: "system" }] });
        if (observers === "matching-before") {
          expect(before.mock.calls[0]?.[1].source).toEqual(source);
        } else {
          expect(before).not.toHaveBeenCalled();
        }
        appendAdmittedRunSource(
          fixture.admittedRunContext,
          createHostNonUserTurnSource("cross-session"),
        );
        await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "post_tool_use",
          rawPayload: { ...rawPayload, tool_response: { output: "synthetic-result" } },
        });
        expect(after).toHaveBeenCalledOnce();
        expect(after.mock.calls[0]?.[1].source).toEqual(source);
      } finally {
        relay.unregister();
        fixture.closeHost();
        fixture.closeAdmission();
      }
    },
  );

  it.each(["blocked", "canceled", "disposed", "post-disabled", "post-filtered"] as const)(
    "releases native source without a completion after %s",
    async (mode) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const controller = new AbortController();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            matcher: ["exec"],
            handler: async () => {
              entered.resolve();
              if (mode === "canceled" || mode === "disposed") {
                await release.promise;
              }
              return mode === "blocked"
                ? { block: true, blockReason: "Synthetic rejection" }
                : undefined;
            },
          },
          { hookName: "after_tool_call", matcher: ["apply_patch"], handler: vi.fn() },
        ]),
      );
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "synthetic-cleanup-relay",
        sessionId: "synthetic-session",
        runId: "synthetic-cleanup-run",
        signal: controller.signal,
        ...(mode === "post-disabled" ? { allowedEvents: ["pre_tool_use"] as const } : {}),
      });
      const pending = invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          tool_name: "Bash",
          tool_use_id: "synthetic-cleanup-call",
          tool_input: { command: "true" },
        },
      });
      const settled = pending.catch(() => undefined);
      try {
        await entered.promise;
        if (mode === "canceled") {
          controller.abort();
        } else if (mode === "disposed") {
          relay.unregister();
        } else {
          await pending;
        }
        expect(
          consumeSourceForToolCall("synthetic-cleanup-call", "synthetic-cleanup-run"),
        ).toBeUndefined();
      } finally {
        release.resolve();
        await settled;
        relay.unregister();
      }
    },
  );

  it("does not carry an old native source into a same-run successor", async () => {
    const fixture = await createAdmittedHostCapabilityTestFixture({
      runId: "synthetic-successor-run",
    });
    const after = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "after_tool_call", handler: after, matcher: ["exec"] },
      ]),
    );
    const register = () =>
      registerOwnedNativeHookRelay({
        provider: "codex",
        relayId: "synthetic-successor-relay",
        sessionId: "synthetic-session",
        runId: "synthetic-successor-run",
        approvalHost: fixture.hostCapabilities,
      });
    let relay = register();
    const rawPayload = {
      tool_name: "Bash",
      tool_use_id: "synthetic-successor-call",
      tool_input: { command: "true" },
    };
    try {
      await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload,
      });
      relay.unregister();
      appendAdmittedRunSource(
        fixture.admittedRunContext,
        createHostNonUserTurnSource("cross-session"),
      );
      relay = register();
      const source = fixture.hostCapabilities.readSource?.();
      await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "post_tool_use",
        rawPayload: { ...rawPayload, tool_response: { output: "synthetic-result" } },
      });
      expect(after).toHaveBeenCalledOnce();
      expect(after.mock.calls[0]?.[1].source).toEqual(source);
    } finally {
      relay.unregister();
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });

  it("cleans native source while preserving retained child policy after foreground close", async () => {
    const fixture = await createAdmittedHostCapabilityTestFixture({
      runId: "synthetic-retained-run",
    });
    const before = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: before, matcher: ["exec"] },
      ]),
    );
    let retainChild = true;
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: "synthetic-retained-relay",
      sessionId: "synthetic-session",
      runId: "synthetic-retained-run",
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: fixture.hostCapabilities.runBeforeToolCall,
      assertActive: fixture.hostCapabilities.assertActive,
      retention: {
        readClaim: () => "synthetic-child",
        shouldRetainAfterForegroundClose: () => retainChild,
        allowPreToolUse: (claim) => claim === "synthetic-child",
        onDispose: () => {},
      },
    });
    try {
      closeAdmittedRunDelegatedAuthority(fixture.admittedRunContext);
      fixture.closeHost();
      relay.unregister();
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload: {
            agent_id: "synthetic-child",
            tool_name: "Bash",
            tool_use_id: "synthetic-child-call",
            tool_input: { command: "true" },
          },
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(before).toHaveBeenCalledOnce();
      expect(before.mock.calls[0]?.[1].source).toMatchObject({ inputs: [{ origin: "system" }] });
      expect(
        consumeSourceForToolCall("synthetic-child-call", "synthetic-retained-run"),
      ).toBeUndefined();
    } finally {
      retainChild = false;
      relay.unregister();
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });

  it("accepts a waitDecision reply bound to the requested approval id", async () => {
    mockGatewayApproval({ id: "approval-1", decision: "allow-once" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-binding-match",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokePermissionRequest(relay.relayId);

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("defers when a waitDecision reply carries a different approval id", async () => {
    mockGatewayApproval({ id: "approval-other", decision: "allow-once" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-binding-mismatch",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokePermissionRequest(relay.relayId);

    // A misrouted reply must never release the gate; the relay falls back to
    // the provider's own approval path via the noop response.
    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("denies when a script operand changes during the permission approval", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-hook-drift-"));
    const script = path.join(cwd, "script.sh");
    try {
      await fs.writeFile(script, "#!/bin/sh\necho approved\n");
      mockCallGatewayTool.mockImplementation(async (method: string) => {
        if (method === "plugin.approval.request") {
          return { id: "approval-1", status: "accepted" };
        }
        if (method === "plugin.approval.waitDecision") {
          await fs.writeFile(script, "#!/bin/sh\necho mutated\n");
          return { id: "approval-1", decision: "allow-once" };
        }
        throw new Error(`unexpected gateway method: ${method}`);
      });
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "codex-script-drift",
        sessionId: "session-1",
        runId: "run-1",
      });

      const response = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });

      expect(JSON.parse(response.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
          },
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows an unchanged script operand after permission approval", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-hook-stable-"));
    try {
      await fs.writeFile(path.join(cwd, "script.sh"), "#!/bin/sh\necho approved\n");
      mockGatewayApproval({ id: "approval-1", decision: "allow-once" });
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "codex-script-stable",
        sessionId: "session-1",
        runId: "run-1",
      });

      const response = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });

      expect(JSON.parse(response.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not reuse allow-always after bound script bytes change", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-hook-always-"));
    const script = path.join(cwd, "script.sh");
    try {
      await fs.writeFile(script, "#!/bin/sh\necho approved\n");
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-always",
        decision: "allow-always",
      });
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "codex-script-always",
        sessionId: "session-1",
        runId: "run-1",
      });

      const first = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });
      expect(JSON.parse(first.stdout).hookSpecificOutput.decision).toEqual({ behavior: "allow" });

      await fs.writeFile(script, "#!/bin/sh\necho changed\n");
      mockCallGatewayTool.mockReset();
      mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-changed", decision: "deny" });
      const second = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });

      expect(mockCallGatewayTool).toHaveBeenCalledOnce();
      expect(JSON.parse(second.stdout).hookSpecificOutput.decision).toEqual({
        behavior: "deny",
        message: "Denied by user",
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
