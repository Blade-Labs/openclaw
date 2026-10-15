import {
  buildActiveNodeContextText,
  prepareActiveNodeContext,
} from "../../infra/active-node-context.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import type {
  CliBackendConfig,
  CliBackendPromptContext,
  CliBackendPreparedPrompt,
} from "../../plugins/cli-backend.types.js";
import { hashCliImageTurnEntryId } from "../cli-image-turn-correlation.js";
import {
  detectImageReferences,
  hasHydratableMediaImages,
} from "../embedded-agent-runner/run/images.js";
import type { MediaImageLayout } from "../embedded-agent-runner/run/prompt-image-metadata.js";
import { buildRuntimeContextCustomMessage } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { buildMediaTaskRuntimeContext } from "../media-generation-task-status.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { isClaudeCliBackendId, prepareCliPromptImagePayload } from "./helpers.js";
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

/** Materialize the actual image transport before the final readiness gate. */
export async function prepareCliAttemptPrompt(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
) {
  const projection = finalizeCliPreparedPrompt(context, cliSessionIdToUse);
  const params = context.params as PreparedCliRunContext["params"] & {
    mediaImageLayout?: MediaImageLayout;
  };
  const nodePlacement = context.executionTarget.kind === "node";
  if (
    nodePlacement &&
    ((params.images?.length ?? 0) > 0 ||
      (params.mediaImageLayout
        ? params.mediaImageLayout.slots.length > 0
        : hasHydratableMediaImages(params.media)) ||
      (params.imagePrompt ? detectImageReferences(params.imagePrompt).length > 0 : false))
  ) {
    throw new Error("paired-node Claude CLI sessions do not support attachments or images");
  }
  const imageTurnEntryId = isClaudeCliBackendId(context.backendResolved.id)
    ? params.userTurnTranscriptRecorder?.getAdmissionReceipt()?.entryId
    : undefined;
  const imagePayload = nodePlacement
    ? { prompt: projection.prompt, imagePaths: [] as string[] }
    : await prepareCliPromptImagePayload({
        backend: context.preparedBackend.backend,
        prompt: projection.prompt,
        imagePrompt: params.imagePrompt,
        workspaceDir: context.workspaceDir,
        localRoots: getAgentScopedMediaLocalRoots(params.config ?? {}, params.agentId),
        images: params.images,
        imageOrder: params.imageOrder,
        mediaImageLayout: params.mediaImageLayout,
        media: params.media,
        ...(imageTurnEntryId ? { imageTurnKey: hashCliImageTurnEntryId(imageTurnEntryId) } : {}),
      });
  return {
    imageTurnEntryId,
    imagePayload,
    preparedPrompt: Object.freeze({
      ...projection,
      prompt: imagePayload.prompt,
      logicalPrompt: composeCliPromptContext(imagePayload.prompt, projection.promptContext),
    }),
  };
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
