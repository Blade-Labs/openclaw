---
summary: "Microsoft Teams Adaptive Card approvals, polls, presentation cards, member info, and targets"
read_when:
  - Sending approvals, polls, or presentation cards to Teams
  - Addressing a Teams user or conversation from the CLI or message tool
  - Resolving roster details for a Teams conversation
title: "Microsoft Teams cards and actions"
sidebarTitle: "Cards and actions"
---

The Adaptive Card surfaces OpenClaw sends to Teams, the Graph-backed roster lookup, and the target formats that address them.

## Member info action

OpenClaw exposes a Graph-backed `member-info` action for Microsoft Teams so agents and automations can resolve verified roster details for a configured conversation.

Requirements:

- `ChannelSettings.Read.Group` and `TeamMember.Read.Group` RSC permissions (already in the recommended manifest).

The action is available whenever Graph credentials are configured; there is no separate `channels.msteams.actions.memberInfo` toggle.
Standard-channel lookups return the matching team-roster identity, display name, email, and roles.
In the current DM or group chat, the action can return the trusted sender's stable user ID.
Private/shared-channel and non-current chat member lookups require additional roster permissions
and are rejected by the default permission baseline.

For `member-info` and `search` in the message tool, use `channelId` to select the
conversation. The Graph `<team-id>/<channel-id>` form identifies a Teams channel:

```json5
{
  action: "member-info",
  channel: "msteams",
  channelId: "<team-id>/<channel-id>",
  userId: "<user-id>",
}
```

`search` uses the same `channelId` filter with a `query` instead of `userId`.
Omitting the filter uses the current conversation when its Graph route is
available. For the current channel, its bare `19:...@thread.tacv2` ID and
`conversation:19:...@thread.tacv2` form reuse that same Graph route. Use the full
Graph form to select another channel. The selected conversation must still
satisfy the configured access policy and the action's membership requirements.

## Native approval cards

Microsoft Teams can deliver exec and plugin approval requests as Adaptive Cards in the originating conversation. Each card describes the requested command or plugin action and provides only the decisions allowed for that request, such as **Approve once**, **Always allow**, and **Deny**. After a decision or expiration, OpenClaw updates the original card with its final status.

Enable the existing top-level approval forwarding settings for each approval type you want to receive:

```json5
{
  approvals: {
    exec: { enabled: true, mode: "session" },
    plugin: { enabled: true, mode: "session" },
  },
  channels: {
    msteams: {
      allowFrom: ["00000000-0000-0000-0000-000000000000"],
    },
  },
}
```

`approvals.exec` and `approvals.plugin` are independent; enabling one does not enable the other. Native card delivery also requires a configured Teams bot and at least one approver resolved from `channels.msteams.allowFrom` or `channels.msteams.defaultTo`. Approvers must be stable AAD object IDs; display names, email addresses, group entries, and conversation IDs do not grant approval access. OpenClaw checks the clicking user's AAD object ID before resolving the request.

No Teams-specific approval configuration is required. The existing `/approve <id> <decision>` command remains available as a text fallback when native delivery is unavailable. For forwarding modes and supported decisions, see [Approval forwarding to chat channels](/tools/exec-approvals-advanced#approval-forwarding-to-chat-channels).

### Requester-only approvals

By default every approver in `allowFrom`/`defaultTo` may resolve any Teams approval. In both modes, native delivery requires a core-bound user origin and revalidates its exact conversation and thread; session drift and `user:` routing aliases cannot choose the destination. Native cards stay in the originating conversation; OpenClaw never fans them out to the approver roster's DMs. When `allowFrom` lists everyone who may chat with the bot, set:

```json5
{
  channels: {
    msteams: {
      approvals: { requesterOnly: true },
    },
  },
}
```

With `requesterOnly` enabled:

- Core binds each approval to the authenticated user messages admitted to its run. Delivery requires one verified human Teams requester on the default account, a valid Entra object ID, and an unambiguous origin conversation and thread. Session routing, `dmScope`, and `session.identityLinks` do not establish requester identity.
- The requester must be explicitly listed in `allowFrom` or `defaultTo`; an empty approver roster denies. OpenClaw checks current membership again when the user resolves the request.
- The card goes where the conversation happened: a channel request receives a reply in its originating thread, a group request receives a card in that group chat, and a personal request receives a card in the requester's verified 1:1 chat. OpenClaw uses the core's authenticated source, checks the stored conversation ID and type, and verifies ownership for personal chats. A missing or mismatched record withholds the card; no conversation falls back to another DM.
- Only the authenticated requester can choose **Approve once** or **Deny**, using the card or `/approve <id> <decision>`. Every resolution path applies the same core identity check. `/approve` is identity-scoped: the same authenticated requester may resolve from another conversation. Card clicks remain bound to the original card, and updates target its original conversation and activity ID. Another user's rejected click leaves the card usable by its requester. Operators, administrators, Control UI, CLI, and RPC clients cannot override this policy.
- Queued follow-up turns keep their admitted source and can receive cards. Collected messages qualify only when all inputs are user messages from the same authenticated requester in the same conversation and channel thread. Under strict policy, steering becomes a FIFO follow-up turn instead of changing the running requester's inputs.
- Mixed, missing, unverified, or non-user sources (including scheduled, cron, and heartbeat runs) fail closed, as do ambiguous conversations or threads and unverifiable destinations. No action is approved and approval details are not forwarded elsewhere. When OpenClaw can verify one personal-chat recipient from the admitted source, core sends a brief blocked-request notice asking the user to submit a new request there. If there is no unique verified chat or notice delivery fails, OpenClaw records that outcome and sends nothing to other recipients.

Already stamped requester-only requests and policies latched to admitted runs remain strict after you turn the option off. Requests without a previously latched strict policy use the current option; with it off, configured approvers may resolve, while cards still require the same bound origin. If native delivery has no safe target, core records a blocked delivery and the private notice outcome (`sent`, `no-unique-chat`, or `failed`). Default approvals remain available when delivered to another authorized approval surface; otherwise core denies the request and reports that the requester could not be reached. Scheduled and unattributable runs never receive Teams cards or approver DM fan-out.

This option requires a matching OpenClaw core and Teams plugin version with core requester binding and authenticated channel approval resolution. Updating the Teams plugin alone on an older core is insufficient.

## Polls (Adaptive Cards)

OpenClaw sends Teams polls as Adaptive Cards (there is no native Teams poll API).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> --poll-question "..." --poll-option "..." --poll-option "..."`.
- Votes are recorded by the gateway in OpenClaw plugin-state SQLite under `state/openclaw.sqlite`.
- Existing `msteams-polls.json` files are imported by `openclaw doctor --fix`, not by the running plugin.
- The gateway must stay online to record votes.
- Polls do not auto-post result summaries, and there is no poll-results CLI.

Revoking a scheduled job's message permission stops a poll that has not yet been submitted.
A poll already submitted to Teams retains its accepted ID and normal vote tracking while the run finishes.

## Presentation cards

Send semantic presentation payloads to Teams users or conversations using the `message` tool, CLI, or normal reply delivery. OpenClaw renders them as Teams Adaptive Cards from the generic presentation contract.

The `presentation` parameter accepts semantic blocks. When `presentation` is provided, the message text is optional. Buttons render as Adaptive Card submit or URL actions. Select menus are not native in the Teams renderer, so OpenClaw downgrades them to readable text before delivery.

**Agent tool:**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:<id>",
  presentation: {
    title: "Hello",
    blocks: [{ type: "text", text: "Hello!" }],
  },
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --presentation '{"title":"Hello","blocks":[{"type":"text","text":"Hello!"}]}'
```

For target format details, see [Target formats](#target-formats) below.

## Target formats

MSTeams targets use prefixes to distinguish between users and conversations:

| Target type         | Format                           | Example                                                                                                |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| User (by ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                                                            |
| User (by name)      | `user:<display-name>`            | `user:John Smith` (requires Graph API)                                                                 |
| Group/channel       | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                                               |
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2`, `19:...@unq.gbl.spaces`, or a bare `a:`/`8:orgid:`/`29:` Bot Framework id |

**CLI examples:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send a presentation card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --presentation '{"title":"Hello","blocks":[{"type":"text","text":"Hello"}]}'
```

**Agent tool examples:**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:John Smith",
  message: "Hello!",
}
```

```json5
{
  action: "send",
  channel: "msteams",
  target: "conversation:19:abc...@thread.tacv2",
  presentation: {
    title: "Hello",
    blocks: [{ type: "text", text: "Hello" }],
  },
}
```

<Note>
Without the `user:` prefix, names default to group or team resolution. Always use `user:` when targeting people by display name.
</Note>

## Proactive messaging

- Proactive messages are only possible **after** a user has interacted, because OpenClaw stores conversation references at that point.
- See [/gateway/configuration](/gateway/configuration) for `dmPolicy` and allowlist gating.
