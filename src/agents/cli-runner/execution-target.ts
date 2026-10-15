import { createAbortError } from "../../infra/abort-signal.js";
import type { CliBackendExecute, CliBackendRunIdentity } from "../../plugins/cli-backend.types.js";
import { getPluginValueInstance } from "../../plugins/plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "../../plugins/plugin-instance.types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import type { CliExecutionTarget, PreparedCliRunContext, RunCliAgentParams } from "./types.js";

/** Capture both the admitted run and any narrower caller-owned execution authority. */
export function createCliRunCurrentAssertion(
  params: PreparedCliRunContext["params"],
  signal = params.abortSignal,
  runIdentity?: CliBackendRunIdentity,
): () => void {
  const assertCallerCurrent = params.assertCurrent;
  const assertAdmitted = resolveAdmittedRunActiveAssertion(params.admittedRunContext, signal);
  return () => {
    if (
      runIdentity &&
      Object.entries(runIdentity).some(
        ([field, value]) => params[field as keyof CliBackendRunIdentity] !== value,
      )
    ) {
      throw new Error("CLI host run identity changed after preparation");
    }
    assertCallerCurrent?.();
    if (signal?.aborted) {
      throw createAbortError("CLI run aborted");
    }
    if (!assertAdmitted) {
      throw new Error("CLI run authority is no longer active");
    }
    assertAdmitted();
  };
}

/** CLI callbacks carry the same admitted requester and lifetime as host-bound tools. */
export async function withCliGatewayToolCallerIdentity<T>(
  run: PreparedCliRunContext["params"],
  signal: AbortSignal,
  callback: () => Promise<T> | T,
): Promise<T> {
  const identity = run.admittedRunContext
    ? createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: run.admittedRunContext,
        receiptAuthority: createCliRunCurrentAssertion(run, signal),
        approvalSignals: [signal, ...(run.abortSignal ? [run.abortSignal] : [])],
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        turnSourceChannel: run.messageChannel ?? run.messageProvider,
        turnSourceTo: run.chatId ?? run.currentChannelId,
        turnSourceAccountId: run.agentAccountId,
        turnSourceThreadId: run.currentThreadTs,
      })
    : undefined;
  // Native callbacks stay sessionless; MCP's separately assigned session is not
  // their authority. Missing identity must clear any enclosing run's caller.
  return identity
    ? withGatewayToolCallerIdentity(identity, callback)
    : withoutGatewayToolCallerIdentity(callback);
}

/** Preparation and execution must agree on the owner of private prompt context. */
export function resolveCliExecutionTarget(context: {
  params: Pick<RunCliAgentParams, "sessionEntry" | "controlOperation">;
  backendId: string;
  execute?: CliBackendExecute;
}): CliExecutionTarget {
  const entry = context.params.sessionEntry;
  // Claude placement owns its CLI, auth, transcript, and exec tools together.
  if (context.backendId === "claude-cli" && entry?.execHost === "node") {
    const nodeId = entry.execNode?.trim();
    if (!nodeId) {
      throw new Error("node-placed Claude CLI session is missing execNode");
    }
    return {
      kind: "node",
      placement: { nodeId, ...(entry.execCwd?.trim() ? { cwd: entry.execCwd.trim() } : {}) },
    };
  }
  return context.execute && context.params.controlOperation !== "compact"
    ? { kind: "plugin", execute: context.execute }
    : { kind: "process" };
}

/**
 * A plugin hot reload retires the previous backend instance after a bounded call
 * drain and then rejects its calls, which discarded turns that finished later.
 * A retained consumer keeps every plugin call of one prepared turn (execution
 * stream, lifecycle parser, text transforms, cleanup) admitted on that instance
 * until the turn's cleanup releases it; the owner's physical cleanup waits for it.
 */
export function retainCliPluginExecutionConsumer(
  execute: CliBackendExecute | undefined,
): PluginInstanceConsumer | undefined {
  const owner = execute ? getPluginValueInstance(execute) : undefined;
  if (!owner) {
    return undefined;
  }
  try {
    return owner.retainConsumer();
  } catch {
    // The owner is already retiring; the ordinary call path reports that itself.
    return undefined;
  }
}
