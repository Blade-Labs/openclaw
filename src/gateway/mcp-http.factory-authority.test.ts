import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const transport = vi.hoisted(() => ({ listener: undefined as RequestListener | undefined }));
vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>();
  return {
    ...http,
    createServer: (listener: RequestListener) => {
      const server = http.createServer(listener);
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
      return server;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeMcpLoopbackServer();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  transport.listener = undefined;
});

// Exercise the registered HTTP callback and actual plugin factory/callback binding.
// Stream close supplies connection cancellation without requiring a permitted socket.
function callTool(requestIndex: number) {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime || !transport.listener) {
    throw new Error("MCP listener unavailable");
  }
  const chunks: Buffer[] = [];
  const req = Object.assign(
    Readable.from([
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestIndex,
          method: "tools/call",
          params: { name: "authority_probe", arguments: { requestIndex } },
        }),
      ),
    ]),
    {
      headers: {
        authorization: `Bearer ${runtime.ownerToken}`,
        "content-type": "application/json",
        "x-session-key": "agent:main:authority-proof",
      },
      method: "POST",
      url: "/mcp",
      complete: true,
      aborted: false,
      socket: { remoteAddress: "127.0.0.1" },
    },
  );
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
  const response = new Promise<unknown>((resolve, reject) => {
    res.once("finish", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    res.once("error", reject);
  });
  transport.listener(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { response, disconnect: () => res.emit("close") };
}

it.each(["first-disconnect", "second-disconnect"] as const)(
  "binds each factory's final-effect authority to its own HTTP request: %s",
  async (mode) => {
    const root = tempDirs.make("mcp-factory-authority-");
    const pluginDir = path.join(root, "plugins", "authority-probe");
    const controlKey = Symbol.for(`openclaw.test.mcpFactoryAuthority:${root}`);
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: path.join(root, "workspace") } },
      plugins: {
        allow: ["authority-probe"],
        load: { paths: [pluginDir] },
        slots: { memory: "none" },
      },
      tools: { allow: ["authority_probe"] },
    };
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    writeJsonFile(path.join(pluginDir, "package.json"), {
      name: "authority-probe",
      version: "1.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    });
    writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "authority-probe",
      configSchema: { type: "object", additionalProperties: false },
      contracts: { tools: ["authority_probe"] },
    });
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `const control = globalThis[Symbol.for(${JSON.stringify(controlKey.description)})];
module.exports = { id: "authority-probe", register(api) {
  api.registerTool({ contextVersion: 2, create(context) {
    return { name: "authority_probe", label: "Authority probe", description: "Synthetic final-effect probe",
      parameters: { type: "object", properties: { requestIndex: { type: "number" } } },
      async execute(_id, args) {
        const gate = control.gates[args.requestIndex];
        gate.entered.resolve();
        await gate.release.promise;
        context.assertInvocationCurrent();
        control.effects.push(args.requestIndex);
        return { content: [{ type: "text", text: "effect committed" }], details: {} };
      }
    };
  } }, { name: "authority_probe" });
} };
`,
    );
    const gates = [0, 1].map(() => ({ entered: createDeferred(), release: createDeferred() }));
    // Captured plugin sources have their own dependency graph. A unique fixture
    // binding shares only test-owned scheduling controls, without altering authority.
    const control = { gates, effects: [] as number[] };
    Reflect.set(globalThis, controlKey, control);
    try {
      await withPluginCache(createPluginCache(), async () => {
        setRuntimeConfigSnapshot(config);
        const registry = loadPluginRegistryHandle({ config, onlyPluginIds: ["authority-probe"] });
        const record = registry.plugins.find((plugin) => plugin.id === "authority-probe");
        const instance = record && getPluginInstance(record);
        expect(instance, JSON.stringify(registry.diagnostics)).toBeDefined();
        setActivePluginRegistry(registry);
        try {
          await ensureMcpLoopbackServer();
          const first = callTool(0);
          expect(
            await Promise.race([gates[0]!.entered.promise.then(() => "entered"), first.response]),
          ).toBe("entered");
          if (mode === "first-disconnect") {
            first.disconnect();
            gates[0]!.release.resolve();
            expect(await first.response).toMatchObject({ result: { isError: true } });
          }
          const second = callTool(1);
          expect(
            await Promise.race([gates[1]!.entered.promise.then(() => "entered"), second.response]),
          ).toBe("entered");
          if (mode === "second-disconnect") {
            second.disconnect();
          }
          gates[0]!.release.resolve();
          gates[1]!.release.resolve();
          expect(await second.response).toMatchObject({
            result: { isError: mode === "second-disconnect" },
          });
          if (mode === "second-disconnect") {
            expect(await first.response).toMatchObject({ result: { isError: false } });
          }
          expect(control.effects).toEqual([mode === "first-disconnect" ? 1 : 0]);
        } finally {
          for (const gate of gates) {
            gate.release.resolve();
          }
          await closeMcpLoopbackServer();
          await instance?.dispose();
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, controlKey);
    }
  },
);
