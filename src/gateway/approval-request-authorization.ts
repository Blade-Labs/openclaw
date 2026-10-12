import {
  lookupAdmittedRunSource,
  captureAdmittedRunSource,
} from "../agents/admitted-run-context.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type { ApprovalRequestAuthorization } from "../infra/approval-requester-binding.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import {
  isScopedPluginGrantApproval,
  SCOPED_PLUGIN_APPROVAL_DECISIONS,
} from "../infra/plugin-approvals.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { requiresApprovalRequesterMatch } from "./approval-request-policy.js";
import { ApprovalRequesterPolicyError } from "./approval-requester-policy.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.types.js";

/** Identity is supplied by trusted dispatch, never public request parameters. */
export function prepareApprovalRequestAuthorization(params: {
  cfg: OpenClawConfig;
  approvalKind: ChannelApprovalKind;
  identity?:
    | AgentRuntimeIdentity
    | {
        delegatedAuthority?: AgentRunDelegatedAuthority;
        operationalRunInstance?: AgentRuntimeIdentity["operationalRunInstance"];
        turnSourceChannel?: string;
        turnSourceAccountId?: string;
      };
}): {
  authorization: ApprovalRequestAuthorization;
  assertCurrent: () => void;
  requiresRequesterMatch: () => boolean;
} {
  const identity = params.identity;
  const active =
    identity?.delegatedAuthority &&
    identity.operationalRunInstance &&
    validateAgentRunDelegatedAuthority(identity.delegatedAuthority)
      ? getActiveAgentRunDelegatedAuthority(identity.operationalRunInstance)
      : undefined;
  const snapshot = active
    ? lookupAdmittedRunSource(active, active.operationalRunInstance)
    : undefined;
  const facts = snapshot ?? captureAdmittedRunSource(undefined);
  const channel = identity?.turnSourceChannel;
  const accountId = identity?.turnSourceAccountId;
  const strict =
    facts.requireResolverMatch ||
    Boolean(
      channel &&
      accountId &&
      resolveChannelApprovalCapability(getLoadedChannelPlugin(channel))?.resolveRequestPolicy?.({
        cfg: params.cfg,
        accountId,
        approvalKind: params.approvalKind,
      })?.requireResolverMatch,
    );
  const authorization: ApprovalRequestAuthorization = Object.freeze({
    version: 1,
    source: facts.source,
    requesterBinding: facts.requesterBinding,
    policy: strict
      ? Object.freeze({
          requireResolverMatch: true,
          delivery: "requester",
          allowedDecisions: Object.freeze(["allow-once", "deny"] as const),
        })
      : Object.freeze({ requireResolverMatch: false, delivery: "default" }),
  });
  let requesterMatchRequired = strict;
  const requiresRequesterMatch = () =>
    (requesterMatchRequired ||=
      (active &&
        lookupAdmittedRunSource(active, active.operationalRunInstance)?.requireResolverMatch ===
          true) ||
      Boolean(
        channel &&
        accountId &&
        resolveChannelApprovalCapability(getLoadedChannelPlugin(channel))?.resolveRequestPolicy?.({
          cfg: getRuntimeConfig(),
          accountId,
          approvalKind: params.approvalKind,
        })?.requireResolverMatch,
      ) ||
      requiresApprovalRequesterMatch(authorization, getRuntimeConfig(), params.approvalKind));
  return {
    authorization,
    requiresRequesterMatch,
    assertCurrent: () => {
      if (snapshot && requiresRequesterMatch()) {
        try {
          snapshot.assertCurrent();
        } catch {
          throw new ApprovalRequesterPolicyError("stale");
        }
      }
    },
  };
}

export function bindApprovalRequestAuthorization<T>(
  params: {
    record: ExecApprovalRecord<T>;
    prepared?: ReturnType<typeof prepareApprovalRequestAuthorization>;
  } & Parameters<typeof prepareApprovalRequestAuthorization>[0],
): void {
  const original = params.prepared ?? prepareApprovalRequestAuthorization(params);
  const prepared =
    params.approvalKind === "plugin" &&
    isScopedPluginGrantApproval(params.record.request) &&
    original.authorization.policy.requireResolverMatch
      ? {
          ...original,
          authorization: Object.freeze({
            ...original.authorization,
            policy: Object.freeze({
              ...original.authorization.policy,
              allowedDecisions: SCOPED_PLUGIN_APPROVAL_DECISIONS,
            }),
          }),
        }
      : original;
  Object.defineProperty(params.record, "authorization", {
    value: prepared.authorization,
    enumerable: true,
  });
  if (params.record.request && typeof params.record.request === "object") {
    Object.defineProperty(params.record.request, "authorization", {
      value: prepared.authorization,
      enumerable: true,
    });
  }
  params.record.assertRequesterCurrent = prepared.assertCurrent;
  params.record.requiresRequesterMatch = prepared.requiresRequesterMatch;
}
