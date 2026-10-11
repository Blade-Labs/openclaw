// Covers native approval runtime delivery and resolution.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { requesterAuthorization } from "../gateway/approval-requester.test-support.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createChannelNativeApprovalRuntime as createChannelNativeApprovalRuntimeRaw,
  deliverApprovalRequestViaChannelNativePlan,
} from "./approval-native-runtime.js";
import type { ApprovalRequestAuthorization } from "./approval-requester-binding.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";

const hoisted = vi.hoisted(() => ({
  logError: vi.fn(),
  callGatewayLeastPrivilege: vi.fn(async () => ({ ok: true })),
  createOperatorApprovalsGatewayClient: vi.fn(
    async (params: { onHelloOk?: (hello: unknown) => void }) => {
      queueMicrotask(() => params.onHelloOk?.({ type: "hello-ok" }));
      return {
        request: vi.fn(async () => []),
        stop: vi.fn(),
      };
    },
  ),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: true,
    aborted: false,
  })),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    error: hoisted.logError,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("../gateway/call.js", () => ({
  callGatewayLeastPrivilege: hoisted.callGatewayLeastPrivilege,
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: hoisted.createOperatorApprovalsGatewayClient,
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: hoisted.startGatewayClientWhenEventLoopReady,
}));

const execRequest = {
  id: "approval-1",
  request: {
    command: "uname -a",
  },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

const approvalRuntimes: Array<ReturnType<typeof createChannelNativeApprovalRuntimeRaw>> = [];

function createChannelNativeApprovalRuntime(
  params: Parameters<typeof createChannelNativeApprovalRuntimeRaw>[0],
) {
  const runtime = createChannelNativeApprovalRuntimeRaw(params);
  approvalRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(approvalRuntimes.splice(0).map((runtime) => runtime.stop()));
  hoisted.logError.mockClear();
  hoisted.callGatewayLeastPrivilege.mockReset().mockResolvedValue({ ok: true });
  hoisted.createOperatorApprovalsGatewayClient.mockClear();
  hoisted.startGatewayClientWhenEventLoopReady.mockClear();
  vi.useRealTimers();
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockCallArg(mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const arg = mock.mock.calls[index]?.[0];
  return requireRecord(arg);
}

describe("native zero-target delivery", () => {
  it.each(["private", "shared", "unavailable", "failed-notice", "missing-provenance"] as const)(
    "records zero-target native delivery with a safe %s notice outcome",
    async (sourceKind) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      let authorization: ApprovalRequestAuthorization | undefined = requesterAuthorization(false);
      if (sourceKind === "missing-provenance") {
        authorization = undefined;
      } else if (sourceKind === "unavailable") {
        authorization = {
          ...authorization,
          source: { ...authorization.source, completeness: "unavailable" },
          requesterBinding: { state: "unavailable", reason: "missing-source" },
        };
      } else if (sourceKind === "shared") {
        authorization = {
          ...authorization,
          source: {
            ...authorization.source,
            inputs: authorization.source.inputs.map((input) =>
              input.origin === "user"
                ? {
                    ...input,
                    message: {
                      ...input.message,
                      conversationKind: "channel",
                      conversationId: "shared-origin",
                    },
                  }
                : input,
            ),
          },
        };
      }
      if (sourceKind === "failed-notice") {
        hoisted.callGatewayLeastPrivilege.mockRejectedValueOnce(new Error("notice unavailable"));
      }
      const request = {
        ...execRequest,
        id: `zero-${sourceKind}`,
        request: {
          ...execRequest.request,
          authorization,
          turnSourceChannel: "test",
          turnSourceAccountId: "default",
          turnSourceTo: "user:misleading-target",
          turnSourceThreadId: "wrong-thread",
        },
      };
      const deliverTarget = vi.fn();
      const onDeliveryError = vi.fn();
      const runtime = createChannelNativeApprovalRuntime({
        label: "test/zero-target",
        clientDisplayName: "Test",
        channel: "test",
        accountId: "default",
        cfg: {},
        isConfigured: () => true,
        shouldHandle: () => sourceKind !== "unavailable",
        nativeAdapter: {
          describeDeliveryCapabilities: () => ({
            enabled: true,
            preferredSurface: "origin",
            supportsOriginSurface: true,
            supportsApproverDmSurface: false,
          }),
          resolveOriginTarget: () => null,
          resolveRequesterNoticeTarget: async () => ({ to: "verified-private-origin" }),
        },
        buildPendingContent: () => "private command",
        prepareTarget: vi.fn(),
        deliverTarget,
        onDeliveryError,
        finalizeResolved: async () => {},
      });
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "test" }),
        approvalCapability: {
          delivery: { shouldSuppressForwardingFallback: () => true },
        },
      };
      const forwarded = vi.fn();
      await withPluginRuntimeRegistryScope(
        createTestRegistry([{ pluginId: "test", source: "test", plugin }]),
        async () => {
          const forwarder = createExecApprovalForwarder({
            getConfig: () => ({
              approvals: {
                exec: {
                  enabled: true,
                  mode: "targets",
                  targets: [{ channel: "test", to: "user:misleading-target" }],
                },
              },
            }),
            deliver: forwarded,
            nowMs: () => 1000,
          });
          try {
            await runtime.start();
            await expect(forwarder.handleRequested(request)).resolves.toBe(false);
            expect(forwarded).not.toHaveBeenCalled();
            await runtime.handleRequested(request);
          } finally {
            await forwarder.stop();
            await runtime.stop();
          }
        },
      );
      expect(deliverTarget).not.toHaveBeenCalled();
      expect(onDeliveryError).not.toHaveBeenCalled();
      const expectedOutcome =
        sourceKind === "private"
          ? "sent"
          : sourceKind === "failed-notice"
            ? "failed"
            : "no-unique-chat";
      expect(hoisted.logError).toHaveBeenCalledWith(
        `approval ${request.id}: native delivery blocked; notice outcome=${expectedOutcome}`,
      );
      if (sourceKind === "private" || sourceKind === "failed-notice") {
        expect(hoisted.callGatewayLeastPrivilege).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "send",
            params: expect.objectContaining({
              to: "verified-private-origin",
              idempotencyKey: `approval-route-notice:delivery-failed:${request.id}`,
              message:
                "The native approval card could not be delivered. Check the request's status in Control UI or terminal UI.",
            }),
          }),
        );
      } else {
        expect(hoisted.callGatewayLeastPrivilege).not.toHaveBeenCalled();
      }
      expect(JSON.stringify(hoisted.callGatewayLeastPrivilege.mock.calls)).not.toMatch(
        /misleading-target|wrong-thread|private command/,
      );
      await runtime.stop();
    },
  );
});

describe("deliverApprovalRequestViaChannelNativePlan", () => {
  it("dedupes converged prepared targets", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      }),
      resolveOriginTarget: async () => ({ to: "origin-room" }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const prepareTarget = vi
      .fn()
      .mockImplementation(
        async ({ plannedTarget }: { plannedTarget: { target: { to: string } } }) =>
          plannedTarget.target.to === "approver-1"
            ? {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-1" },
              }
            : {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-2" },
              },
      );
    const deliverTarget = vi
      .fn()
      .mockImplementation(
        async ({ preparedTarget }: { preparedTarget: { channelId: string } }) => ({
          channelId: preparedTarget.channelId,
        }),
      );
    const onDuplicateSkipped = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget,
      deliverTarget,
      onDuplicateSkipped,
    });

    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(onDuplicateSkipped).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "shared-dm" }]);
    expect(result.deliveryPlan.notifyOriginWhenDmOnly).toBe(true);
  });

  it("continues after per-target delivery failures", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: false,
        supportsApproverDmSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const onDeliveryError = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { channelId: plannedTarget.target.to },
      }),
      deliverTarget: async ({ preparedTarget }) => {
        if (preparedTarget.channelId === "approver-1") {
          throw new Error("boom");
        }
        return { channelId: preparedTarget.channelId };
      },
      onDeliveryError,
    });

    expect(onDeliveryError).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "approver-2" }]);
  });
});

describe("createChannelNativeApprovalRuntime", () => {
  it("selects and expires system-agent approval targets through the native lifecycle", async () => {
    const deliverTarget = vi.fn().mockResolvedValue({ chatId: "123", messageId: "m1" });
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/system-agent-native-runtime",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "default",
      eventKinds: ["system-agent"],
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: false,
        }),
        resolveOriginTarget: () => ({ to: "123" }),
      },
      isConfigured: () => true,
      shouldHandle: vi.fn().mockReturnValue(true),
      buildPendingContent: vi.fn().mockResolvedValue({ text: "pending" }),
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { chatId: plannedTarget.target.to },
      }),
      deliverTarget,
      finalizeResolved: vi.fn().mockResolvedValue(undefined),
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "system-agent:native-1",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "delegation-1",
      },
      createdAtMs: 0,
      expiresAtMs: 2_000,
    });

    expect(deliverTarget).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent" }),
    );
    await runtime.handleExpired("system-agent:native-1");
    expect(finalizeExpired).toHaveBeenCalledOnce();
  });

  it("passes the resolved approval kind and pending content through native delivery hooks", async () => {
    const describeDeliveryCapabilities = vi.fn().mockReturnValue({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: true,
    });
    const resolveApproverDmTargets = vi
      .fn()
      .mockImplementation(({ approvalKind, accountId }) => [
        { to: `${approvalKind}:${accountId}` },
      ]);
    const buildPendingContent = vi.fn().mockResolvedValue("pending plugin");
    const prepareTarget = vi.fn().mockReturnValue({
      dedupeKey: "dm:plugin:secondary",
      target: { chatId: "plugin:secondary" },
    });
    const deliverTarget = vi
      .fn()
      .mockResolvedValue({ chatId: "plugin:secondary", messageId: "m1" });
    const finalizeResolved = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "secondary",
      eventKinds: ["exec", "plugin"] as const,
      nativeAdapter: {
        describeDeliveryCapabilities,
        resolveApproverDmTargets,
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget,
      deliverTarget,
      finalizeResolved,
    });

    await runtime.handleRequested({
      id: "opaque-request-1",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    });
    await runtime.handleResolved({
      id: "opaque-request-1",
      decision: "allow-once",
      ts: 1,
    });

    const pendingCall = mockCallArg(buildPendingContent);
    expect(requireRecord(pendingCall.request).id).toBe("opaque-request-1");
    expect(pendingCall.approvalKind).toBe("plugin");
    expect(typeof pendingCall.nowMs).toBe("number");

    const prepareCall = mockCallArg(prepareTarget);
    expect(prepareCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(requireRecord(prepareCall.request).id).toBe("opaque-request-1");
    expect(prepareCall.approvalKind).toBe("plugin");
    expect(prepareCall.pendingContent).toBe("pending plugin");

    const deliverCall = mockCallArg(deliverTarget);
    expect(deliverCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(deliverCall.preparedTarget).toEqual({ chatId: "plugin:secondary" });
    expect(requireRecord(deliverCall.request).id).toBe("opaque-request-1");
    expect(deliverCall.approvalKind).toBe("plugin");
    expect(deliverCall.pendingContent).toBe("pending plugin");

    const capabilitiesCall = mockCallArg(describeDeliveryCapabilities);
    expect(capabilitiesCall.cfg).toEqual({});
    expect(capabilitiesCall.accountId).toBe("secondary");
    expect(capabilitiesCall.approvalKind).toBe("plugin");
    expect(requireRecord(capabilitiesCall.request).id).toBe("opaque-request-1");

    const dmTargetsCall = mockCallArg(resolveApproverDmTargets);
    expect(dmTargetsCall.cfg).toEqual({});
    expect(dmTargetsCall.accountId).toBe("secondary");
    expect(dmTargetsCall.approvalKind).toBe("plugin");
    expect(requireRecord(dmTargetsCall.request).id).toBe("opaque-request-1");

    const resolvedCall = mockCallArg(finalizeResolved);
    expect(requireRecord(resolvedCall.request).id).toBe("opaque-request-1");
    expect(requireRecord(resolvedCall.resolved)).toEqual({
      id: "opaque-request-1",
      decision: "allow-once",
      ts: 1,
    });
    expect(resolvedCall.entries).toEqual([{ chatId: "plugin:secondary", messageId: "m1" }]);
  });

  it("honors the deprecated approval kind compatibility override", async () => {
    const resolveApprovalKind = vi.fn().mockReturnValue("exec");
    const buildPendingContent = vi.fn().mockResolvedValue("pending");
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-legacy-kind",
      clientDisplayName: "Test",
      cfg: {} as never,
      resolveApprovalKind,
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget: async () => null,
      deliverTarget: async () => null,
      finalizeResolved: async () => {},
    });

    const request = {
      id: "legacy-owned-id",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    } as const;
    const normalizedRequest = { ...request, approvalKind: "plugin" as const };
    await runtime.handleRequested(request);

    expect(resolveApprovalKind).toHaveBeenCalledWith(normalizedRequest);
    expect(buildPendingContent).toHaveBeenCalledWith(
      expect.objectContaining({ request: normalizedRequest, approvalKind: "exec" }),
    );
  });

  it("sends route notices over least-privilege gateway calls", async () => {
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-route-notice",
      clientDisplayName: "Test",
      channel: "slack",
      channelLabel: "Slack",
      cfg: { gateway: { auth: { token: "configured-token" } } } as never,
      accountId: "default",
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({
          to: "channel:C123",
          threadId: "1712345678.123456",
        }),
        resolveApproverDmTargets: async () => [{ to: "user:owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { chatId: plannedTarget.target.to },
      }),
      deliverTarget: async () => ({ chatId: "user:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    try {
      await runtime.handleRequested({
        id: "approval-route-notice",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.123456",
        },
        createdAtMs: 0,
        expiresAtMs: Date.now() + 60_000,
      });
    } finally {
      await runtime.stop();
    }

    expect(hoisted.callGatewayLeastPrivilege).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { gateway: { auth: { token: "configured-token" } } },
        method: "send",
        clientName: "gateway-client",
        mode: "backend",
        params: {
          channel: "slack",
          to: "channel:C123",
          accountId: "default",
          threadId: "1712345678.123456",
          message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
          idempotencyKey: "approval-route-notice:approval-route-notice",
        },
      }),
    );
  });

  it("runs expiration through the shared runtime factory", async () => {
    vi.useFakeTimers();
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-expiry",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nowMs: Date.now,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "req-1",
      request: {
        command: "echo hi",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    const expiredCall = mockCallArg(finalizeExpired);
    expect(requireRecord(expiredCall.request).id).toBe("req-1");
    expect(expiredCall.entries).toEqual([{ chatId: "owner", messageId: "m1" }]);
    vi.useRealTimers();
  });
});
