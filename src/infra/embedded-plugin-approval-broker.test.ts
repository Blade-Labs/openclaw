import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { withRequesterApprovalChannel } from "../gateway/approval-requester.test-support.js";
import { EmbeddedPluginApprovalBroker } from "./embedded-plugin-approval-broker.js";
import { createHostChannelTurnSource } from "./host-turn-source.js";

async function withAdmittedRequester<T>(run: (close: () => void) => Promise<T>) {
  const runId = "synthetic-embedded-run";
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "embedded-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    sessionKey: "agent:main:synthetic-embedded",
    turnSource: createHostChannelTurnSource({
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
    }),
  });
  const admittedRunContext = await admission.admit("embedded");
  try {
    return await withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey: "agent:main:synthetic-embedded",
        turnSourceChannel: "test",
        turnSourceAccountId: "default",
      }),
      () => run(admission.close),
    );
  } finally {
    admission.close();
  }
}

function requestPayload() {
  return {
    title: "Apply workspace skill proposal",
    description: "Apply a pending workspace skill proposal into live workspace skills.",
    toolName: "skill_workshop",
    sessionKey: "agent:main:main",
    allowedDecisions: ["allow-once"] as const,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EmbeddedPluginApprovalBroker", () => {
  it("lists, emits, and resolves pending approvals", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(approval.approvalKind).toBe("plugin");
    expect(approval.request.authorization).toMatchObject({
      source: { completeness: "unavailable", runId: null },
      requesterBinding: { state: "unavailable" },
      policy: { requireResolverMatch: false },
    });
    expect(approval?.request.toolName).toBe("skill_workshop");
    expect(events[0]).toEqual({
      event: "plugin.approval.requested",
      payload: approval,
    });
    expect(broker.resolve(approval?.id, "allow-once")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "allow-once" });
    expect(broker.listPending()).toEqual([]);
    expect(events[1]).toMatchObject({
      event: "plugin.approval.resolved",
      payload: {
        id: approval?.id,
        decision: "allow-once",
        resolvedByActor: { kind: "runtime", clientId: "tui:embedded" },
      },
    });
  });

  it.for([false, true])(
    "rejects strict local requests visibly without a prompt (admitted=%s)",
    async (admitted) => {
      await withRequesterApprovalChannel(async () => {
        const broker = new EmbeddedPluginApprovalBroker();
        const listener = vi.fn();
        broker.subscribe(listener);
        const request = async () => {
          await expect(
            broker.request({ request: requestPayload(), timeoutMs: 5_000 }),
          ).rejects.toMatchObject({
            code: "APPROVAL_REQUESTER_UNAVAILABLE",
            reason: admitted ? "ineligible" : "missing",
          });
          expect(broker.listPending()).toEqual([]);
          expect(listener).not.toHaveBeenCalled();
        };
        try {
          if (admitted) {
            await withAdmittedRequester(request);
          } else {
            await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "synthetic-session",
                turnSourceChannel: "test",
                turnSourceAccountId: "default",
              },
              request,
            );
          }
        } finally {
          broker.stop();
        }
      });
    },
  );

  it.for(["allow-once", "allow-always", "deny"] as const)(
    "rejects a local %s after requester policy strengthens and relaxes",
    async (decision) => {
      let strict = false;
      await withRequesterApprovalChannel(
        () =>
          withAdmittedRequester(async () => {
            const broker = new EmbeddedPluginApprovalBroker();
            const result = broker.request({
              request: {
                ...requestPayload(),
                allowedDecisions: ["allow-once", "allow-always", "deny"],
              },
              timeoutMs: 5_000,
            });
            void result.catch(() => {});
            try {
              const record = expectDefined(broker.listPending()[0], "local approval");
              expect(record.request.authorization).toMatchObject({
                requesterBinding: {
                  state: "bound",
                  senderId: "synthetic-requester",
                  runId: "synthetic-embedded-run",
                },
              });
              strict = true;
              expect(() => broker.resolve(record.id, decision)).toThrow(
                "Approval requester unavailable: ineligible",
              );
              strict = false;
              expect(broker.listPending()).toEqual([]);
              expect(() => broker.resolve(record.id, decision)).toThrow(
                "Approval requester unavailable: ineligible",
              );
            } finally {
              broker.stop();
              await expect(result).rejects.toThrow("broker stopped");
            }
          }),
        { strict: () => strict },
      );
    },
  );

  it.for(["current", "policy", "stop", "run-close", "abort"] as const)(
    "retains one-use local consent through final dispatch (%s)",
    async (change) => {
      let strict = false;
      await withRequesterApprovalChannel(
        () =>
          withAdmittedRequester(async (close) => {
            const broker = new EmbeddedPluginApprovalBroker();
            const controller = new AbortController();
            try {
              const result = broker.request({
                request: requestPayload(),
                timeoutMs: 5_000,
                signal: controller.signal,
              });
              const record = expectDefined(broker.listPending()[0], "local consent");
              expect(broker.resolve(record.id, "allow-once")).toBe(true);
              const outcome = await result;
              const execution = expectDefined(
                outcome.approvalExecutions?.[0],
                "local execution custody",
              );
              expect(JSON.stringify(outcome)).toBe(
                JSON.stringify({ id: record.id, decision: "allow-once" }),
              );
              if (change === "policy") {
                strict = true;
                expect(execution.requiresMatch()).toBe(true);
                strict = false;
              } else if (change === "stop") {
                broker.stop();
              } else if (change === "run-close") {
                close();
              } else if (change === "abort") {
                controller.abort();
              }
              if (change === "current") {
                await execution.redeem();
                await execution.revalidate();
                execution.assertCurrent();
                await expect(execution.redeem()).rejects.toThrow("already been consumed");
                broker.stop();
                expect(() => execution.assertCurrent()).toThrow();
              } else {
                await expect(execution.redeem()).rejects.toThrow();
              }
            } finally {
              broker.stop();
            }
          }),
        { strict: () => strict },
      );
    },
  );

  it("returns a typed denial instead of timeout after local policy strengthens", async () => {
    vi.useFakeTimers();
    let strict = false;
    await withRequesterApprovalChannel(
      () =>
        withAdmittedRequester(async () => {
          const broker = new EmbeddedPluginApprovalBroker();
          const result = broker.request({ request: requestPayload(), timeoutMs: 5_000 });
          const denied = expect(result).rejects.toMatchObject({
            code: "APPROVAL_REQUESTER_UNAVAILABLE",
          });
          strict = true;
          expect(broker.listPending()).toEqual([]);
          strict = false;
          await vi.advanceTimersByTimeAsync(5_000);
          await denied;
          broker.stop();
        }),
      { strict: () => strict },
    );
  });

  it("rejects decisions outside the request decision set", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval?.id, "allow-always")).toBe(false);
    broker.stop();
    await expect(resultPromise).rejects.toThrow("embedded plugin approval broker stopped");
  });

  it("keeps deny available as the canonical fail-closed decision", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval?.id, "deny")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "deny" });
  });

  it("times out pending approvals", async () => {
    vi.useFakeTimers();
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toMatchObject({ decision: null });
    expect(broker.listPending()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      event: "plugin.approval.removed",
      payload: { id: expect.stringMatching(/^plugin:/) },
    });
  });

  it("removes approvals when the embedded run is aborted", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: Array<{ event: string; payload: unknown }> = [];
    broker.subscribe((event) => {
      events.push(event);
    });
    const controller = new AbortController();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    controller.abort(new Error("run aborted"));

    await expect(resultPromise).rejects.toThrow("run aborted");
    expect(broker.listPending()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      event: "plugin.approval.removed",
      payload: { id: expect.stringMatching(/^plugin:/) },
    });
  });

  it("rejects pending approvals when stopped", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });

    broker.stop(new Error("local TUI stopped"));

    await expect(resultPromise).rejects.toThrow("local TUI stopped");
    expect(broker.listPending()).toEqual([]);
  });

  it("isolates a failed listener when announcing a request", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: string[] = [];
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.requested") {
        throw new Error("request listener failed");
      }
    });
    broker.subscribe((event) => {
      events.push(event.event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(broker.resolve(approval.id, "allow-once")).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({ decision: "allow-once" });
    expect(events).toEqual(["plugin.approval.requested", "plugin.approval.resolved"]);
    expect(broker.listPending()).toEqual([]);
  });

  it("isolates a failed listener when announcing a resolution", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    const events: string[] = [];
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.resolved") {
        throw new Error("resolution listener failed");
      }
    });
    broker.subscribe((event) => {
      events.push(event.event);
    });

    const resultPromise = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );

    expect(() => broker.resolve(approval.id, "allow-once")).not.toThrow();
    await expect(resultPromise).resolves.toMatchObject({ decision: "allow-once" });
    expect(events).toEqual(["plugin.approval.requested", "plugin.approval.resolved"]);
    expect(broker.listPending()).toEqual([]);
  });

  it("isolates failed listeners while stopping every pending request", async () => {
    vi.useFakeTimers();
    const broker = new EmbeddedPluginApprovalBroker();
    const removedIds: string[] = [];
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.removed") {
        throw new Error("removal listener failed");
      }
    });
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.removed") {
        removedIds.push(event.payload.id);
      }
    });
    const first = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    const second = broker.request({
      request: requestPayload(),
      timeoutMs: 5_000,
    });
    let stopError: unknown;

    try {
      broker.stop(new Error("local TUI stopped"));
    } catch (error) {
      stopError = error;
    }
    const settlementsPromise = Promise.allSettled([first, second]);
    await vi.runAllTimersAsync();
    const settlements = await settlementsPromise;

    expect(stopError).toBeUndefined();
    expect(settlements.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(removedIds).toHaveLength(2);
    expect(new Set(removedIds).size).toBe(2);
    expect(broker.listPending()).toEqual([]);
  });
});
