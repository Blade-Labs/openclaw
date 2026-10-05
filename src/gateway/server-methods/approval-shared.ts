// Approval shared helpers normalize pending exec/plugin approval lookups,
// decision payloads, turn-source routing, and gateway error responses.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type {
  ApprovalChannelReviewer,
  ValidationError,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ApprovalResolvingActor } from "../../infra/approval-requester-binding.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { prepareApprovalChannelCustody } from "../approval-channel-custody.js";
import { requiresApprovalRequesterMatch } from "../approval-request-policy.js";
import { isApprovalRequesterPolicyError } from "../approval-requester-policy.js";
import {
  prepareApprovalResolvingActor,
  readApprovalChannelReviewer,
} from "../approval-resolving-actor.js";
import type { ExecApprovalManager, ExecApprovalRecord } from "../exec-approval-manager.js";
import {
  type ApprovalRecordLookupResult,
  isApprovalRecordVisibleToClient,
  normalizeApprovalIdentities,
  resolvePendingApprovalRecord,
  resolveResolvedApprovalRecord,
  respondPendingApprovalLookupError,
  respondUnknownOrExpiredApproval,
} from "./approval-record-lookup.js";
import { reportBlockedApprovalRequest } from "./approval-requester-blocked.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

export {
  isApprovalRecordVisibleToClient,
  listVisiblePendingApprovalRequests,
  resolvePendingApprovalRecord,
  respondPendingApprovalLookupError,
} from "./approval-record-lookup.js";

const APPROVAL_ALREADY_RESOLVED_DETAILS = {
  reason: "APPROVAL_ALREADY_RESOLVED",
} as const;

function resolveRecordedApprovalDecision<TPayload>(
  record: ExecApprovalRecord<TPayload>,
): ExecApprovalDecision | undefined {
  return record.decision ?? record.consumedDecision;
}

export type ApprovalTurnSourceFields = {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
};

export type RequestedApprovalEvent<
  TPayload extends ApprovalTurnSourceFields,
  TKind extends ChannelApprovalKind = ChannelApprovalKind,
> = {
  approvalKind?: TKind;
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

type ResolvedApprovalEvent<TPayload> = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy: string | null;
  resolvedByActor?: ApprovalResolvingActor | null;
  ts: number;
  request: TPayload;
};

type ApprovalResolveParams = {
  id: string;
  decision: string;
  reviewer?: ApprovalChannelReviewer;
};

type ApprovalResolveParamsValidator<TParams extends ApprovalResolveParams> = ((
  params: unknown,
) => params is TParams) & {
  errors?: ValidationError[] | null;
};

function isApprovalDecision(value: string): value is ExecApprovalDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

/** Binds the current gateway client identity onto a newly-created approval record. */
export function bindApprovalRequesterMetadata<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  client?: GatewayClient | null;
}): void {
  params.record.requestedByConnId = params.client?.connId ?? null;
  params.record.requestedByDeviceId = params.client?.connect?.device?.id ?? null;
  params.record.requestedByClientId = params.client?.connect?.client?.id ?? null;
  params.record.requestedByDeviceTokenAuth = params.client?.isDeviceTokenAuth === true;
}

export function bindApprovalReviewerDeviceIds<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  deviceIds?: readonly string[] | null;
}): void {
  const deviceIds = normalizeApprovalIdentities(params.deviceIds);
  if (deviceIds.length > 0) {
    params.record.approvalReviewerDeviceIds = deviceIds;
  }
}

export function respondApprovalStorageUnavailable(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  operation: "request" | "resolve" | "history" | "lookup";
  error: unknown;
}): void {
  if (isApprovalRequesterPolicyError(params.error)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, params.error.message, {
        details: { code: params.error.code, reason: params.error.reason },
      }),
    );
    return;
  }
  params.context.logGateway?.error?.(
    `approval ${params.operation} storage failure: ${String(params.error)}`,
  );
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, `approval ${params.operation} unavailable`),
  );
}

/** Registers an approval record and converts manager registration errors to gateway errors. */
export async function registerPendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  timeoutMs: number;
  respond: RespondFn;
  context: GatewayRequestContext;
  throwStorageErrors?: boolean;
}): Promise<{ decision: Promise<ExecApprovalDecision | null> } | undefined> {
  try {
    const registered = await params.manager.register(params.record, params.timeoutMs);
    if (
      params.record.authorization?.policy.requireResolverMatch &&
      params.record.authorization.requesterBinding.state !== "bound"
    ) {
      await params.manager.forceDenyDetailed(
        params.record.id,
        "requester-unavailable",
        { kind: "system", id: null },
        "denied",
      );
      await reportBlockedApprovalRequest({
        context: params.context,
        approvalKind: params.manager.approvalKind,
        event: buildRequestedApprovalEvent(
          params.record as ExecApprovalRecord<ApprovalTurnSourceFields>,
        ),
      });
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
              reason: params.record.authorization.requesterBinding.state,
              terminalReason: "requester-unavailable",
            },
          },
        ),
      );
      return undefined;
    }
    return registered;
  } catch (err) {
    if (isApprovalRequesterPolicyError(err)) {
      await params.manager.recordRequesterDenial(params.record);
      await reportBlockedApprovalRequest({
        context: params.context,
        approvalKind: params.manager.approvalKind,
        event: buildRequestedApprovalEvent(
          params.record as ExecApprovalRecord<ApprovalTurnSourceFields>,
        ),
      });
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
              reason: err.reason,
              terminalReason: "requester-unavailable",
            },
          },
        ),
      );
      return undefined;
    }
    if (params.throwStorageErrors) {
      throw err;
    }
    respondApprovalStorageUnavailable({ ...params, operation: "request", error: err });
    return undefined;
  }
}

/** Builds the gateway event payload broadcast when an approval starts waiting. */
export function buildRequestedApprovalEvent<
  TPayload extends ApprovalTurnSourceFields,
  TKind extends ChannelApprovalKind,
>(
  record: ExecApprovalRecord<TPayload>,
  approvalKind?: TKind,
): RequestedApprovalEvent<TPayload, TKind> {
  return {
    ...(approvalKind ? { approvalKind } : {}),
    id: record.id,
    request: record.request,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}

/** Validates approval resolve params and narrows the decision to the supported enum. */
export function resolveApprovalDecisionParams<TParams extends ApprovalResolveParams>(params: {
  rawParams: unknown;
  validate: ApprovalResolveParamsValidator<TParams>;
  methodName: string;
  respond: RespondFn;
}): {
  inputId: string;
  decision: ExecApprovalDecision;
  reviewer?: ApprovalChannelReviewer;
} | null {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.methodName, params.respond)) {
    return null;
  }
  if (!isApprovalDecision(rawParams.decision)) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
    return null;
  }
  return {
    inputId: rawParams.id,
    decision: rawParams.decision,
    ...(rawParams.reviewer ? { reviewer: rawParams.reviewer } : {}),
  };
}

/** Resolves the approval clients that should receive request or resolution events. */
export function resolveApprovalRequestRecipientConnIds<TPayload>(params: {
  approvalKind: "exec" | "plugin" | "system-agent";
  context: GatewayRequestContext;
  record: ExecApprovalRecord<TPayload>;
  excludeConnId?: string;
}): ReadonlySet<string> | null {
  return (
    params.context.getApprovalClientConnIds?.({
      approvalKind: params.approvalKind,
      excludeConnId: params.excludeConnId,
      record: params.record,
      filter: (client) =>
        isApprovalRecordVisibleToClient({
          record: params.record,
          client,
        }),
    }) ?? null
  );
}

/** Sends a resolved approval only to clients authorized for its live binding. */
export function broadcastApprovalResolvedEvent<TPayload>(params: {
  approvalKind: "exec" | "plugin" | "system-agent";
  context: GatewayRequestContext;
  record: ExecApprovalRecord<TPayload>;
  event: ResolvedApprovalEvent<TPayload>;
}): void {
  if (
    params.record.requiresRequesterMatch?.() === true ||
    requiresApprovalRequesterMatch(
      params.record.authorization,
      params.context.getRuntimeConfig?.() ?? {},
      params.approvalKind,
    )
  ) {
    return;
  }
  const eventName =
    params.approvalKind === "system-agent"
      ? "openclaw.approval.resolved"
      : `${params.approvalKind}.approval.resolved`;
  const recipientConnIds = resolveApprovalRequestRecipientConnIds({
    approvalKind: params.approvalKind,
    context: params.context,
    record: params.record,
  });
  if (recipientConnIds) {
    params.context.broadcastToConnIds(eventName, params.event, recipientConnIds, {
      dropIfSlow: true,
    });
    return;
  }
  params.context.broadcast(eventName, params.event, { dropIfSlow: true });
}

function respondRepeatedApprovalResolution<TPayload>(
  record: ExecApprovalRecord<TPayload>,
  decision: ExecApprovalDecision,
  respond: RespondFn,
): void {
  // Identical retries are idempotent; a conflicting retry must never replace
  // or obscure the first durable operator decision.
  if (resolveRecordedApprovalDecision(record) === decision) {
    respond(true, { ok: true }, undefined);
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "approval already resolved", {
      details: APPROVAL_ALREADY_RESOLVED_DETAILS,
    }),
  );
}

/** Resolves a pending approval and broadcasts the final decision exactly once. */
export async function handleApprovalResolve<
  TPayload extends ExecApprovalRequestPayload | PluginApprovalRequestPayload,
>(params: {
  approvalKind: ChannelApprovalKind;
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  decision: ExecApprovalDecision;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  reviewer?: ApprovalChannelReviewer;
  exposeAmbiguousPrefixError?: boolean;
  validateDecision?: (snapshot: ExecApprovalRecord<TPayload>) =>
    | {
        message: string;
        details?: Record<string, unknown>;
      }
    | null
    | undefined;
  resolveRecord?: (params: {
    approvalId: string;
    decision: ExecApprovalDecision;
    resolvedBy: string | null;
    snapshot: ExecApprovalRecord<TPayload>;
    resolver?: { kind: "channel" | "runtime"; id: string | null; actor?: ApprovalResolvingActor };
    assertCurrent: () => void;
  }) => Promise<boolean>;
  forwardResolved?: (event: ResolvedApprovalEvent<TPayload>) => Promise<void> | void;
  forwardResolvedErrorLabel?: string;
  extraResolvedHandlers?: Array<{
    run: (event: ResolvedApprovalEvent<TPayload>) => Promise<void> | void;
    errorLabel: string;
  }>;
}): Promise<void> {
  let reviewer: ApprovalChannelReviewer | undefined;
  try {
    reviewer = readApprovalChannelReviewer(params.client, params.reviewer);
  } catch (error) {
    respondApprovalStorageUnavailable({ ...params, operation: "resolve", error });
    return;
  }
  const custody = reviewer
    ? prepareApprovalChannelCustody({
        cfg: params.context.getRuntimeConfig(),
        approvalKind: params.approvalKind,
        reviewer,
      })
    : null;
  if (reviewer && !custody) {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  const recordFilter = custody
    ? (record: ExecApprovalRecord<TPayload>) => custody.authorizes(record)
    : undefined;
  let resolved: ApprovalRecordLookupResult<TPayload>;
  try {
    resolved = await resolvePendingApprovalRecord({
      manager: params.manager,
      inputId: params.inputId,
      client: params.client,
      exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
      recordFilter,
    });
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "resolve", error: err });
    return;
  }
  if (!resolved.ok) {
    let resolvedRepeat: ApprovalRecordLookupResult<TPayload>;
    try {
      resolvedRepeat = await resolveResolvedApprovalRecord({
        manager: params.manager,
        inputId: params.inputId,
        client: params.client,
        exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
        recordFilter,
      });
    } catch (err) {
      respondApprovalStorageUnavailable({ ...params, operation: "resolve", error: err });
      return;
    }
    if (resolvedRepeat.ok) {
      try {
        prepareApprovalResolvingActor({
          client: params.client,
          context: params.context,
          approvalKind: params.approvalKind,
          authorization: resolvedRepeat.snapshot.authorization,
          decision: params.decision,
        });
      } catch (error) {
        respondApprovalStorageUnavailable({ ...params, operation: "resolve", error });
        return;
      }
      respondRepeatedApprovalResolution(resolvedRepeat.snapshot, params.decision, params.respond);
      return;
    }
    respondPendingApprovalLookupError({ respond: params.respond, response: resolved.response });
    return;
  }

  let preparedActor: ReturnType<typeof prepareApprovalResolvingActor>;
  try {
    preparedActor = prepareApprovalResolvingActor({
      client: params.client,
      context: params.context,
      approvalKind: params.approvalKind,
      authorization: resolved.snapshot.authorization,
      decision: params.decision,
    });
  } catch (error) {
    respondApprovalStorageUnavailable({ ...params, operation: "resolve", error });
    return;
  }
  const validationError = params.validateDecision?.(resolved.snapshot);
  if (validationError) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        validationError.message,
        validationError.details ? { details: validationError.details } : undefined,
      ),
    );
    return;
  }

  const resolvedBy =
    params.client?.connect?.client?.displayName ?? params.client?.connect?.client?.id ?? null;
  const resolver = custody
    ? ({ kind: "channel", id: custody.resolverId, actor: preparedActor.actor } as const)
    : ({ kind: "runtime", id: resolvedBy, actor: preparedActor.actor } as const);
  const assertCurrent = () => {
    preparedActor.assertCurrent();
    const currentCustody = reviewer
      ? prepareApprovalChannelCustody({
          cfg: params.context.getRuntimeConfig(),
          approvalKind: params.approvalKind,
          reviewer,
        })
      : null;
    if (
      params.client?.invalidated ||
      !isApprovalRecordVisibleToClient({
        record: resolved.snapshot,
        client: params.client,
        cfg: params.context.getRuntimeConfig(),
      }) ||
      (reviewer && !currentCustody?.authorizes(resolved.snapshot))
    ) {
      throw new Error("approval resolver authority is no longer active");
    }
  };
  let ok: boolean;
  try {
    ok = params.resolveRecord
      ? await params.resolveRecord({
          approvalId: resolved.approvalId,
          decision: params.decision,
          resolvedBy,
          snapshot: resolved.snapshot,
          resolver,
          assertCurrent,
        })
      : resolver
        ? (
            await params.manager.resolveDetailed(
              resolved.approvalId,
              params.decision,
              resolver,
              resolvedBy,
              "operator",
              { assertCurrent },
            )
          ).outcome === "resolved"
        : await params.manager.resolve(resolved.approvalId, params.decision, resolvedBy, {
            assertCurrent,
          });
  } catch (err) {
    respondApprovalStorageUnavailable({ ...params, operation: "resolve", error: err });
    return;
  }
  if (!ok) {
    // A concurrent surface can win between the pending lookup and this
    // resolve; report the recorded conflict, not a missing approval.
    const raced = await params.manager.getSnapshot(resolved.approvalId);
    if (raced && raced.resolvedAtMs !== undefined) {
      try {
        preparedActor.assertCurrent();
      } catch (error) {
        respondApprovalStorageUnavailable({ ...params, operation: "resolve", error });
        return;
      }
      respondRepeatedApprovalResolution(raced, params.decision, params.respond);
      return;
    }
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }

  const resolvedEvent: ResolvedApprovalEvent<TPayload> = {
    id: resolved.approvalId,
    decision: params.decision,
    resolvedBy,
    resolvedByActor: (await params.manager.getSnapshot(resolved.approvalId))?.resolvedByActor,
    ts: Date.now(),
    request: resolved.snapshot.request,
  };
  broadcastApprovalResolvedEvent({
    approvalKind: params.approvalKind,
    context: params.context,
    record: resolved.snapshot,
    event: resolvedEvent,
  });
  if (
    params.approvalKind !== "system-agent" &&
    (resolved.snapshot.requiresRequesterMatch?.() !== true ||
      resolved.snapshot.authorization?.policy.requireResolverMatch)
  ) {
    params.context.approvalEvents?.publishResolved(params.approvalKind, resolvedEvent as never);
  }

  if (
    resolved.snapshot.requiresRequesterMatch?.() === true ||
    requiresApprovalRequesterMatch(
      resolved.snapshot.authorization,
      params.context.getRuntimeConfig(),
      params.approvalKind,
    )
  ) {
    params.respond(true, { ok: true }, undefined);
    return;
  }
  const followUps = [
    params.forwardResolved
      ? {
          run: params.forwardResolved,
          errorLabel: params.forwardResolvedErrorLabel ?? "approval resolve follow-up failed",
        }
      : null,
    ...(params.extraResolvedHandlers ?? []),
    params.context.approvalWebPushDelivery
      ? {
          run: params.context.approvalWebPushDelivery.handleResolved,
          errorLabel: `${params.approvalKind} approvals: Web Push resolve failed`,
        }
      : null,
  ].filter(
    (
      entry,
    ): entry is {
      run: (event: ResolvedApprovalEvent<TPayload>) => Promise<void> | void;
      errorLabel: string;
    } => Boolean(entry),
  );

  // Resolution has already been recorded and broadcast; follow-up hooks are
  // best-effort so a plugin/channel forwarding failure cannot reopen it.
  for (const followUp of followUps) {
    try {
      await followUp.run(resolvedEvent);
    } catch (err) {
      params.context.logGateway?.error?.(`${followUp.errorLabel}: ${String(err)}`);
    }
  }

  params.respond(true, { ok: true }, undefined);
}

export { handlePendingApprovalRequest } from "./approval-request-pending.js";

export { handleApprovalWaitDecision } from "./approval-wait.js";
