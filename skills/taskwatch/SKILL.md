---
name: taskwatch
description: Use when starting new work, picking up old work, or tracking progress on something in flight. Teaches the taskwatch protocol — a tree of plain-text resources at human-readable URIs — so agents can create and update tasks via the b3nd MCP (b3nd_receive / b3nd_read). Triggers when the user mentions starting a new task, opening a worktree, dispatching a sub-agent, picking up rotting work, or asks to "track", "log", "record", or "remember" a piece of work. Also relevant after committing meaningful progress.
---

# Taskwatch — tracking work-in-flight over b3nd

The taskwatch MCP server exposes a pure b3nd PIN — three tools: `b3nd_receive`, `b3nd_read`, `b3nd_status`. There are no purpose-built taskwatch tools. The protocol shape below is the contract; the agent constructs the right URIs with plain-text payloads, the rig stores them.

## When to use

- **Starting new work** — opening a worktree, beginning a PR, dispatching a sub-agent. Create a task before doing the work, not after.
- **Progress checkpoints** — milestones hit, blockers surfaced, decisions made. Append an entry.
- **Status transitions** — pausing, finishing, abandoning, marking as rotting. Append a status entry.
- **Picking up old work** — read the task before resuming so you can pick up the chain.
- **Spawning a sub-task** — when one piece of work spawns another, create the child with `parent` pointing at the parent task URI.

## URI shape — basepath + type + actuals

Every URI starts with a **basepath** (operator-chosen) followed by a **type** segment and per-resource paths:

```
{basepath}task/{ts}/{slug}/title              plain text — short, the title
{basepath}task/{ts}/{slug}/description        plain text — markdown body
{basepath}task/{ts}/{slug}/parent             plain text — parent task URI
{basepath}task/{ts}/{slug}/context/{field}    plain text — one URI per fact (worktree, repo, branch, pr, agent, ...)
{basepath}task/{ts}/{slug}/tags/{tag}         empty payload — presence is the tag
{basepath}task/{ts}/{slug}/entries/{ts2}-{kind}    plain text — body of an append-only entry
{basepath}task/{ts}/{slug}/resources/{name}   plain text — URL string, file ref, or short content

{basepath}index/{ts}-{slug}                   plain text — current title (enumeration aid)
```

- **`{basepath}`** — defaults to `taskwatch://`. Operator may mount under any URI prefix that contains `://`. Don't hardcode; the value is announced by the MCP server at startup and by the `/config` endpoint on the HTTP transport.
- **`{ts}`** — `YYYYMMDDhhmmss` in UTC. The task's create-time second. Sortable, unique.
- **`{slug}`** — lowercase URL-safe slug from the title. `[a-z0-9-]`, max 60 chars. Slug never changes after creation.
- **`{ts2}`** — entry's own timestamp in `YYYYMMDDhhmmss`. Monotonic; no shared counter to bump.
- **`{kind}`** — the entry kind embedded in the URI. Convention: `progress`, `note`, `handoff`, `rot`, `supersede`, `title-changed`, `description-changed`, `accessed` (auto-written by the rig when a task is viewed; excluded from "last update"), or `status-{value}` where `{value}` ∈ `active|paused|blocked|done|abandoned|rotting|superseded`.

Every payload is plain UTF-8 text. No JSON, no envelopes, no counters.

## State is derived

A task's "current state" is not stored — it's computed by reading the tree and folding the entries:

| Field         | How                                                                 |
|---------------|---------------------------------------------------------------------|
| title         | read `…/title`                                                      |
| description   | read `…/description`                                                |
| context       | list `…/context/?fn=ls&format=full`                                 |
| tags          | list `…/tags/?fn=ls&format=uris` (strip prefix → tag names)         |
| status        | list `…/entries/?fn=ls&format=uris`, pick the latest URI matching `*-status-*`, take the trailing token. Default `active` if none. |
| updates count | count of `…/entries/`                                               |
| updatedAt     | timestamp of the latest entry, or of the task's own `{ts}` if no entries |
| resources     | list `…/resources/?fn=ls&format=full`                               |

There's a **synthetic view locator** that hides the fan-out: `{basepath}task/{ts}/{slug}?fn=view` returns the folded TaskView in one call. Use it for read paths; it's a single `b3nd_read` round trip.

## Creating a task

Build the URIs from a chosen `{ts}` (now in UTC) and `{slug}` (slugify the title). Issue one `b3nd_receive` batch:

```jsonc
b3nd_receive { messages: [
  ["{basepath}task/{ts}/{slug}/title",            "the title text"],
  ["{basepath}task/{ts}/{slug}/description",      "long markdown..."],
  ["{basepath}task/{ts}/{slug}/context/worktree", "/Users/m0/ws/foo/.wt/auth"],
  ["{basepath}task/{ts}/{slug}/context/repo",     "owner/foo"],
  ["{basepath}task/{ts}/{slug}/context/branch",   "feat/auth"],
  ["{basepath}task/{ts}/{slug}/context/agent",    "claude"],
  ["{basepath}task/{ts}/{slug}/tags/auth",        ""],
  ["{basepath}task/{ts}/{slug}/tags/frontend",    ""],
  ["{basepath}index/{ts}-{slug}",                 "the title text"]
]}
```

The index entry at the end carries the title for cheap enumeration. Maintain it on title edits (rewrite the index payload to the new title).

If the initial status is anything other than `active`, also append the corresponding status entry:

```
["{basepath}task/{ts}/{slug}/entries/{ts}-status-paused", "deferred until next sprint"]
```

## Appending a status update

**One write. No read first.** Take a fresh `{ts2}` (now in UTC) and pick the new status:

```jsonc
b3nd_receive { messages: [
  ["{basepath}task/{ts}/{slug}/entries/{ts2}-status-paused", "lunch — back in 45min"]
]}
```

That's it. The next `?fn=view` of the task picks this up as the current status.

## Appending a progress note

```jsonc
b3nd_receive { messages: [
  ["{basepath}task/{ts}/{slug}/entries/{ts2}-progress", "rewrote protocol.ts; listing works against the new index"]
]}
```

The payload is the human-readable note (multi-line OK).

## Attaching a resource

```jsonc
b3nd_receive { messages: [
  ["{basepath}task/{ts}/{slug}/resources/pr", "https://github.com/owner/repo/pull/42"]
]}
```

Resource name is `[a-z0-9._-]{1,64}`. Payload is whatever's meaningful — a URL string for links, a path for files, or short content.

## Tags

Add: write an empty payload.
Remove: send `null` as the payload (b3nd convention for delete).

```jsonc
b3nd_receive { messages: [
  ["{basepath}task/{ts}/{slug}/tags/auth", ""],      // add
  ["{basepath}task/{ts}/{slug}/tags/backlog", null]  // remove
]}
```

## Editing the title or description

Title and description are last-write-wins URIs. To rename: write the new title, update the index payload, and (for the audit trail) append a `title-changed` entry with the prior value.

```jsonc
b3nd_receive { messages: [
  ["{basepath}task/{ts}/{slug}/title",              "New title"],
  ["{basepath}index/{ts}-{slug}",                   "New title"],
  ["{basepath}task/{ts}/{slug}/entries/{ts2}-title-changed", "was: Old title"]
]}
```

## Listing tasks

Read the index. Use `format=full` to get titles alongside URIs:

```jsonc
b3nd_read { urls: ["{basepath}index/?fn=ls&format=full"] }
// → [[index-uri, title], [index-uri, title], ...]
```

Decompose each index URI back to `{ts, slug}`: strip the `{basepath}index/` prefix, split on the first `-`. To enrich each row with derived status, read each task's `entries/?fn=ls&format=uris` and fold.

## Viewing a task

Use the synthetic view locator for a single round-trip read of the whole tree:

```jsonc
b3nd_read { urls: ["{basepath}task/{ts}/{slug}?fn=view"] }
```

Returns a `TaskView`:

```jsonc
{
  basepath: "{basepath}",
  addr: { ts, slug },
  uri: "{basepath}task/{ts}/{slug}",
  title, description, status, parent,
  context: { worktree, repo, ... },
  tags: ["auth", "frontend"],
  entries: [{ uri, ts, kind, body }, ...],
  resources: [{ uri, name, body }, ...],
  createdAt, updatedAt
}
```

## Rendezvous — taking turns with another agent

Two (or more) agents can converge on a single task and exchange context through it. The task URI is the only handle; every agent reads and writes through `b3nd_receive` / `b3nd_read` against the shared rig (same `TASKWATCH_DATA` on one host, or same `TASKWATCH_BACKEND`).

There is **no `observe` over MCP** — agents poll. Entry URIs are timestamped (`{ts2}-{kind}`) and lexically sortable, so a cursor is just "the URI of the last entry I've processed."

**Self-author marker.** Put `from: {agent-name}\n\n` at the head of every handoff body so the peer can ignore its own writes when polling. The agent name is whatever both sides agreed on (passed in the spawn prompt, or recorded at `…/context/agent`).

**Cursor loop:**

```jsonc
// poll
b3nd_read { urls: ["{basepath}task/{ts}/{slug}/entries/?fn=ls&format=full"] }
// → [[uri, body], [uri, body], ...]
```

For each `[uri, body]` where `uri > cursor`:
- If `body` starts with `from: {self}`, advance `cursor = uri` and continue.
- Otherwise treat it as the peer's turn: read it, do the work, write a reply, then advance `cursor`.

If nothing new, wait ~500–2000ms and re-poll. Don't hammer.

**Same-second collisions.** Entry timestamps are second-precision. If two agents write the same `kind` in the same UTC second, the second write overwrites the first. **Before writing, list `entries/?fn=ls&format=uris` and pick `{ts2}` such that the candidate URI is strictly greater than every existing entry URI**, bumping `ts2` by one second until satisfied. Same rule as the index-collision bump used at task creation.

**Roles.** Pick `handoff` as the entry kind for inter-agent turns. Keep the body human-readable — the first line is `from: ...`, then a blank line, then the message. Don't invent a second kind per role; the `from:` marker carries that information and the kind suffix stays uniform so polling logic is one path.

```jsonc
b3nd_receive { messages: [
  ["{basepath}task/{ts}/{slug}/entries/{ts2}-handoff", "from: alice\n\nturn 0 — please pick the design"]
]}
```

**Bootstrapping the peer.** When you spawn a sub-agent or hand work to another session, write the task URI into its prompt and pick its agent name. The peer's first move is one `b3nd_read` of `…?fn=view` (to load context) followed by the cursor loop.

**When to stop polling.** Either a turn budget agreed up front, or an entry kind that signals end-of-conversation (`status-done`, or a final `handoff` body marked `closing`). Status entries fold into the task's derived state — a `status-done` is both a signal and a state transition.

## Deleting

- **Soft delete** — append a `status-abandoned` entry. The task stays in the index and is readable.
- **Hard delete** — list every URI under `{basepath}task/{ts}/{slug}/` (entries/, resources/, context/, tags/, plus title, description, parent), send `null` for each, and `null` for `{basepath}index/{ts}-{slug}` too.

## Computing the timestamp + slug

```js
// {ts} — current UTC second
const d = new Date();
const pad = n => String(n).padStart(2, "0");
const ts =
  String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
  pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());

// {slug} — slugify the title
const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 60)
  .replace(/-+$/, "") || "task";
```

If the resulting `{ts}-{slug}` collides with an existing index URI, bump `{ts}` by one second and retry.

## Style

- **One task per discrete piece of work.** Each worktree, PR, exploration, or sub-agent dispatch gets its own task. Don't bundle.
- **Update as you go.** A task with no entries for a long time has rotted; the entry log is the proof of life.
- **Capture context at create time.** `worktree`, `repo`, `branch`, `pr`, `agent` are how future-you reconstructs the situation. Each is its own context URI.
- **Use `parent` for sub-work.** If you spawn a sub-agent or open a nested PR, write the parent URI to `…/parent` on the child.
- **Resources are URIs.** A PR link, a design doc, a related task — attach as `resources/{name}` so it lives independently and can be referenced.
- **Status entries are one write.** Don't read the task first — just write the new entry. The state is derived from the URI; it doesn't matter what was there before.

## Backends and basepath

- `TASKWATCH_BASEPATH` — operator-chosen mount. Default `taskwatch://`. Discover via the MCP server startup log or via the `/config` endpoint on the HTTP transport.
- `TASKWATCH_DATA` — local FS root for the rig (default `~/.taskwatch/data`).
- `TASKWATCH_BACKEND` — when set to an HTTP URL, the MCP fronts a remote b3nd rig instead of writing locally. Same protocol surface; same URI shapes.
