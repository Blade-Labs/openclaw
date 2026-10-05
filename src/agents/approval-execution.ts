import { getRuntimeConfig } from "../config/config.js";
import { requiresApprovalRequesterMatch } from "../gateway/approval-request-policy.js";
import { ApprovalRequesterPolicyError } from "../gateway/approval-requester-policy.js";
import type { ExecApprovalManager } from "../gateway/exec-approval-manager.js";
import type { ApprovalRequestAuthorization } from "../infra/approval-requester-binding.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";

/** The manager owns redemption; isolated workers return to it at final dispatch. */
export function prepareApprovalExecution(params: {
  id: string;
  kind: "exec" | "plugin" | "system-agent";
  authorization?: ApprovalRequestAuthorization;
  requireRequesterMatch?: boolean;
  manager?: Pick<
    ExecApprovalManager<unknown>,
    "getLiveSnapshot" | "prepareAllowOnceExecution" | "projectDecisionIfActive"
  >;
  /** Consumers which already consume option-off one-shot consent retain that contract. */
  consumeAllowOnce?: boolean;
  /** Timeout policy authorizes fallback separately from explicit human consent. */
  isFallback?: () => boolean;
}) {
  const caller = getGatewayToolCallerIdentity();
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const resolveContext = caller?.gatewayContextResolver;
  const context = resolveContext?.();
  const resolveManager = (current: typeof context) =>
    params.kind === "exec"
      ? current?.execApprovalManager
      : params.kind === "plugin"
        ? current?.pluginApprovalManager
        : current?.systemAgentApprovalManager;
  const manager = params.manager ?? resolveManager(context);
  const record = manager?.getLiveSnapshot(params.id);
  let strict = params.requireRequesterMatch === true;
  const requiresMatch = () => {
    strict ||=
      manager?.getLiveSnapshot(params.id)?.requiresRequesterMatch?.() === true ||
      requiresApprovalRequesterMatch(
        params.authorization,
        context?.getRuntimeConfig() ?? getRuntimeConfig(),
        params.kind,
      );
    return strict;
  };
  const execution = manager?.prepareAllowOnceExecution(params.id);
  const remote = !manager && Boolean(caller?.signedAgentRuntimeIdentityToken);
  let remoteConsumed = false;
  const assertOwner = () => {
    const required = requiresMatch();
    if (required && params.isFallback?.()) {
      throw new ApprovalRequesterPolicyError("stale");
    }
    if (!required && !manager && !remote) {
      return false;
    }
    assertCallerCurrent?.();
    if (remote) {
      return required || params.consumeAllowOnce === true;
    }
    const current = resolveContext?.();
    if (!manager || (!params.manager && resolveManager(current) !== manager)) {
      throw new ApprovalRequesterPolicyError("stale");
    }
    if (params.isFallback?.()) {
      return false;
    }
    if (required || params.consumeAllowOnce) {
      execution?.assertCurrent();
      if (!execution) {
        throw new ApprovalRequesterPolicyError("stale");
      }
    } else if (
      !record ||
      manager.getLiveSnapshot(params.id) !== record ||
      (record.decision !== "allow-once" && record.decision !== "allow-always") ||
      manager.projectDecisionIfActive(params.id, record.decision) !== record.decision
    ) {
      throw new ApprovalRequesterPolicyError("stale");
    }
    return required || params.consumeAllowOnce === true;
  };
  const redeemRemote = async (validateConsumed: boolean) => {
    if (!caller) {
      throw new ApprovalRequesterPolicyError("stale");
    }
    const result = await withGatewayToolCallerIdentity(caller, () =>
      callGatewayTool<{ id: string; decision: string; consumed?: boolean }>(
        `${params.kind}.approval.waitDecision`,
        {},
        {
          id: params.id,
          ...(validateConsumed ? { validateConsumed: true } : { consumeAllowOnce: true }),
        },
      ),
    );
    if (result.id !== params.id || result.decision !== "allow-once" || result.consumed !== true) {
      throw new ApprovalRequesterPolicyError("stale");
    }
    assertOwner();
  };
  return {
    requiresMatch,
    latchRequesterMatch: (authorization: ApprovalRequestAuthorization) => {
      strict ||= authorization.policy.requireResolverMatch;
    },
    assertCurrent: () => {
      assertOwner();
    },
    redeem: async () => {
      if (assertOwner()) {
        if (remote) {
          if (remoteConsumed) {
            throw new Error("Approval allow-once has already been consumed");
          }
          await redeemRemote(false);
          remoteConsumed = true;
          return;
        }
        if (!execution) {
          throw new ApprovalRequesterPolicyError("stale");
        }
        await execution.redeem();
        assertOwner();
      }
    },
    revalidate: async () => {
      if (assertOwner() && remote) {
        if (!remoteConsumed) {
          throw new ApprovalRequesterPolicyError("stale");
        }
        await redeemRemote(true);
      }
    },
  };
}

export type ApprovalExecution = ReturnType<typeof prepareApprovalExecution>;

/** Execution custody is private; preserve the observable policy result shape. */
export function retainApprovalExecutions<T extends object>(
  outcome: T,
  executions: ApprovalExecution[],
): T & { approvalExecutions?: ApprovalExecution[] } {
  if (executions.length) {
    Object.defineProperty(outcome, "approvalExecutions", { value: executions, configurable: true });
  }
  return outcome;
}

// Native callbacks enter outside the caller's async scope. Retain the host's
// private preparer without adding execution authority to the public SDK.
const hostPreparers = new WeakMap<
  object,
  (params: Parameters<typeof prepareApprovalExecution>[0]) => Promise<ApprovalExecution>
>();

export function registerApprovalExecutionPreparer(
  owner: object,
  prepare: (params: Parameters<typeof prepareApprovalExecution>[0]) => Promise<ApprovalExecution>,
): void {
  hostPreparers.set(owner, prepare);
}

export async function prepareNativeApprovalExecution(
  owner: object | undefined,
  params: Parameters<typeof prepareApprovalExecution>[0],
): Promise<ApprovalExecution> {
  return (owner && hostPreparers.get(owner))?.(params) ?? prepareApprovalExecution(params);
}

/** Redeem each policy's consent and retain its synchronous final dispatch checks. */
export async function redeemApprovalExecutions(executions: readonly ApprovalExecution[]) {
  for (const execution of executions) {
    await execution.redeem();
    await execution.revalidate();
  }
  return () => {
    for (const execution of executions) {
      execution.assertCurrent();
    }
  };
}
