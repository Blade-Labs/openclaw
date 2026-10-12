---
summary: "Ask users to approve plugin tool calls and plugin-owned permission prompts"
title: "Plugin permission requests"
sidebarTitle: "Permission requests"
read_when:
  - You need a plugin hook or tool to ask before a side effect runs
  - You need to configure where plugin approval prompts are delivered
  - You are deciding between optional tools, exec approvals, and plugin approvals
---

Plugin permission requests let plugin code pause a tool call or plugin-owned
operation until a user approves or denies it. They use the Gateway
`plugin.approval.*` flow and the same approval UI surfaces that handle chat
approval buttons and `/approve` commands.

Use plugin permission requests for plugin/app permissions. They do not replace
host exec approvals, optional tool allowlists, or Codex's native permission
review.

## Choose the right gate

Pick the gate that matches the decision point you need:

| Gate                             | Use it when                                                              | What it controls                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Optional tools                   | A tool should not be visible to the model until the user opts in.        | Tool exposure through `tools.allow`.                                                                              |
| Plugin permission requests       | A plugin hook or plugin-owned operation must ask before one action runs. | Runtime approval through `plugin.approval.*`.                                                                     |
| Exec approvals                   | A host command or shell-like tool needs operator approval.               | Host exec policy and durable exec allowlists.                                                                     |
| Codex native permission requests | Codex asks before native shell, file, MCP, or app-server actions.        | Codex app-server or native hook approval handling, routed through plugin approvals when OpenClaw owns the prompt. |
| MCP approval elicitations        | A Codex MCP server requests approval for a tool call.                    | MCP approval responses bridged through OpenClaw plugin approvals.                                                 |

Optional tools are a discovery-time gate. Plugin permission requests are a
per-call gate. Use both when a sensitive tool should require explicit opt-in
before the model can see it and approval before the action runs.

## Request approval before a tool call

Most plugin-authored prompts should start in a `before_tool_call` hook. The hook
runs after the model selects a tool and before OpenClaw executes it:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "deploy-policy",
  name: "Deploy Policy",
  register(api) {
    api.on("before_tool_call", async (event) => {
      if (event.toolName !== "deploy_service") {
        return;
      }

      const environment =
        typeof event.params.environment === "string" ? event.params.environment : "unknown";

      return {
        requireApproval: {
          title: "Deploy service",
          description: `Deploy service to ${environment}.`,
          severity: environment === "production" ? "critical" : "warning",
          allowedDecisions:
            environment === "production" ? ["allow-once", "deny"] : ["allow-once", "deny"],
          timeoutMs: 120_000,
          onResolution(decision) {
            console.log(`deploy approval resolved: ${decision}`);
          },
        },
      };
    });
  },
});
```

Write prompt text for the person who will approve the action:

- Keep `title` short and action-focused. The Gateway caps it at 80 characters.
- Keep `description` specific and bounded. The Gateway caps the sanitized description at 4,096 Unicode code points and rejects overflow rather than truncating it.
- Include the action, target, and risk. Do not include secrets, tokens, or
  private payloads that should not appear in chat approval surfaces.
- `severity` defaults to `"warning"` when omitted. Use `"critical"` only for
  actions where the wrong decision could cause production damage or data loss.
- Ordinary plugin requests offer `allow-once` and `deny`. A trusted plugin may mark an exact delegation with `grantEligible: true` and `grantScopeSummary`; only then does the host offer all five choices described below.
- `timeoutMs` defaults to 120000 (2 minutes) and is capped at 600000 (10
  minutes) regardless of the requested value.

## Declare approval scope

Set `requireApproval.scope` when your plugin knows the consequences of an
operation. Scope is typed, optional, and display-only: it helps reviewers
understand the action but never grants permission or changes the approval
decision. The plugin declaring the approval supplies these facts. Channels never
infer scope from commands, titles, or message text.

For an email to three external recipients, include the destination, total
recipient count, an optional preview, and the audience:

```typescript
requireApproval: {
  title: "Send customer update",
  scope: {
    kind: "message-send",
    target: "email",
    recipientCount: 3,
    recipients: ["alice@example.com", "bob@example.com"],
    audience: "external",
  },
}
```

For a payment, provide the exact decimal amount as a string, its currency, and
the payee or payment system:

```typescript
requireApproval: {
  title: "Pay invoice",
  scope: {
    kind: "payment",
    amount: "49.99",
    currency: "EUR",
    target: "Stripe",
  },
}
```

For an external post, identify its destination and declare its visibility:

```typescript
requireApproval: {
  title: "Publish announcement",
  scope: {
    kind: "external-post",
    target: "github",
    visibility: "public",
  },
}
```

Message audiences can be `internal` or `external`. External-post visibility can
be `public` or `restricted`. Recipient previews contain at most five identities.
All strings are sanitized and bounded before display: targets and recipient
identities are limited to 128 characters, payment amounts to 40, and currencies
to 12. If sanitization would exceed a bound, OpenClaw omits the scope while
preserving the normal approval prompt.

## Decision behavior

OpenClaw creates a pending approval with a `plugin:` ID, delivers it to the
available approval surfaces, and waits for a decision.

| Decision          | Result                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `allow-once`      | The current call continues.                                               |
| `allow-always`    | The current call continues and the decision is passed to the plugin.      |
| `deny`            | The call is blocked with a denied tool result.                            |
| Timeout           | The call is blocked.                                                      |
| Cancellation      | The call is blocked when the run is aborted.                              |
| No approval route | The call is blocked because no connected approval surface can resolve it. |

Only an exact offered allow decision permits execution. Unknown, malformed, mismatched, missing, and timed-out
decisions fail closed. The legacy `timeoutBehavior` field remains accepted for
plugin compatibility but is deprecated and ignored. Do not set it in new hooks.

`allow-always` is only durable when the requesting plugin or runtime implements
that persistence. For ordinary `before_tool_call.requireApproval` hooks,
OpenClaw treats the offered allow choices as approval decisions for the
current call and passes the resolved value to `onResolution`. If your plugin
offers `allow-always`, document and implement exactly what future calls it
trusts.

If the hook also returns `params`, OpenClaw snapshots the base parameters and
those overrides when approval is requested, then applies the overrides only
after approval succeeds. A lower-priority hook can still block, but cannot
rewrite the parameters covered by the pending approval.

`allowedDecisions` limits the buttons and commands shown to the user. The
Gateway rejects a resolve attempt for any decision the request did not offer.

## Scoped decisions and receipts

For a request eligible for plugin-owned grants, set `grantEligible: true` and
`grantScopeSummary` on `requireApproval`. The summary describes the exact scope
and tells the reviewer whether later values may differ. These fields come from
the registered hook, never model parameters. Public Gateway requests cannot
mark a request eligible without the signed plugin owner.

Eligible requests offer `allow-once`, `allow-15m`, `allow-session`, `allow-always`,
and `deny`. Every surface offering reusable consent displays the sanitized
`grantScopeSummary` alongside the current operation. The host carries the chosen decision through storage, resolution,
and one-use execution redemption. The plugin owns creating, matching, expiring,
and revoking any reusable grant. Scoped decisions never mint a generic MCP
grant. Native MCP and placement approvals keep their separate bound contracts.
The legacy three-choice exception requires a host-authenticated native permission
callback, live MCP binding, or placement binding. Merely listing the three legacy
choices or omitting `grantEligible` does not establish that contract. Public
Gateway RPC requests and ordinary plugin requests offer only `allow-once` and
`deny`; ordinary `before_tool_call.requireApproval` hooks send `grantEligible: false`
by default.
Native owners should retain their current matching and removal lifecycle; new
plugin delegations use the scoped contract above.
Requester matching, approver rosters, and live run authority remain required.

Native CLI shell callbacks retain their 512-code-point escaped summary limit and
never offer Always for Bash; the larger plugin description budget does not widen
native shell approval policy.

The iOS native plugin prompt accepts five-choice snapshots and displays their
delegation summary, but offers only **Allow Once** and **Deny**. When reusable
choices are available, it explains this limit and offers **Review in Dashboard**
under the current operator authority. The Dashboard owns the full five-choice
review. Native plugin actions cannot submit reusable decisions, including from
restored prompts or notification actions. A decision recorded on another surface
still closes the native prompt and reports its recorded outcome. Exec approvals
retain their separate three-choice native contract.

`onResolution(decision, receipt)` keeps the existing first argument. The optional
second argument contains host evidence:

```typescript
{
  approvalId: string;
  decision: "allow-once" | "allow-15m" | "allow-session" | "allow-always" | "deny" | null;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  resolvedByActor?: ApprovalResolvingActor | null;
  terminalReason?: ApprovalTerminalReason | null;
}
```

The host copies these facts from the matching request/wait response. A failure before a request ID exists has no receipt. A known no-route record
retains its ID and available timestamps without inventing a resolver or success. A receipt records consent; it does not prove that the
tool completed. Existing one-argument callbacks continue to work.

## Route approval prompts

Approval prompts can resolve in local UI surfaces or in chat channels that
support approval handling. To forward plugin approval prompts to explicit chat
targets, configure `approvals.plugin`:

```json5
{
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      agentFilter: ["main"],
      targets: [{ channel: "slack", to: "U12345678" }],
    },
  },
}
```

`approvals.plugin` is independent from `approvals.exec`. Enabling exec approval
forwarding does not route plugin approval prompts, and enabling plugin approval
forwarding does not change host exec policy.

When a prompt includes manual approval text, resolve it with one of the offered
decisions:

```text
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

See [Advanced exec approvals](/tools/exec-approvals-advanced#plugin-approval-forwarding)
for the full forwarding model, same-chat approval behavior, native channel
delivery, and channel-specific approver rules.

## Codex native permissions

Codex native permission prompts can also travel through plugin approvals, but
they have different ownership than plugin-authored hooks.

- Codex app-server approval requests route through OpenClaw after Codex review.
- The native hook `permission_request` relay can ask through
  `plugin.approval.request` when that relay is enabled.
- MCP tool approval elicitations route through plugin approvals when Codex marks
  `_meta.codex_approval_kind` as `"mcp_tool_call"`.

See [Codex harness runtime](/plugins/codex-harness-runtime#native-permissions-and-mcp-elicitations)
for the Codex-specific behavior and fallback rules.

## Troubleshooting

**The tool says plugin approvals are unavailable.** No approval UI or configured
approval route accepted the request. Connect an approval-capable client, use a
channel that supports same-chat `/approve`, or configure `approvals.plugin`.

**`allow-always` appears but the next call prompts again.** The generic plugin
approval flow does not automatically persist trust for arbitrary hooks. Persist
plugin-owned trust in your plugin after `onResolution("allow-always")`, or
offer only `allow-once` and `deny`.

**`/approve` rejects the decision.** The request restricted
`allowedDecisions`. Use one of the decisions printed in the prompt.

**A Discord, Matrix, Slack, or Telegram prompt routes differently from exec
approvals.** Plugin approvals and exec approvals use separate config and may use
different authorization checks. Verify `approvals.plugin` and the channel's
plugin approval support instead of only checking `approvals.exec`.

## Related

- [Plugin hooks](/plugins/hooks/tool-policy#tool-call-policy)
- [Building plugins](/plugins/building-plugins#registering-tools)
- [Advanced exec approvals](/tools/exec-approvals-advanced#plugin-approval-forwarding)
- [Gateway protocol](/gateway/protocol)
- [Codex harness runtime](/plugins/codex-harness-runtime#native-permissions-and-mcp-elicitations)
