// Msteams tests cover sdk proactive plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference,
} from "./sdk-proactive.js";
import type { MSTeamsApp } from "./sdk.js";

const clientState = vi.hoisted(() => ({
  created: [] as Array<{ serviceUrl: string; http: unknown }>,
  update: vi.fn(async (_conversationId: string, _activityId: string, _activity: unknown) => ({
    id: "card-activity",
  })),
  create: vi.fn(async (_payload: { conversationId: string; activity: unknown }) => ({
    id: "activity-1",
  })),
}));

vi.mock("@microsoft/teams.api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@microsoft/teams.api")>()),
  Client: vi.fn(function MockClient(this: unknown, serviceUrl: string, http: unknown) {
    clientState.created.push({ serviceUrl, http });
    return {
      serviceUrl,
      conversations: {
        activities: (conversationId: string) => ({
          update: (activityId: string, activity: unknown) =>
            clientState.update(conversationId, activityId, activity),
          create: (activity: unknown) =>
            clientState.create({
              conversationId,
              activity,
            }),
        }),
      },
    };
  }),
}));

describe("sendMSTeamsActivityWithReference", () => {
  beforeEach(() => {
    clientState.update.mockClear();
    clientState.created.length = 0;
    clientState.create.mockClear().mockResolvedValue({ id: "activity-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends a legacy bot-only imported reference instead of rejecting it", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    const app = {
      client: { request: vi.fn() },
      api: { serviceUrl: "https://smba.trafficmanager.net/teams" },
    } as unknown as MSTeamsApp;

    const result = await sendMSTeamsActivityWithReference(
      app,
      {
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        bot: { id: "28:legacy-bot", name: "OpenClaw" },
        user: { id: "29:user" },
        conversation: {
          id: "19:conversation@thread.tacv2",
          conversationType: "personal",
          tenantId: "tenant-1",
        },
        channelId: "msteams",
      },
      { type: "message", text: "hello" },
    );

    expect(result).toMatchObject({ id: "activity-1" });
    expect(clientState.create).toHaveBeenCalledTimes(1);
  });

  it("sends through a reference-scoped API client without the protected SDK activitySender", async () => {
    vi.stubEnv("SERVICE_URL", "https://bot.example.com/api/messages");
    const httpClient = { request: vi.fn() };
    const app = {
      client: httpClient,
      api: {
        serviceUrl: "https://smba.trafficmanager.net/teams",
        conversations: {
          activities: () => ({
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
          }),
        },
      },
    } as unknown as MSTeamsApp;

    const result = await sendMSTeamsActivityWithReference(
      app,
      {
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        agent: { id: "28:bot", name: "OpenClaw", role: "bot" },
        user: { id: "29:user", aadObjectId: "aad-user" },
        conversation: {
          id: "19:conversation@thread.tacv2",
          conversationType: "personal",
          tenantId: "tenant-1",
        },
        channelId: "msteams",
      },
      { type: "message", text: "hello" },
      { serviceUrlBoundary: { cloud: "Public" } },
    );

    expect(result).toMatchObject({ id: "activity-1" });
    expect(clientState.created).toEqual([
      {
        serviceUrl: "https://smba.trafficmanager.net/amer",
        http: httpClient,
      },
    ]);
    expect(clientState.create).toHaveBeenCalledWith({
      conversationId: "19:conversation@thread.tacv2",
      activity: expect.objectContaining({
        type: "message",
        text: "hello",
        from: { id: "28:bot", name: "OpenClaw", role: "bot" },
        conversation: {
          id: "19:conversation@thread.tacv2",
          conversationType: "personal",
          tenantId: "tenant-1",
        },
        channelData: { tenant: { id: "tenant-1" } },
      }),
    });
  });
  it("updates a channel-thread card by its original conversation and activity id", async () => {
    const app = {
      client: { request: vi.fn() },
      api: { serviceUrl: "https://smba.trafficmanager.net/teams" },
    } as unknown as MSTeamsApp;
    const conversationId = "19:channel@thread.tacv2";
    const reference = {
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      agent: { id: "28:bot" },
      conversation: { id: conversationId, conversationType: "channel" },
      channelId: "msteams",
    };
    const sent = await sendMSTeamsActivityWithReference(
      app,
      reference,
      { type: "message", attachments: [] },
      { threadActivityId: "root" },
    );
    expect(clientState.create).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: `${conversationId};messageid=root` }),
    );
    if (!sent.id) {
      throw new Error("Expected sent card activity id");
    }
    const terminal = {
      type: "message",
      id: sent.id,
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: { type: "AdaptiveCard", body: [] },
        },
      ],
    };
    await updateMSTeamsActivityWithReference(app, reference, sent.id, terminal);
    expect(clientState.update).toHaveBeenCalledWith(conversationId, sent.id, terminal);
  });
});
