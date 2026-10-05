/**
 * Channel approval capability adapters.
 *
 * Projects plugin approval metadata into runtime approval delivery adapters.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readHostTurnSource, type HostTurnSource } from "../../infra/host-turn-source.js";
import { getLoadedChannelPlugin } from "./registry.js";
import type { ChannelApprovalAdapter, ChannelApprovalCapability } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";

/** A retained restriction can strengthen with current account policy, never disappear. */
export function requiresTurnSourceRequesterMatch(
  cfg: OpenClawConfig,
  source?: HostTurnSource,
): boolean {
  const facts = readHostTurnSource(source);
  return (
    facts.requireResolverMatch ||
    facts.accounts.some(({ channel, accountId }) => {
      const capability = resolveChannelApprovalCapability(getLoadedChannelPlugin(channel));
      return (["exec", "plugin", "system-agent"] as const).some(
        (approvalKind) =>
          capability?.resolveRequestPolicy?.({ cfg, accountId, approvalKind })
            ?.requireResolverMatch === true,
      );
    })
  );
}

/**
 * Returns the approval capability exposed by a channel plugin.
 */
export function resolveChannelApprovalCapability(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalCapability | undefined {
  return plugin?.approvalCapability;
}

/**
 * Projects a channel approval capability into the runtime approval adapter shape.
 */
export function resolveChannelApprovalAdapter(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): ChannelApprovalAdapter | undefined {
  const capability = resolveChannelApprovalCapability(plugin);
  if (!capability) {
    return undefined;
  }
  if (
    !capability.delivery &&
    !capability.nativeRuntime &&
    !capability.render &&
    !capability.native
  ) {
    // Auth-only capabilities are valid plugin metadata but do not form a delivery adapter.
    return undefined;
  }
  return {
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    describePluginApprovalSetup: capability.describePluginApprovalSetup,
    delivery: capability.delivery,
    nativeRuntime: capability.nativeRuntime,
    render: capability.render,
    native: capability.native,
  };
}
