// Teams memory qualification follows the live JWT callback through provenance and source facts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMSTeamsAuthenticatedActivity, isMSTeamsReplayedActivity } from "./inbound.js";
import { installMSTeamsTestRuntime } from "./monitor-handler.test-helpers.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import {
  areMSTeamsBatchConstituentsExternalUser,
  resolveMSTeamsInboundInputProvenance,
} from "./monitor-handler/input-provenance.js";
import { resolveMSTeamsIngressDispatchContext } from "./replay-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";

type Activity = MSTeamsTurnContext["activity"];

function journaledActivity(conversationType = "personal", id = "activity-1"): Activity {
  return {
    id,
    type: "message",
    channelId: "msteams",
    text: "hello",
    from: { id: "29:sender", aadObjectId: "40a1a0ed-4ff2-4164-a219-55518990c197" },
    recipient: { id: "bot-id" },
    conversation: { id: "conversation-1", conversationType },
    serviceUrl: "https://smba.trafficmanager.net/amer/",
  } as Activity;
}

function dispatchContext(activity: Activity, mode = "authenticated") {
  const live = {
    activity: { ...activity, text: "callback payload" },
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
  } as unknown as MSTeamsTurnContext;
  const context = resolveMSTeamsIngressDispatchContext({
    activity,
    ...(mode !== "replay" ? { liveContext: live } : {}),
    payloadMatchesLiveCallback: mode !== "mismatch" && mode !== "replay",
    app: {} as MSTeamsApp,
    jwtEnforced: mode !== "bypass",
    serviceUrlBoundary: { cloud: "Public" },
  });
  expect(context.activity).toBe(activity);
  expect(context.activity.text).toBe("hello");
  if (mode !== "replay") {
    expect(context).toBe(live);
  }
  return context;
}

async function memoryFacts(activity: Activity, batch = [activity]) {
  const observed = vi.spyOn(getMSTeamsRuntime().channel.inbound.ingress, "resolveStable");
  const access = await resolveMSTeamsSenderAccess({
    cfg: { channels: { msteams: { dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open" } } },
    activity,
    inputProvenanceBatchEligible: areMSTeamsBatchConstituentsExternalUser(batch),
    contextBinding: { agentId: "agent-1", sessionKey: "session-1", messageId: activity.id },
  });
  // Ordinary sender policy still permits bypass fixtures; memory needs the live source facts.
  expect(access.senderAccess.allowed).toBe(true);
  return {
    source: observed.mock.lastCall?.[0].source,
    provenance: resolveMSTeamsInboundInputProvenance({
      activity,
      senderAdmitted: access.senderAccess.allowed,
      batchEligible: areMSTeamsBatchConstituentsExternalUser(batch),
    }),
  };
}

const surfaces = ["personal", "groupChat", "channel"];

describe("Microsoft Teams ingress dispatch context", () => {
  beforeEach(() => {
    installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
  });

  it.each(surfaces)(
    "qualifies a matching JWT-enforced %s callback through source admission",
    async (scope) => {
      const activity = journaledActivity(scope);
      dispatchContext(activity);
      expect(isMSTeamsAuthenticatedActivity(activity)).toBe(true);
      expect(await memoryFacts(activity)).toMatchObject({
        source: { actorKind: "human", eventKind: "message" },
        provenance: { kind: "external_user", sourceChannel: "msteams" },
      });
    },
  );

  it.each(
    surfaces.flatMap((scope) => ["bypass", "mismatch", "replay"].map((mode) => ({ scope, mode }))),
  )(
    "refuses memory for a $scope $mode callback through source admission",
    async ({ scope, mode }) => {
      const activity = journaledActivity(scope);
      // Same-id redelivery cannot vouch for the older retained row; replay has no callback.
      dispatchContext(activity, mode);
      expect(isMSTeamsAuthenticatedActivity(activity)).toBe(false);
      expect(isMSTeamsReplayedActivity(activity)).toBe(mode === "replay");
      expect(await memoryFacts(activity)).toMatchObject({
        source: { actorKind: "unknown", eventKind: "message" },
        provenance: undefined,
      });
    },
  );

  it("refuses an authenticated mixed-principal shared batch", async () => {
    const first = journaledActivity("channel");
    const last = journaledActivity("channel", "activity-2");
    last.from = { id: "29:other", aadObjectId: "11111111-1111-4111-8111-111111111111" };
    dispatchContext(first);
    dispatchContext(last);
    expect(await memoryFacts(last, [first, last])).toMatchObject({
      source: { actorKind: "unknown" },
      provenance: undefined,
    });
  });

  it("refuses a shared batch whose earlier callback bypassed authentication", async () => {
    const first = journaledActivity("channel");
    const last = journaledActivity("channel", "activity-2");
    dispatchContext(first, "bypass");
    dispatchContext(last);
    expect(await memoryFacts(last, [first, last])).toMatchObject({
      source: { actorKind: "unknown" },
      provenance: undefined,
    });
  });

  it.each(["groupChat", "channel"])(
    "does not inherit the first %s callback's authentication for later steering",
    async (scope) => {
      const first = journaledActivity(scope);
      dispatchContext(first);
      expect((await memoryFacts(first)).source).toMatchObject({ actorKind: "human" });
      const later = journaledActivity(scope, "activity-2");
      dispatchContext(later, "bypass");
      // Earlier provenance may survive in a host run; the later source constituent must be unknown.
      expect(await memoryFacts(later, [first, later])).toMatchObject({
        source: { actorKind: "unknown" },
        provenance: undefined,
      });
    },
  );

  it.each([
    { scope: "unknown", isGroup: false },
    { scope: "personal", isGroup: true },
  ])(
    "refuses an authenticated later $scope constituent with conflicting scope",
    async ({ scope, isGroup }) => {
      const first = journaledActivity("channel");
      dispatchContext(first);
      expect((await memoryFacts(first)).source).toMatchObject({ actorKind: "human" });
      const later = journaledActivity(scope, "activity-2");
      later.conversation.isGroup = isGroup;
      dispatchContext(later);
      expect(await memoryFacts(later, [first, later])).toMatchObject({
        source: { actorKind: "unknown" },
        provenance: undefined,
      });
    },
  );
});
