import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureAdmittedRunSource,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { withRequesterApprovalChannel } from "../../gateway/approval-requester.test-support.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { classifyApprovalRequester } from "../../infra/approval-requester-binding.js";
import {
  createHostChannelTurnSource,
  projectHostTurnSource,
  readHostTurnSource,
} from "../../infra/host-turn-source.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { appendTranscriptMessage, upsertSessionEntryCore } from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  claimSessionPendingInputDedupeRecovery,
  readSessionPendingInputTurnSource,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("accepted input source custody", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-source-");
  const sessionKey = "agent:main:synthetic-pending";
  const sessionId = "synthetic-pending-session";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const admitSource = (strict: boolean) =>
    createHostChannelTurnSource({
      actor: {
        channel: "test",
        accountId: "default",
        senderId: "synthetic-sender",
        actorKind: "human",
      },
      message: {
        messageId: "synthetic-message",
        conversationId: "synthetic-dm",
        conversationKind: "direct",
        eventKind: "message",
      },
      ...(strict
        ? {
            policy: {
              requireResolverMatch: true as const,
              delivery: "requester" as const,
              allowedDecisions: ["allow-once", "deny"] as const,
            },
          }
        : {}),
    });
  const stage = async (
    runId: string,
    options: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
  ) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      message: {
        role: "user",
        content: "Synthetic request",
        timestamp: 100,
        idempotencyKey: `${runId}:user`,
      },
      assertCurrent: () => {},
      ...options,
    });
    if (!receipt) {
      throw new Error("Expected a pending receipt");
    }
    receipts.push(receipt);
    return receipt;
  };
  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });

  it.each(
    [false, true].flatMap((strict) =>
      (["valid", "legacy-null", "corrupt"] as const).map((retained) => ({ strict, retained })),
    ),
  )(
    "restores retained source through fresh admission (strict=$strict, retained=$retained)",
    async ({ strict, retained }) => {
      const turnSource = admitSource(strict);
      const original = await stage("source-run", {
        turnSource,
        requestFingerprint: "synthetic-fingerprint",
      });
      original.finish("interrupted");
      rotateAgentEventLifecycleGeneration();
      if (retained !== "valid") {
        database()
          .db.prepare(
            "UPDATE session_pending_inputs SET source_provenance_json = ? WHERE input_id = ?",
          )
          .run(retained === "corrupt" ? "invalid-source-envelope" : null, original.inputId);
      }
      const replaySource = admitSource(!strict);
      expect(projectHostTurnSource(replaySource, null, null).inputs).not.toEqual(
        projectHostTurnSource(turnSource, null, null).inputs,
      );
      const recovered = await stage("source-run", {
        requestFingerprint: "synthetic-fingerprint",
        turnSource: replaySource,
      });
      expect(recovered.inputId).toBe(original.inputId);
      expect(
        recovered.run(() => claimSessionPendingInputDedupeRecovery(scope(), "source-run")),
      ).toBe(true);
      expect(readSessionPendingInputTurnSource({ ...recovered })).toBeUndefined();
      const restored = readSessionPendingInputTurnSource(recovered);
      expect(readHostTurnSource(restored).requireResolverMatch).toBe(
        retained === "valid" ? strict : retained === "corrupt",
      );
      const projection = projectHostTurnSource(restored, "synthetic-new-run", sessionKey);
      expect(classifyApprovalRequester(projection).state).toBe(
        retained === "valid" ? "bound" : "unavailable",
      );
      if (retained === "valid") {
        expect(projection.inputs).toEqual(projectHostTurnSource(turnSource, null, null).inputs);
        let currentStrict = !strict;
        await withRequesterApprovalChannel(
          async () => {
            const runId = "synthetic-recovered-policy";
            const admission = prepareAgentRunAdmission({
              cfg: {},
              facts: {
                runId,
                agentId: "main",
                ingress: { kind: "system", boundary: "synthetic-recovery", state: "present" },
              },
              operationalRunInstance: createOperationalRunInstanceRef(runId),
              sessionKey,
              turnSource: restored,
            });
            try {
              const admitted = await admission.admit("plugin-harness");
              expect(captureAdmittedRunSource(admitted).requireResolverMatch).toBe(true);
              currentStrict = false;
              expect(captureAdmittedRunSource(admitted).requireResolverMatch).toBe(true);
              expect(captureAdmittedRunSource(admitted).source.inputs).toEqual(projection.inputs);
            } finally {
              admission.close();
            }
          },
          { strict: () => currentStrict },
        );
        await expect(
          stage("source-run", {
            requestFingerprint: "synthetic-fingerprint",
            turnSource: createHostChannelTurnSource({
              actor: {
                channel: "test",
                accountId: "default",
                senderId: "synthetic-other",
                actorKind: "human",
              },
            }),
          }),
        ).rejects.toThrow("conflicts with the accepted source");
      } else {
        expect(projection.inputs).toEqual([]);
        expect(
          database()
            .db.prepare(
              "SELECT source_provenance_json FROM session_pending_inputs WHERE input_id = ?",
            )
            .get(original.inputId),
        ).toEqual({
          source_provenance_json: retained === "corrupt" ? "invalid-source-envelope" : null,
        });
      }
      expect(recovered.message).not.toHaveProperty("source");
      recovered.finish("interrupted");
      expect(() => readSessionPendingInputTurnSource(recovered)).toThrow("ownership ended");
    },
  );

  it.each(
    [false, true].flatMap((strict) =>
      (["valid", "legacy-null", "corrupt"] as const).map((retained) => ({ strict, retained })),
    ),
  )(
    "deduplicates consumed input with fresh source (strict=$strict, retained=$retained)",
    async ({ strict, retained }) => {
      const original = await stage("consumed-source-run", { turnSource: admitSource(strict) });
      const collected = bindSessionPendingInputSources([original], {
        ...original.message,
        idempotencyKey: "synthetic-collected:user",
      });
      if (!collected) {
        throw new Error("Expected a collected receipt");
      }
      expect(
        await collected.run(() => appendTranscriptMessage(scope(), { message: collected.message })),
      ).toMatchObject({ appended: true });
      original.finish("interrupted");
      rotateAgentEventLifecycleGeneration();
      if (retained !== "valid") {
        database()
          .db.prepare(
            "UPDATE session_pending_inputs SET source_provenance_json = ? WHERE input_id = ?",
          )
          .run(retained === "corrupt" ? "invalid-source-envelope" : null, original.inputId);
      }
      const replay = await stage("consumed-source-run", { turnSource: admitSource(!strict) });
      expect(replay).toMatchObject({
        state: "consumed",
        inputId: original.inputId,
        message: original.message,
      });
      expect(() => replay.run(() => {})).toThrow("already been consumed");
      expect(readSessionPendingInputTurnSource(replay)).toBeUndefined();
    },
  );
});
