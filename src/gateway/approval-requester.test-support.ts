import type { ChannelApprovalCapability, ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  classifyApprovalRequester,
  type ApprovalRequestAuthorization,
} from "../infra/approval-requester-binding.js";
import { createHostChannelTurnSource, projectHostTurnSource } from "../infra/host-turn-source.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";

export function requesterAuthorization(strict = true): ApprovalRequestAuthorization {
  const source = projectHostTurnSource(
    createHostChannelTurnSource({
      actor: {
        channel: "test",
        accountId: "default",
        senderId: "synthetic-requester",
        actorKind: "human",
      },
      message: {
        messageId: "synthetic-message",
        conversationId: "synthetic-personal-chat",
        conversationKind: "direct",
        eventKind: "message",
      },
    }),
    "synthetic-run",
    "synthetic-session",
  );
  return {
    version: 1,
    source,
    requesterBinding: classifyApprovalRequester(source),
    policy: strict
      ? {
          requireResolverMatch: true,
          delivery: "requester",
          allowedDecisions: ["allow-once", "deny"],
        }
      : { requireResolverMatch: false, delivery: "default" },
  };
}

/** Synthetic account policy uses the same loaded-plugin boundary as channel approval handlers. */
export async function withRequesterApprovalChannel<T>(
  run: () => T,
  options: {
    strict?: () => boolean;
    eligible?: () => boolean;
  } = {},
): Promise<Awaited<T>> {
  const capability: ChannelApprovalCapability = {
    resolveRequestPolicy: () =>
      options.strict?.() === false
        ? { requireResolverMatch: false, delivery: "default" }
        : {
            requireResolverMatch: true,
            delivery: "requester",
            allowedDecisions: ["allow-once", "deny"],
          },
    authorizeActorAction: () => ({ authorized: options.eligible?.() ?? true }),
  };
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "test" }),
    approvalCapability: capability,
  };
  return await withPluginRuntimeRegistryScope(
    createTestRegistry([{ pluginId: "test", source: "test", plugin }]),
    run,
  );
}
