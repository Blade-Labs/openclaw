import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  admitChannelApprovalActor,
  readAdmittedChannelApprovalActor,
} from "../channels/message-access/approval-actor.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { withGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import {
  createChannelApprovalHandlerFromCapability,
  createChannelApprovalNativeRuntimeAdapter,
} from "../infra/approval-handler-runtime.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { requesterAuthorization } from "./approval-requester.test-support.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";

function createContext(): GatewayRequestContext {
  return {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: name.includes("approval") ? APPROVALS_SCOPE : WRITE_SCOPE,
    })),
  );
}

describe("createGatewayInstanceRuntime", () => {
  it("uses the typed recovery path and fails closed when the owning instance closes", async () => {
    let available = false;
    const rawAgent = vi.fn<NonNullable<GatewayRequestHandlers["agent"]>>(({ respond }) => {
      respond(true, { raw: true });
    });
    const registry = createRegistry({ agent: rawAgent });
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => available,
    });
    expect(getGatewayRecoveryRuntime()).toBe(runtime.recovery);

    await expect(
      runtime.recovery.dispatchAgent({ message: "test", idempotencyKey: "run-unavailable" }),
    ).rejects.toThrow("Gateway instance dispatch unavailable");
    available = true;
    await expect(runtime.recovery.waitForAgent({ runId: "run-1", timeoutMs: 0 })).resolves.toEqual({
      runId: "run-1",
      status: "timeout",
    });
    context.dedupe.set("agent:run-cached-recovery", {
      ts: Date.now(),
      ok: true,
      payload: { runId: "run-cached-recovery", status: "ok", summary: "replayed" },
    });
    await expect(
      runtime.recovery.dispatchAgent({
        message: "test",
        idempotencyKey: "run-cached-recovery",
      }),
    ).resolves.toEqual({ runId: "run-cached-recovery", status: "ok", summary: "replayed" });
    const onExecutionStarted = vi.fn();
    context.dedupe.set("agent:run-cached-active", {
      ts: Date.now(),
      ok: true,
      payload: { runId: "run-cached-active", status: "accepted" },
    });
    context.chatAbortControllers.set("run-cached-active", {
      controller: new AbortController(),
      executionStarted: true,
    } as never);
    await expect(
      runtime.recovery.dispatchAgent(
        { message: "test", idempotencyKey: "run-cached-active" },
        undefined,
        { onExecutionStarted },
      ),
    ).resolves.toMatchObject({ runId: "run-cached-active", status: "in_flight" });
    expect(onExecutionStarted).toHaveBeenCalledOnce();
    await expect(
      runtime.recovery.dispatchAgent({
        message: "test",
        idempotencyKey: "run-typed-recovery",
        cwd: "relative",
      }),
    ).rejects.toThrow("cwd must be absolute");
    expect(rawAgent).not.toHaveBeenCalled();

    const retainedFacade = await runtime.createAgentTurnFacade({
      client: createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] }),
    });
    runtime.close();
    expect(getGatewayRecoveryRuntime()).toBeUndefined();
    await expect(runtime.recovery.waitForAgent({ runId: "run-1" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
    await expect(
      retainedFacade.dispatch({ message: "stale completion", idempotencyKey: "closed-host" }),
    ).rejects.toThrow("Gateway instance dispatch unavailable");
    await expect(retainedFacade.wait({ runId: "run-1" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
  });

  it("captures trusted agent principal fields verbatim", () => {
    const client = createSyntheticPluginRuntimeClient({
      allowModelOverride: true,
      agentRunTracking: "plugin_subagent",
      cronRunContinuation: true,
      internalDeliveryMediaUrls: ["https://example.test/media"],
      internalDeliverySuppressText: true,
      pluginRuntimeOwnerId: "memory-core",
      delegatedToolPolicyHandoffId: "handoff-1",
      sessionCreation: {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
      },
    });

    const principal = captureAgentTurnPrincipal(client);

    expect(principal?.connect).toBe(client.connect);
    expect(principal?.internal).toBe(client.internal);
    expect(principal?.internal).toEqual(client.internal);

    const recoveryClient = createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] });
    const recoveryPrincipal = captureAgentTurnPrincipal(recoveryClient);
    expect(recoveryPrincipal?.connect?.client.mode).toBe("backend");
    expect(recoveryPrincipal?.internal).toEqual({
      syntheticClient: true,
      allowModelOverride: false,
    });
    expect(recoveryPrincipal?.internal?.agentRunTracking).toBeUndefined();
    expect(recoveryPrincipal?.internal?.sessionCreation).toBeUndefined();
  });

  it("sends recovery notices through normal outbound without invoking plugin actions", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "recovery-notice-" }, async () => {
      let releasePlatformDispatch: (() => void) | undefined;
      let platformDispatchHold: Promise<void> | undefined;
      const visibleSend = vi.fn();
      const sendText = vi.fn(async (ctx: { onPlatformSendDispatch?: () => Promise<void> }) => {
        await platformDispatchHold;
        await ctx.onPlatformSendDispatch?.();
        visibleSend();
        return { channel: "signal", messageId: `signal-message-${visibleSend.mock.calls.length}` };
      });
      const handleAction = vi.fn(async () => {
        throw new Error("recovery notice must not invoke message actions");
      });
      const plugin: ChannelPlugin = {
        id: "signal",
        meta: {
          id: "signal",
          label: "Signal",
          selectionLabel: "Signal",
          docsPath: "/channels/signal",
          blurb: "Signal-shaped recovery test plugin.",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["work"],
          resolveAccount: () => ({}),
          isConfigured: () => true,
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: () => false,
          handleAction,
        },
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
          sendText,
        },
      };
      const pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createTestRegistry([{ pluginId: "signal", source: "test", plugin }]),
        null,
        "default",
      );
      const context = {
        ...createContext(),
        getRuntimeConfig: () => ({ channels: { signal: { enabled: true } } }),
      } as GatewayRequestContext;
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRegistry({}),
        isDispatchAvailable: () => true,
      });

      try {
        const idempotencyKey = "main-session-restart-recovery:run-1:failed-notice";
        const notice = {
          channel: "signal",
          to: "+15551234567",
          accountId: "work",
          threadId: "thread-1",
          text: "Recovery notice",
          idempotencyKey,
        } as const;
        await runtime.recovery.sendRecoveryNotice(notice);
        await runtime.recovery.sendRecoveryNotice(notice);

        expect(await findDeliveryIntentOwner(idempotencyKey)).toMatchObject({
          status: "completed",
        });
        expect(visibleSend).toHaveBeenCalledOnce();

        let ownerCurrent = true;
        platformDispatchHold = new Promise<void>((resolve) => {
          releasePlatformDispatch = resolve;
        });
        const staleDelivery = runtime.recovery.sendRecoveryNotice({
          ...notice,
          idempotencyKey: "main-session-restart-recovery:run-2:failed-notice",
          liveOnly: true,
          isCurrent: () => ownerCurrent,
        });
        await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
        const queuedResumption = await findDeliveryIntentOwner(
          "main-session-restart-recovery:run-2:failed-notice",
        );
        ownerCurrent = false;
        releasePlatformDispatch?.();

        await expect(staleDelivery).rejects.toThrow(
          "Recovery notice owner retired before delivery",
        );

        expect(visibleSend).toHaveBeenCalledOnce();
        expect(queuedResumption).toBeNull();
        expect(sendText).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "+15551234567",
            accountId: "work",
            threadId: "thread-1",
            text: "Recovery notice",
          }),
        );
        expect(handleAction).not.toHaveBeenCalled();

        const guardedDurableNotice = {
          ...notice,
          idempotencyKey: "main-session-restart-recovery:subagent:run-3:resumed-notice",
          isCurrent: () => true,
        };
        await runtime.recovery.sendRecoveryNotice(guardedDurableNotice);
        expect(await findDeliveryIntentOwner(guardedDurableNotice.idempotencyKey)).toMatchObject({
          status: "completed",
        });
        await runtime.recovery.sendRecoveryNotice(guardedDurableNotice);
        expect(visibleSend).toHaveBeenCalledTimes(2);
        expect(await findDeliveryIntentOwner(guardedDurableNotice.idempotencyKey)).toMatchObject({
          status: "completed",
        });
      } finally {
        runtime.close();
        restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
      }
    });
  });

  it("keeps approval subscribers isolated by Gateway instance and unregisters exactly once", () => {
    const registry = createRegistry({});
    const first = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    const second = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
    const onRequested = vi.fn();
    const unsubscribe = first.nativeApprovals.subscribe({
      eventKinds: new Set(["exec"]),
      shouldHandle: () => true,
      onRequested,
      onResolved: vi.fn(),
    });
    const request = {
      id: "approval-1",
      request: {},
      createdAtMs: 1,
      expiresAtMs: 2,
    } as ExecApprovalRequest;

    expect(second.approvalEvents.publishRequested("exec", request)).toBe(0);
    expect(first.approvalEvents.publishRequested("plugin", request)).toBe(0);
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(1);
    expect(onRequested).toHaveBeenCalledOnce();

    unsubscribe();
    unsubscribe();
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(0);

    const declined = vi.fn();
    first.nativeApprovals.subscribe({
      eventKinds: new Set(["exec"]),
      shouldHandle: () => false,
      onRequested: declined,
      onResolved: vi.fn(),
    });
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(0);
    expect(declined).not.toHaveBeenCalled();
    first.close();
    expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
    second.close();
    expect(getGatewayRecoveryRuntime()).toBeUndefined();
  });

  it("delivers strict requests only through one matching account and preserves admitted actors", async () => {
    const actor = admitChannelApprovalActor(
      {
        kind: "channel",
        channel: "test",
        accountId: "default",
        senderId: "synthetic-requester",
        actorKind: "human",
      },
      () => {},
    );
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () =>
        createRegistry({
          "approval.resolve": ({ client, respond }) => {
            respond(true, {
              actor: client?.internal?.approvalActor
                ? readAdmittedChannelApprovalActor(client.internal.approvalActor)?.actor
                : null,
            });
          },
        }),
      isDispatchAvailable: () => true,
    });
    try {
      expect(
        await runtime.nativeApprovals.request("approval.resolve", {}, { approvalActor: actor }),
      ).toMatchObject({
        actor: {
          kind: "channel",
          channel: "test",
          accountId: "default",
          senderId: "synthetic-requester",
        },
      });
      const selected = vi.fn(async () => true);
      const general = vi.fn();
      const other = vi.fn(async () => true);
      runtime.nativeApprovals.subscribe({
        eventKinds: new Set(["exec"]),
        shouldHandle: () => true,
        onRequested: general,
        onResolved: vi.fn(),
      });
      runtime.nativeApprovals.subscribe({
        channel: "test",
        accountId: "other",
        eventKinds: new Set(["exec"]),
        shouldHandle: () => true,
        onRequested: general,
        onResolved: vi.fn(),
        deliverRequester: other,
      });
      runtime.nativeApprovals.subscribe({
        channel: "test",
        accountId: "default",
        eventKinds: new Set(["exec"]),
        shouldHandle: () => true,
        onRequested: general,
        onResolved: vi.fn(),
        deliverRequester: selected,
      });
      const request = {
        id: "synthetic-exclusive",
        request: { command: "echo synthetic", authorization: requesterAuthorization() },
        createdAtMs: 1,
        expiresAtMs: 100,
      };
      expect(runtime.approvalEvents.publishRequested("exec", request)).toBe(0);
      await expect(runtime.approvalEvents.deliverRequester!("exec", request)).resolves.toBe(true);
      expect(selected).toHaveBeenCalledOnce();
      expect(general).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
      const duplicate = runtime.nativeApprovals.subscribe({
        channel: "test",
        accountId: "default",
        eventKinds: new Set(["exec"]),
        shouldHandle: () => true,
        onRequested: general,
        onResolved: vi.fn(),
        deliverRequester: other,
      });
      await expect(runtime.approvalEvents.deliverRequester!("exec", request)).resolves.toBe(false);
      expect(selected).toHaveBeenCalledOnce();
      expect(other).not.toHaveBeenCalled();
      duplicate();
    } finally {
      runtime.close();
    }
  });

  it("delivers a strict Teams request through the composed native handler and Gateway", async () => {
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () =>
        createRegistry({ "exec.approval.list": ({ respond }) => respond(true, []) }),
      isDispatchAvailable: () => true,
    });
    const deliverPending = vi.fn(async () => ({ messageId: "synthetic-card" }));
    const authorization = requesterAuthorization();
    const binding = authorization.requesterBinding;
    if (binding.state !== "bound") {
      throw new Error("Expected bound fixture requester");
    }
    const request: ExecApprovalRequest = {
      id: "synthetic-teams-native",
      request: {
        command: "echo synthetic",
        turnSourceChannel: "msteams",
        turnSourceAccountId: "default",
        authorization: {
          ...authorization,
          source: {
            ...authorization.source,
            inputs: authorization.source.inputs.map((input) =>
              input.origin === "user"
                ? Object.assign({}, input, {
                    actor: Object.assign({}, input.actor, { channel: "msteams" }),
                  })
                : input,
            ),
          },
          requesterBinding: { ...binding, channel: "msteams" },
        },
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    // Keep the channel transport isolated while exercising the handler's real
    // native-runtime subscription and the Gateway's exact account selection.
    const handler = await withGatewayNativeApprovalRuntime(runtime.nativeApprovals, () =>
      createChannelApprovalHandlerFromCapability({
        label: "test/teams-native",
        clientDisplayName: "Teams test approvals",
        channel: "msteams",
        channelLabel: "Microsoft Teams",
        accountId: "default",
        cfg: {},
        capability: {
          native: {
            describeDeliveryCapabilities: () => ({
              enabled: true,
              preferredSurface: "origin",
              supportsOriginSurface: true,
              supportsApproverDmSurface: false,
            }),
            resolveRequesterTarget: () => ({ to: "conversation:synthetic-personal-chat" }),
          },
          nativeRuntime: createChannelApprovalNativeRuntimeAdapter({
            eventKinds: ["exec"],
            availability: { isConfigured: () => true, shouldHandle: () => true },
            presentation: {
              buildPendingPayload: ({ view }) => ({ title: view.title }),
              buildResolvedResult: () => ({ kind: "leave" }),
              buildExpiredResult: () => ({ kind: "leave" }),
            },
            transport: {
              prepareTarget: ({ plannedTarget }) => ({
                dedupeKey: plannedTarget.target.to,
                target: plannedTarget.target,
              }),
              deliverPending,
            },
          }),
        },
      }),
    );
    if (!handler) {
      runtime.close();
      throw new Error("Expected Teams native handler");
    }
    try {
      await handler.start();
      expect(runtime.approvalEvents.publishRequested("exec", request)).toBe(0);
      await expect(runtime.approvalEvents.deliverRequester!("exec", request)).resolves.toBe(true);
      expect(deliverPending).toHaveBeenCalledOnce();
      expect(deliverPending).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "default",
          preparedTarget: { to: "conversation:synthetic-personal-chat" },
          request: expect.objectContaining({ id: request.id }),
        }),
      );
    } finally {
      await handler.stop();
      runtime.close();
    }
  });

  it("rejects methods outside each closed internal principal", async () => {
    const runtime = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => createRegistry({}),
      isDispatchAvailable: () => true,
    });

    await expect(
      runtime.nativeApprovals.request("config.get" as GatewayNativeApprovalMethod, {}),
    ).rejects.toThrow("internal principal cannot dispatch config.get");
    await expect(runtime.nativeApprovals.requestRoute("config.get" as "send", {})).rejects.toThrow(
      "internal principal cannot dispatch config.get",
    );
    runtime.close();
  });

  it("preserves a trusted approval resolver display name", async () => {
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () =>
        createRegistry({
          "exec.approval.list": ({ client, respond }) =>
            respond(true, { displayName: client?.connect.client.displayName }),
        }),
      isDispatchAvailable: () => true,
    });

    await expect(
      runtime.nativeApprovals.request(
        "exec.approval.list",
        {},
        { clientDisplayName: "Telegram approval (owner)" },
      ),
    ).resolves.toEqual({ displayName: "Telegram approval (owner)" });
    runtime.close();
  });

  it("preserves the Gateway client's approval request deadline", async () => {
    vi.useFakeTimers();
    try {
      const { promise: started, resolve: markStarted } = createDeferred();
      const { promise: handlerCanFinish, resolve: finishHandler } = createDeferred();
      const context = createContext();
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () =>
          createRegistry({
            send: async () => {
              markStarted();
              await handlerCanFinish;
            },
          }),
        isDispatchAvailable: () => true,
      });

      try {
        const request = runtime.nativeApprovals.requestRoute("send", { message: "test" });
        const error = request.catch((value: unknown) => value);
        await started;
        await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
        const caught = await error;
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("gateway request timeout for send");
      } finally {
        finishHandler();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        runtime.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
