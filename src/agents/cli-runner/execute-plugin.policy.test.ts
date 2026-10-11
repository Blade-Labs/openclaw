import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  requesterAuthorization,
  withRequesterApprovalChannel,
} from "../../gateway/approval-requester.test-support.js";
import { createTestApprovalManager } from "../../gateway/exec-approval-manager.test-support.js";
import * as operatorApprovalStore from "../../gateway/operator-approval-store.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { createHostChannelTurnSource } from "../../infra/host-turn-source.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { CliBackendToolPermissionResult } from "../../plugins/cli-backend.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { appendAdmittedRunSource } from "../admitted-run-context.js";
import * as beforeToolCall from "../agent-tools.before-tool-call.js";
import { consumeSourceForToolCall } from "../agent-tools.before-tool-call.state.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import { createCliEventHandlers } from "./execute-events.js";
import {
  closePluginTestAdmissions,
  createExecution,
  requestNativeTool,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function installBeforeToolCallHook(
  handler: PluginHookHandlerMap["before_tool_call"],
  matcher?: [string, ...string[]],
) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        handler: (...args) => Reflect.apply(handler, undefined, args),
        ...(matcher ? { matcher } : {}),
      },
    ]),
  );
}

afterEach(() => {
  resetGlobalHookRunner();
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
});

describe("plugin-owned CLI native tool policy", () => {
  it.each(["deny", "cancel", "dispose", "throw"] as const)(
    "releases CLI provenance without a tool result on %s",
    async (terminal) => {
      const { context } = await createExecution({ nativeTools: ["WebFetch"] });
      const cancellation = new AbortController();
      const policyEntered = createDeferred();
      const releasePolicy = createDeferred();
      installBeforeToolCallHook(async () => {
        if (terminal === "cancel") {
          policyEntered.resolve();
          await releasePolicy.promise;
        }
        if (terminal === "throw") {
          throw new Error("Synthetic policy failure");
        }
        return terminal === "deny" ? { block: true, blockReason: "Synthetic denial" } : undefined;
      });
      await runPlugin(context, async function* (execution) {
        const permission = execution.requestToolPermission({
          toolName: "WebFetch",
          toolInput: { resource: "synthetic-resource" },
          toolCallId: "synthetic-no-result",
          abortSignal: cancellation.signal,
        });
        if (terminal === "cancel") {
          await policyEntered.promise;
          cancellation.abort();
          releasePolicy.resolve();
        }
        const result = await permission;
        expect(result.behavior).toBe(terminal === "dispose" ? "allow" : "deny");
        if (terminal !== "dispose") {
          expect(
            consumeSourceForToolCall("synthetic-no-result", context.params.runId),
          ).toBeUndefined();
        }
        yield SUCCESS_RESULT;
      });
      expect(consumeSourceForToolCall("synthetic-no-result", context.params.runId)).toBeUndefined();
    },
  );

  it.for([true, false])(
    "redeems strict consent before returning native CLI permission (resolver revoked=%s)",
    async (revoked, testContext) => {
      const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
        approvalKind: "plugin",
      });
      const record = manager.create(
        { title: "Synthetic native tool", description: "Synthetic input" },
        60_000,
        "synthetic-native-cli-dispatch",
      );
      record.authorization = requesterAuthorization();
      await manager.register(record, 60_000);
      let resolverCurrent = true;
      await manager.resolveDetailed(
        record.id,
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
            if (!resolverCurrent) {
              throw new Error("Synthetic resolver revoked");
            }
          },
        },
      );
      const gatewayContext = createGatewayRequestContext(
        makeContextParams({ pluginApprovalManager: manager }),
      );
      const { context } = await createExecution({
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
        nativeTools: ["WebFetch"],
      });
      mockCallGatewayTool.mockResolvedValue({
        id: record.id,
        decision: "allow-once",
        authorization: record.authorization,
      });
      const consuming = createDeferred();
      const releaseConsumption = createDeferred();
      const consume = operatorApprovalStore.consumeOperatorApprovalAllowOnce;
      const consumeSpy = vi
        .spyOn(operatorApprovalStore, "consumeOperatorApprovalAllowOnce")
        .mockImplementationOnce(async (params) => {
          consuming.resolve();
          await releaseConsumption.promise;
          return consume(params);
        });
      const permissionReturned = createDeferred<CliBackendToolPermissionResult>();
      let replay: CliBackendToolPermissionResult | undefined;
      const run = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "synthetic-session",
          operationalRunInstance: context.params.admittedRunContext?.operationalRunInstance,
          gatewayContextResolver: () => gatewayContext,
        },
        () =>
          runPlugin(context, async function* (execution) {
            const decision = await requestNativeTool(execution, "WebFetch", {
              resource: "synthetic-resource",
            });
            permissionReturned.resolve(decision);
            if (!revoked && decision.behavior === "allow") {
              replay = await requestNativeTool(execution, "WebFetch", {
                resource: "synthetic-resource",
              });
            }
            yield SUCCESS_RESULT;
          }),
      );
      try {
        // A consumer that returns consent without redemption must fail this
        // assertion immediately instead of waiting on an unused consumption gate.
        expect(
          await Promise.race([
            consuming.promise.then(() => "consume"),
            permissionReturned.promise.then(() => "permission"),
            run.then(() => "finished"),
          ]),
        ).toBe("consume");
        resolverCurrent = !revoked;
      } finally {
        releaseConsumption.resolve();
        await run;
      }
      await expect(permissionReturned.promise).resolves.toMatchObject({
        behavior: revoked ? "deny" : "allow",
      });
      expect(manager.getLiveSnapshot(record.id)?.consumedDecision).toBe(
        revoked ? undefined : "allow-once",
      );
      if (!revoked) {
        expect(replay).toMatchObject({ behavior: "deny" });
      }
      expect(consumeSpy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { phase: "hook", decision: "allow-always" },
    { phase: "decision", decision: "allow-always" },
    { phase: "decision", decision: "allow-once" },
  ])(
    "rechecks strict policy after the $phase await before using $decision consent",
    async ({ phase, decision }) => {
      let strict = false;
      await withRequesterApprovalChannel(
        async () => {
          const { context } = await createExecution({
            nativeTools: ["WebFetch"],
            config: { tools: { exec: { security: "full", ask: "on-miss" } } },
          });
          appendAdmittedRunSource(
            context.params.admittedRunContext!,
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
            }),
          );
          mockCallGatewayTool.mockImplementation(async () => {
            if (phase === "decision") {
              strict = true;
            }
            return { id: "synthetic-approval", decision };
          });
          await runPlugin(context, async function* (execution) {
            if (phase === "hook") {
              await expect(
                requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
              ).resolves.toMatchObject({ behavior: "allow" });
              installBeforeToolCallHook(async () => {
                strict = true;
              });
            }
            await expect(
              requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
            ).resolves.toMatchObject({ behavior: "deny" });
            yield SUCCESS_RESULT;
          });
          expect(mockCallGatewayTool).toHaveBeenCalledTimes(phase === "hook" ? 2 : 1);
        },
        { strict: () => strict },
      );
    },
  );

  it("denies native tools when caller authority expires during policy or before a retained call", async () => {
    const { context } = await createExecution({ nativeTools: ["WebFetch"] });
    let callerCurrent = true;
    context.params.assertCurrent = () => {
      if (!callerCurrent) {
        throw new Error("caller revoked");
      }
    };
    const hook = vi.fn(async () => {
      callerCurrent = false;
    });
    installBeforeToolCallHook(hook);
    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com/retained" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      expect(execution.abortSignal?.aborted).toBe(false);
      yield SUCCESS_RESULT;
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("runs canonical policy before native approval and carries rewritten params plus run context", async () => {
    const hook = vi.fn(async (_event: unknown, _context: unknown) => ({
      params: { url: "https://example.com/rewritten" },
    }));
    const completions: unknown[] = [];
    const completionSources: unknown[] = [];
    const afterToolCall: PluginHookHandlerMap["after_tool_call"] = (event, ctx) => {
      completions.push(event);
      completionSources.push(ctx.source);
    };
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: hook },
        {
          hookName: "after_tool_call",
          matcher: ["web_fetch"],
          handler: (...args) => Reflect.apply(afterToolCall, undefined, args),
        },
      ]),
    );
    const { context } = await createExecution({ nativeTools: ["WebFetch"] });
    Object.assign(context.params, {
      messageChannel: "telegram",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
      chatId: "chat-1",
      agentAccountId: "bot-1",
      senderId: "user-1",
      senderIsOwner: true,
      currentThreadTs: "thread-1",
    });
    let decision: CliBackendToolPermissionResult | undefined;

    const handlers = createCliEventHandlers({
      context,
      toolTracking: createCliToolTracking(context),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const parser = createCliJsonlStreamingParser({
      backend: { ...context.preparedBackend.backend, jsonlDialect: "claude-stream-json" },
      providerId: context.backendResolved.id,
      onAssistantDelta: () => {},
      onToolUseStart: handlers.emitParsedToolUseStart,
      onToolResult: handlers.emitParsedToolResult,
    });
    await runPlugin(
      context,
      async function* (execution) {
        const input = { url: "https://example.com/original" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "native-WebFetch", name: "WebFetch", input }],
          },
        };
        decision = await requestNativeTool(execution, "WebFetch", input);
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "native-WebFetch", content: "fetched" }],
          },
        };
        yield SUCCESS_RESULT;
      },
      { consumeStdout: (chunk) => parser.push(chunk) },
    );

    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: { url: "https://example.com/rewritten" },
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      toolName: "web_fetch",
      params: { url: "https://example.com/original" },
      toolCallId: "native-WebFetch",
      runId: context.params.runId,
    });
    expect(hook.mock.calls[0]?.[1]).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "sdk-session",
      runId: context.params.runId,
      channelId: "chat-1",
      source: { version: 1, runId: context.params.runId, inputs: [{ origin: "system" }] },
      requester: {
        channel: "telegram",
        accountId: "bot-1",
        senderId: "user-1",
        senderIsOwner: true,
      },
    });
    await vi.waitFor(() =>
      expect(completions).toMatchObject([
        {
          toolName: "web_fetch",
          toolCallId: "native-WebFetch",
          runId: context.params.runId,
          params: { url: "https://example.com/rewritten" },
          result: "fetched",
        },
      ]),
    );
    expect(completionSources).toEqual([
      expect.objectContaining({
        version: 1,
        runId: context.params.runId,
        inputs: [expect.objectContaining({ origin: "system" })],
      }),
    ]);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    { native: "Bash", canonical: "exec", input: { command: "echo blocked" } },
    {
      native: "WebFetch",
      canonical: "web_fetch",
      input: { url: "https://example.com", prompt: "summarize" },
    },
    { native: "WebSearch", canonical: "web_search", input: { query: "blocked" } },
  ])(
    "applies matched $canonical policy to native $native",
    async ({ native, canonical, input }) => {
      const hook = vi.fn(async () => ({ block: true, blockReason: `${canonical} blocked` }));
      installBeforeToolCallHook(hook, [canonical]);
      const { context } = await createExecution({ nativeTools: [native] });
      let decision: CliBackendToolPermissionResult | undefined;

      await runPlugin(context, async function* (execution) {
        decision = await requestNativeTool(execution, native, input);
        yield SUCCESS_RESULT;
      });

      expect(decision).toEqual({ behavior: "deny", message: `${canonical} blocked` });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: canonical, params: input }),
        expect.objectContaining({ toolName: canonical }),
      );
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { native: "Read", canonical: "read", input: { file_path: "/tmp/private.txt" } },
    {
      native: "Write",
      canonical: "write",
      input: { file_path: "/tmp/private.txt", content: "private" },
    },
    {
      native: "Edit",
      canonical: "edit",
      input: { file_path: "/tmp/private.txt", old_string: "old", new_string: "new" },
    },
  ])(
    "applies path-based $canonical policy to native $native",
    async ({ native, canonical, input }) => {
      const hook = vi.fn(async (event: { params: Record<string, unknown> }) =>
        event.params.path === "/tmp/private.txt"
          ? { block: true, blockReason: "private path blocked" }
          : undefined,
      );
      installBeforeToolCallHook(hook, [canonical]);
      const { context } = await createExecution({ nativeTools: [native] });
      let decision: CliBackendToolPermissionResult | undefined;

      await runPlugin(context, async function* (execution) {
        decision = await requestNativeTool(execution, native, input);
        yield SUCCESS_RESULT;
      });

      expect(decision).toEqual({ behavior: "deny", message: "private path blocked" });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: canonical,
          params: expect.objectContaining({ path: "/tmp/private.txt" }),
        }),
        expect.objectContaining({ toolName: canonical }),
      );
    },
  );

  it("projects rewritten canonical file arguments back into the native Edit schema", async () => {
    const hook = vi.fn(async () => ({
      params: {
        path: "/tmp/approved.txt",
        edits: [{ oldText: "safe-before", newText: "safe-after" }],
      },
    }));
    installBeforeToolCallHook(hook, ["edit"]);
    const { context } = await createExecution({ nativeTools: ["Edit"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Edit", {
        file_path: "/tmp/original.txt",
        old_string: "before",
        new_string: "after",
        replace_all: false,
      });
      yield SUCCESS_RESULT;
    });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "edit",
        params: expect.objectContaining({
          path: "/tmp/original.txt",
          edits: [{ oldText: "before", newText: "after" }],
        }),
      }),
      expect.anything(),
    );
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: {
        file_path: "/tmp/approved.txt",
        old_string: "safe-before",
        new_string: "safe-after",
        replace_all: false,
      },
    });
  });

  it("rejects conflicting native and canonical paths before invoking policy", async () => {
    const hook = vi.fn(async () => undefined);
    installBeforeToolCallHook(hook, ["read"]);
    const { context } = await createExecution({ nativeTools: ["Read"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Read", {
        file_path: "/tmp/private.txt",
        path: "/tmp/allowed.txt",
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("conflicting"),
      }),
    );
    expect(hook).not.toHaveBeenCalled();
  });

  it("rejects canonical edit rewrites that the native tool cannot represent", async () => {
    const hook = vi.fn(async () => ({
      params: {
        edits: [
          { oldText: "first", newText: "one" },
          { oldText: "second", newText: "two" },
        ],
      },
    }));
    installBeforeToolCallHook(hook, ["edit"]);
    const { context } = await createExecution({ nativeTools: ["Edit"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Edit", {
        file_path: "/tmp/file.txt",
        old_string: "before",
        new_string: "after",
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("native edit"),
      }),
    );
  });

  it.each([
    {
      name: "blocks",
      handler: vi.fn(async () => ({ block: true, blockReason: "blocked by plugin policy" })),
      message: "blocked by plugin policy",
    },
    {
      name: "fails",
      handler: vi.fn(async () => {
        throw new Error("policy crashed");
      }),
      message: "before_tool_call hook failed",
    },
  ])("fails closed when before_tool_call $name", async ({ handler, message }) => {
    installBeforeToolCallHook(handler);
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining(message) }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("aborts before_tool_call without reaching native approval", async () => {
    const controller = new AbortController();
    const hook = vi.fn(
      async (_event: unknown, hookContext: { abortSignal?: AbortSignal }): Promise<undefined> =>
        await new Promise((_, reject) => {
          hookContext.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("policy aborted")),
            { once: true },
          );
        }),
    );
    installBeforeToolCallHook(hook);
    const { context } = await createExecution({
      abortSignal: controller.signal,
      nativeTools: ["Bash"],
    });
    const run = runPlugin(context, async function* (execution) {
      await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());

    controller.abort(new Error("cancel policy"));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("fails closed when canonical policy returns a non-record rewrite", async () => {
    vi.spyOn(beforeToolCall, "runBeforeToolCallHook").mockResolvedValueOnce({
      blocked: false,
      params: "invalid",
    });
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("invalid input"),
      }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
