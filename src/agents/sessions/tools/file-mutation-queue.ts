import { AsyncLocalStorage } from "node:async_hooks";
import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
/**
 * Per-file mutation queue.
 *
 * Serializes reads and mutations targeting the same real file while allowing independent files to run in parallel.
 */
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../../shared/global-singleton.js";

const fileMutationTails = resolveGlobalMap<string, Promise<void>>(
  Symbol.for("openclaw.fileMutationTails"),
  "close-only",
);
const keyAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.fileMutationKeyAdmissions"),
  () => ({ fallbackScope: {}, tails: new WeakMap<object, Promise<void>>() }),
);

type FileMutationAdmission = {
  previous: Promise<void>;
  release: () => void;
  claimed: boolean;
};
const pendingAdmission = new AsyncLocalStorage<FileMutationAdmission>();

function reserveFileMutationAdmission(): FileMutationAdmission {
  const scope = getAgentToolExecutionContext()?.assistantMessage ?? keyAdmissions.fallbackScope;
  const previous = keyAdmissions.tails.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => released);
  keyAdmissions.tails.set(scope, tail);
  const cleanup = () => {
    if (keyAdmissions.tails.get(scope) === tail) {
      keyAdmissions.tails.delete(scope);
    }
  };
  tail.then(cleanup, cleanup);
  return { previous, release, claimed: false };
}

/** Reserve source order before asynchronous input preparation; acquire file keys only once. */
export async function withFileMutationQueueAdmission<T>(fn: () => Promise<T>): Promise<T> {
  if (pendingAdmission.getStore()?.claimed === false) {
    return await fn();
  }
  const admission = reserveFileMutationAdmission();
  try {
    return await pendingAdmission.run(admission, fn);
  } finally {
    // A failed preparation or an operation with no file queue must not strand later calls.
    admission.release();
  }
}

function resolveLocalFileMutationQueueKey(filePath: string): string {
  return resolveIdentityPathViaExistingAncestorSync(filePath);
}

export async function resolveFileMutationQueueKey(
  filePath: string,
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  return await (resolveQueueKey?.(filePath, signal) ?? resolveLocalFileMutationQueueKey(filePath));
}

/**
 * Preserve source-call admission while backend-owned physical identities resolve concurrently.
 * Registration is ordered per assistant message; file operations still use only fileMutationTails.
 */
export async function withFileMutationQueueKeyResolution<T>(
  keyResolution: Promise<string>,
  fn: () => Promise<T>,
): Promise<T> {
  return await withFileMutationQueueKeysResolution(
    keyResolution.then((key) => [key]),
    fn,
  );
}

export async function withFileMutationQueueKeysResolution<T>(
  keysResolution: Promise<readonly string[]>,
  fn: () => Promise<T>,
): Promise<T> {
  const pending = pendingAdmission.getStore();
  const admission = pending && !pending.claimed ? pending : reserveFileMutationAdmission();
  admission.claimed = true;
  void keysResolution.catch(() => undefined);
  let operation!: Promise<T>;
  try {
    await admission.previous;
    const keys = await keysResolution;
    operation = enqueueFileMutationQueueKeys(keys, fn);
  } finally {
    admission.release();
  }
  return await operation;
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return await withFileMutationQueues([filePath], fn);
}

async function withFileMutationQueues<T>(
  filePaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  return await enqueueFileMutationQueueKeys(filePaths.map(resolveLocalFileMutationQueueKey), fn);
}

function enqueueFileMutationQueueKeys<T>(
  queueKeys: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(queueKeys)].toSorted();
  const current = Promise.all(
    keys.map((key) => (fileMutationTails.get(key) ?? Promise.resolve()).catch(() => undefined)),
  ).then(fn);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) {
    fileMutationTails.set(key, tail);
  }
  const cleanup = () => {
    for (const key of keys) {
      if (fileMutationTails.get(key) === tail) {
        fileMutationTails.delete(key);
      }
    }
  };
  tail.then(cleanup, cleanup);
  return current;
}
