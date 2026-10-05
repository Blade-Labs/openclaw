import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { GatewayRequestContext } from "./types.js";

/** Notice delivery cannot replace an already committed requester denial. */
export async function reportBlockedApprovalRequest(params: {
  context: GatewayRequestContext;
  approvalKind: ChannelApprovalKind;
  event: { id: string };
}): Promise<void> {
  let outcome: "sent" | "no-unique-chat" | "failed";
  try {
    outcome =
      (await params.context.approvalEvents?.reportBlockedRequest?.(
        params.approvalKind,
        params.event,
      )) ?? "no-unique-chat";
  } catch (error) {
    outcome = "failed";
    params.context.logGateway?.error?.(
      `approval ${params.event.id}: blocked notice failed: ${String(error)}`,
    );
  }
  params.context.logGateway?.error?.(
    `approval ${params.event.id}: requester unavailable; notice outcome=${outcome}`,
  );
}
