// Detects approval-not-found errors across gateway response shapes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const INVALID_REQUEST = "INVALID_REQUEST";
const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND";
const APPROVAL_ALREADY_RESOLVED = "APPROVAL_ALREADY_RESOLVED";
const APPROVAL_REQUESTER_UNAVAILABLE = "APPROVAL_REQUESTER_UNAVAILABLE";
const LEGACY_APPROVAL_NOT_FOUND_RE =
  /\b(?:unknown or expired approval id|approval expired or not found)\b/i;

function readErrorCode(value: unknown): string | null {
  return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}

/** Requester denials remain terminal even when local policy predates the Gateway policy. */
export function isApprovalRequesterUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const coded = error as {
    code?: unknown;
    gatewayCode?: unknown;
    details?: unknown;
    cause?: unknown;
  };
  const details = coded.details;
  return (
    readErrorCode(coded.code) === APPROVAL_REQUESTER_UNAVAILABLE ||
    readErrorCode(coded.gatewayCode) === APPROVAL_REQUESTER_UNAVAILABLE ||
    (details !== null &&
      typeof details === "object" &&
      "code" in details &&
      readErrorCode(details.code) === APPROVAL_REQUESTER_UNAVAILABLE) ||
    (coded.cause !== undefined &&
      coded.cause !== error &&
      isApprovalRequesterUnavailableError(coded.cause))
  );
}

function readApprovalErrorDetailsReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" ? (normalizeOptionalString(reason) ?? null) : null;
}

/**
 * Detects approval-not-found failures across gateway error shapes.
 * Kept broad enough for legacy message-only errors emitted before structured codes.
 */
export function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === APPROVAL_NOT_FOUND) {
    return true;
  }
  const detailsReason = readApprovalErrorDetailsReason((err as { details?: unknown }).details);
  if (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_NOT_FOUND) {
    return true;
  }
  return LEGACY_APPROVAL_NOT_FOUND_RE.test(err.message);
}

/** Detects approval failures that mean a pending prompt is no longer actionable. */
export function isApprovalStaleError(err: unknown): boolean {
  if (isApprovalNotFoundError(err)) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  const detailsReason = readApprovalErrorDetailsReason((err as { details?: unknown }).details);
  return (
    (gatewayCode === INVALID_REQUEST && detailsReason === APPROVAL_ALREADY_RESOLVED) ||
    /approval already resolved/i.test(err.message)
  );
}
