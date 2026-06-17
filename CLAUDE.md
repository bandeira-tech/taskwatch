# CLAUDE.md — taskwatch

## What this is

Taskwatch is a b3nd-based protocol and rig for tracking work-in-flight. The premise: an agent (or human) is doing work, more work spawns in parallel, some of it rots — we want a single PIN where every active task is visible and append-only updates flow as the work moves.

The data shape is the protocol. The same `task://` URIs work in-process, over HTTP, and over MCP. Storage backends are swappable per scope (local FS for personal, remote HTTP for shared).

## Shape

- **`task://{id}`** — mutable metadata document (TaskMeta JSON). Title, status, owner pubkey, content reference, parent, tags, context (worktree/repo/branch/PR), and the list of update/resource URIs.
- **`task://{id}/u/{seq}`** — append-only update entries (TaskUpdate JSON). Each update is its own URI; sequence is monotonic per task.
- **`task://{id}/r/{name}`** — resources attached to a task (links, files, refs).
- **`hash://sha256/{hex}`** — content-addressed payload bytes. The original content (task description, update body) lives here; metadata documents reference it via `contentRef`.
- **`task://list?...`** — read endpoint returning the current task index.

**Metadata is separated from content** by design. The task metadata is the index — light, mutable, queryable. The content is content-addressed, immutable, and verifiable. Updating the status of a task doesn't touch its content; adding new content doesn't rewrite the metadata.

## Code principles

- **Cores stay puritan.** This package depends on `b3nd-core`, `b3nd-save`, `b3nd-move`, `b3nd-canon` directly. Don't pull the umbrella SDK — keep imports explicit and deduplicated.
- **No silent coercion.** Programs validate writes against the protocol shape; bad writes are rejected, not patched.
- **Storage is injected.** The rig factory takes a store; it doesn't default to one in tests or libraries. The CLI/serve/MCP entrypoints pick FS as their concrete default.
- **PIN symmetry.** The same `receive` / `read` / `observe` calls work in-process (CLI), over HTTP (web UI), and over MCP (agents). Don't add a verb to one transport that isn't on the others.
- **Content addressing for content.** Task descriptions and update bodies go through `hash://sha256/...`. Metadata documents reference them. Don't inline content into metadata — that destroys the separation.

## Entrypoints

- **`mod.ts`** — default export is the rig factory. Consumable by `bnd node --rig path/to/mod.ts` and by anything that wants the rig in-process.
- **`src/cli.ts`** — `taskwatch` CLI (add, list, view, update, resource). Talks to the rig in-process.
- **`src/serve.ts`** — single process that hosts the rig over HTTP and serves the web UI from `web/dist/`.
- **`.claude-plugin/mcp-server/mod.ts`** — MCP server with purpose-built agent tools (`taskwatch_create`, `taskwatch_update`, `taskwatch_list`, `taskwatch_view`). Wraps the rig.
- **`web/`** — Vite + React + Tailwind UI. Talks to the rig over HTTP via `HttpClient`.

## Storage scopes

Default storage is the local filesystem at `$TASKWATCH_DATA` (default `~/.taskwatch/data`), via `FsStore`. To target a remote rig (shared scope), point the HTTP/MCP client at it: the `TASKWATCH_BACKEND` env var, when set to an HTTP URL, makes the rig delegate to a remote node instead of writing locally.

Different scopes can run side-by-side: agents writing to a local FS rig over MCP, the web UI reading from a hosted HTTP rig over the network. The same protocol shape works for both.

## Working rules

- **Commit per capability.** Each meaningful slice (protocol types, rig, CLI, MCP, UI, plugin) ships its own commit. Don't batch.
- **Verify imports before edits.** JSR versions drift; check `deno.json` and the upstream package version before assuming an export exists.
- **Don't introduce defaults in the protocol layer.** New required fields require a migration story.
