import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { toErrorObject } from "../../infra/errors.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgramCandidate,
} from "../../plugin-sdk/windows-spawn.js";
import type {
  CliBackendExecute,
  CliBackendUserInputRequest,
  CliBackendUserInputResult,
} from "../../plugins/cli-backend.types.js";
import type { RunExit, TerminationReason } from "../../process/supervisor/types.js";
import type { CliTerminalInterruption } from "../cli-output-contracts.js";
import { FailoverError, isSignalTimeoutReason } from "../failover-error.js";
import { withAgentQuestionAnswerAuthority } from "../harness/host-private-capabilities.js";
import { runStructuredInput } from "../harness/structured-input-execution.js";
import { compileStructuredInputQuestions } from "../harness/structured-input.js";
import { resolveReplyExpectation } from "../reply-completion.js";
import { recordAgentCleanupFailure } from "../run-cleanup-timeout.js";
import {
  restartCliLiveSession,
  createCliLiveSessionCapability,
} from "./cli-live-session-registry.js";
import { createCliAbortError } from "./execute-node-claude.js";
import { createPluginToolPermissionHandler } from "./execute-plugin-tool-permission.js";
import { createCliPluginWatchdog, type CliWatchdogClock } from "./execute-plugin-watchdog.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import { createCliFailoverError as failover } from "./exit-error.js";
import * as noOutputPolicy from "./no-output-timeout-policy.js";
import type { PreparedCliRunContext } from "./types.js";

const PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS = 5_000;

function cancelUserInput(message: string): CliBackendUserInputResult {
  return { status: "cancelled", message };
}

function createPluginUserInputHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
  onPendingInput: (delta: 1 | -1) => void;
}): (request: CliBackendUserInputRequest) => Promise<CliBackendUserInputResult> {
  const run = params.context.params;
  return async (request) => {
    const signal = request.abortSignal
      ? AbortSignal.any([params.abortSignal, request.abortSignal])
      : params.abortSignal;
    const assertActive = createCliRunCurrentAssertion(run, signal, params.context.runIdentity);
    try {
      assertActive();
    } catch {
      return cancelUserInput(
        "OpenClaw cancelled operator input: the admitted run is no longer active.",
      );
    }

    const toolName = request.toolName.trim();
    if (
      !toolName ||
      (run.cliToolAvailability && !run.cliToolAvailability.native.includes(toolName))
    ) {
      return cancelUserInput(
        toolName
          ? `OpenClaw cancelled operator input from ${toolName}: it is unavailable to this run.`
          : "OpenClaw cancelled an unnamed operator input request.",
      );
    }
    if (request.questions.length === 0 || request.questions.length > 12) {
      return cancelUserInput("OpenClaw cancelled an invalid operator input request.");
    }

    const questionAuthority = params.context.bindQuestionAnswerAuthority?.(assertActive);
    const assertQuestionActive = () => {
      assertActive();
      questionAuthority?.assertActive();
    };
    params.onPendingInput(1);
    try {
      const result = await withAgentQuestionAnswerAuthority(questionAuthority, () =>
        runStructuredInput({
          input: compileStructuredInputQuestions({
            questions: request.questions.map((question) => ({
              ...question,
              isSecret: false,
            })),
            intro: request.intro?.trim() || "Agent needs input:",
          }),
          sessionKey: run.sessionKey ?? run.sessionId,
          agentId: run.agentId,
          runId: run.runId,
          timeoutMs: run.timeoutMs,
          delivery: {
            onBlockReply: run.onBlockReply,
            onPartialReply: run.onPartialReply,
          },
          signal,
          isActive: () => {
            try {
              assertQuestionActive();
              return true;
            } catch {
              return false;
            }
          },
          questionId: request.toolCallId ? (batch) => `${request.toolCallId}:${batch}` : undefined,
        }),
      );
      try {
        assertQuestionActive();
      } catch {
        return cancelUserInput(
          "OpenClaw cancelled operator input: the admitted run closed before the answer was committed.",
        );
      }
      return result.status === "answered"
        ? { status: "answered", answers: result.answers }
        : cancelUserInput(
            result.message ??
              "OpenClaw cancelled operator input; continue with your best judgment.",
          );
    } catch {
      return cancelUserInput(
        "OpenClaw could not collect operator input; continue with your best judgment.",
      );
    } finally {
      params.onPendingInput(-1);
    }
  };
}

function waitForIteratorValue<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    return Promise.reject(toErrorObject(signal.reason, "CLI plugin execution was aborted."));
  }
  return new Promise((resolve, reject) => {
    const rejectAborted = () =>
      reject(toErrorObject(signal.reason, "CLI plugin execution was aborted."));
    signal.addEventListener("abort", rejectAborted, { once: true });
    void iterator.next().then(
      (value) => {
        signal.removeEventListener("abort", rejectAborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", rejectAborted);
        reject(toErrorObject(error, "CLI plugin execution stream failed."));
      },
    );
  });
}

async function closePluginIterator(
  iterator: AsyncIterator<Record<string, unknown>> | undefined,
): Promise<void> {
  if (!iterator?.return) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      iterator.return(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("CLI plugin runtime did not close after its run ended.")),
          PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } catch (error) {
    recordAgentCleanupFailure();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Runs a prepared plugin transport while keeping cancellation and approvals host-owned. */
export async function executePluginOwnedProcess(params: {
  context: PreparedCliRunContext;
  execute: CliBackendExecute;
  executionCommand: string;
  executionArgv0?: string;
  executionArgs: readonly string[];
  env: Record<string, string>;
  prompt: string;
  promptContext?: PreparedCliRunContext["promptContext"];
  useResume: boolean;
  forceNewSession?: boolean;
  sessionId?: string;
  noOutputTimeoutMs: number;
  watchdogClock?: CliWatchdogClock;
  consumeStdout: (chunk: string) => void;
  onOutstandingWorkChange?: (active: boolean) => void;
  activeToolCount?: () => number;
  getActiveLoopbackAskUserDeadline?: () => number | undefined;
  onActiveLoopbackAskUserDeadlineChange?: (listener: () => void) => () => void;
  onNoOutputTimeout?: (error: FailoverError) => void;
  onInterrupted?: (reason: CliTerminalInterruption["reason"]) => boolean;
  mcpCapture?: {
    captureKey?: string;
    beginCapture: (captureKey: string | undefined, assertCurrent: () => void) => void;
  };
  liveSession?: {
    requiredGeneration?: string;
  };
}): Promise<RunExit> {
  const run = params.context.params;
  const cwd = params.context.cwd ?? params.context.workspaceDir;
  const executable =
    process.platform === "win32"
      ? resolveWindowsExecutablePath(params.executionCommand, params.env, cwd)
      : params.executionCommand;
  let command = resolveExecutablePath(executable, { cwd, env: params.env });
  if (!command) {
    throw new Error(`CLI backend executable could not be resolved: ${params.executionCommand}`);
  }
  let executionArgs = params.executionArgs;
  if (process.platform === "win32") {
    const program = resolveWindowsSpawnProgramCandidate({ command, env: params.env });
    // npm launchers need the child PATH's Node, not a packaged OpenClaw executable.
    command =
      program.resolution === "node-entrypoint"
        ? resolveWindowsExecutablePath("node", params.env, cwd)
        : program.command;
    if (program.leadingArgv.length > 0) {
      executionArgs = [...program.leadingArgv, ...executionArgs];
    }
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = run.abortSignal
    ? AbortSignal.any([controller.signal, run.abortSignal])
    : controller.signal;
  const assertCurrent = createCliRunCurrentAssertion(run, signal, params.context.runIdentity);
  const assertRunCurrent = createCliRunCurrentAssertion(
    run,
    run.abortSignal,
    params.context.runIdentity,
  );
  const termination: { reason: TerminationReason } = { reason: "exit" };
  // Normal cleanup closes native callbacks; MCP results retain their admitted
  // caller through the capture drain. Cancellation and timeouts still close both.
  const assertCaptureCurrent = () =>
    (termination.reason === "exit" ? assertRunCurrent : assertCurrent)();
  const outstanding = {
    approvals: 0,
    background: 0,
    observed: false,
    replayUnsafe: false,
  };
  const reportOutstandingWork = () =>
    params.onOutstandingWorkChange?.(outstanding.approvals > 0 || outstanding.background > 0);
  const updatePendingApproval = (delta: number) => {
    outstanding.approvals = Math.max(0, outstanding.approvals + delta);
    reportOutstandingWork();
  };
  const watchdog = createCliPluginWatchdog(
    {
      provider: run.provider,
      model: params.context.modelId,
      sessionId: run.sessionId,
      lane: run.lane,
      overallTimeoutMs: clampPositiveTimerTimeoutMs(run.timeoutMs),
      noOutputTimeoutMs: clampPositiveTimerTimeoutMs(params.noOutputTimeoutMs),
      useResume: params.useResume,
      getActiveAskUserDeadline: params.getActiveLoopbackAskUserDeadline,
      activeToolCount: () => Math.max(params.activeToolCount?.() ?? 0, outstanding.approvals),
      backgroundTaskCount: () => outstanding.background,
      hasObservedActivity: () => outstanding.observed,
      hasReplayUnsafeActivity: () => outstanding.replayUnsafe,
      onNoOutputTimeout: (error) => {
        termination.reason = "no-output-timeout";
        params.onNoOutputTimeout?.(error);
        controller.abort(error);
      },
      onOverallTimeout: () => {
        termination.reason = "overall-timeout";
        controller.abort(new Error("CLI plugin runtime exceeded its execution timeout."));
      },
    },
    params.watchdogClock,
  );
  const requestToolPermission = createPluginToolPermissionHandler({
    context: params.context,
    abortSignal: signal,
    onPendingApproval: updatePendingApproval,
    env: params.env,
  });
  const stopAskUserDeadlineListener = params.onActiveLoopbackAskUserDeadlineChange?.(() =>
    watchdog.reset(),
  );

  const replyBackendHandle = run.replyOperation
    ? {
        kind: "cli" as const,
        runId: run.runId,
        toolAuthorityFingerprint: run.toolAuthorityFingerprint,
        terminalReplyExpectation: resolveReplyExpectation(run),
        cancel: () => {
          termination.reason = "manual-cancel";
          controller.abort(createCliAbortError());
        },
      }
    : undefined;
  if (replyBackendHandle) {
    run.replyOperation?.attachBackend(replyBackendHandle);
  }

  let iterator: AsyncIterator<Record<string, unknown>> | undefined;
  let liveSession: ReturnType<typeof createCliLiveSessionCapability> | undefined;
  let terminalResult: "none" | "success" | "error" = "none";
  try {
    assertCurrent();
    watchdog.reset();
    if (
      params.liveSession &&
      (params.forceNewSession ||
        (Boolean(params.context.preparedBackend.backend.resumeArgs?.length) && !params.useResume))
    ) {
      if (params.liveSession.requiredGeneration) {
        throw new Error("The required CLI live session cannot be replaced by a fresh process.");
      }
      await restartCliLiveSession(params.context, signal);
    }
    assertCurrent();
    if (params.liveSession) {
      liveSession = createCliLiveSessionCapability({
        context: params.context,
        argv: [command, ...executionArgs],
        argv0: params.executionArgv0,
        env: params.env,
        ...params.liveSession,
        captureKey: params.mcpCapture?.captureKey,
        beginCapture: (captureKey) =>
          params.mcpCapture?.beginCapture(captureKey, assertCaptureCurrent),
        abortSignal: signal,
        claimResources: params.context.preparedBackend.claimLiveSessionResources,
      });
    } else {
      params.mcpCapture?.beginCapture(params.mcpCapture.captureKey, assertCaptureCurrent);
    }
    assertCurrent();
    const execution = params.execute({
      command,
      argv0: params.executionArgv0,
      args: executionArgs,
      cwd,
      workspaceDir: params.context.workspaceDir,
      hostRunContractVersion: params.context.hostRunContractVersion,
      runIdentity: params.context.runIdentity,
      preparedPrompt: params.context.preparedPrompt,
      env: params.env,
      prompt: params.prompt,
      ...(params.promptContext ? { promptContext: params.promptContext } : {}),
      modelId: params.context.normalizedModel,
      systemPrompt: stripSystemPromptCacheBoundary(params.context.systemPrompt).trim(),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      useResume: params.useResume,
      abortSignal: signal,
      assertCurrent,
      timeoutMs: run.timeoutMs,
      ...(run.executionMode ? { executionMode: run.executionMode } : {}),
      ...(run.cliToolAvailability ? { toolAvailability: run.cliToolAvailability } : {}),
      ...(liveSession ? { liveSession } : {}),
      requestToolPermission,
      requestUserInput: createPluginUserInputHandler({
        context: params.context,
        abortSignal: signal,
        onPendingInput: updatePendingApproval,
      }),
    });
    iterator = execution[Symbol.asyncIterator]();

    for (;;) {
      const next = await waitForIteratorValue(iterator, signal);
      if (next.done) {
        break;
      }
      if (!isRecord(next.value)) {
        outstanding.replayUnsafe = true;
        throw new Error("CLI plugin runtime emitted an invalid structured stream event.");
      }
      if (next.value.type === "result" && next.value.openclaw_interim_result !== true) {
        terminalResult =
          terminalResult === "error" ||
          next.value.is_error === true ||
          (typeof next.value.subtype === "string" && next.value.subtype.startsWith("error_"))
            ? "error"
            : "success";
      }
      if (
        next.value.type === "system" &&
        next.value.subtype === "background_tasks_changed" &&
        Array.isArray(next.value.tasks)
      ) {
        outstanding.background = next.value.tasks.filter(isRecord).length;
        reportOutstandingWork();
      }
      params.consumeStdout(`${JSON.stringify(next.value)}\n`);
      outstanding.observed = true;
      if (
        !(next.value.type === "system" && next.value.subtype === "init") &&
        next.value.type !== "command_lifecycle"
      ) {
        outstanding.replayUnsafe = true;
      }
      watchdog.noteOutput();
    }

    if (terminalResult === "none") {
      throw new Error("CLI plugin runtime completed without a terminal result.");
    }
  } catch (error) {
    if (run.abortSignal?.aborted || termination.reason === "manual-cancel") {
      const reason = isSignalTimeoutReason(run.abortSignal?.reason) ? "timeout" : "aborted";
      if (!params.onInterrupted?.(reason)) {
        throw createCliAbortError();
      }
      termination.reason = "manual-cancel";
    }
    if (termination.reason === "exit" && terminalResult !== "error") {
      if (
        params.liveSession?.requiredGeneration &&
        noOutputPolicy.isReplaySafeCliResumeControlOnly(
          params.useResume,
          outstanding.replayUnsafe,
          Boolean(outstanding.approvals || outstanding.background || params.activeToolCount?.()),
        )
      ) {
        try {
          liveSession?.current();
        } catch (sessionError) {
          if (sessionError instanceof FailoverError && sessionError.reason === "session_expired") {
            const { code, message, reason } = sessionError;
            throw failover(message, reason, sessionError, { cause: error, code });
          }
        }
      }
      throw error;
    }
  } finally {
    watchdog.dispose();
    stopAskUserDeadlineListener?.();
    params.onOutstandingWorkChange?.(false);
    // Permission callbacks can be retained by the plugin or its subprocess.
    // Closing the turn fences those capabilities before any outer cleanup runs.
    if (!controller.signal.aborted) {
      controller.abort(new Error("CLI plugin runtime turn is no longer active."));
    }
    requestToolPermission.dispose();
    if (replyBackendHandle) {
      run.replyOperation?.detachBackend(replyBackendHandle);
    }
    await closePluginIterator(iterator);
  }

  return {
    reason: termination.reason,
    exitCode: termination.reason === "exit" ? 0 : null,
    exitSignal: null,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: "",
    timedOut:
      termination.reason === "overall-timeout" || termination.reason === "no-output-timeout",
    noOutputTimedOut: termination.reason === "no-output-timeout",
  };
}
