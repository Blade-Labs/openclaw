import { describe, expect, it } from "vitest";
import { validatePluginApprovalRequestParams } from "./index.js";

const nullableMetadataFields = [
  "pluginId",
  "detail",
  "severity",
  "scope",
  "toolName",
  "toolCallId",
  "allowedDecisions",
  "agentId",
  "sessionKey",
  "approvalReviewerDeviceIds",
  "turnSourceChannel",
  "turnSourceTo",
  "turnSourceAccountId",
  "turnSourceThreadId",
] as const;

describe("plugin approval protocol validators", () => {
  it("validates bounded reviewer-only detail independently from the description", () => {
    const request = {
      title: "Apply workspace skill proposal",
      description: "d".repeat(4_096),
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "full tool input" })).toBe(
      true,
    );
    expect(validatePluginApprovalRequestParams({ ...request, detail: "" })).toBe(false);
    expect(validatePluginApprovalRequestParams({ ...request, detail: "x".repeat(16_385) })).toBe(
      false,
    );
    expect(
      validatePluginApprovalRequestParams({ ...request, description: "d".repeat(4_097) }),
    ).toBe(false);
  });

  it.each(["x", "🛡️", "🚀"])("counts Unicode code points for %s descriptions", (text) => {
    const unit = Array.from(text)[0]!;
    expect(
      validatePluginApprovalRequestParams({ title: "Batch", description: unit.repeat(4_096) }),
    ).toBe(true);
    expect(
      validatePluginApprovalRequestParams({ title: "Batch", description: unit.repeat(4_097) }),
    ).toBe(false);
    expect(
      validatePluginApprovalRequestParams({ title: "Batch", description: unit.repeat(513) }),
    ).toBe(true);
  });

  it.each(nullableMetadataFields)("accepts explicit null for optional %s metadata", (field) => {
    expect(
      validatePluginApprovalRequestParams({
        title: "Apply workspace skill proposal",
        description: "Apply the pending proposal",
        [field]: null,
      }),
    ).toBe(true);
  });
});
