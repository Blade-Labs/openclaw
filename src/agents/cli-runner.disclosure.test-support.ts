import path from "node:path";
import { expect, vi } from "vitest";
import type { CliBackendExecute, CliBackendExecuteContext } from "../plugins/cli-backend.types.js";
import type {
  PluginHookBeforeAgentRunEvent,
  PluginHookAgentContext,
  PluginHookLlmInputEvent,
} from "../plugins/hook-types.js";
import { admissionLifetimeOf } from "./admitted-run-context.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

export const disclosurePluginRoot = process.env.LIBMEM_PLUGIN_ROOT;
const nativeDispatch = vi.fn<CliBackendExecute>();

/** Actual Disclosure registration, input attribution and memory-port binding.
 * Only native execution and the socket listener are replaced. No HTTP proof is claimed.
 */
export async function disclosureRecoveryFixture(
  context: PreparedCliRunContext,
  native: CliBackendExecute,
  unqualifiedDuplicate = false,
) {
  if (!disclosurePluginRoot) {
    throw new Error("LIBMEM_PLUGIN_ROOT is required");
  }
  const root = path.join(disclosurePluginRoot, "zeroh-disclosure-openclaw");
  const endpointPath = path.join(root, "src/endpoint.mjs");
  vi.doMock(endpointPath, async () => {
    const actual = await vi.importActual<{ createEndpoint: (options: unknown) => object }>(
      endpointPath,
    );
    return {
      ...actual,
      createEndpoint: (options: unknown) => {
        const endpoint = actual.createEndpoint(options);
        return new Proxy(endpoint, {
          get(target, key) {
            if (key === "port") {
              return 12345;
            }
            if (key === "start") {
              return async () => {};
            }
            return Reflect.get(target, key);
          },
        });
      },
    };
  });
  nativeDispatch.mockImplementation(native);
  vi.doMock(
    path.join(root, "vendor/openclaw-anthropic-cli/extensions/anthropic/cli.runtime.ts"),
    () => ({ executeClaudeCli: nativeDispatch }),
  );
  const { default: disclosure } = await import(path.join(root, "src/index.mjs"));
  const { memoryPort } = await import(path.join(root, "src/memory-port.mjs"));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const services: Array<{ stop: () => Promise<void> }> = [];
  const warnings: string[] = [];
  let backend: PreparedCliRunContext["backendResolved"];
  const stateDir = path.join(context.workspaceDir, "disclosure");
  disclosure.register({
    config: { plugins: { slots: { memory: "atlas-memory" } } },
    pluginConfig: { stateDir, mode: "block", card: "off", cardPrompt: "off" },
    runtime: { version: "2026.9.6" },
    logger: { info() {}, warn: (line: string) => warnings.push(line) },
    registerCliBackend: (value: typeof backend) => {
      backend = value;
    },
    registerTool() {},
    registerCommand() {},
    registerService: (service: (typeof services)[number]) => services.push(service),
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, fn),
  });
  const port = memoryPort();
  const tuple = context.runIdentity!;
  const key = JSON.stringify([tuple.agentId, tuple.runId, tuple.sessionKey, tuple.sessionId]);
  const lifetime = admissionLifetimeOf(context.params.admittedRunContext.operationalRunInstance);
  port.admitWithoutMemory({
    key,
    ctx: { ...tuple, workspaceDir: context.workspaceDir },
    assertCurrent: () => context.params.assertCurrent?.(),
    bindNativeSession: async (id: string) => {
      bindings.push(id);
    },
  });
  const bindings: string[] = [];
  const late: Array<{ prompt: string; lifetime: unknown }> = [];
  const inputs: Array<{ prompt: string; lifetime: unknown; pending: Record<string, unknown> }> = [];
  const observed: CliBackendExecuteContext[] = [];
  const shared = () =>
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for("zeroh.openclaw.state")] as Map<
      string,
      { activeMemoryRuns: Map<string, Record<string, unknown>> }
    >;
  const hookRunner = {
    hasHooks: (name: string) => ["before_agent_run", "llm_input"].includes(name),
    runBeforeAgentRun: vi.fn(
      async (event: PluginHookBeforeAgentRunEvent, ctx: PluginHookAgentContext) => {
        expect(ctx).toMatchObject(tuple);
        expect(ctx.admissionLifetime).toBe(lifetime);
        // Check retirement while the successor is still live, before its input/bind.
        if (observed.length) {
          expect(() => observed.at(-1)!.assertCurrent!()).toThrow();
          expect(observed.at(-1)!.abortSignal?.aborted).toBe(true);
        }
        late.push({ prompt: event.prompt, lifetime: ctx.admissionLifetime });
        await hooks.get("before_agent_run")!(event, ctx);
        port.ready(key, { systemPrompt: context.systemPrompt, prompt: event.prompt });
      },
    ),
    runLlmInput: vi.fn(async (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => {
      expect(ctx).toMatchObject(tuple);
      expect(ctx.admissionLifetime).toBe(lifetime);
      const delivery = hooks.get("llm_input")!(event, ctx);
      // Actual handler records synchronously, before receipt I/O.
      const pending = shared().get(stateDir)!.activeMemoryRuns.get(key)!;
      inputs.push({ prompt: event.prompt, lifetime: ctx.admissionLifetime, pending });
      if (unqualifiedDuplicate) {
        await hooks.get("llm_input")!({ ...event }, ctx);
      }
      await delivery;
    }),
  };
  const prepared = await backend!.prepareExecution!({
    hostRunContractVersion: 1,
    runIdentity: tuple,
    workspaceDir: context.workspaceDir,
    provider: context.params.provider,
    modelId: context.modelId,
    executionMode: "agent",
  });
  if (!prepared?.execute) {
    throw new Error("Disclosure plugin execution unavailable");
  }
  const execute = prepared.execute;
  // Preserve the actual plugin config/prepare/execute, with a synthetic executable.
  const config = { ...backend!.config, command: "/bin/sh", liveSession: undefined };
  context.backendResolved = { ...backend!, config };
  context.preparedBackend = { ...prepared, backend: config, env: prepared.env ?? {} };
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      observed.push(execution);
      yield* execute(execution);
    },
  };
  return {
    hookRunner,
    bindings,
    late,
    inputs,
    observed,
    warnings,
    lifetime,
    async cleanup() {
      for (const service of services) {
        await service.stop();
      }
      port.stop();
      shared().delete(stateDir);
      nativeDispatch.mockReset();
    },
  };
}
