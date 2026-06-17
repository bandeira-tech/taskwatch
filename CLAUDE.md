# CLAUDE.md — taskwatch

## What this is

Taskwatch is a b3nd-based protocol and rig for tracking work-in-flight. The premise: an agent (or human) is doing work, more work spawns in parallel, some of it rots — we want a single PIN where every active task is visible and append-only entries flow as the work moves.

A task is a tree of plain-text resources at a human-readable path. The "current state" of a task is *derived* by reading the tree; nothing is maintained as a separate record. No JSON envelopes, no counters, no read-modify-write to append.

## Shape

The protocol is mounted under an operator-chosen **basepath** (containing `://`, defaults to `taskwatch://`). All URIs are `{basepath}{type}/{actuals}`:

- **`{basepath}task/{ts}/{slug}/title`** — plain text, the task's title.
- **`{basepath}task/{ts}/{slug}/description`** — markdown body.
- **`{basepath}task/{ts}/{slug}/parent`** — parent task URI, when this is sub-work.
- **`{basepath}task/{ts}/{slug}/context/{field}`** — one URI per fact (worktree, repo, branch, pr, agent, ...). Last-write-wins.
- **`{basepath}task/{ts}/{slug}/tags/{tag}`** — empty payload as a presence sentinel; `null` payload deletes.
- **`{basepath}task/{ts}/{slug}/entries/{ts2}-{kind}`** — append-only entries. Each `{kind}` is `progress | note | handoff | rot | supersede | title-changed | description-changed | status-{value}`. Payload is the entry body.
- **`{basepath}task/{ts}/{slug}/resources/{name}`** — attached resources (URL, file ref, short content).
- **`{basepath}task/{ts}/{slug}?fn=view`** — synthetic read locator that returns the folded `TaskView` in one call.
- **`{basepath}index/{ts}-{slug}`** — enumeration aid; payload is the current title.

`{ts}` is `YYYYMMDDhhmmss` UTC, `{slug}` is `[a-z0-9-]{1,60}`. Listing all tasks: read `{basepath}index/?fn=ls&format=full`.

## Code principles

- **Cores stay puritan.** This package depends on `b3nd-core`, `b3nd-save`, `b3nd-move` directly. Don't pull the umbrella SDK.
- **No JSON, no envelopes.** Each fact has its own URI; payloads are plain UTF-8 text. The protocol shape is the URI tree.
- **State is derived.** No meta document, no counters, no maintained arrays. Status is computed by folding entry URIs. The single denormalisation is the `index/` URIs, which carry the current title for cheap listing (and are rebuildable from the task tree).
- **Storage is injected.** The rig factory takes a store; it doesn't default to one in tests or libraries. The CLI/serve/MCP entrypoints pick FS as their concrete default.
- **Basepath is injected.** The rig factory takes a basepath; it normalises and uses it for both writes and the connection pattern. Default `taskwatch://`; override via `TASKWATCH_BASEPATH`.
- **PIN symmetry.** The same `receive` / `read` / `observe` calls work in-process (CLI), over HTTP (web UI), and over MCP (agents). Don't add a verb to one transport that isn't on the others. In particular: **no taskwatch-specific MCP tools.** Agents talk to the rig through the universal b3nd PIN; the protocol shape (taught by the skill) is the surface.

## Entrypoints

- **`mod.ts`** — default export is the rig factory. Returns `{ rig, node, basepath }`.
- **`src/cli.ts`** — `taskwatch` CLI: `new`, `list`, `view`, `status`, `progress`, `note`, `resource`, `tag`, `ctx`, `rot`, `rename`, `delete`.
- **`src/serve.ts`** — single process that hosts the rig over HTTP (`/api/v1/*`) and serves the web UI from `web/` (`/`). Also exposes `/config` returning `{ basepath, version, protocol }` so the UI can discover the mount.
- **`.claude-plugin/mcp-server/mod.ts`** — MCP server exposing the rig as a **pure b3nd PIN** (`b3nd_receive`, `b3nd_read`, `b3nd_status`). The `skills/taskwatch/SKILL.md` teaches agents how to drive it.
- **`web/`** — vanilla HTML + Tailwind via CDN. Talks the b3nd HTTP wire directly (`web/b3nd-http.js`).

`TASKWATCH_BACKEND=<http url>` makes the MCP front a remote rig instead of writing to disk.

## Storage scopes

- Default: local FS at `$TASKWATCH_DATA` (default `~/.taskwatch/data`).
- Remote: point `TASKWATCH_BACKEND` at a hosted b3nd HTTP rig — same protocol surface either way.

## Working rules

- **Commit per capability.** Each meaningful slice (protocol, rig, CLI, MCP, UI, plugin) ships its own commit. Don't batch.
- **Verify imports before edits.** JSR versions drift; check `deno.json` and the upstream package version before assuming an export exists.
- **Don't introduce defaults in the protocol layer.** The shape is the URI tree. New conventions require updating the skill and the parsers together.
