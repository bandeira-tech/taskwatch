/**
 * Taskwatch protocol — paper-trail layout.
 *
 * A task is a tree of resources at:
 *
 *   {basepath}task/{ts}/{slug}/title
 *   {basepath}task/{ts}/{slug}/description
 *   {basepath}task/{ts}/{slug}/parent
 *   {basepath}task/{ts}/{slug}/context/{field}
 *   {basepath}task/{ts}/{slug}/tags/{tag}
 *   {basepath}task/{ts}/{slug}/entries/{ts2}-{kind}
 *   {basepath}task/{ts}/{slug}/resources/{name}
 *
 * Plus a maintained enumeration aid:
 *
 *   {basepath}index/{ts}-{slug}    payload: current title
 *
 * `{basepath}` is operator-chosen and injected at rig creation. Default
 * `taskwatch://`. Operators may mount the protocol under any prefix that
 * contains `://`; e.g. `app://work/` or `b3nd://node/personal/` so a
 * single rig can host taskwatch alongside other protocols at different
 * mount points.
 *
 * Each payload is plain UTF-8 text. There is no JSON envelope, no
 * counter, no meta document. State is derived by reading the tree and
 * folding the entries.
 */

export const DEFAULT_BASEPATH = "taskwatch://";

/** Protocol type segments — namespace under the basepath. */
export const TYPE_TASK = "task";
export const TYPE_INDEX = "index";

export const TASK_STATUSES = [
  "active",
  "paused",
  "blocked",
  "done",
  "abandoned",
  "rotting",
  "superseded",
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

/**
 * Recommended entry-kind grammar. The rig does not enforce; any kind
 * the URI accepts is recorded. Folding only looks at the well-known
 * patterns (`status-{value}`, `title-changed`, `description-changed`).
 */
export const ENTRY_KINDS = [
  "note",
  "progress",
  "handoff",
  "rot",
  "supersede",
  "title-changed",
  "description-changed",
  "accessed",
  // status-{value} is a family — see statusFromEntryKind below
] as const;

/** Identifies a task by its create-time timestamp + slug pair. */
export interface TaskAddress {
  ts: string;
  slug: string;
}

/** Tagged-union result of parsing a URI under our basepath. */
export type ParsedUri =
  | { kind: "task-root"; addr: TaskAddress }
  | { kind: "task-field"; addr: TaskAddress; field: "title" | "description" | "parent" }
  | { kind: "task-context"; addr: TaskAddress; field: string }
  | { kind: "task-tag"; addr: TaskAddress; tag: string }
  | { kind: "task-entry"; addr: TaskAddress; entryTs: string; entryKind: string }
  | { kind: "task-resource"; addr: TaskAddress; resource: string }
  | { kind: "task-list-root" }
  | { kind: "task-list-task"; addr: TaskAddress }
  | { kind: "index-root" }
  | { kind: "index-entry"; addr: TaskAddress };

// ────────────────────────────────────────────────────────────────────
// Basepath normalization

/** Ensure a basepath contains `://` and ends with `/`. Throws on malformed input. */
export function normalizeBasepath(basepath: string): string {
  if (!basepath) throw new Error("basepath required");
  if (!basepath.includes("://")) {
    throw new Error(`basepath must contain '://': ${basepath}`);
  }
  return basepath.endsWith("/") ? basepath : basepath + "/";
}

// ────────────────────────────────────────────────────────────────────
// Slug + timestamp utilities

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const TS_RE = /^[0-9]{14}$/;
const CONTEXT_FIELD_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENTRY_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidTs(ts: string): boolean {
  return TS_RE.test(ts);
}
export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}
export function isValidContextField(s: string): boolean {
  return CONTEXT_FIELD_RE.test(s);
}
export function isValidTag(s: string): boolean {
  return TAG_RE.test(s);
}
export function isValidResourceName(s: string): boolean {
  return RESOURCE_NAME_RE.test(s);
}
export function isValidEntryKind(s: string): boolean {
  return ENTRY_KIND_RE.test(s);
}

/** Slugify a title for the URI path. Lowercase, alphanumeric + hyphens, max 60 chars. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "task";
}

/** Format a Date as `YYYYMMDDhhmmss` in UTC. */
export function formatTs(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

/** Parse a `YYYYMMDDhhmmss` UTC timestamp back to a Date. */
export function parseTs(ts: string): Date {
  if (!isValidTs(ts)) throw new Error(`invalid ts: ${ts}`);
  return new Date(
    Date.UTC(
      Number(ts.slice(0, 4)),
      Number(ts.slice(4, 6)) - 1,
      Number(ts.slice(6, 8)),
      Number(ts.slice(8, 10)),
      Number(ts.slice(10, 12)),
      Number(ts.slice(12, 14)),
    ),
  );
}

export function nowTs(): string {
  return formatTs(new Date());
}

// ────────────────────────────────────────────────────────────────────
// URI builders

function pathSuffix(basepath: string, suffix: string): string {
  return basepath + suffix;
}

export function taskRootUri(basepath: string, addr: TaskAddress): string {
  return pathSuffix(basepath, `${TYPE_TASK}/${addr.ts}/${addr.slug}`);
}

export function taskFieldUri(
  basepath: string,
  addr: TaskAddress,
  field: "title" | "description" | "parent",
): string {
  return `${taskRootUri(basepath, addr)}/${field}`;
}

export function contextUri(basepath: string, addr: TaskAddress, field: string): string {
  if (!isValidContextField(field)) {
    throw new Error(`invalid context field: ${field}`);
  }
  return `${taskRootUri(basepath, addr)}/context/${field}`;
}

export function tagUri(basepath: string, addr: TaskAddress, tag: string): string {
  if (!isValidTag(tag)) throw new Error(`invalid tag: ${tag}`);
  return `${taskRootUri(basepath, addr)}/tags/${tag}`;
}

export function entryUri(
  basepath: string,
  addr: TaskAddress,
  entryTs: string,
  kind: string,
): string {
  if (!isValidTs(entryTs)) throw new Error(`invalid entry ts: ${entryTs}`);
  if (!isValidEntryKind(kind)) throw new Error(`invalid entry kind: ${kind}`);
  return `${taskRootUri(basepath, addr)}/entries/${entryTs}-${kind}`;
}

export function resourceUri(
  basepath: string,
  addr: TaskAddress,
  name: string,
): string {
  if (!isValidResourceName(name)) {
    throw new Error(`invalid resource name: ${name}`);
  }
  return `${taskRootUri(basepath, addr)}/resources/${name}`;
}

export function indexUri(basepath: string, addr: TaskAddress): string {
  return pathSuffix(basepath, `${TYPE_INDEX}/${addr.ts}-${addr.slug}`);
}

/** Listing locator for the task index (cheap enumeration of all tasks). */
export function indexListLocator(basepath: string, format: "uris" | "full" = "full"): string {
  return pathSuffix(basepath, `${TYPE_INDEX}/?fn=ls&format=${format}`);
}

/** Listing locator for a task's entries directory. */
export function entriesListLocator(
  basepath: string,
  addr: TaskAddress,
  format: "uris" | "full" = "full",
): string {
  return `${taskRootUri(basepath, addr)}/entries/?fn=ls&format=${format}`;
}

/** Listing locator for a task's resources directory. */
export function resourcesListLocator(
  basepath: string,
  addr: TaskAddress,
  format: "uris" | "full" = "full",
): string {
  return `${taskRootUri(basepath, addr)}/resources/?fn=ls&format=${format}`;
}

/** Listing locator for a task's context directory. */
export function contextListLocator(
  basepath: string,
  addr: TaskAddress,
  format: "uris" | "full" = "full",
): string {
  return `${taskRootUri(basepath, addr)}/context/?fn=ls&format=${format}`;
}

/** Listing locator for a task's tags directory. */
export function tagsListLocator(basepath: string, addr: TaskAddress): string {
  return `${taskRootUri(basepath, addr)}/tags/?fn=ls&format=uris`;
}

/** Synthetic locator returning the folded task view in one call. */
export function viewLocator(basepath: string, addr: TaskAddress): string {
  return `${taskRootUri(basepath, addr)}?fn=view`;
}

// ────────────────────────────────────────────────────────────────────
// Parser

/** Parse the index-entry path segment back to a TaskAddress. */
function parseIndexName(name: string): TaskAddress | null {
  const m = name.match(/^([0-9]{14})-(.+)$/);
  if (!m) return null;
  const [, ts, slug] = m;
  if (!isValidSlug(slug)) return null;
  return { ts, slug };
}

/** Parse the entry-leaf segment back to (entryTs, kind). */
function parseEntryLeaf(leaf: string): { entryTs: string; entryKind: string } | null {
  const m = leaf.match(/^([0-9]{14})-(.+)$/);
  if (!m) return null;
  const [, entryTs, entryKind] = m;
  if (!isValidEntryKind(entryKind)) return null;
  return { entryTs, entryKind };
}

/**
 * Parse a URI under `basepath`. Returns null if the URI is outside the
 * basepath or doesn't match a known shape. The query string is ignored
 * here; consumers parse `?fn=...` separately.
 */
export function parseUri(basepath: string, uri: string): ParsedUri | null {
  if (!uri.startsWith(basepath)) return null;
  const rest = uri.slice(basepath.length);
  const qIdx = rest.indexOf("?");
  const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const parts = path.split("/");

  // {basepath}index/...
  if (parts[0] === TYPE_INDEX) {
    if (parts.length === 1 || (parts.length === 2 && parts[1] === "")) {
      return { kind: "index-root" };
    }
    if (parts.length === 2) {
      const addr = parseIndexName(parts[1]);
      if (!addr) return null;
      return { kind: "index-entry", addr };
    }
    return null;
  }

  // {basepath}task/...
  if (parts[0] === TYPE_TASK) {
    if (parts.length === 1 || (parts.length === 2 && parts[1] === "")) {
      return { kind: "task-list-root" };
    }
    const ts = parts[1];
    if (!isValidTs(ts)) return null;
    if (parts.length === 2) return { kind: "task-list-root" };
    const slug = parts[2];
    if (!slug || !isValidSlug(slug)) return null;
    const addr: TaskAddress = { ts, slug };
    if (parts.length === 3) return { kind: "task-root", addr };
    if (parts.length === 4) {
      const sub = parts[3];
      if (sub === "title" || sub === "description" || sub === "parent") {
        return { kind: "task-field", addr, field: sub };
      }
      // Could be /entries, /resources, /context, /tags listings (no leaf)
      if (sub === "entries" || sub === "resources" || sub === "context" || sub === "tags") {
        return { kind: "task-list-task", addr };
      }
      return null;
    }
    if (parts.length === 5) {
      const sub = parts[3];
      const leaf = parts[4];
      if (!leaf) return { kind: "task-list-task", addr };
      if (sub === "context") {
        if (!isValidContextField(leaf)) return null;
        return { kind: "task-context", addr, field: leaf };
      }
      if (sub === "tags") {
        if (!isValidTag(leaf)) return null;
        return { kind: "task-tag", addr, tag: leaf };
      }
      if (sub === "entries") {
        const parsed = parseEntryLeaf(leaf);
        if (!parsed) return null;
        return { kind: "task-entry", addr, ...parsed };
      }
      if (sub === "resources") {
        if (!isValidResourceName(leaf)) return null;
        return { kind: "task-resource", addr, resource: leaf };
      }
      return null;
    }
    return null;
  }
  return null;
}

/** Extract `?fn=<verb>` from a locator. Returns null when absent. */
export function readFn(locator: string): { fn: string; params: URLSearchParams } | null {
  const qIdx = locator.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(locator.slice(qIdx + 1));
  const fn = params.get("fn");
  if (!fn) return null;
  return { fn, params };
}

// ────────────────────────────────────────────────────────────────────
// Folding

/** Extract a TaskStatus from an entry-kind segment, when applicable. */
export function statusFromEntryKind(kind: string): TaskStatus | undefined {
  if (!kind.startsWith("status-")) return undefined;
  const v = kind.slice("status-".length);
  return (TASK_STATUSES as readonly string[]).includes(v) ? (v as TaskStatus) : undefined;
}

export interface EntryRef {
  uri: string;
  entryTs: string;
  entryKind: string;
  body?: string;
}

/**
 * Fold a set of entry refs into the derived status, last-updated time,
 * and count. Pure — works on URIs alone; payloads are optional and not
 * required for status derivation.
 */
export function foldEntries(entries: EntryRef[]): {
  status: TaskStatus;
  latestTs: string | undefined;
  count: number;
} {
  let latestStatus: { ts: string; status: TaskStatus } | undefined;
  let latestTs: string | undefined;
  for (const e of entries) {
    // `accessed` records a read, not progress — exclude from "last update".
    if (e.entryKind !== "accessed" && (!latestTs || e.entryTs > latestTs)) {
      latestTs = e.entryTs;
    }
    const st = statusFromEntryKind(e.entryKind);
    if (st && (!latestStatus || e.entryTs > latestStatus.ts)) {
      latestStatus = { ts: e.entryTs, status: st };
    }
  }
  return {
    status: latestStatus?.status ?? "active",
    latestTs,
    count: entries.length,
  };
}

// ────────────────────────────────────────────────────────────────────
// Derived view

export interface TaskView {
  basepath: string;
  addr: TaskAddress;
  uri: string;
  title: string;
  description: string;
  status: TaskStatus;
  parent: string | undefined;
  context: Record<string, string>;
  tags: string[];
  entries: { uri: string; ts: string; kind: string; body: string }[];
  resources: { uri: string; name: string; body: string }[];
  createdAt: Date;
  updatedAt: Date;
}
