import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { rewrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { ExecutionRootFiles } from "./execution-root-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetGlobalHookRunner();
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

async function fixture(memory = false) {
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
  });
  const call = (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Missing ${name}`);
    }
    return tool.execute(`containment-${name}`, args);
  };
  return { parent, root, outside, call, tools };
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
    const { root, tools } = await fixture();
    let observed = false;
    hook(async (_event, ctx) => {
      expect(ctx.executionRootContainment).toBe("operation-bound");
      expect(ctx.executionRoot).toBe(root);
      observed = true;
    });
    const read = tools.find((tool) => tool.name === "read")!;
    const rebuilt = rewrapToolWithBeforeToolCallHook(read, { agentId: "main" });
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
