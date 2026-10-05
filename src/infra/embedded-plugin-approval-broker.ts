// Provides the process-local plugin approval path used by embedded TUI runs.
import { randomUUID } from "node:crypto";
import {
  prepareApprovalExecution,
  retainApprovalExecutions,
  type ApprovalExecution,
} from "../agents/approval-execution.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getRuntimeConfig } from "../config/config.js";
import { bindApprovalRequestAuthorization } from "../gateway/approval-request-authorization.js";
import { ApprovalRequesterPolicyError } from "../gateway/approval-requester-policy.js";
import { prepareExecApprovalOnceExecution } from "../gateway/exec-approval-consumption.js";
import type { ExecApprovalRecord } from "../gateway/exec-approval-manager.types.js";
import { prepareExecApprovalRequesterGuard } from "../gateway/exec-approval-requester-guard.js";
import { notifyListeners } from "../shared/listeners.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "./plugin-approvals.js";

type PendingApproval = {
  record: PluginApprovalRequest & ExecApprovalRecord<PluginApprovalRequestPayload>;
  assertCurrent: (decision: ExecApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: ExecApprovalDecision | null) => void;
  reject: (error: unknown) => void;
};

type ApprovalEvent =
  | { event: "plugin.approval.requested"; payload: PluginApprovalRequest }
  | { event: "plugin.approval.resolved"; payload: PluginApprovalResolved }
  | { event: "plugin.approval.removed"; payload: { id: string } };

let activeBroker: EmbeddedPluginApprovalBroker | null = null;

export class EmbeddedPluginApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private generation = 0;
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();

  subscribe(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listPending(): PluginApprovalRequest[] {
    return [...this.pending.values()]
      .filter((entry) => entry.record.requiresRequesterMatch?.() !== true)
      .map((entry) => entry.record);
  }

  async request(params: {
    request: Omit<PluginApprovalRequestPayload, "authorization">;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    id: string;
    decision: ExecApprovalDecision | null;
    approvalExecutions?: ApprovalExecution[];
  }> {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new Error("approval request aborted");
    }
    const id = `plugin:${randomUUID()}`;
    const createdAtMs = Date.now();
    const record: PendingApproval["record"] = {
      approvalKind: "plugin",
      id,
      request: { ...params.request },
      createdAtMs,
      expiresAtMs: createdAtMs + params.timeoutMs,
    };
    const generation = this.generation;
    const caller = getGatewayToolCallerIdentity();
    const assertCallerCurrent = captureGatewayToolCallerAssertion();
    bindApprovalRequestAuthorization({
      record,
      cfg: getRuntimeConfig(),
      approvalKind: "plugin",
      identity: caller && {
        delegatedAuthority: caller.approvalAuthority,
        operationalRunInstance: caller.operationalRunInstance,
        turnSourceChannel: caller.turnSourceChannel,
        turnSourceAccountId: caller.turnSourceAccountId,
      },
    });
    const actor = { kind: "runtime", clientId: "tui:embedded" } as const;
    const assertCurrent = (decision: ExecApprovalDecision) => {
      prepareExecApprovalRequesterGuard(
        record,
        "plugin",
        record.resolvedByActor ?? actor,
        decision,
      ).assertCurrent();
      if (generation !== this.generation || params.signal?.aborted) {
        throw new ApprovalRequesterPolicyError("stale");
      }
      assertCallerCurrent?.();
    };
    // Local input authenticates a runtime actor, never a channel requester.
    assertCurrent("allow-once");
    let resolve!: (decision: ExecApprovalDecision | null) => void;
    let reject!: (error: unknown) => void;
    const decision = new Promise<ExecApprovalDecision | null>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      this.pending.delete(id);
      if (entry.record.requiresRequesterMatch?.()) {
        entry.reject(new ApprovalRequesterPolicyError("ineligible"));
      } else {
        entry.resolve(null);
      }
      this.emit({ event: "plugin.approval.removed", payload: { id } });
    }, params.timeoutMs);
    timer.unref?.();
    this.pending.set(id, { record, timer, resolve, reject, assertCurrent });

    const abort = () => {
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(params.signal?.reason ?? new Error("approval request aborted"));
      this.emit({ event: "plugin.approval.removed", payload: { id } });
    };
    params.signal?.addEventListener("abort", abort, { once: true });

    this.emit({ event: "plugin.approval.requested", payload: record });
    try {
      const verdict = await decision;
      const outcome = { id, decision: verdict };
      if (verdict !== "allow-once" && verdict !== "allow-always") {
        return outcome;
      }
      const manager = {
        getLiveSnapshot: (recordId: string) =>
          recordId === id && generation === this.generation ? record : null,
        projectDecisionIfActive: (_recordId: string, value: ExecApprovalDecision | null) => {
          assertCurrent(value ?? "deny");
          return value;
        },
        consumeAllowOnce: async (_recordId: string, consumerId: string) => {
          assertCurrent("allow-once");
          if (record.consumedDecision) {
            return false;
          }
          record.consumedDecision = "allow-once";
          record.consumedBy = consumerId;
          record.consumedAtMs = Date.now();
          return true;
        },
        prepareAllowOnceExecution: (recordId: string, consumerId = randomUUID()) =>
          prepareExecApprovalOnceExecution(manager, recordId, consumerId),
      };
      return retainApprovalExecutions(outcome, [
        prepareApprovalExecution({
          id,
          kind: "plugin",
          authorization: record.authorization,
          manager,
          consumeAllowOnce: verdict === "allow-once",
        }),
      ]);
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  }

  resolve(id: string, decision: ExecApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (
      !entry ||
      !resolveCanonicalPluginApprovalRequestAllowedDecisions(entry.record.request).includes(
        decision,
      )
    ) {
      return false;
    }
    const actor = { kind: "runtime", clientId: "tui:embedded" } as const;
    entry.assertCurrent(decision);
    entry.record.resolvedByActor = actor;
    entry.record.decision = decision;
    entry.record.status = decision === "deny" ? "denied" : "allowed";
    entry.record.terminalReason = "user";
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    this.emit({
      event: "plugin.approval.resolved",
      payload: {
        id,
        decision,
        resolvedBy: "tui:embedded",
        resolvedByActor: actor,
        ts: Date.now(),
        request: entry.record.request,
      },
    });
    return true;
  }

  stop(reason: unknown = new Error("embedded plugin approval broker stopped")): void {
    this.generation += 1;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.emit({ event: "plugin.approval.removed", payload: { id } });
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private emit(event: ApprovalEvent): void {
    notifyListeners(this.listeners, event);
  }
}

export function setEmbeddedPluginApprovalBroker(broker: EmbeddedPluginApprovalBroker | null): void {
  activeBroker = broker;
}

export function clearEmbeddedPluginApprovalBroker(broker: EmbeddedPluginApprovalBroker): void {
  if (activeBroker === broker) {
    activeBroker = null;
  }
}

export function getEmbeddedPluginApprovalBroker(): EmbeddedPluginApprovalBroker | null {
  return activeBroker;
}
