# taskwatch

A b3nd protocol and rig for tracking work-in-flight.

You spin up new agents, you open worktrees, you start PRs, you switch contexts. Some work rots silently because nothing was watching it. Taskwatch is a uniform place — runnable as MCP, CLI, HTTP, or in-process — where every task being worked on is visible and every state change is appended as it happens.

## The shape

```
task://{id}              # mutable metadata (title, status, owner, context, refs)
task://{id}/u/{seq}      # append-only update entries
task://{id}/r/{name}     # attached resources
hash://sha256/{hex}      # content-addressed payloads (descriptions, notes)
```

Metadata and content are separated by design. The metadata document is the index; the content is immutable and content-addressed. Status updates don't rewrite content. Adding content doesn't rewrite metadata.

## Surfaces

- **MCP** — `bnd node --mcp --rig ./mod.ts` or the bundled `.claude-plugin/mcp-server/mod.ts` (purpose-built `taskwatch_*` tools)
- **HTTP** — `deno task serve` hosts the rig + web UI together
- **CLI** — `deno task cli list|add|view|update`
- **In-process** — `import createRig from "@bandeira-tech/taskwatch"`

## Install as a Claude Code plugin

```sh
/plugin install taskwatch@bandeira-tech/taskwatch
```

The plugin registers an MCP server backed by a local taskwatch rig and ships slash commands:

- `/taskwatch:track` — log new work being started
- `/taskwatch:list` — show active tasks
- `/taskwatch:view <id>` — view a task and its update log
- `/taskwatch:update <id>` — append a status update
- `/taskwatch:ui` — open the web UI

## Storage

Default: local filesystem at `~/.taskwatch/data` (configurable via `TASKWATCH_DATA`). Backend swappable per scope — point `TASKWATCH_BACKEND` at a remote b3nd HTTP rig to use shared storage.

## Status

Pre-1.0. The protocol shape is stable enough to build on; ergonomics will accumulate. See `CLAUDE.md` for design rules.
