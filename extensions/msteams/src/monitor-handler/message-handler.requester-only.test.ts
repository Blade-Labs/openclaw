// Microsoft Teams dispatch preserves source facts for core approval provenance.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
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
  expect(dispatch).toHaveBeenCalledTimes(1);
  return dispatch.mock.calls[0]?.[0] as
    | {
        ctx?: {
          SenderId?: string;
          ChatType?: string;
          MessageSid?: string;
          OriginatingChannel?: string;
          OriginatingTo?: string;
        };
        replyOptions?: { onAgentRunStart?: (runId: string) => unknown };
      }
    | undefined;
}

describe("Microsoft Teams requester-only turn provenance", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it.each([true, false])(
    "passes the personal message source to core without a plugin run callback (requesterOnly=%s)",
    async (requesterOnly) => {
      const dispatchParams = await dispatchDirectMessage(createConfig(requesterOnly));
      expect(dispatchParams?.ctx).toMatchObject({
        SenderId: REQUESTER_ID,
        ChatType: "direct",
        MessageSid: "activity-1",
        OriginatingChannel: "msteams",
        OriginatingTo: `conversation:${PERSONAL_CHAT}`,
      });
      expect(dispatchParams?.replyOptions?.onAgentRunStart).toBeUndefined();
    },
  );
});
