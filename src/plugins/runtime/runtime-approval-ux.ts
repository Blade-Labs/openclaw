import type { PluginApprovalUX } from "./types-approval-ux.js";

/** Never substitute requested OAuth scopes, transport URLs, or log redaction for host proof. */
export function createRuntimeApprovalUX(): PluginApprovalUX {
  return Object.freeze({
    awaitsResolution: true,
    scopedDecisions: true,
    // MCP connection config/resolvers have no verified installation or effective
    // access scope, so even an authenticated owner DM lacks the required tuple.
    identity: () => null,
    githubRead: async () => {
      throw new Error(
        "Approval GitHub reads unavailable: verified installation/access scope missing",
      );
    },
    maskDisplay: async () => {
      throw new Error("Approval display masking unavailable: no host Disclosure integration");
    },
  });
}
