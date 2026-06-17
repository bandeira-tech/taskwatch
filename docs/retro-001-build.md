# Build retro — taskwatch v0.0.2

What hurt, what would have been smoother, and what to fix. From one session of building taskwatch from scratch, shipping it, installing it as a Claude Code plugin, and dogfooding it to track its own build.

Grouped by where the pain lives. Each item: **pain** (what went wrong) + **fix** (concrete proposal).

---

## A. Agent-driven protocol UX

This is the biggest cluster. The "MCP is a pure b3nd PIN" decision is right architecturally, but the cost falls on the agent doing the bookkeeping by hand.

### A1. Multi-step writes are brittle boilerplate

**Pain.** To create a task, the agent must: pick an id, encode the description to UTF-8, SHA-256-hex it, build a 12-field TaskMeta (with `createdAt`/`updatedAt`/`updateCount: 0`/`updateUris: []`/`resourceUris: []`/...), and batch it with the hash content. To append an update: read current meta, take `updateCount` as seq, pad to 6 digits, build the update, build the *full updated meta* with `updateCount + 1` and `updateUris` appended, batch it. I had to use Bash to compute SHA-256 inside this session because the MCP doesn't help with it.

**Fix.** Add programs to the rig (b3nd-canon style) that take a high-level "write" message and decompose it into the right `Output[]`. E.g. send `[["task://t/create", { title, description, tags, ... }]]` and the program: (1) writes content to `hash://sha256/...`, (2) writes the meta with auto-filled seq/timestamps/refs. The MCP surface stays `b3nd_receive` — only the *protocol* gains higher-order verbs. Same for `task://t/{id}/update` and `task://t/{id}/resource`.

### A2. `hash://` content comes back as a numeric-keyed object over MCP

**Pain.** `b3nd_read(["hash://sha256/<hex>"])` returns `{ "0": 66, "1": 117, ... }` — JSON-serialised bytes. The web UI's `decodeHashContent` already handles this; agents calling MCP get a wall of integers and have to know to decode. We saw it firsthand in `/taskwatch:view`.

**Fix.** In `TaskwatchNode.read`, when the URI is `hash://sha256/...` and the bytes are valid UTF-8, surface a string. Otherwise wrap as `{ encoding: "base64", content: "..." }`. Either way, never let raw byte-objects leak out.

### A3. Slash commands are prose checklists, not enforced flows

**Pain.** `/taskwatch:track` lists steps in prose ("compute the hash, then write the batch, etc."). Nothing stops the agent from skipping the description, omitting `updateCount`, or padding seq wrong. We did the right thing because we read the SKILL.md carefully — that won't always be true.

**Fix.** Combine with A1: once the protocol has higher-order programs (`task://t/create`, `task://t/{id}/update`), the slash commands become one-shot calls. The skill stays as background reference; the commands no longer rely on the agent threading a sequence correctly.

### A4. `$ARGUMENTS` is freeform — every command parses its own DSL

**Pain.** `/taskwatch:update twbuild001 lunch break` — what's the id vs the message? Each command's prose says "expected form: `<id> <message...>`", which is a parsing contract the agent has to honour. Error-prone.

**Fix.** Use the AskUserQuestion tool inside commands for structured args, or define commands with frontmatter-declared arg fields if/when Claude Code adds support. Until then, document `$ARGUMENTS` parsing more defensively (e.g. accept JSON if the agent has it).

### A5. No `delete` or `correct` story

**Pain.** Mistyped tasks stay forever; you can only `supersede` them with an update. The b3nd-save layer supports `payload === null` as delete-by-convention, but no slash command exposes it.

**Fix.** Add `/taskwatch:delete <id>` and a corresponding program. Soft-delete (status: abandoned) by default; `--hard` for actual deletion that also unlinks the `hash://` content if no other task references it.

---

## B. Protocol design

### B1. The `task://t/` prefix is a storage leak

**Pain.** I had to switch from `task://{id}` to `task://t/{id}` mid-build because `FsStore`'s prefix-based listing needed a path component. The protocol URI now carries a single-letter `t/` that exists only because of how filesystem dirs work.

**Fix.** Either (a) move list synthesis into `TaskwatchNode` independent of FsStore's prefix behaviour (we already do that — the `t/` is now redundant), and rename to `task://{id}`; or (b) embrace the structure and make it semantically meaningful (`task://m/{id}` = metadata, future `task://q/{name}` = saved query). Either way, decouple from the storage backend's quirks.

### B2. Every update rewrites the full TaskMeta

**Pain.** No patch semantics. To append one update we send the whole meta back (id, title, status, createdAt, updatedAt, contentRef, parent, tags, context, updateCount, updateUris, resourceUris). Bandwidth's fine; correctness is the worry — forget a field, you silently corrupt the row.

**Fix.** Either (a) the program approach from A1 — the agent sends a delta and the program reads current state and writes the full record server-side, or (b) introduce a CRDT-shaped meta where `updateUris` is `task://t/{id}/updateUris` as its own append-only URI. Option (a) is simpler.

### B3. No identity / signing wired

**Pain.** `ownerPubkey` is optional in TaskMeta and never set. Single-user local is fine, but the "shared scope" story (multiple agents writing to a remote rig) has no identity surface. Anyone can write anything.

**Fix.** Plug in a node identity (Ed25519, b3nd-core's `Identity`) at rig boot. Sign each write batch with a canon envelope. The MCP server picks an identity from env (`TASKWATCH_IDENTITY=<seed-or-key-path>`) and surfaces `pubkey` in status. Programs validate that `ownerPubkey` on writes matches the signing key.

### B4. No agent-id mechanism — `context.agent` is a free-form string

**Pain.** The premise was "track which agent is doing what". `context.agent` is `"claude"` or `"rafael"` — nothing stops two parallel sessions from clobbering each other's tasks.

**Fix.** Pair with B3: the signing identity *is* the agent id. A "claim" verb writes a `task://t/{id}/c/{pubkey}` resource. A task is "owned" by whoever last claimed it; releasing means writing a null. Surface ownership in lists.

### B5. Streaming for large content

**Pain.** Task descriptions and update bodies all marshal as a single payload. Fine for now; not fine for attached files or long logs.

**Fix.** The b3nd-save layer supports `ReadableStream<Uint8Array>` natively. The bottleneck is the MCP wire (JSON-RPC, no streaming). Defer until a use case actually demands it; document the limit.

---

## C. Live state and the UI

### C1. UI polls instead of observing

**Pain.** The web UI only re-renders on manual refresh or status-filter change. The protocol supports `observe`; we don't use it. New tasks created via MCP don't appear in the UI until you click refresh.

**Fix.** Open a WS or NDJSON observe stream from `app.js` to `task://t/**` and re-render affected tasks. b3nd-move's HTTP observe route already exists; add a small browser-side iterator.

### C2. Tailwind via CDN

**Pain.** `<script src="https://cdn.tailwindcss.com">` is fine for v0 but not for production-grade hosting.

**Fix.** Once anything else changes about the UI, move to a Vite build (matching `b3nd-web-rig`'s layout) with proper Tailwind v4 compilation. Not urgent.

### C3. No way to create/append from the agent path back to the UI

**Pain.** Agent writes a task via MCP; the UI doesn't know unless the human refreshes. The user mentioned reminders/nudges as a future capability — the same channel solves both.

**Fix.** Combine with C1. Once observe is wired, the UI surfaces a "new since you last looked" indicator; reminders are a server-side reaction that emits an observe ping or a system notification.

---

## D. Claude Code plugin distribution

### D1. `/plugin install <plugin>@<repo>` requires manual marketplace add first

**Pain.** First try failed with "Marketplace bandeira-tech/taskwatch not found". Had to `/plugin marketplace add bandeira-tech/taskwatch` then `/plugin install taskwatch@taskwatch`. The error didn't suggest the fix.

**Fix.** Out of our scope (Claude Code itself), but worth filing upstream: either auto-add marketplace from the `@repo` shorthand, or improve the error message to suggest `/plugin marketplace add <repo>`.

### D2. Version pinning prevents refetch when only file layout changes

**Pain.** Bumping `commands/` and `skills/` to repo root without bumping `version` left the installed plugin stuck at the old 0.0.1 cache. `/plugin update` reported "already at latest 0.0.1" until we bumped to 0.0.2 — two roundtrips lost.

**Fix.** Use content-hash (git SHA) for the plugin cache key, not just the declared `version`. Or add a `/plugin reinstall <name>` that bypasses the version check. Upstream again. Workaround in our docs: bump version on any plugin layout change.

### D3. Plugin layout convention is undocumented in the obvious places

**Pain.** I put `commands/` and `skills/` under `.claude-plugin/` initially because that felt symmetric with `.claude-plugin/plugin.json`. Wrong: they belong at the *repo root* alongside `.claude-plugin/`. Cost a commit + reinstall cycle.

**Fix.** Add a one-screen "plugin layout cheat sheet" to our repo docs (this file plus a `docs/plugin-layout.md`) so future plugin authors don't repeat the mistake. Upstream: a `claude-plugin validate` linter that flags this.

### D4. MCP server name collides with plugin name in the tool prefix

**Pain.** Tools surface as `mcp__plugin_taskwatch_taskwatch__b3nd_read` — the double `taskwatch` is the plugin name + the MCP server name. Cosmetic, but cluttered.

**Fix.** Rename the MCP server to something distinct in plugin.json, e.g. `"rig"`. Tools become `mcp__plugin_taskwatch_rig__b3nd_read`. Cleaner.

---

## E. b3nd build-time DX

### E1. b3nd type signatures aren't in the READMEs — only in code

**Pain.** I needed `ReceiveResult` shape, `EntityStore.write` signature, `ObserveEmitter._emit` vs `emit`, `StoreWriteResult` field names. The READMEs have prose; the truth is in `src/`. The `b3nd:b3nd` skill plugin is *outdated* (the workspace CLAUDE.md says so explicitly), so it can't be trusted.

**Fix.** Two paths: (a) keep doing what we did — grep the packages — and accept the cost; (b) generate API reference from the source into the b3nd skill so it's always current. (b) is upstream work on the b3nd skill.

### E2. JSR submodule imports each need their own deno.json entry

**Pain.** Had to add five separate entries to deno.json for `b3nd-move/mcp/service`, `b3nd-move/http/client`, `b3nd-move/http/service`, `b3nd-save/fs`, `b3nd-save/clients`. Each entry is the same JSR package, just a different export path.

**Fix.** Out of our scope, but if Deno supported subpath wildcards (`@bandeira-tech/b3nd-move/*` → `jsr:@bandeira-tech/b3nd-move@^0.17.1/*`) this would collapse to one line per package.

### E3. FsStore listing semantics aren't visible from the outside

**Pain.** Took a smoke test failure to discover that `task://` (no trailing path) doesn't list its children — FsStore needs a directory prefix. The behaviour is documented in `src/fs/store.ts` comments, not in any user-facing place.

**Fix.** Lift the rule into `b3nd-save`'s README: "URIs without a path component cannot be enumerated via `fn=ls`". Upstream. For us, the fix is B1.

### E4. `crypto.subtle.digest` strict-mode typing in Deno

**Pain.** `Uint8Array<ArrayBufferLike>` not assignable to `BufferSource`. Had to copy into a fresh `Uint8Array` and pass `.buffer as ArrayBuffer`. Mild paper-cut, but the kind that loses an agent a turn.

**Fix.** Tiny utility: `src/util/sha256.ts` that hides this. Use everywhere.

---

## F. Testing & validation

### F1. No unit tests shipped

**Pain.** We smoke-tested CLI → list works → call it done. The protocol validators (`validateTaskMeta`, `validateTaskUpdate`, `validateTaskResource`) have zero coverage. The TaskwatchNode encode/decode round-trip has zero coverage.

**Fix.** Land a `deno test -A` suite covering: each validator's reject path; round-trip encode/decode for TaskMeta/TaskUpdate/TaskResource; list-by-status/tag/parent. Memory store for fixtures. Single commit.

### F2. No browser test for the UI

**Pain.** We tested the HTTP route from curl, not the UI. The wire codec implementation in `web/b3nd-http.js` could be subtly wrong (off-by-one in length prefixes, base64 padding wrong) and we'd find out from a user.

**Fix.** Playwright test that boots `serve.ts`, creates a task via UI, asserts it appears in the list. Match `listorama-b3nd`'s pattern.

---

## Priority order (if I were picking three for the next session)

1. **A1 + B2** — programs for `task://t/create` and `task://t/{id}/update`. Collapses the agent boilerplate, eliminates the full-meta-rewrite footgun, makes A3 fall out for free.
2. **A2** — fix `hash://` decoding at the node layer. One-line behavioural change; eliminates a recurring agent confusion.
3. **C1** — wire observe through to the UI so it stops feeling like a snapshot tool.

Everything else can wait, but the agent-UX cluster (A) is what'll bite hardest if other people install this and try to drive it from a fresh session.
