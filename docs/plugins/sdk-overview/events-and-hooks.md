---
summary: "Typed lifecycle hooks and the decision rules each hook applies"
title: "Plugin SDK events and hook semantics"
sidebarTitle: "Events and hook semantics"
read_when:
  - You are subscribing to a typed lifecycle hook from a plugin
  - You need to know whether a hook result is terminal
  - You are projecting Gateway cron state into an external scheduler
---

The typed lifecycle hook registrars and the decision semantics core applies to
each hook result. Part of the [Plugin SDK overview](/plugins/sdk-overview).

## Events and lifecycle

| Method                                       | What it does                  |
| -------------------------------------------- | ----------------------------- |
| `api.on(hookName, handler, opts?)`           | Typed lifecycle hook          |
| `api.onConversationBindingResolved(handler)` | Conversation binding callback |

See [Plugin hooks](/plugins/hooks) for examples, common hook names, and guard
semantics.

## Admitted turn source

`PluginHookAgentContext.source` and `PluginHookToolContext.source` expose an
optional, read-only `TurnSourceProvenance` snapshot. Tool hooks, including
`before_tool_call` and `after_tool_call`, receive the source of the admitted
execution, including queued follow-up inputs. Its fields are:

- `version: 1`, `runId`, `sessionKey`, and `revision` identify the snapshot.
  `runId` and `sessionKey` can be `null` when unavailable.
- `completeness` is `complete` or `unavailable`.
- `inputs` records each `inputId` and `origin`: `user`, `system`,
  `cross-session`, `cron`, `heartbeat`, `subagent`, or `unknown`.
- A user input includes an actor tuple (`channel`, `accountId`, `senderId`,
  `actorKind`) and native message facts (`messageId`, `conversationId`,
  `conversationKind`, `eventKind`, and optional thread/edit/team fields).
  Non-user inputs may include `parentRunId`.

These are host-derived facts, not an execution or approval capability. The
snapshot may be absent on a path that cannot prove its source. Even a complete
snapshot can contain different actors or a mixture of user and non-user inputs;
it does not imply a unique human requester. Missing actor/message identity,
unavailable recovery data, mixed actors, and mixed origins cannot authorize a
requester-only approval. Do not infer the requester from a session-key grammar,
routing fields, transcript text, a run-start observer, or the last sender.

Core creates approval authorization from the exact live admitted runtime and
applies the channel's request policy. Hooks cannot supply or replace that binding
by copying `source` into approval parameters. See
[Channel approvals](/plugins/sdk-channel-plugins/approvals#requester-policy-and-authenticated-resolution)
for delivery and resolution contracts.

## Hook decision semantics

`before_install` is a plugin-runtime lifecycle hook, not the operator install
policy surface. Use `security.installPolicy` when an allow/warn/block decision must
cover CLI and Gateway-backed install or update paths.

- `before_tool_call`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_tool_call`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `before_install`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_install`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `reply_dispatch`: returning `{ handled: true, ... }` is terminal. Once any handler claims dispatch, lower-priority handlers and the default model dispatch path are skipped.
- `message_sending`: returning `{ cancel: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `message_sending`: returning `{ cancel: false }` is treated as no decision (same as omitting `cancel`), not as an override.
- `message_received`: use the typed `threadId` field when you need inbound thread/topic routing. Keep `metadata` for channel-specific extras.
- `message_sending`: use typed `replyToId` / `threadId` routing fields before falling back to channel-specific `metadata`.
- `gateway_start`: use `ctx.config`, `ctx.workspaceDir`, and `ctx.getCron?.()` for gateway-owned startup state instead of relying on internal `gateway:startup` hooks. Cron may still be loading at this point.
- `cron_reconciled`: rebuild a full external cron projection after startup or scheduler reload. It includes `reason` and the effective `enabled` state, including `enabled: false`, while `ctx.getCron?.()` returns the exact reconciled scheduler. Pass `ctx.abortSignal` into durable projection work; it aborts when that scheduler snapshot is superseded or the Gateway closes.
- `cron_changed`: observe gateway-owned cron lifecycle changes. `scheduled` and `removed` events are post-commit reconciliation hints, not an ordered delta log. A scheduled event's `event.nextRunAtMs` is absent when the job has no next wake; a removed event still carries the deleted job snapshot.

External wake schedulers should debounce or coalesce `cron_changed` events,
then reread the full durable view from the scheduler last captured by
`cron_reconciled`. Do not adopt the scheduler from a `cron_changed` context: a
detached hint from an older scheduler can overlap a later reload.

Use `cron_reconciled` as the full-snapshot trigger for durable state loaded at
Gateway startup or scheduler replacement. It is not replayed for a plugin-only
hot reload. Observation handlers run in parallel, and fire-and-forget
dispatches can overlap, so consumers must not depend on event completion order.
Keep OpenClaw as the source of truth for due checks and execution.

For a single-flight adapter with durable replacement, retry/backoff, and clean
shutdown, see [Safe external cron projection](/plugins/hooks/lifecycle#safe-external-cron-projection).
