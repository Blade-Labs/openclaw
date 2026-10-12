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
        nativeApproval: true,
      }),
    ).toEqual(["allow-once", "allow-always", "deny"]);
  });
  it("requires host native provenance for legacy three-choice callbacks", () => {
    const explicit = { allowedDecisions: ["allow-once", "allow-always", "deny"] as const };
    expect(resolveCanonicalPluginApprovalRequestAllowedDecisions(explicit)).toEqual([
      "allow-once",
      "deny",
    ]);
    expect(
      resolveCanonicalPluginApprovalRequestAllowedDecisions({
        ...explicit,
        mcpTool: { server: "synthetic", tool: "write" },
      }),
    ).toEqual(["allow-once", "deny"]);
    const native = { ...explicit, nativeApproval: true as const };
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
        nativeApproval: true,
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
