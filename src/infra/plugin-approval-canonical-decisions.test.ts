import { describe, expect, it } from "vitest";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import { resolvePluginApprovalRequestAllowedDecisions } from "./plugin-approvals.js";

describe("plugin approval decisions", () => {
  it("offers reusable choices only for a scoped Policy declaration", () => {
    const all = ["allow-once", "allow-15m", "allow-session", "allow-always", "deny"] as const;
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        allowedDecisions: all,
        grantEligible: false,
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        grantEligible: true,
        grantScopeSummary: "",
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        grantEligible: true,
        grantScopeSummary: "Project 4 approved fields; future values may differ.",
      }),
    ).toEqual(all);
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        mcpTool: { server: "synthetic", tool: "write" },
      }),
    ).toEqual(["allow-once", "allow-always", "deny"]);
  });
  it("retains explicit legacy three-choice callbacks only when eligibility is unset", () => {
    const native = { allowedDecisions: ["allow-once", "allow-always", "deny"] as const };
    expect(resolveCanonicalPluginApprovalRequestAllowedDecisions(native)).toEqual(
      native.allowedDecisions,
    );
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({ ...native, grantEligible: false }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        ...native,
        allowedDecisions: ["allow-15m", "allow-session", "deny"],
      }),
    ).toEqual(["deny"]);
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        ...native,
        grantEligible: true,
        mcpTool: { server: "synthetic", tool: "write" },
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        ...native,
        allowedDecisions: ["allow-once", "allow-15m", "allow-session", "allow-always", "deny"],
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(resolveCanonicalPluginApprovalRequestAllowedDecisions()).toEqual(["allow-once", "deny"]);
  });

  it("preserves the shipped explicit list while canonical decisions add deny", () => {
    const request = { allowedDecisions: ["allow-once"] as const };

    const legacyDecisions = resolvePluginApprovalRequestAllowedDecisions(request);
    expect(legacyDecisions).toEqual(["allow-once"]);
    expect(legacyDecisions.includes("deny")).toBe(false);
    expect(resolveCanonicalPluginApprovalRequestAllowedDecisions(request)).toEqual([
      "allow-once",
      "deny",
    ]);
  });
});
