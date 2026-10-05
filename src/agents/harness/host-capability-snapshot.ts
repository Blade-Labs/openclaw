import path from "node:path";

const MAX_NATIVE_OPERATION_CWD_BYTES = 4096;

export function normalizeNativeOperationCwd(
  value: unknown,
  attemptCwd: string | undefined,
): string {
  if (typeof value !== "string") {
    throw new Error("native operation cwd must be a string");
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("native operation cwd must not be empty");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_NATIVE_OPERATION_CWD_BYTES) {
    throw new Error(`native operation cwd must not exceed ${MAX_NATIVE_OPERATION_CWD_BYTES} bytes`);
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new Error("native operation cwd must not contain control characters");
    }
  }
  return path.resolve(attemptCwd ?? process.cwd(), normalized);
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeSnapshot(nested, seen);
  }
  return Object.freeze(value);
}

export function cloneSnapshot<T>(value: T): T {
  return freezeSnapshot(structuredClone(value));
}
