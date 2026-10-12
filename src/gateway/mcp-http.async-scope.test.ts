import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse, RequestListener } from "node:http";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { getLogger, setLoggerOverride, resetLogger, flushLogger } from "../logging/logger.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const { execute, resolveTools, transport } = vi.hoisted(() => ({
  execute: vi.fn(),
  resolveTools: vi.fn(),
  transport: { inMemory: false, listener: undefined as RequestListener | undefined },
}));
vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>();
  return {
    ...http,
    createServer: (listener: RequestListener) => {
      const server = http.createServer(listener);
      if (transport.inMemory) {
        const runInListenerContext = AsyncLocalStorage.snapshot();
        transport.listener = (req, res) => runInListenerContext(() => listener(req, res));
        vi.spyOn(server, "listen").mockImplementation((...args: unknown[]) => {
          (args.at(-1) as () => void)();
          return server;
        });
        vi.spyOn(server, "address").mockReturnValue({
          port: 18789,
          address: "127.0.0.1",
          family: "IPv4",
        });
        vi.spyOn(server, "close").mockImplementation((callback) => {
          callback?.();
          return server;
        });
      }
      return server;
    },
  };
});
vi.mock("../config/io.js", () => {
  const config = {};
  return { getRuntimeConfig: () => config };
});
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const completed = { content: [{ type: "text", text: "tracked tool completed" }] };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const executionScopes: Array<AbortSignal | undefined> = [];
const constructionScopes: Array<AbortSignal | undefined> = [];

beforeEach(() => {
  executionScopes.length = 0;
  constructionScopes.length = 0;
  execute.mockReset().mockImplementation(() => {
    executionScopes.push(getAsyncWorkSignal());
    return trackAsyncWork(() => {
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      return completed;
    });
  });
  resolveTools.mockReset().mockImplementation(() => {
    constructionScopes.push(getAsyncWorkSignal());
    return {
      agentId: "main",
      tools: [
        {
          name: "scope_probe",
          label: "Scope probe",
          description: "Synthetic tracked tool for lifecycle proof",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
    };
  });
});

afterEach(async () => {
  resetGlobalHookRunner();
  await closeMcpLoopbackServer();
  transport.inMemory = false;
  transport.listener = undefined;
  vi.restoreAllMocks();
  await flushLogger();
  setLoggerOverride(null);
  resetLogger();
});

async function callTool(headers: Record<string, string> = {}, status = 200) {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("MCP runtime missing");
  }
  const request = transport.inMemory ? memoryRequest : fetch;
  const response = await request(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.ownerToken}`,
      "content-type": "application/json",
      "x-session-key": "agent:main:scope-proof",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scope_probe", arguments: {} },
    }),
  });
  expect(response.status).toBe(status);
  return response.json();
}

// Exercise the registered HTTP callback when the sandbox cannot bind loopback.
// Live transport cases below remain separate evidence and are never relabeled as passing.
async function memoryRequest(_url: string, init: RequestInit): Promise<Response> {
  const chunks: Buffer[] = [];
  const req = Object.assign(Readable.from([Buffer.from(String(init.body))]), {
    headers: init.headers,
    method: "POST",
    url: "/mcp",
    complete: true,
    aborted: false,
    socket: { remoteAddress: "127.0.0.1" },
  });
  const res = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
    {
      headersSent: false,
      statusCode: 200,
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
      },
    },
  );
  const finished = new Promise<Response>((resolve, reject) => {
    res.once("finish", () =>
      resolve(new Response(Buffer.concat(chunks).toString(), { status: res.statusCode })),
    );
    res.once("error", reject);
  });
  transport.listener!(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return await finished;
}

async function startFromCaller() {
  const scope = new AsyncWorkScope();
  const admission = tryBeginGatewayRootWorkAdmission("mcp-scope-test");
  if (!admission) {
    throw new Error("Caller admission unavailable");
  }
  try {
    await admission.run(() => scope.track(() => ensureMcpLoopbackServer()));
    return scope;
  } finally {
    admission.release();
  }
}

describe("MCP HTTP work ownership", () => {
  it.each([false, true])(
    "serves fresh request scopes after its creator closes (replacement=%s)",
    async (replace) => {
      if (replace) {
        const predecessor = await startFromCaller();
        await Promise.all([closeMcpLoopbackServer(), closeMcpLoopbackServer()]);
        await predecessor.drain();
      }
      const creator = await startFromCaller();
      await creator.drain();
      expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
      expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
      expect(resolveTools).toHaveBeenCalledTimes(2);
      expect(constructionScopes[0]).toBeDefined();
      expect(constructionScopes[0]?.aborted).toBe(false);
      expect(constructionScopes[0]).not.toBe(creator.signal);
      expect(executionScopes[0]).toBeDefined();
      expect(executionScopes[1]).toBeDefined();
      expect(executionScopes[0]).not.toBe(executionScopes[1]);
      for (const signal of executionScopes) {
        expect(signal).not.toBe(constructionScopes[0]);
        expect(signal?.aborted).toBe(true);
      }
      await closeMcpLoopbackServer();
      expect(constructionScopes[0]?.aborted).toBe(true);
    },
  );

  it("joins accepted tool cleanup without closing a replacement listener", async () => {
    const releaseCleanup = createDeferred();
    const cleanupStarted = createDeferred();
    let cleanup: Promise<unknown> | undefined;
    execute.mockImplementationOnce(() => {
      cleanup = trackAsyncWork(async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        return trackAsyncWork(() => completed);
      });
      return completed;
    });
    await ensureMcpLoopbackServer();
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      expect(await callTool()).toMatchObject({ result: { isError: false } });
      await cleanupStarted.promise;
      closing = closeMcpLoopbackServer().then(() => {
        closed = true;
      });
      await ensureMcpLoopbackServer();
      expect(await callTool()).toMatchObject({ result: { isError: false } });
      expect(closed).toBe(false);
      releaseCleanup.resolve();
      await closing;
      await expect(cleanup).resolves.toEqual(completed);
      expect(await callTool()).toMatchObject({ result: { isError: false } });
    } finally {
      releaseCleanup.resolve();
      await cleanup;
      await closing;
    }
  });
});

describe("MCP HTTP approval authority", () => {
  it.each([
    [false, "approved"],
    [true, "approved"],
    [true, "expired-grant"],
    [true, "aborted-run"],
    [true, "replaced-gateway"],
    [true, "forged-requester"],
    [true, "revoked-while-waiting"],
    [true, "replaced-during-discovery"],
    [true, "revoked-during-preparation"],
  ] as const)(
    "routes a fresh admitted batch after the listener creator request closes (inMemory=%s, outcome=%s)",
    async (inMemory, outcome) => {
      transport.inMemory = inMemory;
      const approvalWarnings: string[] = [];
      const approvalLogDirectory = tempDirs.make("mcp-approval-log-");
      setLoggerOverride({ level: "warn", file: join(approvalLogDirectory, "approval.log") });
      getLogger().attachTransport({
        write: (entry) => {
          approvalWarnings.push(JSON.stringify(entry));
        },
      });
      const requested = createDeferred();
      const approved = createDeferred();
      const resolution = vi.fn();
      const requestApproval = vi.fn(({ respond }: GatewayRequestHandlerOptions) => {
        requested.resolve();
        respond(true, { id: "batch-approval", status: "accepted" });
      });
      const waitApproval = vi.fn(async ({ respond }: GatewayRequestHandlerOptions) => {
        await approved.promise;
        respond(true, { id: "batch-approval", decision: "allow-once" });
      });
      const context = createContext();
      let currentContext = context;
      const resolver = () => currentContext;
      context.resolveGatewayContext = resolver;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "plugin.approval.request",
            owner: { kind: "core", area: "gateway" },
            scope: "operator.approvals",
            handler: requestApproval,
          },
          {
            name: "plugin.approval.waitDecision",
            owner: { kind: "core", area: "gateway" },
            scope: "operator.approvals",
            handler: waitApproval,
          },
        ]);
      let creatorOpen = true;
      const creator = await withPluginRuntimeGatewayRequestScope(
        {
          resolveGatewayContext: resolver,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: () => creatorOpen,
        },
        () => startFromCaller(),
      );
      creatorOpen = false;
      await creator.drain();
      const admission = prepareSystemAgentRunAdmission(
        {},
        "fresh-batch-run",
        "main",
        "mcp-approval-test",
      );
      try {
        const admitted = await admission.admit("gateway");
        bindGatewayContextResolver(admitted, resolver);
        const runtime = getActiveMcpLoopbackRuntime()!;
        const grant = mintMcpLoopbackClientGrant({
          runtimeOwnerToken: runtime.ownerToken,
          admittedRunContext: admitted,
          context: {
            sessionKey: "agent:main:scope-proof",
            runId: "fresh-batch-run",
            senderIsOwner: true,
            messageProvider: "msteams",
            currentChannelId: "dm-proof",
            accountId: "default",
          },
        });
        const captureKey = "fresh-batch-capture";
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey,
        });
        const beforeToolCall = vi.fn(() => ({
          requireApproval: {
            title: "Approve batch",
            description: "1. Set status",
            onResolution: resolution,
          },
        }));
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              pluginId: "policy",
              handler: beforeToolCall,
            },
          ]),
        );
        if (outcome === "replaced-during-discovery" || outcome === "revoked-during-preparation") {
          const resolveNormally = resolveTools.getMockImplementation()!;
          resolveTools.mockImplementationOnce(() => {
            const resolved = resolveNormally();
            if (outcome === "replaced-during-discovery") {
              currentContext = createContext();
            } else {
              resolved.tools[0].prepareBeforeToolCallParams = async (params: unknown) => {
                revokeMcpLoopbackClientGrant(grant.token);
                return params;
              };
            }
            return resolved;
          });
        }
        if (outcome === "aborted-run") {
          admission.close();
        }
        const token =
          outcome === "expired-grant"
            ? mintAttachGrant({ sessionKey: "agent:main:scope-proof", ttlMs: 1, nowMs: 1 }).token
            : outcome === "forged-requester"
              ? "forged-bearer"
              : grant.token;
        const rejectedAtAdmission = ["expired-grant", "aborted-run", "forged-requester"].includes(
          outcome,
        );
        const pending = callTool(
          {
            authorization: `Bearer ${token}`,
            "x-openclaw-cli-capture-key": captureKey,
            "x-session-key": "agent:other:forged",
            "x-openclaw-current-channel-id": "forged-dm",
          },
          rejectedAtAdmission || outcome === "replaced-during-discovery" ? 401 : 200,
        );
        if (outcome === "replaced-during-discovery" || outcome === "revoked-during-preparation") {
          const response = await pending;
          expect(beforeToolCall).not.toHaveBeenCalled();
          expect(requestApproval).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
          expect(response).toMatchObject(
            outcome === "replaced-during-discovery"
              ? { error: "unauthorized" }
              : { result: { isError: true } },
          );
          revokeMcpLoopbackClientGrant(grant.token);
          return;
        }
        if (rejectedAtAdmission) {
          expect(await pending).toEqual({ error: "unauthorized" });
          expect(requestApproval).not.toHaveBeenCalled();
          expect(execute).not.toHaveBeenCalled();
          revokeMcpLoopbackClientGrant(grant.token);
          return;
        }
        // Failure must surface instead of hanging on a request that never dispatched.
        const observed = await Promise.race([requested.promise.then(() => "requested"), pending]);
        expect(observed, approvalWarnings.join("\n")).toBe("requested");
        expect(execute).not.toHaveBeenCalled();
        expect(requestApproval).toHaveBeenCalledOnce();
        expect(requestApproval.mock.calls[0]?.[0].params).toMatchObject({
          sessionKey: "agent:main:scope-proof",
          turnSourceTo: "dm-proof",
        });
        if (outcome === "replaced-gateway") {
          currentContext = createContext();
        } else if (outcome === "revoked-while-waiting") {
          revokeMcpLoopbackClientGrant(grant.token);
        }
        approved.resolve();
        if (outcome !== "approved") {
          expect(await pending).toMatchObject({ result: { isError: true } });
          expect(execute).not.toHaveBeenCalled();
          revokeMcpLoopbackClientGrant(grant.token);
          return;
        }
        expect(await pending).toMatchObject({ result: { ...completed, isError: false } });
        expect(resolution.mock.calls[0]?.[0]).toBe("allow-once");
        expect(execute).toHaveBeenCalledOnce();
        revokeMcpLoopbackClientGrant(grant.token);
      } finally {
        approved.resolve();
        admission.close();
      }
    },
  );
});
