import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { handleMcpJsonRpc } from "../gateway/mcp-http.handlers.js";
import { buildMcpToolSchema } from "../gateway/mcp-http.schema.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createDeferredCore } from "../shared/deferred.js";
import { rewrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { createHostWorkspaceEditTool } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { ExecutionRootFiles } from "./execution-root-files.js";
import * as pluginTools from "./openclaw-plugin-tools.js";
import * as openClawTools from "./openclaw-tools.js";
import * as mutationQueue from "./sessions/tools/file-mutation-queue.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { createImageTool } from "./tools/image-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function hook(handler: PluginHookHandlerMap["before_tool_call"]) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push({
    pluginId: "containment-test",
    hookName: "before_tool_call",
    handler,
    source: "test",
  });
  initializeGlobalHookRunner(registry);
}

async function fixture(memory = false, overrides: Partial<OpenClawCodingToolsOptions> = {}) {
  const parent = tempDirs.make("openclaw-operation-bound-");
  const root = path.join(parent, "workshop");
  const outside = path.join(parent, "outside");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "nested", "skill.txt"), "original\n");
  await fs.writeFile(path.join(outside, "skill.txt"), "outside unchanged\n");
  const rootedFiles = new ExecutionRootFiles(root);
  cleanups.push(() => rootedFiles.close());
  const tools = createOpenClawCodingTools({
    executionRootFiles: rootedFiles,
    ...(memory ? { trigger: "memory", memoryFlushWritePath: "nested/skill.txt" } : {}),
    ...{ workspaceDir: root, cwd: root, requireWorkspaceOnly: true as const },
    config: { tools: { fs: { workspaceOnly: false } } },
    registerRunCleanup: (cleanup) => cleanups.push(() => cleanup("test complete")),
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
    ...overrides,
  });
  const call = (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Missing ${name}`);
    }
    return tool.execute(`containment-${name}`, args);
  };
  return { parent, root, outside, call, tools, rootedFiles };
}

async function mcpCall(tool: AnyAgentTool, args: Record<string, unknown>, root: string) {
  // A stale shared request context must never stamp an unbound selected tool.
  const requestContext = {
    cwd: root,
    agentId: "main",
    executionRoot: root,
    executionRootContainment: "operation-bound" as const,
  };
  return handleMcpJsonRpc({
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool.name, arguments: args },
    },
    tools: [tool],
    toolSchema: buildMcpToolSchema([tool]),
    hookContext: requestContext,
  });
}

const patch = (body: string) => ({ input: `*** Begin Patch\n${body}\n*** End Patch` });

// Real filesystem operations and real plugin hooks: the hook is the adversarial
// peer at the authorization/open boundary, rather than a mocked filesystem.
describe.runIf(process.platform === "linux")("execution-root file containment", () => {
  it("supports read, batched edit, write, listing pagination, and all patch operations", async () => {
    const { root, call } = await fixture();
    let observed = 0;
    hook(async (_event, ctx) => {
      expect(ctx.executionRootContainment).toBe("operation-bound");
      expect(ctx.executionRoot).toBe(root);
      observed += 1;
    });
    await call("write", { path: "new/deeper.txt", content: "hello\n" });
    await call("edit", {
      path: "nested/skill.txt",
      edits: [{ oldText: "original", newText: "reviewed" }],
    });
    expect(JSON.stringify(await call("read", { path: "nested/skill.txt" }))).toContain("reviewed");
    const page = await call("ls", { path: ".", limit: 1 });
    expect(page.details).toMatchObject({ nextAfter: "nested" });
    const next = await call("ls", { path: ".", limit: 1, after: "nested" });
    expect(JSON.stringify(next)).toContain("new/");
    expect(next.details).not.toHaveProperty("nextAfter");
    await call("apply_patch", patch("*** Add File: patch.txt\n+one"));
    await call("apply_patch", patch("*** Update File: patch.txt\n@@\n-one\n+two"));
    await call(
      "apply_patch",
      patch("*** Update File: patch.txt\n*** Move to: moved.txt\n@@\n-two\n+three"),
    );
    expect(await fs.readFile(path.join(root, "moved.txt"), "utf8")).toBe("three\n");
    await expect(fs.access(path.join(root, "patch.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await call("apply_patch", patch("*** Delete File: moved.txt"));
    await expect(fs.access(path.join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(observed).toBe(9);
  });

  it.each(["hook", "mcp"] as const)(
    "attests only the selected bound tool through %s",
    async (route) => {
      const { root, tools } = await fixture(false, { wrapBeforeToolCallHook: route === "hook" });
      const observations: Array<{ event: unknown; ctx: unknown }> = [];
      hook(async (event, ctx) => {
        observations.push({ event, ctx });
        return { block: true, blockReason: "inspection complete" };
      });
      const invoke = async (tool: AnyAgentTool, args: Record<string, unknown>) => {
        observations.length = 0;
        if (route === "mcp") await mcpCall(tool, args, root);
        else
          await rewrapToolWithBeforeToolCallHook(tool, { cwd: root, agentId: "main" }).execute(
            "attestation",
            args,
          );
        expect(observations).toHaveLength(1);
        return observations[0]!.ctx;
      };
      for (const name of ["read", "ls", "edit", "write", "apply_patch"]) {
        const args =
          name === "apply_patch"
            ? patch("*** Add File: report.md\n+reviewed")
            : name === "edit"
              ? { path: "nested/skill.txt", edits: [{ oldText: "original", newText: "reviewed" }] }
              : name === "write"
                ? { path: "report.md", content: "reviewed" }
                : { path: name === "ls" ? "." : "nested/skill.txt" };
        expect(
          await invoke(
            tools.find((tool) => tool.name === name)!,
            args,
          ),
        ).toMatchObject({
          executionRootContainment: "operation-bound",
          executionRoot: root,
        });
      }
      const absent = async (tool: AnyAgentTool, args: Record<string, unknown>) => {
        const ctx = await invoke(tool, args);
        expect(ctx).not.toHaveProperty("executionRootContainment");
        expect(ctx).not.toHaveProperty("executionRoot");
      };
      await absent(
        tools.find((tool) => tool.name === "exec")!,
        { command: "unused" },
      );
      // Media constructors produce their real independent host backends. Only the
      // inventory factory is replaced; registered policy vetoes before provider I/O.
      const media = [
        createImageTool({ agentDir: root, workspaceDir: root, modelHasVision: true }),
        createPdfTool({ agentDir: root, workspaceDir: root, deferAutoModelResolution: true }),
      ];
      expect(media.every(Boolean)).toBe(true);
      vi.spyOn(openClawTools, "createOpenClawTools").mockReturnValue(
        media.filter((tool): tool is AnyAgentTool => tool !== null),
      );
      const mediaSurface = await fixture(false, {
        wrapBeforeToolCallHook: route === "hook",
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      });
      for (const tool of mediaSurface.tools)
        await absent(tool, { path: "unused.png", pdf: "unused.pdf" });
      expect(mediaSurface.tools.map((tool) => tool.name).toSorted()).toEqual(["pdf", "view_image"]);
      for (const name of ["plugin_file", "read", "ls", "edit", "write", "apply_patch"]) {
        const plugin: AnyAgentTool = {
          name,
          label: name,
          description: "Unbound plugin tool",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
        };
        setPluginToolMeta(plugin, { pluginId: "unbound-files", optional: false });
        vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions").mockReturnValue([plugin]);
        const surface = await fixture(false, {
          wrapBeforeToolCallHook: route === "hook",
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: true,
          },
        });
        expect(surface.tools.map((tool) => tool.name)).toEqual([name]);
        await absent(surface.tools[0]!, {});
      }
      const ordinary = await fixture(false, {
        executionRootFiles: undefined,
        wrapBeforeToolCallHook: route === "hook",
      });
      for (const tool of ordinary.tools)
        await absent(
          tool,
          tool.name === "apply_patch"
            ? patch("*** Add File: report.md\n+reviewed")
            : tool.name === "exec"
              ? { command: "unused" }
              : {
                  path: "nested/skill.txt",
                  content: "unused",
                  edits: [{ oldText: "original", newText: "reviewed" }],
                },
        );
      const sandbox = await fixture(false, {
        wrapBeforeToolCallHook: route === "hook",
        sandbox: createAgentToolsSandboxContext({
          workspaceDir: root,
          fsBridge: createHostSandboxFsBridge(root),
        }),
      });
      for (const tool of sandbox.tools)
        await absent(
          tool,
          tool.name === "apply_patch"
            ? patch("*** Add File: report.md\n+reviewed")
            : tool.name === "exec"
              ? { command: "unused" }
              : {
                  path: "nested/skill.txt",
                  content: "unused",
                  edits: [{ oldText: "original", newText: "reviewed" }],
                },
        );
    },
  );

  it.each([
    { input: "@existing.md", selected: "@existing.md", sibling: "existing.md" },
    { input: "@reference.md", selected: "reference.md", sibling: "other.md" },
    { input: "@@existing.md", selected: "@existing.md", sibling: "existing.md" },
  ])(
    "selects the same @ artifact for read/edit/write: $input",
    async ({ input, selected, sibling }) => {
      const { root, call } = await fixture();
      await fs.writeFile(path.join(root, selected), "selected original\n");
      await fs.writeFile(path.join(root, sibling), "sibling original\n");
      const policyPaths: unknown[] = [];
      hook(async (event) => {
        policyPaths.push(event.derivedPaths);
      });
      expect(JSON.stringify(await call("read", { path: input }))).toContain("selected original");
      await call("edit", { path: input, edits: [{ oldText: "original", newText: "edited" }] });
      expect(await fs.readFile(path.join(root, selected), "utf8")).toBe("selected edited\n");
      await call("write", { path: input, content: "selected written\n" });
      expect(await fs.readFile(path.join(root, selected), "utf8")).toBe("selected written\n");
      expect(await fs.readFile(path.join(root, sibling), "utf8")).toBe("sibling original\n");
      expect(policyPaths).toEqual(Array.from({ length: 3 }, () => [path.join(root, selected)]));
      await fs.mkdir(path.join(root, "@destination"));
      await fs.mkdir(path.join(root, "destination"));
      await fs.writeFile(path.join(root, "destination/moved.md"), "destination sibling");
      await call(
        "apply_patch",
        patch(`*** Update File: ${input}\n@@\n-selected written\n+selected patched`),
      );
      expect(policyPaths.at(-1)).toEqual([path.join(root, selected)]);
      await call(
        "apply_patch",
        patch(
          `*** Update File: ${input}\n*** Move to: @destination/moved.md\n@@\n-selected patched\n+selected moved`,
        ),
      );
      expect(policyPaths.at(-1)).toEqual([
        path.join(root, selected),
        path.join(root, "@destination/moved.md"),
      ]);
      expect(await fs.readFile(path.join(root, "@destination/moved.md"), "utf8")).toBe(
        "selected moved\n",
      );
      await call("apply_patch", patch("*** Delete File: @destination/moved.md"));
      expect(policyPaths.at(-1)).toEqual([path.join(root, "@destination/moved.md")]);
      await expect(fs.access(path.join(root, selected))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(root, sibling), "utf8")).toBe("sibling original\n");
      expect(await fs.readFile(path.join(root, "destination/moved.md"), "utf8")).toBe(
        "destination sibling",
      );
    },
  );

  it("shares @ directory and new descendant semantics with listing and patch policy", async () => {
    const { root, call } = await fixture();
    await fs.mkdir(path.join(root, "@literal"));
    await fs.mkdir(path.join(root, "literal"));
    await fs.mkdir(path.join(root, "reference"));
    await fs.writeFile(path.join(root, "@literal", "selected.txt"), "literal");
    await fs.writeFile(path.join(root, "literal", "sibling.txt"), "sibling");
    await fs.writeFile(path.join(root, "reference", "selected.txt"), "reference");
    const paths: unknown[] = [];
    hook(async (event) => {
      paths.push(event.derivedPaths);
    });
    for (const [input, selected] of [
      ["@literal", "@literal"],
      ["@@literal", "@literal"],
      ["@reference", "reference"],
    ]) {
      expect(JSON.stringify(await call("ls", { path: input }))).toContain("selected.txt");
      expect(paths.at(-1)).toEqual([path.join(root, selected!)]);
    }
    await call("write", { path: "@literal/new/deeper.md", content: "new literal" });
    expect(paths.at(-1)).toEqual([path.join(root, "@literal/new/deeper.md")]);
    expect(await fs.readFile(path.join(root, "@literal/new/deeper.md"), "utf8")).toBe(
      "new literal",
    );
    for (const [input, selected] of [
      ["@literal/new/patch.md", "@literal/new/patch.md"],
      ["@new.md", "new.md"],
      ["@@literal/double.md", "@literal/double.md"],
    ]) {
      await call("apply_patch", patch(`*** Add File: ${input}\n+one`));
      expect(paths.at(-1)).toEqual([path.join(root, selected!)]);
      await call("apply_patch", patch(`*** Update File: ${input}\n@@\n-one\n+two`));
      expect(paths.at(-1)).toEqual([path.join(root, selected!)]);
      const destination = "@literal/moved.md";
      await call(
        "apply_patch",
        patch(`*** Update File: ${input}\n*** Move to: ${destination}\n@@\n-two\n+three`),
      );
      expect(paths.at(-1)).toEqual([
        path.join(root, selected!),
        path.join(root, "@literal/moved.md"),
      ]);
      expect(await fs.readFile(path.join(root, "@literal/moved.md"), "utf8")).toBe("three\n");
      await expect(fs.access(path.join(root, selected!))).rejects.toMatchObject({ code: "ENOENT" });
      await call("apply_patch", patch(`*** Delete File: ${destination}`));
      expect(paths.at(-1)).toEqual([path.join(root, "@literal/moved.md")]);
      await expect(fs.access(path.join(root, "@literal/moved.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(await fs.readFile(path.join(root, "literal/sibling.txt"), "utf8")).toBe("sibling");
  });

  it("uses descriptor-relative @ probes and rejects expanded/raw escapes", async () => {
    const { root, outside, call } = await fixture();
    await fs.writeFile(path.join(root, "@literal.md"), "literal");
    await fs.mkdir(path.join(root, "@dir"));
    // The actual @ disambiguation must use held parents. Bookkeeping's workspace
    // key still uses realpathSync; it does not perform an existence stat probe.
    const syncFs = await import("node:fs");
    const stat = vi.spyOn(syncFs.default, "statSync").mockImplementation(() => {
      throw new Error("pathname stat probe");
    });
    expect(JSON.stringify(await call("read", { path: "@literal.md" }))).toContain("literal");
    await call("write", { path: "@literal.md", content: "changed\n" });
    await call("apply_patch", patch("*** Update File: @literal.md\n@@\n-changed\n+patched"));
    await call("edit", { path: "@literal.md", edits: [{ oldText: "patched", newText: "edited" }] });
    await call("ls", { path: "@dir" });
    expect(stat).not.toHaveBeenCalled();
    for (const input of [
      "@../outside/skill.txt",
      `@${path.join(outside, "skill.txt")}`,
      `file://${root}/nested/../@literal.md`,
      `file://${root}/nested/%2e%2e/@literal.md`,
    ]) {
      await expect(call("write", { path: input, content: "escaped" })).rejects.toThrow(
        /traversal|escapes/,
      );
    }
    expect(await fs.readFile(path.join(root, "@literal.md"), "utf8")).toBe("edited\n");
  });

  it.each([false, true])(
    "shares mutation admission with ordinary real edits (alias=%s)",
    async (alias) => {
      const { root, rootedFiles } = await fixture();
      const file = path.join(root, "nested/skill.txt");
      if (alias) await fs.symlink(root, path.join(root, "self"), "dir");
      const ordinaryPath = alias ? path.join(root, "self/nested/skill.txt") : file;
      await fs.writeFile(file, "first original\nsecond original\n");
      const captured = createDeferredCore<void>();
      const release = createDeferredCore<void>();
      const secondAdmission = createDeferredCore<void>();
      const keys: string[] = [];
      const queue = mutationQueue.withFileMutationQueueKeyResolution;
      vi.spyOn(mutationQueue, "withFileMutationQueueKeyResolution").mockImplementation(
        async (key, run) => {
          keys.push(await key);
          const pending = queue(key, run);
          if (keys.length === 2) secondAdmission.resolve();
          return await pending;
        },
      );
      const read = rootedFiles.readFile;
      let first = true;
      vi.spyOn(rootedFiles, "readFile").mockImplementation(async (target) => {
        const bytes = await read(target);
        if (first && target === file) {
          first = false;
          captured.resolve();
          await release.promise;
        }
        return bytes;
      });
      // Build after installing the I/O barrier: real edit captures the original bytes.
      const tools = createOpenClawCodingTools({
        workspaceDir: root,
        cwd: root,
        executionRootFiles: rootedFiles,
        toolConstructionPlan: {
          includeBaseCodingTools: true,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      });
      const rooted = tools
        .find((tool) => tool.name === "edit")!
        .execute("rooted-edit", {
          path: file,
          edits: [{ oldText: "first original", newText: "first rooted" }],
        });
      await captured.promise;
      const ordinary = createHostWorkspaceEditTool(root, { workspaceOnly: true }).execute(
        "ordinary-edit",
        {
          path: ordinaryPath,
          edits: [{ oldText: "second original", newText: "second ordinary" }],
        },
      );
      try {
        await secondAdmission.promise;
        expect(keys[0]).toBe(keys[1]);
      } finally {
        release.resolve();
        await Promise.all([rooted, ordinary]);
      }
      expect(await fs.readFile(file, "utf8")).toBe("first rooted\nsecond ordinary\n");
    },
  );

  it.each([
    "read",
    "ls",
    "write",
    "edit",
    "patch-add",
    "patch-update",
    "patch-delete",
    "patch-move",
  ])("refuses a parent replaced by a symlink during authorization: %s", async (kind) => {
    const { root, outside, call } = await fixture();
    let swapped = false;
    hook(async () => {
      if (swapped) {
        return;
      }
      swapped = true;
      await fs.rename(path.join(root, "nested"), path.join(root, "saved"));
      await fs.symlink(outside, path.join(root, "nested"));
    });
    const args =
      kind === "read"
        ? { path: "nested/skill.txt" }
        : kind === "ls"
          ? { path: "nested" }
          : kind === "write"
            ? { path: "nested/new.txt", content: "escaped" }
            : kind === "edit"
              ? {
                  path: "nested/skill.txt",
                  edits: [{ oldText: "outside unchanged", newText: "escaped" }],
                }
              : kind === "patch-add"
                ? patch("*** Add File: nested/new.txt\n+escaped")
                : kind === "patch-delete"
                  ? patch("*** Delete File: nested/skill.txt")
                  : kind === "patch-move"
                    ? patch(
                        "*** Update File: saved/skill.txt\n*** Move to: nested/new.txt\n@@\n-original\n+escaped",
                      )
                    : patch("*** Update File: nested/skill.txt\n@@\n-outside unchanged\n+escaped");
    await expect(call(kind.startsWith("patch-") ? "apply_patch" : kind, args)).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await fs.readFile(path.join(outside, "skill.txt"), "utf8")).toBe("outside unchanged\n");
    expect(await fs.readdir(outside)).toEqual(["skill.txt"]);
  });

  it.each(["read", "ls", "write", "edit", "apply_patch"])(
    "refuses a replaced root: %s",
    async (kind) => {
      const { parent, root, outside, call } = await fixture();
      hook(async () => {
        await fs.rename(root, path.join(parent, "saved-root"));
        await fs.symlink(outside, root);
      });
      const args =
        kind === "apply_patch"
          ? patch("*** Delete File: skill.txt")
          : kind === "edit"
            ? { path: "skill.txt", edits: [{ oldText: "outside unchanged", newText: "escaped" }] }
            : kind === "write"
              ? { path: "skill.txt", content: "escaped" }
              : { path: kind === "ls" ? "." : "skill.txt" };
      await expect(call(kind, args)).rejects.toThrow(/replaced/);
      expect(await fs.readFile(path.join(outside, "skill.txt"), "utf8")).toBe(
        "outside unchanged\n",
      );
    },
  );

  it.each(["read", "write", "edit", "patch-update", "patch-delete", "patch-move"])(
    "refuses an outside hard link: %s",
    async (kind) => {
      const { root, outside, call } = await fixture();
      await fs.link(path.join(outside, "skill.txt"), path.join(root, "hard.txt"));
      const args =
        kind === "write"
          ? { path: "hard.txt", content: "escaped" }
          : kind === "edit"
            ? { path: "hard.txt", edits: [{ oldText: "outside unchanged", newText: "escaped" }] }
            : kind === "patch-delete"
              ? patch("*** Delete File: hard.txt")
              : kind === "patch-move"
                ? patch(
                    "*** Update File: hard.txt\n*** Move to: new.txt\n@@\n-outside unchanged\n+escaped",
                  )
                : kind === "patch-update"
                  ? patch("*** Update File: hard.txt\n@@\n-outside unchanged\n+escaped")
                  : { path: "hard.txt" };
      await expect(call(kind.startsWith("patch-") ? "apply_patch" : kind, args)).rejects.toThrow();
      expect(await fs.readFile(path.join(outside, "skill.txt"), "utf8")).toBe(
        "outside unchanged\n",
      );
    },
  );

  it.each(["read", "ls", "write", "edit", "patch-add", "patch-delete", "patch-move"])(
    "refuses traversal and absolute escapes: %s",
    async (kind) => {
      const { root, outside, call } = await fixture();
      for (const input of [
        "../outside/skill.txt",
        path.join(outside, "skill.txt"),
        "nested/../nested/skill.txt",
      ]) {
        const args =
          kind === "write"
            ? { path: input, content: "escaped" }
            : kind === "edit"
              ? { path: input, edits: [{ oldText: "original", newText: "escaped" }] }
              : kind === "patch-add"
                ? patch(`*** Add File: ${input}\n+escaped`)
                : kind === "patch-delete"
                  ? patch(`*** Delete File: ${input}`)
                  : kind === "patch-move"
                    ? patch(
                        `*** Update File: nested/skill.txt\n*** Move to: ${input}\n@@\n-original\n+escaped`,
                      )
                    : { path: input };
        await expect(
          call(kind.startsWith("patch-") ? "apply_patch" : kind, args),
        ).rejects.toThrow();
      }
      expect(await fs.readFile(path.join(outside, "skill.txt"), "utf8")).toBe(
        "outside unchanged\n",
      );
      expect(await fs.readFile(path.join(root, "nested/skill.txt"), "utf8")).toBe("original\n");
    },
  );

  it("rejects retained tools after run cleanup", async () => {
    const { call } = await fixture();
    await call("read", { path: "nested/skill.txt" });
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await expect(call("write", { path: "nested/skill.txt", content: "late" })).rejects.toThrow(
      /closed/,
    );
  });
  it("cancels before mutation and drains concurrent cleanup calls", async () => {
    const { root } = await fixture();
    const owner = new ExecutionRootFiles(root);
    cleanups.push(() => owner.close());
    const entered = createDeferredCore<void>();
    const release = createDeferredCore<void>();
    hook(async () => {
      entered.resolve();
      await release.promise;
    });
    const tools = createOpenClawCodingTools({
      workspaceDir: root,
      cwd: root,
      executionRootFiles: owner,
      requireWorkspaceOnly: true,
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    const signal = new AbortController();
    const pending = tools
      .find((tool) => tool.name === "write")!
      .execute("cancel-write", { path: "nested/skill.txt", content: "cancelled" }, signal.signal);
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    signal.abort(new Error("cancelled"));
    const closes = [owner.close(), owner.close()];
    release.resolve();
    await rejected;
    await Promise.all(closes);
    expect(await fs.readFile(path.join(root, "nested/skill.txt"), "utf8")).toBe("original\n");
  });
  it("retains containment when a harness rebuilds tool hooks", async () => {
    const { root, outside, tools } = await fixture();
    let observed = false;
    hook(async (event, ctx) => {
      expect(ctx.executionRootContainment).toBe("operation-bound");
      expect(ctx.executionRoot).toBe(root);
      expect(event.derivedPaths).toEqual([path.join(root, "nested/skill.txt")]);
      observed = true;
    });
    const read = tools.find((tool) => tool.name === "read")!;
    const rebuilt = rewrapToolWithBeforeToolCallHook(read, { agentId: "main", cwd: outside });
    expect(
      JSON.stringify(await rebuilt.execute("rebuilt", { path: "nested/skill.txt" })),
    ).toContain("original");
    expect(observed).toBe(true);
  });
  it("keeps append-only memory writes on the held root", async () => {
    const { root, call } = await fixture(true);
    await Promise.all([
      call("write", { path: "nested/skill.txt", content: "first\n" }),
      call("write", { path: "nested/skill.txt", content: "second\n" }),
    ]);
    expect(await fs.readFile(path.join(root, "nested/skill.txt"), "utf8")).toBe(
      "original\nfirst\nsecond\n",
    );
  });

  it("refuses root replacement during memory append authorization", async () => {
    const { parent, root, outside, call } = await fixture(true);
    await fs.mkdir(path.join(outside, "nested"));
    await fs.writeFile(path.join(outside, "nested/skill.txt"), "outside unchanged\n");
    hook(async () => {
      await fs.rename(root, path.join(parent, "saved-root"));
      await fs.symlink(outside, root);
    });
    await expect(call("write", { path: "nested/skill.txt", content: "escaped" })).rejects.toThrow(
      /replaced/,
    );
    expect(await fs.readFile(path.join(outside, "nested/skill.txt"), "utf8")).toBe(
      "outside unchanged\n",
    );
  });
});
