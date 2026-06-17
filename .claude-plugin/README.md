# taskwatch (Claude Code plugin)

A Claude Code plugin that turns any session into a taskwatch client.

## What it ships

- **MCP server** — a pure b3nd PIN (`b3nd_receive` / `b3nd_read` / `b3nd_status`) backed by a local FS rig (or a remote one via `TASKWATCH_BACKEND`). The protocol shape is the contract; there are no purpose-built taskwatch tools.
- **Skill** (`skills/taskwatch/SKILL.md`) — teaches the protocol: URI scheme, payload shapes, single-batch flows for create/append/view. Auto-loaded when the conversation talks about starting work, tracking, picking up rotting work, etc.
- **Slash commands** — `/taskwatch:track`, `/taskwatch:tasks`, `/taskwatch:view`, `/taskwatch:update`, `/taskwatch:status`, `/taskwatch:rot`, `/taskwatch:ui`.

## Install

From this repo:

```sh
/plugin install taskwatch@bandeira-tech/taskwatch
```

Or via local marketplace path during development.

## Storage

- `TASKWATCH_DATA` — local FS root. Default: `~/.taskwatch/data`.
- `TASKWATCH_BACKEND` — when set to an HTTP URL, the MCP delegates to that remote b3nd rig. Same protocol surface either way.

## Web UI

`/taskwatch:ui` starts the local HTTP server (`src/serve.ts`) on port 7474 and opens it. The UI talks the b3nd HTTP wire directly — no taskwatch-specific endpoints.
