import { describe, expect, it, vi } from "vitest";
import type { PluginHookBeforePromptBuildEvent } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";

const promptEvent = (prompt: string) => ({ prompt, messages: [] });

describe("before_prompt_build reentrancy", () => {
  it.each([false, true])(
    "preserves trusted evidence presence=%s across modifying plugins",
    async (present) => {
      const historyEvidence = {
        boundary: { id: "committed-reset", reason: "new" as const, actorId: "owner", seq: 1 },
        complete: false,
        turnsSinceBoundary: 2,
        currentEntry: { id: "current", isLastEntry: true, seq: 2 },
      };
      const observer = vi.fn((_event: PluginHookBeforePromptBuildEvent) => ({}));
      const mutations: boolean[] = [];
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_prompt_build",
            pluginId: "mutator",
            priority: 10,
            handler: (...args: unknown[]) => {
              const event = args[0] as PluginHookBeforePromptBuildEvent;
              if (present) {
                mutations.push(
                  Reflect.set(event.historyEvidence!, "complete", true),
                  Reflect.set(event.historyEvidence!.boundary!, "id", "forged"),
                  Reflect.set(event.historyEvidence!.currentEntry!, "id", "forged"),
                  Reflect.set(event, "historyEvidence", { complete: true }),
                  Reflect.deleteProperty(event, "historyEvidence"),
                );
              } else {
                Reflect.set(event, "historyEvidence", historyEvidence);
              }
              event.messages.push("shared message mutation");
              return {};
            },
          },
          {
            hookName: "before_prompt_build",
            pluginId: "observer",
            handler: (...args: unknown[]) => observer(args[0] as PluginHookBeforePromptBuildEvent),
          },
        ]),
      );
      await runner.runBeforePromptBuild(
        { ...promptEvent("hello"), ...(present ? { historyEvidence } : {}) },
        TEST_PLUGIN_AGENT_CTX,
      );
      expect(observer).toHaveBeenCalledOnce();
      const event = observer.mock.calls[0]![0];
      if (present) {
        expect(mutations).toEqual([false, false, false, false, false]);
        expect(event.historyEvidence).toEqual({ complete: false, turnsSinceBoundary: null });
      } else {
        expect(event).not.toHaveProperty("historyEvidence");
      }
      expect(event.messages).toEqual(["shared message mutation"]);
    },
  );
  it.each(["remove", "nested edit"])(
    "drops affirmative evidence after an earlier hook changes messages: %s",
    async (mutation) => {
      const evidence = {
        boundary: { id: "reset", reason: "new" as const, actorId: "owner", seq: 1 },
        complete: true,
        messagesDigest: "caller-forged-digest",
        turnsSinceBoundary: 1,
        currentEntry: { id: "current", isLastEntry: true, seq: 2 },
      };
      const observed: PluginHookBeforePromptBuildEvent[] = [];
      const originalMessages = [{ role: "user", content: [{ type: "text", text: "ask" }] }];
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_prompt_build",
            pluginId: "mutator",
            priority: 10,
            handler: (...args: unknown[]) => {
              const event = args[0] as PluginHookBeforePromptBuildEvent;
              observed.push(structuredClone(event));
              if (mutation === "remove") {
                event.messages.splice(0, 1);
              } else {
                (event.messages[0] as (typeof originalMessages)[0]).content[0]!.text = "changed";
              }
              return {};
            },
          },
          {
            hookName: "before_prompt_build",
            pluginId: "observer",
            handler: (...args: unknown[]) => {
              observed.push(structuredClone(args[0] as PluginHookBeforePromptBuildEvent));
              return {};
            },
          },
        ]),
      );
      await runner.runBeforePromptBuild(
        { prompt: "ask", messages: originalMessages, historyEvidence: evidence },
        TEST_PLUGIN_AGENT_CTX,
      );
      expect(observed).toHaveLength(2);
      expect(observed[0]?.historyEvidence).toEqual({
        ...evidence,
        messagesDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(observed[1]?.historyEvidence).toEqual({ complete: false, turnsSinceBoundary: null });
      expect(originalMessages[0]?.content[0]?.text).toBe("ask");
      expect(originalMessages).toHaveLength(1);
    },
  );
  it("runs each handler once when a handler starts a nested prompt build", async () => {
    const firstHandler = vi.fn(async () => {
      await runner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return { prependContext: "first" };
    });
    const secondHandler = vi.fn(() => ({ appendContext: "second" }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: firstHandler,
          pluginId: "first",
          priority: 10,
        },
        {
          hookName: "before_prompt_build",
          handler: secondHandler,
          pluginId: "second",
          priority: 1,
        },
      ]),
    );

    await expect(
      runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX),
    ).resolves.toEqual({
      systemPrompt: undefined,
      prependContext: "first",
      appendContext: "second",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("keeps sibling hook families and other runners active during dispatch", async () => {
    const turnPrepare = vi.fn(() => ({ prependContext: "turn" }));
    const heartbeat = vi.fn(() => ({ appendContext: "heartbeat" }));
    const otherPromptBuild = vi.fn(() => ({ prependContext: "other runner" }));
    const otherRunner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: otherPromptBuild,
          pluginId: "other",
        },
      ]),
    );
    const promptBuild = vi.fn(async () => {
      await runner.runAgentTurnPrepare(
        { prompt: "nested", messages: [], queuedInjections: [] },
        TEST_PLUGIN_AGENT_CTX,
      );
      await runner.runHeartbeatPromptContribution(
        { heartbeatName: "heartbeat" },
        TEST_PLUGIN_AGENT_CTX,
      );
      await otherRunner.runBeforePromptBuild(promptEvent("nested"), TEST_PLUGIN_AGENT_CTX);
      return {};
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: promptBuild,
          pluginId: "prompt",
        },
        {
          hookName: "agent_turn_prepare",
          handler: turnPrepare,
          pluginId: "turn",
        },
        {
          hookName: "heartbeat_prompt_contribution",
          handler: heartbeat,
          pluginId: "heartbeat",
        },
      ]),
    );

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);

    expect(promptBuild).toHaveBeenCalledOnce();
    expect(turnPrepare).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(otherPromptBuild).toHaveBeenCalledOnce();
  });

  it("allows detached descendants to dispatch after the outer call settles", async () => {
    let releaseDetached: (() => void) | undefined;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedDispatch: Promise<unknown> | undefined;
    const promptBuild = vi.fn(async (event: unknown) => {
      const prompt = (event as { prompt: string }).prompt;
      if (prompt === "outer") {
        detachedDispatch = (async () => {
          await detachedGate;
          return await runner.runBeforePromptBuild(promptEvent("detached"), TEST_PLUGIN_AGENT_CTX);
        })();
      }
      return { prependContext: prompt };
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: promptBuild,
          pluginId: "prompt",
        },
      ]),
    );

    await runner.runBeforePromptBuild(promptEvent("outer"), TEST_PLUGIN_AGENT_CTX);
    releaseDetached?.();
    const pendingDetachedDispatch = detachedDispatch;
    if (!pendingDetachedDispatch) {
      throw new Error("detached prompt dispatch was not created");
    }
    await expect(pendingDetachedDispatch).resolves.toEqual({
      systemPrompt: undefined,
      prependContext: "detached",
      appendContext: undefined,
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
    expect(promptBuild).toHaveBeenCalledTimes(2);
  });
});
