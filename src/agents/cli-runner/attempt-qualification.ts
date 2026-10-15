import { resolveBlockMessage } from "../../plugins/hook-decision-types.js";
import type { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "../harness/hook-context.js";
import { buildAgentHookConversationMessages } from "../harness/hook-history.js";
import { runAgentHarnessLlmInputHook } from "../harness/lifecycle-hook-helpers.js";
import { persistApprovedCliUserTurnTranscript } from "./cli-run-transcript.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import { isClaudeCliBackendId } from "./helpers.js";
import { prepareCliAttemptPrompt } from "./prompt-context.js";
import type { PreparedCliRunContext } from "./types.js";

/** One turn's qualification state survives recovery without repeating persistence. */
export function createCliAttemptQualifier({
  context,
  hookContext,
  hookRunner,
  hasBeforeAgentRunHooks,
  historyMessages,
  imageCleanups,
  onPromptForHooks,
  onUserTurnHandled,
}: {
  context: PreparedCliRunContext;
  hookContext: AgentHarnessHookContext &
    Pick<PreparedCliRunContext["params"], "runId" | "sessionId">;
  hookRunner?: ReturnType<typeof getGlobalHookRunner>;
  hasBeforeAgentRunHooks: boolean;
  historyMessages: unknown[];
  imageCleanups: Set<() => Promise<void>>;
  onPromptForHooks: (prompt: string) => void;
  onUserTurnHandled: (handled: boolean) => void;
}) {
  const { params } = context;
  let qualifiedPrompt: PreparedCliRunContext["preparedPrompt"];
  let qualifiedEnvelope: string | undefined;
  let userPersistenceAttempted = false;
  const qualifyAttempt = async (
    attempt: PreparedCliRunContext,
    nativeId?: string,
  ): Promise<void> => {
    const assertCurrent = createCliRunCurrentAssertion(
      attempt.params,
      attempt.params.abortSignal,
      attempt.runIdentity,
    );
    assertCurrent();
    const transport = await prepareCliAttemptPrompt(attempt, nativeId);
    if (transport.imagePayload.cleanupImages) {
      imageCleanups.add(transport.imagePayload.cleanupImages);
    }
    attempt.preparedImagePayload = transport.imagePayload;
    assertCurrent();
    const projection = transport.preparedPrompt;
    const envelope = JSON.stringify([
      attempt.params.provider,
      attempt.modelId,
      attempt.normalizedModel,
      attempt.systemPrompt,
    ]);
    if (
      qualifiedPrompt &&
      envelope === qualifiedEnvelope &&
      JSON.stringify(projection) === JSON.stringify(qualifiedPrompt)
    ) {
      attempt.preparedPrompt = qualifiedPrompt;
      return;
    }
    onPromptForHooks(projection.logicalPrompt);
    if (hasBeforeAgentRunHooks && hookRunner) {
      let beforeRunResult:
        | Awaited<ReturnType<NonNullable<typeof hookRunner>["runBeforeAgentRun"]>>
        | undefined;
      try {
        beforeRunResult = await hookRunner.runBeforeAgentRun(
          {
            prompt: projection.logicalPrompt,
            systemPrompt: context.systemPrompt,
            messages: buildAgentHookConversationMessages({
              historyMessages,
              currentTurnMessages: [],
            }),
            channelId: hookContext.channelId,
            accountId: params.agentAccountId,
            senderId: params.senderId ?? undefined,
            senderIsOwner: params.senderIsOwner ?? undefined,
          },
          buildAgentHookContext(hookContext),
        );
      } catch {
        const blockMessage = resolveBlockMessage(
          { outcome: "block", reason: "before_agent_run hook failed" },
          { blockedBy: "before_agent_run" },
        );
        throw Object.assign(new Error(blockMessage), { cliBlockedBy: "before_agent_run" });
      }

      const beforeRunDecision = beforeRunResult?.decision;
      if (beforeRunDecision?.outcome === "block") {
        const blockMessage = resolveBlockMessage(beforeRunDecision, {
          blockedBy: beforeRunResult?.pluginId ?? "unknown",
        });
        throw Object.assign(new Error(blockMessage), {
          cliBlockedBy: beforeRunResult?.pluginId ?? "unknown",
        });
      }
    }

    assertCurrent();
    if (!userPersistenceAttempted) {
      userPersistenceAttempted = true;
      onUserTurnHandled(await persistApprovedCliUserTurnTranscript(params));
      // Persistence can establish the transcript image correlation key. Keep
      // the approved row, then qualify those final transport bytes before input.
      if (
        isClaudeCliBackendId(attempt.backendResolved.id) &&
        transport.imagePayload.imagePaths?.length &&
        transport.imageTurnEntryId !==
          params.userTurnTranscriptRecorder?.getAdmissionReceipt()?.entryId
      ) {
        assertCurrent();
        return qualifyAttempt(attempt, nativeId);
      }
    }
    assertCurrent();
    runAgentHarnessLlmInputHook({
      event: {
        runId: hookContext.runId,
        sessionId: hookContext.sessionId,
        provider: params.provider,
        model: context.modelId,
        systemPrompt: context.systemPrompt,
        prompt: projection.logicalPrompt,
        historyMessages,
        imagesCount: params.images?.length ?? 0,
      },
      ctx: hookContext,
      hookRunner,
    });
    assertCurrent();
    attempt.preparedPrompt = projection;
    qualifiedPrompt = projection;
    qualifiedEnvelope = envelope;
  };
  return qualifyAttempt;
}
