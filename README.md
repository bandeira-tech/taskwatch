# taskwatch

A b3nd protocol and rig for tracking work-in-flight.

You spin up new agents, you open worktrees, you start PRs, you switch contexts. Some work rots silently because nothing was watching it. Taskwatch is a uniform place — runnable as MCP, CLI, HTTP, or in-process — where every task being worked on is visible and every state change is appended as it happens.

## The shape

A task is a tree of plain-text resources at a human-readable path under an operator-chosen basepath:

```
{basepath}task/{ts}/{slug}/title              "Update URI schema to paper-trail layout"
{basepath}task/{ts}/{slug}/description        "Drop the JSON envelope. Move to slug paths…"
{basepath}task/{ts}/{slug}/context/branch     "feat/auth"
{basepath}task/{ts}/{slug}/context/agent      "claude"
{basepath}task/{ts}/{slug}/tags/protocol      ""
{basepath}task/{ts}/{slug}/entries/{ts2}-progress       "rewrote node.ts, listing works"
{basepath}task/{ts}/{slug}/entries/{ts2}-status-paused  "lunch"
{basepath}task/{ts}/{slug}/resources/pr        "https://github.com/…/pull/5"

{basepath}index/{ts}-{slug}                   "Update URI schema to paper-trail layout"
```

`{basepath}` defaults to `taskwatch://`; the operator may mount the protocol under any prefix that contains `://` (`app://work/`, `b3nd://node/personal/`, etc.). Every payload is plain UTF-8 text. No JSON envelopes, no counters.

A task's "current state" is *derived* by reading the tree and folding the entry URIs. Status comes from the latest URI matching `*-status-*`; updated-at from the latest entry's `{ts}`. The synthetic locator `{basepath}task/{ts}/{slug}?fn=view` returns the folded `TaskView` in one round trip.

## Surfaces

- **MCP** — pure b3nd PIN: `b3nd_receive`, `b3nd_read`, `b3nd_status`. Agents follow the protocol shape (taught via the bundled skill); there are no taskwatch-specific tools.
- **HTTP** — `deno task serve` hosts the rig at `/api/v1/*` and the web UI at `/`. A `/config` endpoint exposes the basepath for the UI to discover.
- **CLI** — `deno task cli new|list|view|status|progress|note|resource|tag|ctx|rot|rename|delete`.
- **In-process** — `import createRig from "@bandeira-tech/taskwatch"` returns `{ rig, node, basepath }`.

## Install as a Claude Code plugin

```
/plugin marketplace add bandeira-tech/taskwatch
/plugin install taskwatch@taskwatch
```

Ships:

- An MCP server backed by a local taskwatch rig (basepath via `TASKWATCH_BASEPATH`)
- A skill that teaches the URI shape
- Slash commands: `/taskwatch:track`, `:tasks`, `:view`, `:update`, `:status`, `:rot`, `:ui`

## Storage and backends

- `TASKWATCH_BASEPATH` — operator-chosen mount. Default `taskwatch://`.
- `TASKWATCH_DATA` — local FS root. Default `~/.taskwatch/data`.
- `TASKWATCH_BACKEND` — when set to an HTTP URL, the MCP fronts a remote b3nd rig instead of writing locally. Same protocol surface either way.

## Status

v0.1.0 — paper-trail layout. Pre-1.0, but the shape is stable; ergonomics will accumulate. See `CLAUDE.md` for design rules and `docs/proposal-002-paper-trail.md` for why the shape looks like it does.
