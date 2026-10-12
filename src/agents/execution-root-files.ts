import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { bindAgentToolExecutionRoot, copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { normalizeFileToolPathParam } from "./agent-tools.params.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { preserveAtPrefixedRelativePath } from "./path-policy.js";
import { withFileMutationQueueAdmission } from "./sessions/tools/file-mutation-queue.js";
import { resolveToCwd } from "./sessions/tools/path-utils.js";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;

/** Linux procfs supplies fd-relative resolution where Node has no openat API. */
export class ExecutionRootFiles {
  readonly root: string;
  private opening?: Promise<FileHandle>;
  private checkingIdentity?: Promise<void>;
  private closed = false;
  private activeCalls = 0;
  private drained?: () => void;
  private closing?: Promise<void>;
  private readonly invocationSignal = new AsyncLocalStorage<AbortSignal | undefined>();

  constructor(
    root: string,
    private readonly signal?: AbortSignal,
  ) {
    this.root = path.resolve(root);
  }

  /** Validate before callers normalize away traversal components. Absolute paths inside are allowed. */
  resolve(input: string, cwd = this.root): string {
    if (input.includes("\0") || input.split("/").includes("..")) {
      throw new Error(
        "Execution-root containment refuses traversal components that permit escapes.",
      );
    }
    const absolute = path.resolve(cwd, input);
    const relative = path.relative(this.root, absolute);
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error("Path escapes the execution root.");
    }
    return absolute;
  }

  // Admitted host paths contain no symlinks; their canonical identity is the
  // same absolute path used by ordinary host queues. This key grants no access.
  queueKey = (absolute: string) => this.resolve(absolute);

  /** One input interpretation for tools and policy, with fd-relative @ probes. */
  resolveInput = async (input: string, cwd = this.root): Promise<string> => {
    // Validate before repair, reference/home expansion, or URL normalization.
    this.resolve(input, cwd);
    const repaired = normalizeFileToolPathParam(input);
    const reference = repaired.startsWith("@") ? repaired.slice(1) : repaired;
    this.resolve(reference, cwd);
    if (/^file:\/\//i.test(reference)) {
      this.resolve(decodeURIComponent(reference.slice(7)), cwd);
    }
    const preserved = await preserveAtPrefixedRelativePath(
      repaired,
      cwd,
      undefined,
      undefined,
      this.exists,
    );
    return this.resolve(resolveToCwd(preserved, cwd));
  };

  private exists = async (absolute: string): Promise<boolean> => {
    return this.operation(async () => {
      if (this.resolve(absolute) === this.root) {
        await this.ready();
        return true;
      }
      try {
        const parent = await this.parent(absolute);
        try {
          const stat = await fs.lstat(parent.target);
          if (stat.isSymbolicLink())
            throw new Error("Execution-root containment refuses symlinks.");
          await this.ready();
          return true;
        } finally {
          await parent.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  };

  /** Canonical bookkeeping identity: validate existing ancestors through the held root. */
  resolveIdentity = async (absolute: string): Promise<string> => {
    const resolved = this.resolve(absolute);
    let cursor = resolved;
    while (!(await this.exists(cursor))) cursor = path.dirname(cursor);
    return resolved;
  };

  private assertActive() {
    this.signal?.throwIfAborted();
    this.invocationSignal.getStore()?.throwIfAborted();
    if (this.closed) {
      throw new Error("Execution-root containment is closed.");
    }
  }

  private async openRoot(): Promise<FileHandle> {
    let handle = await fs.open("/", directoryFlags);
    try {
      for (const component of this.root.split("/").filter(Boolean)) {
        const next = await fs.open(`${fdPath(handle)}/${component}`, directoryFlags);
        await handle.close();
        handle = next;
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async ready(): Promise<FileHandle> {
    if (process.platform !== "linux") {
      throw new Error("Operation-bound execution roots require Linux procfs on this host.");
    }

    this.assertActive();
    // No eager I/O during schema projection. Selected-tool policy preflight
    // acquires this single root; all operations reuse it.
    const handle = await (this.opening ??= this.openRoot());
    this.assertActive();
    // No observation survives settlement, and cancellation stays invocation-owned.
    await (this.checkingIdentity ??= Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(this.root, { bigint: true }),
    ])
      .then(([held, named]) => {
        if (!named.isDirectory() || named.dev !== held.dev || named.ino !== held.ino) {
          throw new Error("Execution root was replaced; refusing file operations.");
        }
      })
      .finally(() => {
        this.checkingIdentity = undefined;
      }));
    this.assertActive();
    return handle;
  }

  prepareContainment = async () => {
    await this.operation(() => this.ready());
    return { executionRootContainment: "operation-bound" as const, executionRoot: this.root };
  };

  close(): Promise<void> {
    return (this.closing ??= this.closeOnce());
  }

  private async closeOnce() {
    this.closed = true;
    if (this.activeCalls > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    }
    await (await this.opening?.catch(() => undefined))?.close();
  }

  /** Hold the invocation and resolve inputs before descriptor-backed tool execution. */
  bind(tool: AnyAgentTool, cwd: string): AnyAgentTool {
    const bound = copyAgentToolMetadata(tool, {
      ...tool,
      execute: async (id, params, signal, update) => {
        const combined =
          this.signal && signal ? AbortSignal.any([this.signal, signal]) : (signal ?? this.signal);
        return withFileMutationQueueAdmission(() =>
          this.invocationSignal.run(combined, () =>
            this.operation(async () => {
              await this.ready();
              const record = params as { path?: unknown } | undefined;
              if (typeof record?.path === "string") {
                params = { ...record, path: await this.resolveInput(record.path, cwd) };
              }
              return await tool.execute(id, params, signal, update);
            }),
          ),
        );
      },
    });
    bindAgentToolExecutionRoot(bound, this, cwd);
    return bound;
  }

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    this.assertActive();
    this.activeCalls += 1;
    try {
      return await run();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("Execution-root containment refuses symlinks.", { cause: error });
      }
      throw error;
    } finally {
      this.activeCalls -= 1;
      if (this.activeCalls === 0) {
        this.drained?.();
      }
    }
  }

  private async directory(
    absolute: string,
    create = false,
  ): Promise<{ handle: FileHandle; close: () => Promise<void> }> {
    const assertCurrent = captureAgentToolSourceExecutionGuard(
      this.invocationSignal.getStore() ?? this.signal,
    );
    let handle = await this.ready();
    const held: FileHandle[] = [];
    const close = async () => {
      for (const opened of held.reverse()) {
        await opened.close();
      }
    };
    try {
      const relative = path.relative(this.root, this.resolve(absolute));
      for (const component of relative.split("/").filter(Boolean)) {
        const target = `${fdPath(handle)}/${component}`;
        let next: FileHandle;
        try {
          next = await fs.open(target, directoryFlags);
        } catch (error) {
          if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
          this.assertActive();
          assertCurrent();
          await fs.mkdir(target).catch((mkdirError: NodeJS.ErrnoException) => {
            if (mkdirError.code !== "EEXIST") {
              throw mkdirError;
            }
          });
          next = await fs.open(target, directoryFlags);
        }
        held.push(next);
        handle = next;
      }
      await this.ready();
      return { handle, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  private async parent(absolute: string, create = false) {
    const resolved = this.resolve(absolute);
    if (resolved === this.root) {
      throw new Error("File operation requires a path below the execution root.");
    }
    const directory = await this.directory(path.dirname(resolved), create);
    return { ...directory, target: `${fdPath(directory.handle)}/${path.basename(resolved)}` };
  }

  private assertFile(stat: Stats) {
    if (stat.isSymbolicLink()) {
      throw new Error("Execution-root containment refuses symlinks.");
    }
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error("Execution-root files must be regular files with a single hard link.");
    }
  }

  private async withFile<T>(absolute: string, read: (file: FileHandle, stat: Stats) => Promise<T>) {
    return this.operation(async () => {
      const parent = await this.parent(absolute);
      try {
        const file = await fs.open(parent.target, fileFlags);
        try {
          const stat = await file.stat();
          this.assertFile(stat);
          await this.ready();
          return await read(file, stat);
        } finally {
          await file.close();
        }
      } finally {
        await parent.close();
      }
    });
  }

  readFile = (absolute: string) => this.withFile(absolute, (file) => file.readFile());
  access = async (absolute: string) => {
    await this.withFile(absolute, async () => undefined);
  };
  statFile = async (absolute: string) => {
    try {
      return await this.withFile(absolute, async (_file, stat) => ({
        type: "file" as const,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };
  mkdir = async (absolute: string) => {
    return this.operation(async () => {
      const dir = await this.directory(absolute, true);
      await dir.close();
    });
  };
  readDirectory = async (absolute: string) => {
    return this.operation(async () => {
      const dir = await this.directory(absolute);
      try {
        const entries = await fs.readdir(fdPath(dir.handle), { withFileTypes: true });
        await this.ready();
        return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      } finally {
        await dir.close();
      }
    });
  };

  writeFile = async (absolute: string, content: string) => {
    return this.operation(async () => {
      const assertCurrent = captureAgentToolSourceExecutionGuard(
        this.invocationSignal.getStore() ?? this.signal,
      );
      const parent = await this.parent(absolute, true);
      const temporary = `${fdPath(parent.handle)}/.openclaw-${randomUUID()}.tmp`;
      try {
        let mode = 0o666 & ~process.umask();
        try {
          const existing = await fs.lstat(parent.target);
          this.assertFile(existing);
          mode = existing.mode & 0o777;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        this.assertActive();
        assertCurrent();
        const file = await fs.open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode,
        );
        try {
          this.assertFile(await file.stat());
          this.assertActive();
          assertCurrent();
          await file.writeFile(content, "utf8");
          await file.chmod(mode);
        } finally {
          await file.close();
        }
        await this.ready();
        // Replace the directory entry instead of truncating the admitted inode:
        // a concurrently added outside hard link cannot receive these bytes.
        this.assertActive();
        assertCurrent();
        await fs.rename(temporary, parent.target);
      } finally {
        try {
          await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          });
        } finally {
          await parent.close();
        }
      }
    });
  };

  createFileExclusive = async (
    absolute: string,
    content: string,
  ): Promise<"created" | "exists"> => {
    return this.operation(async () => {
      const assertCurrent = captureAgentToolSourceExecutionGuard(
        this.invocationSignal.getStore() ?? this.signal,
      );
      const parent = await this.parent(absolute, true);
      try {
        await this.ready();
        this.assertActive();
        assertCurrent();
        let file: FileHandle;
        try {
          file = await fs.open(
            parent.target,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o666,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return "exists";
          }
          throw error;
        }
        try {
          this.assertFile(await file.stat());
          await this.ready();
          this.assertActive();
          assertCurrent();
          await file.writeFile(content, "utf8");
        } finally {
          await file.close();
        }
        return "created";
      } finally {
        await parent.close();
      }
    });
  };

  remove = async (absolute: string) => {
    return this.operation(async () => {
      const assertCurrent = captureAgentToolSourceExecutionGuard(
        this.invocationSignal.getStore() ?? this.signal,
      );
      const parent = await this.parent(absolute);
      try {
        this.assertFile(await fs.lstat(parent.target));
        await this.ready();
        this.assertActive();
        assertCurrent();
        await fs.unlink(parent.target);
      } finally {
        await parent.close();
      }
    });
  };
}
