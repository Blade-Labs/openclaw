import type { ChannelApprovalNativeTarget } from "../channels/plugins/approval-native.types.js";
import type { ApprovalRequestInput, ChannelApprovalKind } from "./approval-types.js";

type NoticeRuntime = {
  channel?: string;
  accountId?: string | null;
  handledKinds: ReadonlySet<ChannelApprovalKind>;
  resolveRequesterNoticeTarget?: (
    request: ApprovalRequestInput,
    kind: ChannelApprovalKind,
  ) => Promise<ChannelApprovalNativeTarget | null>;
  requestGateway: <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
};

/** Uses the existing send idempotency owner; transport fields cannot select a notice recipient. */
export async function reportBlockedRequesterNotice(params: {
  request: ApprovalRequestInput;
  kind: ChannelApprovalKind;
  runtimes: readonly NoticeRuntime[];
  isCurrent: (runtime: NoticeRuntime) => boolean;
}): Promise<"sent" | "no-unique-chat" | "failed"> {
  const source = params.request.request.authorization?.source;
  const users = source?.inputs.filter((input) => input.origin === "user") ?? [];
  const first = users[0];
  if (
    source?.completeness !== "complete" ||
    !first ||
    first.actor.actorKind !== "human" ||
    first.message.conversationKind !== "direct" ||
    !first.message.conversationId ||
    users.some(
      (input) =>
        input.actor.actorKind !== "human" ||
        input.actor.channel !== first.actor.channel ||
        input.actor.accountId !== first.actor.accountId ||
        input.actor.senderId !== first.actor.senderId ||
        input.message.conversationKind !== "direct" ||
        input.message.conversationId !== first.message.conversationId,
    )
  ) {
    return "no-unique-chat";
  }
  const candidates = params.runtimes.filter(
    (runtime) =>
      runtime.channel === first.actor.channel &&
      runtime.accountId === first.actor.accountId &&
      runtime.handledKinds.has(params.kind) &&
      runtime.resolveRequesterNoticeTarget,
  );
  const runtime = candidates.length === 1 ? candidates[0] : undefined;
  if (!runtime?.resolveRequesterNoticeTarget) {
    return "no-unique-chat";
  }
  try {
    const target = await runtime.resolveRequesterNoticeTarget(params.request, params.kind);
    if (!target) {
      return "no-unique-chat";
    }
    if (!params.isCurrent(runtime)) {
      return "failed";
    }
    await runtime.requestGateway("send", {
      channel: runtime.channel,
      accountId: runtime.accountId,
      to: target.to,
      threadId: target.threadId,
      message:
        "Approval blocked: the requester could not be verified or reached. No action was approved. Send a new request in your personal chat.",
      idempotencyKey: `approval-route-notice:blocked:${params.request.id}`,
    });
    return "sent";
  } catch {
    return "failed";
  }
}
