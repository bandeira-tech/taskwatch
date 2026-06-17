# Proposal — paper-trail layout (taskwatch v0.1.0)

Supersedes `proposal-001-rig-verbs.md`. Reflects the design nudge: a task is **a tree of resources at a human-readable path**, written by appending, never by rewriting an envelope. JSON is dropped where b3nd's `[uri, payload]` shape carries the same data more cheaply.

## The shift

Today: a task is one JSON document at `task://t/{id}` with arrays for `updateUris`/`resourceUris` that get rewritten on every change. Updates are JSON records at `task://t/{id}/u/{seq}`. Content (descriptions, bodies) is content-addressed at `hash://sha256/…` and *referenced* from the JSON.

Proposed: a task is **a path prefix**. Each fact lives at its own URI. Each payload is plain text (or whatever bytes are natural for that fact). The "current state" of a task is derived by reading the relevant URIs and folding the entries. There is no meta document, no counter to bump, no array to maintain, no JSON to parse.

## URI layout

```
task://{ts}/{slug}/title                      # the title (text)
task://{ts}/{slug}/description                # the body, markdown (text)
task://{ts}/{slug}/context/worktree           # context fields, one URI per fact (text)
task://{ts}/{slug}/context/repo
task://{ts}/{slug}/context/branch
task://{ts}/{slug}/context/pr
task://{ts}/{slug}/context/agent
task://{ts}/{slug}/parent                     # parent task URI as a string (text)
task://{ts}/{slug}/tags/{tag}                 # presence-as-sentinel; delete to untag

task://{ts}/{slug}/entries/{ts2}-{kind}       # append-only history (text)
                                              # kind examples: status-paused, status-active,
                                              #                progress, note, handoff, rot

task://{ts}/{slug}/resources/{name}           # attached resource — link or content (text/bytes)
```

- `{ts}` is `YYYYMMDDhhmmss` UTC, derived from the create-time clock. Sortable. Human-readable. Fourteen digits.
- `{slug}` is the URL-safe slug of the title at create time (`fix-the-auth-flow`, `update-uri-schema-protocol`, ...). Lowercase alphanumeric + hyphens, max 60 chars. Slug never changes after creation (renaming the title does *not* re-slug — the path is the identity).
- `{ts2}` inside `entries/` is the entry-time `YYYYMMDDhhmmss` (or with `-NNN` suffix on collision). Monotonic, no shared counter.
- `{kind}` is the entry kind, embedded in the URI. The payload is the human-readable note; the kind is parseable from the URI alone.

## Reading state

The "current view" of a task is derived from its tree, not stored separately:

| Field           | How it's derived |
|-----------------|-------------------------------------------------------------|
| title           | read `…/title`                                              |
| description     | read `…/description`                                        |
| context.*       | list `…/context/?fn=ls&format=full`                         |
| parent          | read `…/parent`                                             |
| tags            | list `…/tags/?fn=ls&format=uris` (strip prefix → tag names) |
| status          | list `…/entries/?fn=ls&format=uris`, pick the latest URI matching `*-status-*`, take the trailing token. Default `active` if none. |
| updates count   | count of `…/entries/`                                       |
| updatedAt       | timestamp of the latest entry, or of `…/title` if no entries |
| resources       | list `…/resources/?fn=ls&format=full`                       |

One synthetic read locator hides the fan-out behind a single call:

```
task://{ts}/{slug}/?fn=view
```

`TaskwatchNode` resolves this by issuing the seven reads in parallel against the store and returning the folded state object (purely a convenience — the underlying URIs remain the truth).

## Writing — the paper trail

### Create a task

```jsonc
b3nd_receive({ messages: [
  ["task://20260628140000/update-uri-schema-protocol/title",
   "Update URI schema to a paper-trail layout"],

  ["task://20260628140000/update-uri-schema-protocol/description",
   "Drop the JSON meta doc. Move to slug-based paths, append-only entries,\nplain-text payloads. Each fact gets its own URI."],

  ["task://20260628140000/update-uri-schema-protocol/context/worktree",
   "/Users/m0/ws/taskwatch"],
  ["task://20260628140000/update-uri-schema-protocol/context/branch",
   "main"],
  ["task://20260628140000/update-uri-schema-protocol/context/agent",
   "claude"],

  ["task://20260628140000/update-uri-schema-protocol/tags/protocol", ""],
  ["task://20260628140000/update-uri-schema-protocol/tags/refactor", ""],

  ["task://index/20260628140000-update-uri-schema-protocol",
   "Update URI schema to a paper-trail layout"]
]})
```

Nine writes, one batch. Payloads are short text strings. No JSON, no counters, no hashes, no array maintenance. The agent computed: timestamp (one wall-clock read), slug (one string transform from title), the URIs (concatenations).

### Append a status update

```jsonc
b3nd_receive({ messages: [
  ["task://20260628140000/update-uri-schema-protocol/entries/20260628153000-status-paused",
   "lunch — back in 45min"]
]})
```

**One write.** No read first. No counter bump. The new status (`paused`) is in the URI path; the payload is the human note. The next time someone reads the task, the fold picks this up as "current status: paused".

### Append a progress note

```jsonc
b3nd_receive({ messages: [
  ["task://20260628140000/update-uri-schema-protocol/entries/20260628170000-progress",
   "rewrote protocol.ts, listing works against task://index/, tests next"]
]})
```

One write. Plain text payload, can be multi-line markdown.

### Attach a resource

```jsonc
b3nd_receive({ messages: [
  ["task://20260628140000/update-uri-schema-protocol/resources/pr",
   "https://github.com/bandeira-tech/taskwatch/pull/5"]
]})
```

One write. The resource payload IS the URL. For binary resources or richer ones, the payload is whatever bytes fit — no envelope.

### Tag changes

```jsonc
b3nd_receive({ messages: [
  ["task://.../tags/auth", ""]   // add
]})
b3nd_receive({ messages: [
  ["task://.../tags/auth", null] // null = delete (b3nd convention)
]})
```

### Edit the title or description

```jsonc
b3nd_receive({ messages: [
  ["task://.../title", "Update URI schema (paper-trail v2)"]
]})
```

Last-write-wins on title/description/context — these are facts, not events. To preserve the prior title in the audit log, write an entry too:

```jsonc
b3nd_receive({ messages: [
  ["task://.../title", "New title"],
  ["task://.../entries/20260628181500-title-changed",
   "was: 'Old title'"]
]})
```

That's a *policy*, not a mechanic the protocol enforces. Cheap to do; the agent skill calls it out.

## The index

Listing all tasks requires somewhere FsStore can enumerate. `task://?fn=ls` cannot reach across timestamp subdirectories under the current FsStore (only direct files in one dir are listed). So we maintain a simple enumeration aid:

```
task://index/{ts}-{slug}     # payload = current title (cached for cheap listing)
```

Each task creation writes one extra URI to the index. Title edits update the index payload too. Hard deletes also delete the index entry.

Listing:

```jsonc
b3nd_read({ urls: ["task://index/?fn=ls&format=full"] })
// → [["task://index/20260628140000-update-uri-schema-protocol", "Update URI schema..."], ...]
```

Each result line gives the agent both the URI (decompose to recover `{ts}/{slug}`) and the current title. To get status as well, the agent reads each task's `entries/?fn=ls&format=uris` and inspects the latest. For now that's N+1; acceptable. Status indexes (`task://by-status/active/{ts}-{slug}`) can be added later if N grows.

The index is *cache-like* — it is derived state, not the source of truth. If it drifts (concurrent writer, crash mid-batch), it can be rebuilt by walking the task prefix. Until we hit the scale where that matters, we just maintain it on writes.

## Storage compatibility — what works today

This layout maps onto FsStore cleanly:

- `task://{ts}/{slug}/title` → `task_{ts}/{slug}/title.bin`
- `task://{ts}/{slug}/entries/{ts2}-{kind}` → `task_{ts}/{slug}/entries/{ts2}-{kind}.bin`
- `task://index/{ts}-{slug}` → `task_index/{ts}-{slug}.bin`

Listing under any non-empty path prefix (`task://{ts}/{slug}/entries/?fn=ls`) hits the shallow-list path FsStore already supports. The index lives at a one-segment prefix (`task_index/`) and lists naturally.

The only thing that does **not** work without the index URI is the global `task://?fn=ls` — FsStore can't see across the timestamp directories at the top level. The index is the workaround. Long-term, we could patch FsStore to support depth-N listing; not blocking this proposal.

## What the agent does end-to-end

The skill teaches the agent four operations. Each is a URI-construction exercise — no protocol object the agent has to fill in.

| Operation        | Writes (one batch)                                                |
|------------------|-------------------------------------------------------------------|
| create           | title, description, context/*, tags/*, index/{ts}-{slug}          |
| status change    | entries/{ts}-status-{new}                                         |
| progress note    | entries/{ts}-progress                                             |
| attach resource  | resources/{name}                                                  |
| edit title       | title, index/{ts}-{slug}, entries/{ts}-title-changed              |
| edit description | description, entries/{ts}-description-changed                    |
| delete (soft)    | entries/{ts}-status-abandoned                                     |
| delete (hard)    | each URI under task://{ts}/{slug}/ as `null` payload + index null |

Each row is one `b3nd_receive` call. No state to read first (except hard delete, which lists first). No counters, no array surgery, no JSON.

## What changes in the codebase

### `src/protocol.ts`

Replace the TaskMeta / TaskUpdate / TaskResource interfaces and validators. New exports:

- `taskRootUri(ts: string, slug: string)` and parsers for the new URI shapes
- `slugify(title: string): string`
- `formatTs(date: Date): string` — `YYYYMMDDhhmmss`
- `parseEntryUri(uri): { ts, slug, entryTs, kind }`
- `foldEntries(uris: string[]): { status, updatedAt, count }` — derive current status from entry URIs (payload not needed for status)

No JSON validators. The protocol's invariant is the URI shape, not a record schema.

### `src/storage/taskwatch-node.ts`

Smaller than today:

- Drop the JSON encode/decode special-casing. Payloads pass through as bytes (UTF-8 strings on the way in and out).
- Drop the synthetic `task://t/list` (was tied to old scheme). Add `task://{ts}/{slug}/?fn=view` synthetic locator that fans out into seven reads and returns the folded state.
- The store's plain `?fn=ls` works for everything else; no node-side filtering of URIs needed.

Roughly: net negative LoC vs today.

### `src/service.ts`

Functions become URI-construction one-liners. `createTask` becomes "compute slug + ts, build the eight URIs, single receive". `appendStatus` becomes "build one entry URI, single receive". The complex multi-step orchestration goes away because it was solving a self-inflicted problem (the JSON envelope).

### `src/cli.ts`

CLI commands map to the new service layer. Same UX (`taskwatch new`, `taskwatch list`, `taskwatch view`, `taskwatch update`, `taskwatch status`, `taskwatch resource`, `taskwatch rot`). Identifiers: accept either a full task root URI or a "ts-slug" or "slug" shortcut (resolve by listing if ambiguous).

### `commands/*.md` and `skills/taskwatch/SKILL.md`

Rewritten. Each command becomes ~10 lines describing the URI(s) to construct. The skill becomes a one-page reference: the URI tree, the fold rules, the four operations.

### `web/app.js`

The reads change shape. Render becomes more honest: we already had a folder/derivation step; now it's the explicit model.

## What this kills

- The JSON envelope on `task://t/{id}` — gone.
- The `updateCount` / `updateUris` / `resourceUris` arrays — gone. Listing is the source.
- The hash-then-meta two-step write — gone. Content lives where it belongs.
- Multi-step read-modify-write for appending an update — gone. One write.
- `task://t/` prefix — gone, replaced by per-task path + index.
- The `content`/`metadata` separation argument — gone. The separation now happens *naturally* because each fact is its own URI; nothing references anything through a string.

## What we give up

- **The single-document atomicity** of TaskMeta. With the JSON doc, one write replaced everything. Now create-task writes ~8 URIs; partial failure leaves an incomplete task. Mitigation: order matters (title last, so a half-failed create looks "untitled" in the index and is recoverable). Long-term: add the canon envelope for batches that need atomicity (orthogonal to this proposal).
- **Schema enforcement on a record level**. The old validators checked TaskMeta fields. Now the "shape" is the URI tree — the rig can validate URI shapes (entry URI must have `{ts}-{kind}` form, etc.), but it can't reject "you forgot to write a title" because there's no record to validate. The skill teaches the right URI set; missing-URI tasks just render as empty fields. Acceptable.
- **The `task://t/list` global listing** — replaced by `task://index/?fn=ls`, which is a maintained side index. Drift is possible (cheap to rebuild).
- **Content-addressing of bodies** (`hash://sha256/…`). Was a nice property — verifiable, dedup-able. Lost in this proposal because most bodies are short text and the addressing overhead is more than the value. We can keep `hash://sha256/…` reachable as an opt-in for callers who want to write content-addressed bytes and reference them from a resource — but it's no longer the default flow.

The content-addressing loss is the only one I'd flag for pushback. If you'd want it back as the default for `description` and entry bodies, the URI tree stays the same; we just have `description` → write hash content and reference it. I'd rather wait until a use case (verification? sharing?) demands it.

## Migration from v0.0.2

v0.0.2 is on disk as `task_t/{id}.bin` (JSON TaskMeta) plus `task_t/{id}/u/*.bin` etc.

v0.1.0 reads/writes the new layout. Migration script (one-shot Deno script):

1. List `task://t/?fn=ls&format=uris` — get every old task primary
2. For each:
   - Parse the old TaskMeta JSON
   - Pick `{ts}` from `createdAt` (formatted), `{slug}` from `slugify(title)`
   - Write `title`, `description` (from content hash dereferenced), `context/*`, `tags/*`, `parent`
   - For each old update at `…/u/{seq}`, parse the TaskUpdate JSON, write `entries/{old.ts formatted}-{kind}` with payload = old `message` (+ body content fetched from `contentRef`)
   - For each old resource, write `resources/{name}` with the URL or content
   - Write `index/{ts}-{slug}` with the title
3. Delete the old URIs at the end (after verification)

Single deno script, idempotent (skip if `index/{ts}-{slug}` already exists). Ships with v0.1.0.

## Implementation order

1. Migration script (writes v0.1.0 layout from v0.0.2 data, kept until removal in v0.2.0).
2. `src/protocol.ts` — new URI parsers, slugify, ts formatter, fold function.
3. `src/storage/taskwatch-node.ts` — drop JSON dispatch; add `?fn=view` synthetic.
4. `src/service.ts` — rewrite (net simpler).
5. `src/cli.ts` — adapt.
6. Tests — round-trip each operation, fold-status correctness.
7. Skill + commands rewrite (~70% less prose).
8. `web/app.js` — adapt reads.
9. Migrate the existing dogfood task (`twbuild001`); ship v0.1.0.

Larger rewrite than proposal-001 but smaller *behaviour* surface — most files end up smaller after.

## Open questions

1. **`{ts}` collisions** if two tasks are created in the same second. Resolution: detect via `index/?fn=ls&pattern=`, bump `{ts}` by 1 second, retry. Or append a 3-char random suffix to `{slug}`. Pick one in the implementation.
2. **Entry URI kind grammar** — should it be free-form (`entries/{ts}-{anything}`) or a closed set? I'd say a *recommended* set (`status-{value}`, `progress`, `note`, `handoff`, `rot`, `title-changed`, `description-changed`) with free-form allowed. Folding ignores unknown kinds.
3. **Whether to keep `task://t/{id}` working in parallel for the migration window.** Yes for one minor version: dual-read the old shape but new writes go to the new shape. Removes friction for anyone with existing data.
4. **Resource payload for non-URL kinds.** A PR is a URL; a file might want bytes; a "linked task" might want just the task URI. I'd say: any text the agent writes is the payload; the kind is implicit in the resource name (`pr`, `design-doc`, `parent-thread`) and the human note for it can live alongside as `resources/{name}.note` (separate URI, optional). Or skip the note and let the URI sit on its own.

If this shape lands well, the next move is wiring observe-based live updates into the UI (the retro's C1) — the paper-trail design makes that even simpler, because every fact is its own URI and a `task://**` observe stream gives you exactly the right granularity.
