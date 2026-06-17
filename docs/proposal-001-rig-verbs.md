# Proposal — higher-order verbs in the taskwatch rig

Addresses retro items **A1** (multi-step bookkeeping) and **B2** (full-meta rewrite), and unblocks **A3** (slash command brittleness) and **A5** (no delete). Status: draft.

## The pain we're collapsing

Today, to create a task, an agent has to compute a SHA-256 hash, generate an id, build a 12-field TaskMeta with zeroed counters and empty arrays, and batch it with the content. To append an update, the same agent has to read the current meta, increment a counter, pad a seq to 6 digits, and rewrite the entire meta record with the new counter and an appended URI array. Every step is a place where the agent gets it wrong silently and we corrupt state.

We can't move this to the MCP layer — the user's clear constraint is that the MCP stays a pure b3nd PIN (`b3nd_receive` / `b3nd_read` / `b3nd_status`), no `taskwatch_*` tools. So the bookkeeping has to move to **the protocol**, not the transport. The rig owns it.

## Design — intent URIs dispatched inside `TaskwatchNode`

The rig recognises a small set of *intent URIs* on `receive`. Each intent decomposes into the underlying storage writes the agent used to construct by hand. The storage URI scheme (`task://t/{id}`, `task://t/{id}/u/{seq}`, etc.) is unchanged — intent URIs are sugar on top.

```
task://?fn=create                — body: CreateInput
task://t/{id}?fn=update          — body: UpdateInput
task://t/{id}?fn=resource        — body: ResourceInput
task://t/{id}?fn=status          — body: StatusInput (sugar over update)
task://t/{id}?fn=delete          — body: { hard?: boolean }
task://?fn=list                  — read locator (already exists as task://t/list)
```

Intent URIs are reserved: the storage layer never writes records at them; `TaskwatchNode.receive` intercepts and expands.

### Why intent URIs and not bespoke b3nd messages

Two alternatives were considered and dropped:

1. **b3nd-canon envelopes** (`{ auth, inputs, outputs }`) — the right answer for atomicity and signing, but doesn't reduce the agent's bookkeeping; the agent still constructs the outputs list. Use canon later for B3 (signing).
2. **Custom verb URI schemes** (`task-create://`, `task-update://`) — multiplies schemes for no gain; the protocol shape gets messier.

Intent URIs reuse the `?fn=<verb>` pattern that `b3nd-save` already uses for reads (`?fn=ls`, `?fn=count`). Same dispatch shape, just on writes.

### Why dispatch inside `TaskwatchNode` and not via `Rig.programs`

`b3nd-core` has a programs/handlers model (programs classify, handlers transform). It's the canonical place for this kind of dispatch. For MVP we'll keep the dispatch inside `TaskwatchNode.receive` — same lifecycle, no separate registration, easier to test. When we want to split dispatch from storage (e.g. a different backend, or a remote rig fronting the same protocol), we extract to a program. Net work for that future refactor: small, because the dispatch is one function.

## Wire shapes

### `task://?fn=create`

```jsonc
// agent sends
b3nd_receive({ messages: [
  ["task://?fn=create", {
    "id": "abc123def4",        // optional; auto-generated if omitted
    "title": "build the auth flow",
    "description": "long markdown body",   // optional
    "status": "active",        // optional, default "active"
    "tags": ["auth"],          // optional
    "parent": "task://t/...",  // optional
    "context": { "worktree": "...", "branch": "...", "agent": "claude" }
  }]
]})
```

What the rig writes (decomposed):

```
hash://sha256/<sha256(description)>   — the description bytes (if description provided)
task://t/<id>                          — full TaskMeta with timestamps, contentRef, zeroed counters
```

Return shape:

```jsonc
[{ "accepted": true, "result": { "uri": "task://t/abc123def4", "id": "abc123def4" } }]
```

### `task://t/{id}?fn=update`

```jsonc
b3nd_receive({ messages: [
  ["task://t/abc123def4?fn=update", {
    "kind": "progress",         // default "note"
    "message": "spec drafted",
    "body": "longer notes...",  // optional, stored content-addressed
    "newStatus": "paused",      // optional, transitions task status
    "payload": { ... }          // optional structured extras
  }]
]})
```

What the rig writes:

```
hash://sha256/<sha256(body)>           — body bytes (if body provided)
task://t/{id}/u/<padded-seq>            — TaskUpdate record
task://t/{id}                           — updated TaskMeta (seq+1, appended uri, new updatedAt)
```

Return:

```jsonc
[{ "accepted": true, "result": { "uri": "task://t/abc123def4/u/000003", "seq": 3, "status": "paused" } }]
```

### `task://t/{id}?fn=resource`, `?fn=status`, `?fn=delete`

Same shape — body is the input record; the node reads current meta, builds the resource/transition/deletion, writes the expansion, returns the canonical URI.

`?fn=delete` with `{ hard: true }` walks `meta.updateUris`, `meta.resourceUris`, and `meta.contentRef`, then deletes them all plus the meta. Without `hard`, it's `?fn=status` → `abandoned` under the hood.

### Backwards compatibility

Raw URI writes still work. An agent (or a different client) can still call:

```
b3nd_receive({ messages: [
  ["hash://sha256/...", "..."],
  ["task://t/abc/u/000003", { ... }],
  ["task://t/abc", { ... }]
] })
```

The intent URIs are additive sugar, not a replacement. The protocol shape (`task://t/{id}` etc.) is the source of truth; intents are a write-side convenience.

## What changes in code

### `src/protocol.ts`

- Add `IntentVerb = "create" | "update" | "resource" | "status" | "delete"`
- Extend `ParsedUri` with `{ kind: "intent", verb: IntentVerb, taskId?: string, query: URLSearchParams }`
- Extend `parseUri` to recognise `?fn=<verb>` in the query and return the new kind

### `src/programs/intents.ts` (new)

A pure module the node calls. Exports one function per verb:

```ts
export async function expandCreate(
  input: CreateInput,
  ctx: { hashUriFor: (body: string) => Promise<string>, now: () => number },
): Promise<{ outputs: Output[], result: { uri: string, id: string } }>;

export async function expandUpdate(
  input: UpdateInput,
  ctx: { ..., meta: TaskMeta },
): Promise<{ outputs: Output[], result: { uri: string, seq: number, status: TaskStatus } }>;

// ... resource, status, delete
```

Pure functions, no IO. Easy to unit-test in isolation. The node provides the IO context (current meta, hash function, clock).

### `src/storage/taskwatch-node.ts`

`receive` gains a pre-pass:

```ts
async receive(msgs) {
  const expanded = [];
  const intentResults = new Map<number, IntentResult>();

  for (let i = 0; i < msgs.length; i++) {
    const [uri, payload] = msgs[i];
    const parsed = parseUri(uri);
    if (parsed?.kind === "intent") {
      const meta = parsed.taskId
        ? await this.loadMeta(parsed.taskId)
        : undefined;
      const { outputs, result } = await dispatch(parsed.verb, payload, { meta, ... });
      for (const out of outputs) expanded.push({ originalIndex: i, msg: out });
      intentResults.set(i, result);
    } else {
      expanded.push({ originalIndex: i, msg: msgs[i] });
    }
  }

  // existing write/delete logic on expanded list
  // collapse results back to original indices, attaching `result` from intents
}
```

The existing per-URI write/delete logic stays unchanged.

### `src/service.ts` (refactor)

The current `createTask`, `appendUpdate`, etc. functions in `service.ts` are the proof-of-design — they already do exactly the expansion the rig will now do. Move that logic into `src/programs/intents.ts` (split IO from pure transform). The CLI continues to use `service.ts`, which becomes a thin shim that calls the intent URIs through the rig instead of orchestrating the writes itself. The CLI's behaviour is unchanged; the orchestration just moved one layer down.

### `.claude-plugin/skills/taskwatch/SKILL.md`

Shrinks dramatically. The "Recommended flows" section becomes:

```
To create a task:
  b3nd_receive [["task://?fn=create", { title, description?, ... }]]

To append an update:
  b3nd_receive [["task://t/{id}?fn=update", { kind?, message, body?, newStatus? }]]

To attach a resource, change status, or delete: same shape with ?fn=resource, ?fn=status, ?fn=delete.
```

The agent no longer needs to know how to SHA-256, how to pad sequence numbers, or how to rewrite the meta. The protocol shape stays documented for read-side use.

### `commands/*.md`

Each slash command collapses to: "Call `b3nd_receive` with `[[..., { ... }]]`". No more multi-step checklists, no more "read meta first, then compute seq". The agent's job is just to fill the input shape.

### `src/cli.ts`

No surface change. `taskwatch new` and `taskwatch update` continue to work; internally they now go through the intent URIs (via service.ts → rig).

## Validation & error reporting

Each intent handler validates its input before computing any expansion. Bad input → `{ accepted: false, error: "create: title required" }` for that message. The rig still rejects per-message; partial batches behave as today.

For atomicity: the expansion is N store writes. If any fail mid-way, we leave a partial state — same as today. This is a known limitation of FsStore (no `atomicBatch`). Documenting; not solving in this proposal. The mitigation is content-first ordering: hash payloads write first, meta last, so a partial failure leaves dangling content (cheap) rather than dangling meta references (broken state).

## What this doesn't solve

- **A2** (`hash://` decoded as numeric object) — orthogonal; one-line fix in `TaskwatchNode.read`, do it alongside.
- **B3** (no signing) — explicitly deferred. Once we add canon envelopes for shared scopes, the verb dispatch becomes "verify envelope → expand outputs → write". The intent URI design is forward-compatible: the envelope can wrap a message whose output URI is an intent URI.
- **C1** (UI polls instead of observes) — separate workstream; doesn't depend on this.

## Implementation order

1. `src/protocol.ts` — extend `parseUri`, add intent types. ~30 LoC.
2. `src/programs/intents.ts` — extract from `service.ts`, pure functions. ~150 LoC.
3. `src/storage/taskwatch-node.ts` — pre-pass dispatch. ~60 LoC.
4. `src/service.ts` — rewrite as a thin shim. Net negative LoC.
5. Tests — round-trip each verb against MemoryStore. ~200 LoC.
6. Skill + commands rewrite. ~40 LoC removed.
7. Bump to 0.1.0; ship.

Estimated session: one focused sitting, no surprises. The riskiest piece is the result-URI return convention — depends whether `ReceiveResult` can carry a `result` field without upstreaming to b3nd-core. If not, fall back: intent URIs require the caller to supply `id`, the canonical URI is derivable, and `accepted: true` is enough.
