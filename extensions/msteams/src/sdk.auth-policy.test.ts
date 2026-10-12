// Microsoft Teams production App pins Bot Framework JWT validation; provenance relies on it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMSTeamsAppJwtEnforced, loadMSTeamsSdkWithAuth } from "./sdk.js";
import type { MSTeamsCredentials } from "./token.js";

const privateQaRuntimeSymbol = Symbol.for("openclaw.msteams.privateQaRuntime");
const creds: MSTeamsCredentials = {
  type: "secret",
  appId: "test-app-id",
  appPassword: "test-secret",
  tenantId: "test-tenant",
};

type AuthorizingServer = {
  authorize: (
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ) => Promise<{ success: boolean }>;
};

function serverOf(app: unknown): AuthorizingServer {
  const server = (app as { server?: AuthorizingServer }).server;
  if (!server || typeof server.authorize !== "function") {
    throw new Error("expected Teams SDK HttpServer");
  }
  return server;
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as typeof globalThis & { [privateQaRuntimeSymbol]?: unknown })[
    privateQaRuntimeSymbol
  ];
});

describe("Microsoft Teams SDK authentication policy", () => {
  it("ignores the ambient DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS bypass in production", async () => {
    vi.stubEnv("DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS", "true");
    const { app } = await loadMSTeamsSdkWithAuth(creds);
    const result = await serverOf(app)
      .authorize(
        { authorization: "Bearer not-a-valid-jwt" },
        { type: "message", serviceUrl: "https://smba.trafficmanager.net/amer/" },
      )
      .catch(() => ({ success: false }));
    expect(result.success).toBe(false);
    expect(isMSTeamsAppJwtEnforced(app)).toBe(true);
  });

  it("does not report JWT enforcement for the private QA skipAuth runtime", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    (globalThis as typeof globalThis & { [privateQaRuntimeSymbol]?: unknown })[
      privateQaRuntimeSymbol
    ] = {
      connectorUrl: "http://127.0.0.1:43123/",
      nonce: "qa-nonce",
      botToken: "e30.e30.qa",
    };
    const { app } = await loadMSTeamsSdkWithAuth(creds);
    expect(isMSTeamsAppJwtEnforced(app)).toBe(false);
  });

  it("does not report JWT enforcement for an App it did not create", () => {
    expect(isMSTeamsAppJwtEnforced({} as never)).toBe(false);
  });
});
