import type { PluginHookToolContext } from "../hook-types.js";
import type { PluginJsonValue } from "../host-hooks.js";

export type AuthenticatedApprovalIdentity = Readonly<{
  owner: true;
  ownerId: string;
  agentId: string;
  channel: "msteams";
  conversationKind: "direct";
  trigger: "user";
  accountId: string;
  dmId: string;
  sessionId: string;
  installationId: string;
  accessScope: string;
  bootId: string;
  subagent?: false;
}>;

export type ApprovalGitHubReadRequest = {
  tool: "projects_get" | "projects_list" | "issue_read";
  params: Record<string, unknown>;
  installationId: string;
  accessScope: string;
};

type ApprovalGitHubIssue = {
  id?: string | number;
  repository: string;
  number: number;
  title: string;
  labels?: string[];
};

export type ApprovalGitHubFacts =
  | { id: string; title: string; owner: string; number: number }
  | {
      id: string | number;
      projectId: string;
      repository: string;
      content: ApprovalGitHubIssue;
      fieldValues?: Record<string, PluginJsonValue>;
    }
  | {
      projectId: string;
      fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
    }
  | ApprovalGitHubIssue;

/** Qualification flags describe approval plumbing, not availability of identity or grants. */
export type PluginApprovalUX = Readonly<{
  awaitsResolution: true;
  scopedDecisions: true;
  identity: (ctx: PluginHookToolContext) => AuthenticatedApprovalIdentity | null;
  githubRead: (
    request: ApprovalGitHubReadRequest,
    ctx: PluginHookToolContext,
  ) => Promise<ApprovalGitHubFacts>;
  maskDisplay: <T extends PluginJsonValue>(value: T, ctx: PluginHookToolContext) => Promise<T>;
  /** Absent until storage can commit synchronously with qualified agent confinement. */
  grantStorage?: {
    transaction: <T>(
      update: (state: { grants: PluginJsonValue[]; audit: PluginJsonValue[] }) => T,
    ) => T;
  };
}>;
