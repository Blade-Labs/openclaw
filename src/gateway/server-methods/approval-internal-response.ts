import type { RespondFn } from "./types.js";

/** Internal callers retain the same typed denial returned by approval RPC handlers. */
export function createInternalApprovalResponse(): {
  respond: RespondFn;
  throwIfFailed: () => void;
} {
  let failure: Error | undefined;
  return {
    respond: (ok, _payload, error) => {
      if (!ok) {
        failure = Object.assign(new Error(error?.message ?? "Approval failed"), {
          gatewayCode: error?.code,
          details: error?.details,
        });
      }
    },
    throwIfFailed: () => {
      if (failure) {
        throw failure;
      }
    },
  };
}
