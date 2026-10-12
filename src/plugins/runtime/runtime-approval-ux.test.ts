import { describe, expect, it } from "vitest";
import type { PluginHookToolContext } from "../hook-types.js";
import { createRuntimeBase } from "./runtime-base.js";

describe("public approval UX host port without qualified integrations", () => {
  const ctx: PluginHookToolContext = {
    agentId: "main",
    sessionId: "synthetic-session",
    sessionKey: "agent:main:msteams:direct:synthetic-owner",
    runId: "synthetic-run",
    toolName: "projects_write",
    requester: {
      channel: "msteams",
      accountId: "default",
      senderId: "synthetic-owner",
      senderIsOwner: true,
    },
    source: {
      version: 1,
      runId: "synthetic-run",
      sessionKey: "agent:main:msteams:direct:synthetic-owner",
      revision: 1,
      completeness: "complete",
      inputs: [
        {
          inputId: "synthetic-input",
          origin: "user",
          actor: {
            channel: "msteams",
            accountId: "default",
            senderId: "synthetic-owner",
            actorKind: "human",
          },
          message: {
            messageId: "synthetic-message",
            conversationId: "synthetic-dm",
            conversationKind: "direct",
            eventKind: "message",
          },
        },
      ],
    },
  };

  it("publishes qualified decision plumbing without fabricating authenticated installation facts or storage", () => {
    const port = createRuntimeBase().approvalUX;
    expect(port.awaitsResolution).toBe(true);
    expect(port.scopedDecisions).toBe(true);
    expect(port.identity(ctx)).toBeNull();
    expect(port.identity({ toolName: "projects_write" })).toBeNull();
    expect(port.identity({ ...ctx, source: undefined })).toBeNull();
    expect(
      port.identity({
        ...ctx,
        source: { ...ctx.source!, inputs: [{ inputId: "child", origin: "subagent" }] },
      }),
    ).toBeNull();
    expect(
      port.identity({
        ...ctx,
        source: {
          ...ctx.source!,
          inputs: [
            {
              inputId: "group",
              origin: "user",
              actor: {
                channel: "msteams",
                accountId: "default",
                senderId: "synthetic-owner",
                actorKind: "human",
              },
              message: {
                messageId: "synthetic-message",
                conversationId: "synthetic-group",
                conversationKind: "group",
                eventKind: "message",
              },
            },
          ],
        },
      }),
    ).toBeNull();
    expect(port).not.toHaveProperty("grantStorage");
    expect(port).not.toHaveProperty("grantStoragePath");
  });

  it("refuses reads without verified GitHub connection facts", async () => {
    const port = createRuntimeBase().approvalUX;
    await expect(
      port.githubRead(
        {
          tool: "projects_get",
          params: { method: "get_project", owner: "synthetic-owner", project_number: 4 },
          installationId: "model-supplied",
          accessScope: "model-supplied",
        },
        ctx,
      ),
    ).rejects.toThrow("verified installation/access scope missing");
  });

  it("refuses display preparation when Disclosure is unavailable", async () => {
    const value = {
      title: "Synthetic title",
      values: ["first", 4, null],
      nested: { private: "Synthetic value" },
    };
    await expect(createRuntimeBase().approvalUX.maskDisplay(value, ctx)).rejects.toThrow(
      "no host Disclosure integration",
    );
    expect(value.nested.private).toBe("Synthetic value");
  });
});
