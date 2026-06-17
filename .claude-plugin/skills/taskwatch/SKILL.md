---
name: taskwatch
description: Use when starting new work, picking up old work, or tracking progress on something in flight. Teaches the taskwatch protocol so agents can create and update tasks via the b3nd MCP (b3nd_receive / b3nd_read). Triggers when the user mentions starting a new task, opening a worktree, dispatching a sub-agent, picking up rotting work, or asks to "track", "log", "record", or "remember" a piece of work. Also relevant after committing meaningful progress.
---

# Taskwatch — tracking work-in-flight over b3nd

Taskwatch is a b3nd protocol. The MCP server `taskwatch` exposes a pure b3nd PIN — three tools: `b3nd_receive`, `b3nd_read`, `b3nd_status`. There are **no** purpose-built `taskwatch_*` tools. The protocol shape below is the contract; you write the right URIs with the right payloads and the rig stores them.

## When to use

- **Starting new work** — opening a worktree, beginning a PR, dispatching a sub-agent, picking up an exploration. Create a task before doing the work, not after.
- **Progress checkpoints** — milestones hit, blockers surfaced, decisions made. Append an update.
- **Status transitions** — pausing, finishing, abandoning, marking as rotting. Append an update with `new_status`.
- **Picking up old work** — read the task before resuming so you can pick up the chain.
- **Spawning a sub-task** — when one piece of work spawns another, create the child with `parent` pointing at the parent task URI.

## URI scheme

```
task://t/{id}              # task metadata document  (mutable)
task://t/{id}/u/{seq}      # update entries — append-only, monotonic seq
task://t/{id}/r/{name}     # attached resources (links, files, refs)
hash://sha256/{hex}        # content-addressed payload bytes (descriptions, bodies)
task://t/list[?...]        # synthetic read locator — lists task metadata
```

`{id}` is 1–64 chars `[a-z0-9-]`, must start `[a-z0-9]`. Generate a short random one (10 chars from `a-z0-9`) when creating.

## Payload shapes

**`task://t/{id}` — TaskMeta:**
```json
{
  "id": "abc123def4",
  "title": "build the auth flow",
  "status": "active",
  "createdAt": 1718600000000,
  "updatedAt": 1718600000000,
  "contentRef": "hash://sha256/...",
  "parent": "task://t/parentId",
  "tags": ["auth", "frontend"],
  "context": {
    "worktree": "/Users/m0/ws/foo/.wt/auth",
    "repo": "bandeira-tech/foo",
    "branch": "feat/auth",
    "pr": "https://github.com/bandeira-tech/foo/pull/42",
    "agent": "claude"
  },
  "updateCount": 0,
  "updateUris": [],
  "resourceUris": []
}
```

Status values: `active`, `paused`, `blocked`, `done`, `abandoned`, `rotting`, `superseded`.

**`task://t/{id}/u/{seq}` — TaskUpdate:**
```json
{
  "taskId": "abc123def4",
  "seq": 0,
  "ts": 1718600000000,
  "kind": "progress",
  "message": "auth UI shipped, server-side wired up",
  "contentRef": "hash://sha256/...",
  "payload": { "to": "done" }
}
```

Update kinds: `note`, `status`, `progress`, `resource`, `rot`, `supersede`, `handoff`.

**`task://t/{id}/r/{name}` — TaskResource:**
```json
{
  "taskId": "abc123def4",
  "name": "design-doc",
  "kind": "link",
  "ts": 1718600000000,
  "url": "https://...",
  "contentRef": "hash://sha256/..."
}
```

`{name}` is `[a-z0-9._-]{1,64}` starting with `[a-z0-9]`.

## Metadata is separated from content

Long bodies (task descriptions, update notes, resource content) live at `hash://sha256/{hex}` and are referenced from the metadata document via `contentRef`. Short one-liners (`title`, `message`) inline in the metadata.

Compute the hash as SHA-256 of the UTF-8 bytes:

```js
const bytes = new TextEncoder().encode(text);
const buf = await crypto.subtle.digest("SHA-256", bytes);
const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const uri = `hash://sha256/${hex}`;
```

## Recommended flows

### Create a task

1. Pick an id (10 random `a-z0-9`).
2. If there's a description body, hash it and add both writes in one batch:
   ```
   b3nd_receive {
     messages: [
       ["hash://sha256/<hex>",  "<the description text>"],
       ["task://t/<id>", {
         id: "<id>", title: "<title>", status: "active",
         createdAt: <now>, updatedAt: <now>,
         contentRef: "hash://sha256/<hex>",
         context: { ... known context ... },
         updateCount: 0, updateUris: [], resourceUris: []
       }]
     ]
   }
   ```
3. If there's no description body, skip the hash write and omit `contentRef`.

### Append an update

1. Read the current TaskMeta:
   ```
   b3nd_read { urls: ["task://t/<id>"] }
   ```
2. Take its `updateCount` as the new seq. Build the update.
3. If there's a body, hash it. Construct the update URI as `task://t/<id>/u/<seq padded to 6>`.
4. Single `b3nd_receive` batch:
   ```
   messages: [
     (optional) ["hash://sha256/<hex>", "<body>"],
     ["task://t/<id>/u/<padded-seq>", { taskId, seq, ts, kind, message, contentRef? }],
     ["task://t/<id>", { ...meta, status: <maybe new>, updatedAt: ts,
                         updateCount: seq + 1,
                         updateUris: [...meta.updateUris, "<update uri>"] }]
   ]
   ```

### List tasks

```
b3nd_read { urls: ["task://t/list"] }
```

Filter via query string: `task://t/list?status=active`, `task://t/list?tag=frontend`, `task://t/list?parent=task://t/<id>`. Returns an array of TaskMeta.

### View a single task

```
b3nd_read {
  urls: [
    "task://t/<id>",
    ...meta.updateUris,
    ...meta.resourceUris,
    meta.contentRef   // if set
  ]
}
```

The `hash://sha256/...` reads return raw bytes — decode UTF-8 to recover the text.

### Mark something as rotting

Append an update with `kind: "rot"` and `new_status: "rotting"`. The user can later view rotting tasks with `task://t/list?status=rotting` to decide what to revive, supersede, or abandon.

## Style

- **One task per discrete piece of work.** Worktree, PR, exploration, sub-agent dispatch — each gets its own task. Don't bundle.
- **Update as you go.** A task with no updates for a long time has rotted; the update log is the proof of life.
- **Capture context.** `worktree`, `repo`, `branch`, `pr`, `agent` are how future-you reconstructs the situation.
- **Use `parent` for sub-work.** If you spawn a sub-agent or open a nested PR, point at the parent.
- **Resources are URIs.** A PR link, a design doc, a related task — attach as a resource so it lives independently and can be referenced.

## Backends

The MCP server's storage is configured via env when the plugin loads:

- `TASKWATCH_DATA` — local FS root for the rig. Default: `~/.taskwatch/data`.
- `TASKWATCH_BACKEND` — when set to an HTTP URL, the MCP fronts a remote b3nd rig instead of writing locally. Used for shared/cloud scope.

You don't need to know which is active; the PIN surface is the same either way.
