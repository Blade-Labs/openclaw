// Microsoft Teams ingress attributes a live callback only to the payload it actually stored.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsIngress } from "./msteams-ingress.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type IngressQueue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
type IngressPayload = Parameters<IngressQueue["enqueue"]>[1];
type IngressDispatch = Parameters<typeof createMSTeamsIngress>[0]["dispatch"];
type Delivered = {
  text?: string;
  liveContext?: MSTeamsTurnContext;
  facts?: Parameters<IngressDispatch>[3];
};

function activity(text: string): MSTeamsTurnContext["activity"] {
  return {
    id: "activity-provenance",
    type: "message",
    text,
    from: { id: "29:sender", aadObjectId: "40a1a0ed-4ff2-4164-a219-55518990c197" },
    recipient: { id: "bot-1" },
    conversation: { id: "a:1personal", conversationType: "personal" },
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
  } as MSTeamsTurnContext["activity"];
}

function liveContext(live: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return {
    activity: live,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
  } as unknown as MSTeamsTurnContext;
}

async function withQueue<T>(fn: (queue: IngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-ingress-prov-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<IngressPayload>({
    channelId: "msteams",
    accountId: "app-id",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function ingressRecording(queue: IngressQueue) {
  const delivered = createDeferred<Delivered>();
  const ingress = createMSTeamsIngress({
    accountId: "app-id",
    queue,
    runtime: { error: vi.fn(), log: vi.fn() },
    dispatch: async (journaled, lifecycle, live, facts) => {
      await lifecycle.onAdopted();
      delivered.resolve({ text: journaled.text, liveContext: live, facts });
    },
  });
  return { ingress, delivered: delivered.promise };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("Microsoft Teams ingress live-callback attribution", () => {
  it("attributes the live callback to the row it created", async () => {
    await withQueue(async (queue) => {
      const { ingress, delivered } = ingressRecording(queue);
      const live = activity("validated payload");
      const context = liveContext(live);
      ingress.start();
      try {
        await ingress.accept(live, context);
        const result = await delivered;
        expect(result.text).toBe("validated payload");
        expect(result.liveContext).toBe(context);
        expect(result.facts).toEqual({ payloadMatchesLiveCallback: true });
      } finally {
        await ingress.stop();
      }
    });
  });

  it("does not attribute a redelivery's live callback to an older retained row", async () => {
    await withQueue(async (queue) => {
      const { ingress, delivered } = ingressRecording(queue);
      // A retained pending row with this id existed before the validated callback arrived.
      await ingress.accept(activity("old unvalidated payload"));
      const live = activity("new validated payload");
      const context = liveContext(live);
      await ingress.accept(live, context);
      ingress.start();
      try {
        const result = await delivered;
        expect(result.text).toBe("old unvalidated payload");
        expect(result.liveContext).toBe(context);
        expect(result.facts).toEqual({ payloadMatchesLiveCallback: false });
      } finally {
        await ingress.stop();
      }
    });
  });
});
