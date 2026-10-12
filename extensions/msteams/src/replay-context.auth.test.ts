// Microsoft Teams ingress dispatch carries the transport authentication fact only for live JWT callbacks.
import { describe, expect, it, vi } from "vitest";
import { isMSTeamsAuthenticatedActivity, isMSTeamsReplayedActivity } from "./inbound.js";
import { resolveMSTeamsIngressDispatchContext } from "./replay-context.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";

function journaledActivity(): MSTeamsTurnContext["activity"] {
  return {
    id: "activity-1",
    type: "message",
    channelId: "msteams",
    text: "hello",
    from: { id: "29:sender", aadObjectId: "40a1a0ed-4ff2-4164-a219-55518990c197" },
    recipient: { id: "bot-id" },
    conversation: { id: "a:1personal", conversationType: "personal" },
    serviceUrl: "https://smba.trafficmanager.net/amer/",
  } as MSTeamsTurnContext["activity"];
}

function liveContext(text = "hello"): MSTeamsTurnContext {
  return {
    activity: { ...journaledActivity(), text },
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
  } as unknown as MSTeamsTurnContext;
}

const app = {} as MSTeamsApp;
const serviceUrlBoundary = {} as Parameters<
  typeof resolveMSTeamsIngressDispatchContext
>[0]["serviceUrlBoundary"];

describe("Microsoft Teams ingress dispatch context", () => {
  it("marks the journaled activity authenticated for a live JWT-enforced callback", () => {
    const activity = journaledActivity();
    const live = liveContext();
    const context = resolveMSTeamsIngressDispatchContext({
      activity,
      liveContext: live,
      payloadMatchesLiveCallback: true,
      app,
      jwtEnforced: true,
      serviceUrlBoundary,
    });
    expect(context).toBe(live);
    expect(context.activity).toBe(activity);
    expect(isMSTeamsAuthenticatedActivity(activity)).toBe(true);
  });

  it("does not mark a live callback when the App does not enforce JWT validation", () => {
    const activity = journaledActivity();
    resolveMSTeamsIngressDispatchContext({
      activity,
      liveContext: liveContext(),
      payloadMatchesLiveCallback: true,
      app,
      jwtEnforced: false,
      serviceUrlBoundary,
    });
    expect(isMSTeamsAuthenticatedActivity(activity)).toBe(false);
  });

  it("does not authenticate a stored payload the live callback did not deliver", () => {
    // A redelivery with the same activity id can carry a live context for an older retained
    // row; the journal stays the payload, but its bytes were never validated by this callback.
    const activity = journaledActivity();
    const live = liveContext("new validated payload");
    const context = resolveMSTeamsIngressDispatchContext({
      activity,
      liveContext: live,
      payloadMatchesLiveCallback: false,
      app,
      jwtEnforced: true,
      serviceUrlBoundary,
    });
    expect(context.activity).toBe(activity);
    expect(context.activity.text).toBe("hello");
    expect(isMSTeamsAuthenticatedActivity(activity)).toBe(false);
  });

  it("never marks a journal replay authenticated", () => {
    const activity = journaledActivity();
    const context = resolveMSTeamsIngressDispatchContext({
      activity,
      payloadMatchesLiveCallback: false,
      app,
      jwtEnforced: true,
      serviceUrlBoundary,
    });
    expect(context.activity).toBe(activity);
    expect(isMSTeamsReplayedActivity(activity)).toBe(true);
    expect(isMSTeamsAuthenticatedActivity(activity)).toBe(false);
  });
});
