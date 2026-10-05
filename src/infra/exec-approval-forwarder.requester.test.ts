import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";

const baseRequest = {
  id: "synthetic-request",
  request: { command: "echo synthetic", agentId: "main", sessionKey: "agent:main:synthetic" },
  createdAtMs: 1_000,
  expiresAtMs: 6_000,
};
const TARGETS_CFG: OpenClawConfig = {
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "slack", to: "synthetic-recipient" }],
    },
  },
};
const activeForwarders: Array<ReturnType<typeof createExecApprovalForwarder>> = [];
afterEach(async () => {
  for (const forwarder of activeForwarders.splice(0)) {
    await forwarder.stop();
  }
  setActivePluginRegistry(createTestRegistry([]));
  vi.useRealTimers();
});
function createForwarder(params: {
  cfg: OpenClawConfig;
  resolveSessionTarget: NonNullable<
    NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["resolveSessionTarget"]
  >;
}) {
  const deliver = vi
    .fn<NonNullable<NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["deliver"]>>()
    .mockResolvedValue({
      status: "sent",
      results: [],
      receipt: { platformMessageIds: ["synthetic-message"], parts: [], sentAt: 1_000 },
    });
  const forwarder = createExecApprovalForwarder({
    getConfig: () => params.cfg,
    resolveSessionTarget: params.resolveSessionTarget,
    deliver,
    nowMs: () => 1_000,
  });
  activeForwarders.push(forwarder);
  return { deliver, forwarder };
}

describe("requester policy forwarding boundary", () => {
  it.each(["route", "send", "expiry", "resolved"] as const)(
    "suppresses forwarding after requester policy strengthens during %s",
    async (phase) => {
      vi.useFakeTimers();
      let strict = false;
      const entered = createDeferred();
      const release = createDeferred();
      const plugin = {
        ...createChannelTestPluginBase({ id: "slack" }),
        approvalCapability: {
          resolveRequestPolicy: () =>
            strict
              ? {
                  requireResolverMatch: true as const,
                  delivery: "requester" as const,
                  allowedDecisions: ["allow-once", "deny"] as const,
                }
              : { requireResolverMatch: false as const, delivery: "default" as const },
        },
        outbound: {
          deliveryMode: "direct" as const,
          beforeDeliverPayload: async () => {
            if (phase === "send") {
              entered.resolve();
              await release.promise;
            }
          },
        },
      } satisfies ChannelPlugin;
      setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", source: "test", plugin }]));
      const cfg =
        phase === "route"
          ? { approvals: { exec: { enabled: true, mode: "session" as const } } }
          : TARGETS_CFG;
      const sent = createDeferred();
      const { deliver, forwarder } = createForwarder({
        cfg,
        resolveSessionTarget: async () => {
          entered.resolve();
          await release.promise;
          return { channel: "slack", to: "synthetic-recipient" };
        },
      });
      const originalDelivery = deliver.getMockImplementation();
      deliver.mockImplementation(async (...args) => {
        const outcome = await originalDelivery!(...args);
        sent.resolve();
        return outcome;
      });
      const request = {
        ...baseRequest,
        request: {
          ...baseRequest.request,
          turnSourceChannel: "slack",
          turnSourceAccountId: "default",
        },
      };
      const requested = forwarder.handleRequested(request);
      if (phase === "route" || phase === "send") {
        await entered.promise;
        strict = true;
        release.resolve();
        await requested;
        await forwarder.stop();
        expect(deliver).not.toHaveBeenCalled();
      } else {
        await requested;
        await sent.promise;
        expect(deliver).toHaveBeenCalledOnce();
        strict = true;
        if (phase === "expiry") {
          await vi.advanceTimersByTimeAsync(baseRequest.expiresAtMs - baseRequest.createdAtMs);
        } else {
          await forwarder.handleResolved({
            id: request.id,
            decision: "deny",
            resolvedBy: "synthetic-reviewer",
            ts: 2_000,
          });
        }
        await forwarder.stop();
        expect(deliver).toHaveBeenCalledOnce();
      }
    },
  );
});
