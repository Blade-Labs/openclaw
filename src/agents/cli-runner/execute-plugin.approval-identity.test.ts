import { afterEach, expect, it, vi } from "vitest";
import { prepareApprovalRequestAuthorization } from "../../gateway/approval-request-authorization.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import type { ApprovalRequestAuthorization } from "../../infra/approval-requester-binding.js";
import { createHostChannelTurnSource } from "../../infra/host-turn-source.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

const gateway = vi.hoisted(() => ({
  dispatch: vi.fn<(request: GatewayRequestOptions) => Promise<void>>(),
  transport: vi.fn(),
}));
vi.mock("../../gateway/server-methods.js", () => ({ handleGatewayRequest: gateway.dispatch }));
vi.mock("../../gateway/call.js", () => ({ callGateway: gateway.transport }));
vi.mock("../../infra/device-identity-async.js", () => ({
  loadOrCreateDeviceIdentityAsync: async () => undefined,
}));

const conversationId = "19:synthetic-channel@thread.tacv2";
const threadId = "synthetic-root";
const senderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  closePluginTestAdmissions();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  gateway.dispatch.mockReset();
  gateway.transport.mockReset();
});

it.for([
  { path: "policy", unrelatedCaller: false, sessionless: false, turns: 1 },
  { path: "native", unrelatedCaller: false, sessionless: false, turns: 1 },
  { path: "native", unrelatedCaller: true, sessionless: false, turns: 1 },
  { path: "policy", unrelatedCaller: false, sessionless: true, turns: 1 },
  { path: "policy", unrelatedCaller: true, sessionless: true, turns: 1 },
  { path: "native", unrelatedCaller: false, sessionless: true, turns: 1 },
  { path: "native", unrelatedCaller: true, sessionless: true, turns: 1 },
  { path: "native", unrelatedCaller: false, sessionless: false, turns: 2 },
] as const)(
  "isolates CLI $path approval provenance (ambient=$unrelatedCaller, sessionless=$sessionless, turns=$turns)",
  async ({ path, unrelatedCaller, sessionless, turns }, testContext) => {
    let previousCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
    for (let turn = 0; turn < turns; turn++) {
      gateway.dispatch.mockClear();
      gateway.transport.mockClear();
      const turnSenderId = turn === 0 ? senderId : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const { context, admission: initialAdmission } = await createExecution({
        config: { tools: { exec: { security: "allowlist", ask: "always" } } },
        nativeTools: ["WebFetch"],
      });
      initialAdmission.close();
      context.backendResolved.id = "zeroh-claude-cli";
      context.backendResolved.pluginId = "zeroh";
      const run = context.params;
      if (sessionless) {
        run.sessionKey = undefined;
      }
      const admission = prepareAgentRunAdmission({
        cfg: run.config ?? {},
        facts: {
          runId: run.runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "cli-approval-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(run.runId),
        sessionKey: run.sessionKey,
        turnSource: createHostChannelTurnSource({
          actor: {
            channel: "msteams",
            accountId: "default",
            senderId: turnSenderId,
            actorKind: "human",
          },
          message: {
            messageId: "synthetic-reply",
            conversationId,
            conversationKind: "channel",
            threadId,
            eventKind: "message",
          },
          policy: {
            requireResolverMatch: true,
            delivery: "requester",
            allowedDecisions: ["allow-once", "deny"],
          },
        }),
      });
      testContext.onTestFinished(() => admission.close());
      run.admittedRunContext = await admission.admit("plugin-harness", "claude-cli");
      Object.assign(run, {
        messageProvider: "msteams",
        chatId: conversationId,
        agentAccountId: "default",
        currentThreadTs: threadId,
        senderId: turnSenderId,
      });
      const gatewayContext = {
        getRuntimeConfig: () => run.config ?? {},
        trackExecution: (task: () => Promise<void>) => task(),
      } as GatewayRequestContext;
      bindGatewayContextResolver(run.admittedRunContext, () => gatewayContext);
      const authorizations: ApprovalRequestAuthorization[] = [];
      gateway.dispatch.mockImplementation(async ({ req, client, respond }) => {
        expect(req.method).toBe("plugin.approval.request");
        expect(client?.internal?.agentRuntimeIdentity).toMatchObject({
          agentId: "main",
          approvalOwnerPluginId: path === "policy" ? "synthetic-policy" : "zeroh",
          sessionKey: run.sessionKey,
          operationalRunInstance: run.admittedRunContext?.operationalRunInstance,
          turnSourceChannel: "msteams",
          turnSourceTo: conversationId,
          turnSourceAccountId: "default",
          turnSourceThreadId: threadId,
        });
        const { authorization } = prepareApprovalRequestAuthorization({
          cfg: run.config ?? {},
          approvalKind: "plugin",
          identity: client?.internal?.agentRuntimeIdentity,
        });
        authorizations.push(authorization);
        respond(true, { id: "synthetic-approval", decision: "deny", authorization });
      });
      // The pre-fix path falls through to anonymous transport even though the run
      // owns a Gateway. Record its actual authorization so failure names missing-source.
      gateway.transport.mockImplementation(async () => {
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
        const { authorization } = prepareApprovalRequestAuthorization({
          cfg: {},
          approvalKind: "plugin",
        });
        expect(authorization.requesterBinding).toEqual({
          state: "unavailable",
          reason: "missing-source",
        });
        authorizations.push(authorization);
        return { id: "synthetic-approval", decision: "deny", authorization };
      });
      let approvalCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            pluginId: "synthetic-policy",
            handler: () => {
              approvalCaller = getGatewayToolCallerIdentity();
              return path === "policy"
                ? { requireApproval: { title: "Synthetic policy", description: "Approve fetch" } }
                : undefined;
            },
          },
        ]),
      );
      const requestAbort = new AbortController();
      await withGatewayToolCallerIdentity(
        unrelatedCaller
          ? {
              agentId: "other-agent",
              sessionKey: "agent:other:session",
              operationalRunInstance: createOperationalRunInstanceRef("unrelated-run"),
              receiptAuthority: () => false,
              gatewayContextResolver: () => undefined,
              turnSourceChannel: "other-channel",
            }
          : previousCaller,
        () =>
          runPlugin(context, async function* (execution) {
            await expect(
              execution.requestToolPermission({
                toolName: "WebFetch",
                toolInput: { url: "https://example.com" },
                toolCallId: "synthetic-request",
                abortSignal: requestAbort.signal,
              }),
            ).resolves.toMatchObject({ behavior: "deny" });
            if (sessionless) {
              expect(approvalCaller).toBeUndefined();
              yield SUCCESS_RESULT;
              return;
            }
            expect(approvalCaller?.receiptAuthority?.()).toBe(true);
            expect(approvalCaller?.approvalSignals?.some((signal) => signal.aborted)).toBe(false);
            requestAbort.abort();
            expect(approvalCaller?.approvalSignals?.some((signal) => signal.aborted)).toBe(true);
            expect(approvalCaller?.receiptAuthority?.()).toBe(false);
            yield SUCCESS_RESULT;
          }),
      );
      if (sessionless) {
        expect(authorizations).toMatchObject([
          {
            requesterBinding: { state: "unavailable", reason: "missing-source" },
          },
        ]);
        expect(gateway.transport).toHaveBeenCalledOnce();
        expect(gateway.dispatch).not.toHaveBeenCalled();
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
        return;
      }
      expect(authorizations).toMatchObject([
        {
          requesterBinding: {
            state: "bound",
            channel: "msteams",
            accountId: "default",
            senderId: turnSenderId,
            sessionKey: run.sessionKey,
            runId: run.runId,
            sources: [
              {
                conversationId,
                conversationKind: "channel",
                messageId: "synthetic-reply",
                threadId,
              },
            ],
          },
          policy: {
            requireResolverMatch: true,
            delivery: "requester",
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      ]);
      expect(gateway.transport).not.toHaveBeenCalled();
      expect(gateway.dispatch).toHaveBeenCalledOnce();
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      if (previousCaller) {
        expect(approvalCaller?.operationalRunInstance).not.toBe(
          previousCaller.operationalRunInstance,
        );
        expect(previousCaller.receiptAuthority?.()).toBe(false);
      }
      previousCaller = approvalCaller;
    }
  },
);

it("keeps anonymous operator approval requests available with missing-source provenance", async () => {
  gateway.transport.mockImplementation(
    async () =>
      prepareApprovalRequestAuthorization({ cfg: {}, approvalKind: "plugin" }).authorization,
  );
  await expect(
    callGatewayTool("plugin.approval.request", {}, { title: "Synthetic operator request" }),
  ).resolves.toMatchObject({
    requesterBinding: { state: "unavailable", reason: "missing-source" },
  });
  expect(gateway.dispatch).not.toHaveBeenCalled();
});
