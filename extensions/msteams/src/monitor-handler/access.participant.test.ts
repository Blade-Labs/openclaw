import { describe, expect, it, vi } from "vitest";
import { markMSTeamsAuthenticatedActivity, markMSTeamsReplayedActivity } from "../inbound.js";
import { installMSTeamsTestRuntime } from "../monitor-handler.test-helpers.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { resolveMSTeamsSenderAccess } from "./access.js";

describe("Teams participant domain", () => {
  it.each([
    "human",
    "bot",
    "replay",
    "unauthenticated",
    "invoke",
    "foreign",
    "unknown-scope",
  ] as const)("projects authenticated source kind for %s", async (kind) => {
    installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
    const observed = vi.spyOn(getMSTeamsRuntime().channel.inbound.ingress, "resolveStable");
    const activity = {
      type: "message",
      id: "synthetic-message",
      channelId: "msteams",
      from: {
        id: "synthetic-account",
        aadObjectId: "11111111-1111-4111-8111-111111111111",
        ...(kind === "bot" ? { role: "bot" } : {}),
      },
      conversation: { id: "synthetic-dm", conversationType: "personal" },
    };
    if (kind !== "unauthenticated") {
      markMSTeamsAuthenticatedActivity(activity);
    }
    if (kind === "invoke") {
      activity.type = "invoke";
    }
    if (kind === "foreign") {
      activity.channelId = "directline";
    }
    if (kind === "unknown-scope") {
      activity.conversation.conversationType = "unknown";
    }
    if (kind === "replay") {
      markMSTeamsReplayedActivity(activity);
    }
    await resolveMSTeamsSenderAccess({
      cfg: { channels: { msteams: { dmPolicy: "open" } } },
      activity,
    });
    expect(observed.mock.lastCall?.[0].source).toMatchObject({
      actorKind: kind === "human" || kind === "bot" ? kind : "unknown",
      eventKind: kind === "invoke" ? "unknown" : "message",
    });
  });
  it.each(["entra", "application", "unknown"] as const)(
    "retains %s identity evidence",
    async (kind) => {
      installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
      const observed = vi.spyOn(getMSTeamsRuntime().channel.inbound.ingress, "resolveStable");
      const activity = {
        type: "message",
        id: "message",
        text: "hello",
        serviceUrl: "https://fixture.invalid",
        channelId: "msteams",
        from: {
          id: "opaque-account",
          name: "Alice",
          ...(kind === "entra" ? { aadObjectId: "OBJECT-ID" } : {}),
        },
        recipient: { id: "bot", name: "Bot" },
        conversation: {
          id: "conversation",
          conversationType: "personal",
          ...(kind === "entra" ? { tenantId: "TENANT" } : {}),
        },
      };
      const result = await resolveMSTeamsSenderAccess({
        cfg: {
          channels: {
            msteams: {
              dmPolicy: "open",
              allowFrom: ["*"],
              ...(kind === "application" ? { appId: "APP" } : {}),
            },
          },
        },
        activity,
      });
      expect(result.senderAccess.allowed).toBe(true);
      const input = observed.mock.calls[0]?.[0];
      expect(input?.identity?.resolveParticipant?.(input.subject)).toEqual(
        kind === "entra"
          ? { domain: "entra:tenant", idKind: "object-id", id: "object-id" }
          : kind === "application"
            ? { domain: "bot:app", idKind: "channel-account-id", id: "opaque-account" }
            : undefined,
      );
    },
  );
});
