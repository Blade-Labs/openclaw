import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { mergePathPrepend } from "../../infra/path-prepend.js";
import type {
  CliBackendToolPermissionRequest,
  CliBackendToolPermissionResult,
} from "../../plugins/cli-backend.types.js";
import { captureAdmittedRunSource } from "../admitted-run-context.js";
import {
  recordAdjustedParamsForToolCall,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import {
  consumeSourceForToolCall,
  consumeAdjustedParamsForToolCall,
} from "../agent-tools.before-tool-call.state.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import { resolveExecToolConfig } from "../lazy-exec-tool.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { getCliLiveSessionApprovalGrants } from "./cli-live-session-registry.js";
import {
  requestCliNativeToolApproval,
  resolveCliNativeToolApprovalPlan,
} from "./cli-native-tool-approval.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import { normalizeCliToolName } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

function denyTool(message: string): CliBackendToolPermissionResult {
  return { behavior: "deny", message };
}

export function createPluginToolPermissionHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
  onPendingApproval: (delta: 1 | -1) => void;
  env: NodeJS.ProcessEnv;
}): ((request: CliBackendToolPermissionRequest) => Promise<CliBackendToolPermissionResult>) & {
  dispose: () => void;
} {
  const run = params.context.params;
  const permission = resolveExecDefaults({
    cfg: run.config,
    sessionEntry: run.sessionEntry,
    execOverrides: run.execOverrides,
    agentId: run.agentId,
    sessionKey: run.runtimePolicySessionKey ?? run.sessionKey,
  });
  const grants = new Set<string>();

  const handlePermission = async (
    request: CliBackendToolPermissionRequest,
  ): Promise<CliBackendToolPermissionResult> => {
    const signal = request.abortSignal
      ? AbortSignal.any([params.abortSignal, request.abortSignal])
      : params.abortSignal;
    const assertRunActive = createCliRunCurrentAssertion(run, signal);
    const sourceSnapshot = captureAdmittedRunSource(run.admittedRunContext);
    const strict = () => captureAdmittedRunSource(run.admittedRunContext).requireResolverMatch;
    const assertActive = () => {
      assertRunActive();
      if (strict()) {
        sourceSnapshot.assertCurrent();
      }
    };
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run is no longer active.");
    }

    const toolName = request.toolName.trim();
    if (!toolName) {
      return denyTool("OpenClaw denied an unnamed native tool.");
    }
    if (run.cliToolAvailability && !run.cliToolAvailability.native.includes(toolName)) {
      return denyTool(`OpenClaw denied native tool ${toolName}: it is unavailable to this run.`);
    }

    // Provider schemas are not policy schemas: match canonical names and file operands.
    const canonicalToolName = normalizeCliToolName(toolName);
    const nativeFileTool =
      ["read", "write", "edit"].includes(canonicalToolName) &&
      Object.hasOwn(request.toolInput, "file_path");
    let policyInput = request.toolInput;
    if (nativeFileTool) {
      const nativePath = request.toolInput.file_path;
      if (typeof nativePath !== "string") {
        return denyTool("OpenClaw denied native file tool use: invalid file path.");
      }
      if (Object.hasOwn(request.toolInput, "path") && request.toolInput.path !== nativePath) {
        return denyTool("OpenClaw denied native file tool use: conflicting file paths.");
      }
      policyInput = { ...request.toolInput, path: nativePath };
      if (canonicalToolName === "edit") {
        const { old_string: oldText, new_string: newText, edits } = request.toolInput;
        if (typeof oldText !== "string" || typeof newText !== "string") {
          return denyTool("OpenClaw denied native edit tool use: invalid replacement.");
        }
        if (
          edits !== undefined &&
          (!Array.isArray(edits) ||
            edits.length !== 1 ||
            !isRecord(edits[0]) ||
            edits[0].oldText !== oldText ||
            edits[0].newText !== newText)
        ) {
          return denyTool("OpenClaw denied native edit tool use: conflicting replacements.");
        }
        policyInput.edits = [{ oldText, newText }];
      }
    }

    const requester = {
      ...((run.messageChannel ?? run.messageProvider)
        ? { channel: run.messageChannel ?? run.messageProvider }
        : {}),
      ...(run.agentAccountId ? { accountId: run.agentAccountId } : {}),
      ...(run.senderId ? { senderId: run.senderId } : {}),
      ...(run.senderIsOwner !== undefined ? { senderIsOwner: run.senderIsOwner } : {}),
    };
    const hookResult = await runBeforeToolCallHook({
      toolName: canonicalToolName,
      params: policyInput,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      signal,
      ctx: {
        source: sourceSnapshot.source,
        ...(run.agentId ? { agentId: run.agentId } : {}),
        ...(run.config ? { config: run.config } : {}),
        cwd: params.context.cwd ?? params.context.workspaceDir,
        workspaceDir: params.context.workspaceDir,
        ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
        sessionId: run.sessionId,
        runId: run.runId,
        ...(run.trigger ? { trigger: run.trigger } : {}),
        ...(run.approvalReviewerDeviceId
          ? { approvalReviewerDeviceId: run.approvalReviewerDeviceId }
          : {}),
        ...(run.currentChannelId ? { channelId: run.currentChannelId } : {}),
        ...(Object.keys(requester).length > 0 ? { requester } : {}),
        turnSourceChannel: run.messageChannel ?? run.messageProvider,
        turnSourceTo: run.chatId ?? run.currentChannelId,
        turnSourceAccountId: run.agentAccountId,
        turnSourceThreadId: run.currentThreadTs,
        loopDetection: resolveToolLoopDetectionConfig({
          cfg: run.config,
          agentId: run.agentId,
        }),
      },
    });
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run closed during policy.");
    }
    if (hookResult.blocked) {
      return denyTool(hookResult.reason);
    }
    if (!isRecord(hookResult.params)) {
      return denyTool("OpenClaw denied native tool use: before_tool_call returned invalid input.");
    }
    let toolInput = hookResult.params;
    const redeemPolicyApprovals = async () => {
      for (const execution of hookResult.approvalExecutions ?? []) {
        await execution.redeem();
        await execution.revalidate();
      }
      assertActive();
      for (const execution of hookResult.approvalExecutions ?? []) {
        execution.assertCurrent();
      }
    };
    // SDK permission replies must return the native schema, never policy-only aliases.
    if (nativeFileTool) {
      if (typeof toolInput.path !== "string") {
        return denyTool("OpenClaw denied native file tool use: invalid rewritten file path.");
      }
      if (toolInput === policyInput) {
        toolInput = request.toolInput;
      } else {
        toolInput = { ...toolInput, file_path: toolInput.path };
        if (!Object.hasOwn(request.toolInput, "path")) {
          delete toolInput.path;
        }
        if (canonicalToolName === "edit") {
          const edits = toolInput.edits;
          if (
            !Array.isArray(edits) ||
            edits.length !== 1 ||
            !isRecord(edits[0]) ||
            typeof edits[0].oldText !== "string" ||
            typeof edits[0].newText !== "string"
          ) {
            return denyTool("OpenClaw denied an unrepresentable native edit rewrite.");
          }
          toolInput.old_string = edits[0].oldText;
          toolInput.new_string = edits[0].newText;
          if (!Object.hasOwn(request.toolInput, "edits")) {
            delete toolInput.edits;
          }
        }
      }
    }

    const plan = resolveCliNativeToolApprovalPlan(permission);
    if (plan === "deny") {
      return denyTool(
        `OpenClaw exec policy denied native tool use (security=${permission.security}, ask=${permission.ask}).`,
      );
    }
    const currentGrants = getCliLiveSessionApprovalGrants(params.context) ?? grants;
    if (
      plan === "allow" ||
      (!strict() && permission.ask !== "always" && currentGrants.has(toolName))
    ) {
      try {
        await redeemPolicyApprovals();
      } catch {
        return denyTool("OpenClaw approval authority closed before native tool dispatch.");
      }
      assertActive();
      recordAdjustedParamsForToolCall(request.toolCallId, toolInput, run.runId);
      return { behavior: "allow", updatedInput: toolInput };
    }

    params.onPendingApproval(1);
    const requesterMatchAtRequest = strict();
    let outcome: Awaited<ReturnType<typeof requestCliNativeToolApproval>>;
    try {
      outcome = await requestCliNativeToolApproval({
        toolName,
        toolInput,
        pluginId: params.context.backendResolved.id,
        sessionKey: run.sessionKey,
        agentId: run.agentId,
        toolCallId: request.toolCallId,
        cwd: request.cwd,
        fallbackCwd: params.context.cwd ?? params.context.workspaceDir,
        bindingEnv: params.env,
        env: {
          ...params.env,
          PATH: mergePathPrepend(
            params.env.PATH,
            resolveExecToolConfig({ cfg: run.config, agentId: run.agentId }).pathPrepend ?? [],
          ),
        },
        assertActive,
        abortSignal: signal,
        ask: permission.ask,
        requireRequesterMatch: requesterMatchAtRequest,
      });
    } finally {
      params.onPendingApproval(-1);
    }
    // Approval itself may outlive, replace, or close the exact admitted turn.
    // The host rechecks authority immediately before returning any capability.
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run closed during approval.");
    }
    if (outcome.kind !== "allow") {
      return denyTool(
        outcome.message ??
          (outcome.reason === "user"
            ? `OpenClaw user denied native tool use (${toolName}).`
            : `OpenClaw approval was not granted for native tool use (${toolName}).`),
      );
    }
    if (strict() && !requesterMatchAtRequest) {
      return denyTool("OpenClaw requester policy changed during approval. Request approval again.");
    }
    if (outcome.grantAlways && strict()) {
      return denyTool("OpenClaw requester approval requires one-shot consent.");
    }
    try {
      if (outcome.redeem) {
        await outcome.redeem();
      }
      await redeemPolicyApprovals();
      assertActive();
      outcome.assertCurrent?.();
      if (strict() && (!requesterMatchAtRequest || outcome.grantAlways)) {
        return denyTool("OpenClaw requester policy changed before native tool dispatch.");
      }
    } catch {
      return denyTool("OpenClaw approval authority closed before native tool dispatch.");
    }
    if (outcome.grantAlways) {
      currentGrants.add(toolName);
    }
    const updatedInput = outcome.updatedInput ?? toolInput;
    recordAdjustedParamsForToolCall(request.toolCallId, updatedInput, run.runId);
    return { behavior: "allow" as const, updatedInput };
  };
  const cleanups = new Set<() => void>();
  return Object.assign(
    async (request: CliBackendToolPermissionRequest) => {
      const signal = request.abortSignal
        ? AbortSignal.any([params.abortSignal, request.abortSignal])
        : params.abortSignal;
      const release = () => {
        if (request.toolCallId) {
          consumeSourceForToolCall(request.toolCallId, run.runId);
          consumeAdjustedParamsForToolCall(request.toolCallId, run.runId);
        }
        signal.removeEventListener("abort", release);
        cleanups.delete(release);
      };
      cleanups.add(release);
      signal.addEventListener("abort", release, { once: true });
      let allowed = false;
      try {
        const result = await handlePermission(request);
        allowed = result.behavior === "allow";
        return result;
      } finally {
        // Denied/cancelled tools need not emit a terminal result. Successful
        // callbacks retain provenance until completion or this exact CLI owner closes.
        if (!allowed || signal.aborted) {
          release();
        }
      }
    },
    {
      dispose: () => {
        for (const release of cleanups) {
          release();
        }
      },
    },
  );
}
