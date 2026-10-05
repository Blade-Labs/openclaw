import { afterEach, describe, expect, it, vi } from "vitest";
import { requesterAuthorization } from "../../gateway/approval-requester.test-support.js";
import { createTestApprovalManager } from "../../gateway/exec-approval-manager.test-support.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { createHostNonUserTurnSource } from "../../infra/host-turn-source.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  appendAdmittedRunSource,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { runBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { callGatewayTool } from "../tools/gateway.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
afterEach(() => {
  resetAgentRunRegistryForTest();
  vi.clearAllMocks();
});

async function admittedHost() {
  return createAdmittedHostCapabilityTestFixture({
    agentId: "main",
    sessionId: "synthetic-session",
    sessionKey: "agent:main:synthetic",
    runId: "synthetic-source-run",
  });
}

describe("host approval source", () => {
  it("refreshes host facts for each tool call and rejects reads after closure", async () => {
    const { hostCapabilities, closeHost, closeAdmission, admittedRunContext } =
      await admittedHost();
    try {
      expect(hostCapabilities.readSource?.().revision).toBe(0);
      appendAdmittedRunSource(admittedRunContext, createHostNonUserTurnSource("cross-session"));
      await hostCapabilities.runBeforeToolCall({
        toolName: "exec",
        params: { command: "true" },
        approvalMode: "defer",
      });
      expect(runBeforeToolCallHook).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            source: expect.objectContaining({
              revision: 1,
              inputs: [
                expect.objectContaining({ origin: "system" }),
                expect.objectContaining({ origin: "cross-session" }),
              ],
            }),
          }),
        }),
      );
      closeHost();
      expect(() => hostCapabilities.readSource?.()).toThrow("no longer active");
    } finally {
      closeHost();
      closeAdmission();
    }
  });

  it("preserves authorization, authenticated actor and timestamps through the host wait", async () => {
    const { hostCapabilities, closeHost, closeAdmission } = await admittedHost();
    const result = {
      id: "synthetic-approval",
      decision: "allow-once",
      terminalReason: "user",
      createdAtMs: 1,
      expiresAtMs: 100,
      resolvedAtMs: 2,
      authorization: requesterAuthorization(),
      resolvedByActor: {
        kind: "channel",
        channel: "test",
        accountId: "default",
        senderId: "synthetic-requester",
        actorKind: "human",
      },
    };
    vi.mocked(callGatewayTool).mockResolvedValue(result);
    try {
      await expect(
        hostCapabilities.waitForApproval({ approvalId: result.id, timeoutMs: 100 }),
      ).resolves.toEqual(result);
    } finally {
      closeHost();
      closeAdmission();
    }
  });
  it.for([false, true])(
    "retains manager-owned consent across a direct host wait (revoked=%s)",
    async (revoked, testContext) => {
      const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
        approvalKind: "plugin",
      });
      const record = manager.create(
        { title: "Synthetic native approval", description: "Synthetic input" },
        60_000,
        "synthetic-host-consent",
      );
      record.authorization = requesterAuthorization();
      await manager.register(record, 60_000);
      let resolverCurrent = true;
      await manager.resolveDetailed(
        record.id,
        "allow-once",
        {
          kind: "channel",
          id: "synthetic-resolver",
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
            if (!resolverCurrent) {
              throw new Error("Synthetic resolver revoked");
            }
          },
        },
      );
      const runId = "synthetic-host-consent-run";
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "synthetic-host-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("plugin-harness");
      const attempt = {
        runId,
        agentId: "main",
        sessionKey: "agent:main:synthetic-host-consent",
        admittedRunContext,
      };
      const context = createGatewayRequestContext(
        makeContextParams({ pluginApprovalManager: manager }),
      );
      bindGatewayContextResolver(attempt.admittedRunContext, () => context);
      const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
      vi.mocked(callGatewayTool).mockResolvedValueOnce({
        id: record.id,
        decision: "allow-once",
        terminalReason: "user",
        authorization: record.authorization,
      });
      try {
        const result = await host.capabilities.waitForApproval({
          approvalId: record.id,
          timeoutMs: 1000,
        });
        const execution = result?.approvalExecutions?.[0];
        expect(execution).toBeDefined();
        expect(JSON.stringify(result)).not.toContain("approvalExecutions");
        resolverCurrent = !revoked;
        if (revoked) {
          await expect(execution!.redeem()).rejects.toThrow();
          expect(record.consumedDecision).toBeUndefined();
        } else {
          await execution!.redeem();
          await execution!.revalidate();
          expect(record.consumedDecision).toBe("allow-once");
          await expect(execution!.redeem()).rejects.toThrow();
          resolverCurrent = false;
          expect(() => execution!.assertCurrent()).toThrow();
        }
      } finally {
        host.close();
        admission.close();
      }
    },
  );
});
