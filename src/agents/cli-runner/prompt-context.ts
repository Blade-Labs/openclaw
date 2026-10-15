import {
  buildActiveNodeContextText,
  prepareActiveNodeContext,
} from "../../infra/active-node-context.js";
import type {
  CliBackendConfig,
  CliBackendPromptContext,
  CliBackendPreparedPrompt,
} from "../../plugins/cli-backend.types.js";
import { buildRuntimeContextCustomMessage } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { buildMediaTaskRuntimeContext } from "../media-generation-task-status.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import type { PreparedCliRunContext } from "./types.js";

/** Current-turn facts stay outside native prompts that are retained across CLI turns. */
export async function buildCliTurnAppendContext(
  params: Parameters<typeof buildMediaTaskRuntimeContext>[0] & {
    backend: CliBackendConfig;
    isNewSession: boolean;
    systemPrompt: string;
    context: readonly (string | undefined)[];
  },
): Promise<string> {
  const { resolveSystemPromptUsage } = await import("./helpers.js");
  const mediaTaskContext = await buildMediaTaskRuntimeContext({
    capabilityToolNames: params.capabilityToolNames,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  await prepareActiveNodeContext();
  return [
    ...params.context,
    buildRuntimeContextCustomMessage(mediaTaskContext)?.content,
    // Native-prompt owners and first-only resumes do not receive the current runtime line.
    resolveSystemPromptUsage(params) ? undefined : buildActiveNodeContextText(),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

/** Logical input for raw transports, policy hooks, and bounded diagnostics. */
export function composeCliPromptContext(prompt: string, context?: CliBackendPromptContext): string {
  const prepended = context?.prependContext ? `${context.prependContext}\n\n${prompt}` : prompt;
  return context?.appendContext ? `${prepended}\n\n${context.appendContext}` : prepended;
}

/** Select and transform the actual attempt before readiness and input observation. */
export function finalizeCliPreparedPrompt(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): CliBackendPreparedPrompt {
  if (!cliSessionIdToUse && context.openClawHistoryPrompt) {
    context.cliHistoryWriter?.assertReadable();
  }
  const replace = (text: string) =>
    context.params.controlOperation !== undefined
      ? text
      : applyPluginTextReplacements(text, context.backendResolved.textTransforms?.input);
  const prompt = replace(
    cliSessionIdToUse
      ? context.params.prompt
      : (context.openClawHistoryPrompt ?? context.params.prompt),
  );
  const promptContext = context.promptContext
    ? Object.freeze({
        ...(context.promptContext.prependContext
          ? { prependContext: replace(context.promptContext.prependContext) }
          : {}),
        ...(context.promptContext.appendContext
          ? { appendContext: replace(context.promptContext.appendContext) }
          : {}),
      })
    : undefined;
  return Object.freeze({
    version: 1,
    prompt,
    ...(promptContext ? { promptContext } : {}),
    logicalPrompt: composeCliPromptContext(prompt, promptContext),
  });
}

export async function prepareCliSystemPrompt(
  params: Omit<
    Parameters<typeof import("./helpers.js").buildCliAgentSystemPrompt>[0],
    "preparedModelRuntime"
  >,
): Promise<string> {
  const { buildCliAgentSystemPrompt } = await import("./helpers.js");
  let preparedModelRuntime:
    | import("../prepared-model-runtime.types.js").PreparedModelRuntimeSnapshot
    | undefined;
  if (params.config) {
    const { getPreparedModelRuntimeBorrowedSnapshot, getPreparedModelRuntimePluginGeneration } =
      await import("../prepared-model-runtime-generation-scope.js");
    const generation = getPreparedModelRuntimePluginGeneration();
    const borrowed = generation ? getPreparedModelRuntimeBorrowedSnapshot(generation) : undefined;
    if (
      borrowed?.config === params.config &&
      borrowed.agentId === params.agentId &&
      borrowed.workspaceDir === params.workspaceDir
    ) {
      preparedModelRuntime = borrowed;
    } else {
      const { getPreparedModelCatalogOwnerSnapshot } = await import("../prepared-model-catalog.js");
      preparedModelRuntime = getPreparedModelCatalogOwnerSnapshot({
        config: params.config,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
      });
    }
  }
  await prepareActiveNodeContext();
  return buildCliAgentSystemPrompt({ ...params, preparedModelRuntime });
}
