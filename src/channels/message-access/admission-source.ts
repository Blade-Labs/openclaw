import {
  combineHostTurnSources,
  createHostChannelTurnSource,
  latchHostTurnSourcePolicy,
  type HostTurnSource,
} from "../../infra/host-turn-source.js";
import type {
  ChannelSourceActor,
  ChannelSourceMessage,
} from "../../infra/turn-source-provenance.js";
import { requiresTurnSourceRequesterMatch } from "../plugins/approvals.js";
import type { ChannelIngressHostOwner } from "./ingress-host-owner.js";

/** Source assembly follows the exact handoff validation owned by admission evidence. */
export function prepareChannelAdmissionTurnSource(params: {
  owner?: ChannelIngressHostOwner;
  channelId: string;
  accountId?: string;
  bindings?: readonly { sourceActor: ChannelSourceActor; sourceMessage?: ChannelSourceMessage }[];
}): HostTurnSource | undefined {
  if (!params.owner?.isLive() || params.owner.channelId !== params.channelId) {
    return undefined;
  }
  const source = params.bindings
    ? combineHostTurnSources(
        params.bindings.map((binding) =>
          createHostChannelTurnSource({
            actor: binding.sourceActor,
            message: binding.sourceMessage,
          }),
        ),
      )
    : createHostChannelTurnSource({
        actor: {
          channel: params.channelId,
          accountId: params.accountId ?? "default",
          senderId: "",
          actorKind: "unknown",
        },
      });
  const cfg = params.owner.resolveGatewayContext?.()?.getRuntimeConfig?.() ?? {};
  return latchHostTurnSourcePolicy(source, requiresTurnSourceRequesterMatch(cfg, source));
}
