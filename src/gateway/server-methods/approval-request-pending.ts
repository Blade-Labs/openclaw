import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { hasApprovalTurnSourceRoute } from "../../infra/approval-turn-source.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { requiresApprovalRequesterMatch } from "../approval-request-policy.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import { reportBlockedApprovalRequest } from "./approval-requester-blocked.js";
import {
  resolveApprovalRequestRecipientConnIds,
  respondApprovalStorageUnavailable,
  type ApprovalTurnSourceFields,
  type RequestedApprovalEvent,
} from "./approval-shared.js";
import { buildWaitResponse } from "./approval-wait-response.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type ApprovalRequestDeliveryRoute = "approval-client" | "forwarder" | "turn-source" | "none";

/** Broadcasts or routes a pending approval request, then responds after acceptance/decision. */
export async function handlePendingApprovalRequest<
  TPayload extends ApprovalTurnSourceFields,
>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  respond: RespondFn;
  context: GatewayRequestContext;
  clientConnId?: string;
  requestEventName: string;
  requestEvent: RequestedApprovalEvent<TPayload>;
  twoPhase: boolean;
  approvalKind?: ChannelApprovalKind;
  deliverRequest: () => boolean | Promise<boolean>;
  afterDecision?: (
    decision: ExecApprovalDecision | null,
    requestEvent: RequestedApprovalEvent<TPayload>,
  ) => Promise<void> | void;
  afterDecisionErrorLabel?: string;
  keepPendingWithoutRoute?: boolean;
  requireDeliveryRoute?: boolean;
  suppressDelivery?: boolean;
  deliverToApprovalClientsOnly?: boolean;
}): Promise<void> {
  const deliveryReady = createDeferredCore<boolean>();
  let noRouteWon = false;
  let requesterDeliveryBlocked = false;
  const handoff = params.manager.registerDecisionHandoff(params.record.id, async (decision) => {
    if (!(await deliveryReady.promise)) {
      return;
    }
    let projectedDecision = params.manager.projectDecisionIfActive(params.record.id, decision);
    if (!noRouteWon && params.afterDecision) {
      try {
        await params.afterDecision(projectedDecision, params.requestEvent);
      } catch (err) {
        params.context.logGateway?.error?.(
          `${params.afterDecisionErrorLabel ?? "approval follow-up failed"}: ${String(err)}`,
        );
      }
    }
    projectedDecision = params.manager.projectDecisionIfActive(params.record.id, projectedDecision);
    if (requesterDeliveryBlocked) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Approval requester unavailable. No action was approved.",
          {
            details: {
              code: "APPROVAL_REQUESTER_UNAVAILABLE",
              approvalId: params.record.id,
              terminalReason: "requester-unavailable",
            },
          },
        ),
      );
    } else {
      params.respond(
        true,
        buildWaitResponse(params.record.id, projectedDecision, params.record),
        undefined,
      );
    }
  });
  // Observation can close while delivery is preparing; the registered genuine
  // handoff remains manager-owned and is joined independently of this observer.
  void handoff.observation.catch(() => {});
  try {
    const strict =
      params.record.requiresRequesterMatch?.() === true ||
      requiresApprovalRequesterMatch(
        params.record.authorization,
        params.context.getRuntimeConfig?.() ?? {},
        params.approvalKind ?? "exec",
      );
    if (strict) {
      let delivered = false;
      try {
        params.record.assertRequesterCurrent?.();
        delivered = await params.manager.trackActiveWork(
          () =>
            (params.record.authorization?.policy.requireResolverMatch &&
              params.context.approvalEvents?.deliverRequester?.(
                params.approvalKind ?? "exec",
                params.requestEvent,
              )) ||
            Promise.resolve(false),
        );
        params.record.assertRequesterCurrent?.();
      } catch (error) {
        delivered = false;
        params.context.logGateway?.error?.(
          `approval ${params.record.id}: requester delivery failed: ${String(error)}`,
        );
      }
      if (!delivered) {
        const denied = await params.manager.forceDenyDetailed(
          params.record.id,
          "requester-unavailable",
          { kind: "system", id: null },
          "denied",
        );
        requesterDeliveryBlocked = denied.outcome === "denied";
        if (requesterDeliveryBlocked) {
          await reportBlockedApprovalRequest({
            context: params.context,
            approvalKind: params.approvalKind ?? "exec",
            event: params.requestEvent,
          });
        }
      } else if (params.twoPhase) {
        params.respond(
          true,
          {
            status: "accepted",
            id: params.record.id,
            deliveryRoute: "turn-source",
            authorization: params.record.authorization,
            createdAtMs: params.record.createdAtMs,
            expiresAtMs: params.record.expiresAtMs,
          },
          undefined,
        );
      }
      deliveryReady.resolve(true);
      await handoff.observation;
      return;
    }
    const suppressDelivery = params.suppressDelivery === true;
    // Cron/automation cards go only to connected approval surfaces (Control
    // UI, TUI): chat runtimes and turn-source routes would recreate the
    // per-occurrence spam #128031 removed, while an approval client can end
    // the recurrence with one allow-always (standing grant).
    const approvalClientsOnly = !suppressDelivery && params.deliverToApprovalClientsOnly === true;
    const approvalClientConnIds = suppressDelivery
      ? null
      : resolveApprovalRequestRecipientConnIds({
          approvalKind: params.approvalKind ?? "exec",
          context: params.context,
          record: params.record,
          excludeConnId: params.clientConnId,
        });
    if (!suppressDelivery) {
      if (approvalClientConnIds) {
        params.context.broadcastToConnIds(
          params.requestEventName,
          params.requestEvent,
          approvalClientConnIds,
          {
            dropIfSlow: true,
          },
        );
      } else {
        params.context.broadcast(params.requestEventName, params.requestEvent, {
          dropIfSlow: true,
        });
      }
    }
    const nativeDelivery =
      suppressDelivery || approvalClientsOnly
        ? undefined
        : await params.manager.trackActiveWork(() =>
            Promise.resolve(
              params.context.approvalEvents?.publishRequested(
                params.approvalKind ?? "exec",
                params.requestEvent,
              ),
            ),
          );
    const internalApprovalSubscriberCount = nativeDelivery?.deliveredCount ?? 0;

    const hasApprovalClients = suppressDelivery
      ? false
      : approvalClientConnIds !== null
        ? approvalClientConnIds.size > 0 || internalApprovalSubscriberCount > 0
        : (params.context.hasExecApprovalClients?.(params.clientConnId) ?? false) ||
          internalApprovalSubscriberCount > 0;
    const delivered =
      suppressDelivery || approvalClientsOnly
        ? false
        : await params.manager.trackActiveWork(params.deliverRequest);
    // A turn-source route can approve without an active approval client, so keep
    // the record alive when the originating channel/account can still receive it.
    const hasTurnSourceRoute =
      !suppressDelivery &&
      !approvalClientsOnly &&
      !nativeDelivery?.originUnavailable &&
      !hasApprovalClients &&
      !delivered &&
      hasApprovalTurnSourceRoute({
        turnSourceChannel: params.record.request.turnSourceChannel,
        turnSourceAccountId: params.record.request.turnSourceAccountId,
        approvalKind: params.approvalKind ?? "exec",
      });
    const deliveryRoute: ApprovalRequestDeliveryRoute = delivered
      ? "forwarder"
      : hasApprovalClients
        ? "approval-client"
        : hasTurnSourceRoute
          ? "turn-source"
          : "none";

    if (
      params.requireDeliveryRoute !== false &&
      !params.keepPendingWithoutRoute &&
      !hasApprovalClients &&
      !hasTurnSourceRoute &&
      !delivered
    ) {
      try {
        if (nativeDelivery?.originUnavailable) {
          const denied = await params.manager.forceDenyDetailed(
            params.record.id,
            "requester-unavailable",
            { kind: "system", id: null },
            "denied",
          );
          requesterDeliveryBlocked = denied.outcome === "denied";
          noRouteWon = requesterDeliveryBlocked;
          if (requesterDeliveryBlocked) {
            await reportBlockedApprovalRequest({
              context: params.context,
              approvalKind: params.approvalKind ?? "exec",
              event: params.requestEvent,
            });
          }
        } else {
          noRouteWon = await params.manager.expire(params.record.id, "no-approval-route");
        }
      } catch (err) {
        deliveryReady.resolve(false);
        handoff.abandon();
        respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
        return;
      }
    } else if (params.twoPhase) {
      params.respond(
        true,
        {
          status: "accepted",
          id: params.record.id,
          // Agent-side timeouts use this to distinguish delivered prompts from
          // requests kept pending only because manual /approve routing may work.
          deliveryRoute,
          authorization: params.record.authorization,
          createdAtMs: params.record.createdAtMs,
          expiresAtMs: params.record.expiresAtMs,
        },
        undefined,
      );
    }
  } catch (error) {
    deliveryReady.resolve(false);
    handoff.abandon();
    throw error;
  }
  deliveryReady.resolve(true);
  await handoff.observation;
}
