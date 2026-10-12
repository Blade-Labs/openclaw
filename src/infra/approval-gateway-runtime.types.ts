import type { AdmittedChannelActor } from "../channels/message-access/approval-actor.js";
import type { GatewayNativeApprovalMethod } from "./approval-gateway-runtime-methods.js";
import type { ApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import type { ApprovalRequest, ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";
import type { SystemAgentApprovalResolved } from "./system-agent-approvals.js";

export type GatewayApprovalRequest = ApprovalRequest;
export type GatewayApprovalResolved =
  | ExecApprovalResolved
  | PluginApprovalResolved
  | SystemAgentApprovalResolved;

export type GatewayApprovalEventSubscriber = {
  channel?: string;
  accountId?: string | null;
  deliverRequester?: (request: GatewayApprovalRequest) => Promise<boolean>;
  eventKinds: ReadonlySet<ChannelApprovalKind>;
  shouldHandle: (request: GatewayApprovalRequest) => boolean;
  onRequested: (request: GatewayApprovalRequest) => void;
  onResolved: (resolved: GatewayApprovalResolved) => void;
};

/** Gateway-owned authority and event transport for channel-native approval runtimes. */
export type GatewayNativeApprovalRuntime = {
  request: <T = unknown>(
    method: GatewayNativeApprovalMethod,
    params: Record<string, unknown>,
    options?: { clientDisplayName?: string; approvalActor?: AdmittedChannelActor },
  ) => Promise<T>;
  requestRoute: <T = unknown>(method: "send", params: Record<string, unknown>) => Promise<T>;
  routeCoordinator: ApprovalNativeRouteCoordinator;
  subscribe: (subscriber: GatewayApprovalEventSubscriber) => () => void;
};

/** Account-owned versioned resolution; legacy requests cannot establish human authority. */
export type ChannelApprovalResolutionRuntimeV2 = {
  version: 2;
  admitInteractionActor: (event: {
    senderId: string;
    actorKind: "human" | "bot" | "app" | "unknown";
    interactionId: string;
  }) => AdmittedChannelActor;
  resolve: (
    request: {
      id: string;
      kind: ChannelApprovalKind;
      decision: "allow-once" | "allow-15m" | "allow-session" | "allow-always" | "deny";
    },
    actor: AdmittedChannelActor,
  ) => Promise<import("../../packages/gateway-protocol/src/index.js").ApprovalResolveResult>;
};
