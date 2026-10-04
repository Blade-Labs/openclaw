// Microsoft Teams tests cover requester-only approval provenance recorded at inbound dispatch.
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  classifyMSTeamsApprovalRequester,
  clearMSTeamsRequesterTurnRuns,
} from "../approval-requester.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();
const REQUESTER_ID = "40a1a0ed-4ff2-4164-a219-55518990c197";
const PERSONAL_CHAT = "a:1requester-chat";

function lifecycle(): MSTeamsIngressLifecycle {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: async () => {},
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: async () => {},
  };
}

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

function directActivity(): MSTeamsTurnContext["activity"] {
  return {
    ...buildChannelActivity({
      id: "activity-1",
      text: "please deploy",
      from: { id: "29:requester", aadObjectId: REQUESTER_ID, name: "Requester" },
      conversation: { id: PERSONAL_CHAT, conversationType: "personal" },
      channelData: {},
      entities: [],
    }),
  } as MSTeamsTurnContext["activity"];
}

function createConfig(requesterOnly: boolean): OpenClawConfig {
  return {
    session: { dmScope: "per-channel-peer" },
    channels: {
      msteams: {
        dmPolicy: "allowlist",
        allowFrom: [REQUESTER_ID],
        approvals: { requesterOnly },
      },
    },
  } as OpenClawConfig;
}

async function dispatchDirectMessage(cfg: OpenClawConfig) {
  const { deps } = createMessageHandlerDeps(cfg);
  const handler = createMSTeamsMessageHandler(deps);
  await handler(context(directActivity()), lifecycle());
  const dispatch = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  return dispatch.mock.calls[0]?.[0] as
    | { replyOptions?: { onAgentRunStart?: (runId: string) => unknown } }
    | undefined;
}

function approvalFromRun(runId: string): ExecApprovalRequest {
  return {
    id: "approval-1",
    request: {
      command: "deploy",
      runId,
      sessionKey: `agent:main:msteams:direct:${REQUESTER_ID}`,
      turnSourceChannel: "msteams",
      turnSourceTo: `conversation:${PERSONAL_CHAT}`,
      turnSourceAccountId: "default",
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
}

describe("Microsoft Teams requester-only turn provenance", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
    clearMSTeamsRequesterTurnRuns();
  });

  it("attributes approvals only to runs started by the user's own 1:1 message", async () => {
    const cfg = createConfig(true);
    const dispatchParams = await dispatchDirectMessage(cfg);
    const onAgentRunStart = dispatchParams?.replyOptions?.onAgentRunStart;
    expect(onAgentRunStart).toBeTypeOf("function");

    // Before the run starts (or for any other run, e.g. a scheduled job) nothing is attributable.
    expect(classifyMSTeamsApprovalRequester({ cfg, request: approvalFromRun("run-1") })).toEqual({
      ok: false,
      reason: "not-a-user-turn",
    });

    onAgentRunStart?.("run-1");

    expect(
      classifyMSTeamsApprovalRequester({ cfg, request: approvalFromRun("run-1") }),
    ).toMatchObject({ ok: true, requester: { aadObjectId: REQUESTER_ID } });
    expect(
      classifyMSTeamsApprovalRequester({ cfg, request: approvalFromRun("cron:job:1") }),
    ).toEqual({ ok: false, reason: "not-a-user-turn" });
  });

  it("leaves the reply options untouched when the option is off", async () => {
    const dispatchParams = await dispatchDirectMessage(createConfig(false));
    expect(dispatchParams?.replyOptions?.onAgentRunStart).toBeUndefined();
  });
});
