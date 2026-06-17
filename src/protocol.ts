/**
 * Taskwatch protocol — URI scheme, types, URI helpers, validation.
 *
 * The metadata document at `task://{id}` is the index. Content (descriptions,
 * update bodies) is content-addressed at `hash://sha256/{hex}` and referenced
 * via `contentRef`. Updates and resources are themselves URIs so the protocol
 * is uniform across CLI, HTTP, and MCP.
 */

export const TASK_SCHEME = "task://";
/** Top-level path component holding task metadata. Storage prefix for listing. */
export const TASK_PATH = "t/";
export const TASK_PREFIX = TASK_SCHEME + TASK_PATH;
export const HASH_SCHEME = "hash://sha256/";

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

export const UPDATE_KINDS = [
  "note",
  "status",
  "progress",
  "resource",
  "rot",
  "supersede",
  "handoff",
] as const;

export type UpdateKind = typeof UPDATE_KINDS[number];

export interface TaskContext {
  /** Working tree path, when known. */
  worktree?: string;
  /** Repo identifier (e.g. owner/name). */
  repo?: string;
  /** Branch under work. */
  branch?: string;
  /** Pull request URL. */
  pr?: string;
  /** The agent (or human) doing the work. Free-form. */
  agent?: string;
}

export interface TaskMeta {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  /** Pubkey of the writer who created the task, when signed. */
  ownerPubkey?: string;
  /** `hash://sha256/...` pointing to the original task description. */
  contentRef?: string;
  /** Parent task URI, when this task was spawned from another. */
  parent?: string;
  tags?: string[];
  context?: TaskContext;
  /** Append-only sequence counter for updates. */
  updateCount: number;
  /** URIs of all updates for this task, in order. */
  updateUris: string[];
  /** URIs of attached resources. */
  resourceUris: string[];
}

export interface TaskUpdate {
  taskId: string;
  seq: number;
  ts: number;
  kind: UpdateKind;
  /** Pubkey of the writer, when signed. */
  ownerPubkey?: string;
  /** Free-form short message (one line). */
  message?: string;
  /** `hash://sha256/...` pointing to longer body content, when relevant. */
  contentRef?: string;
  /** Optional structured payload (e.g. `{ from: "active", to: "rotting" }`). */
  payload?: Record<string, unknown>;
}

export interface TaskResource {
  taskId: string;
  name: string;
  /** Free-form kind: "link" | "file" | "pr" | "issue" | ... */
  kind: string;
  ts: number;
  url?: string;
  contentRef?: string;
  payload?: Record<string, unknown>;
}

// ---------- URI helpers ----------

/** A task id is a short URL-safe slug: lowercase a-z 0-9 and `-`. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}

export function assertValidTaskId(id: string): void {
  if (!isValidTaskId(id)) {
    throw new Error(
      `invalid task id ${JSON.stringify(id)}: must match ${TASK_ID_RE}`,
    );
  }
}

export function taskUri(id: string): string {
  assertValidTaskId(id);
  return `${TASK_PREFIX}${id}`;
}

export function updateUri(taskId: string, seq: number): string {
  assertValidTaskId(taskId);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`invalid update seq: ${seq}`);
  }
  return `${TASK_PREFIX}${taskId}/u/${String(seq).padStart(6, "0")}`;
}

const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function resourceUri(taskId: string, name: string): string {
  assertValidTaskId(taskId);
  if (!RESOURCE_NAME_RE.test(name)) {
    throw new Error(
      `invalid resource name ${JSON.stringify(name)}: must match ${RESOURCE_NAME_RE}`,
    );
  }
  return `${TASK_PREFIX}${taskId}/r/${name}`;
}

export type ParsedUri =
  | { kind: "task"; taskId: string }
  | { kind: "update"; taskId: string; seq: number }
  | { kind: "resource"; taskId: string; name: string }
  | { kind: "index"; query: URLSearchParams }
  | { kind: "hash"; algo: "sha256"; hex: string };

export function parseUri(uri: string): ParsedUri | null {
  if (uri.startsWith(HASH_SCHEME)) {
    const hex = uri.slice(HASH_SCHEME.length);
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    return { kind: "hash", algo: "sha256", hex };
  }
  if (!uri.startsWith(TASK_PREFIX)) return null;
  const rest = uri.slice(TASK_PREFIX.length);
  // Index: task://t/list[?...] — special list locator nested in the same prefix
  // so it routes alongside the task data.
  if (rest === "list" || rest.startsWith("list?")) {
    const qIdx = rest.indexOf("?");
    const query = new URLSearchParams(qIdx >= 0 ? rest.slice(qIdx + 1) : "");
    return { kind: "index", query };
  }
  const [path, _q] = rest.split("?", 2);
  const parts = path.split("/");
  const id = parts[0];
  if (!id || !isValidTaskId(id)) return null;
  if (parts.length === 1) return { kind: "task", taskId: id };
  if (parts.length === 3 && parts[1] === "u") {
    const seq = Number(parts[2]);
    if (!Number.isInteger(seq) || seq < 0) return null;
    return { kind: "update", taskId: id, seq };
  }
  if (parts.length === 3 && parts[1] === "r") {
    const name = parts[2];
    if (!RESOURCE_NAME_RE.test(name)) return null;
    return { kind: "resource", taskId: id, name };
  }
  return null;
}

// ---------- payload validators ----------

function isStringOrUndef(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

export function validateTaskMeta(value: unknown): asserts value is TaskMeta {
  if (!value || typeof value !== "object") throw new Error("TaskMeta: not an object");
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !isValidTaskId(v.id)) {
    throw new Error("TaskMeta.id: invalid task id");
  }
  if (typeof v.title !== "string" || v.title.length === 0) {
    throw new Error("TaskMeta.title: non-empty string required");
  }
  if (typeof v.status !== "string" || !TASK_STATUSES.includes(v.status as TaskStatus)) {
    throw new Error(`TaskMeta.status: must be one of ${TASK_STATUSES.join(", ")}`);
  }
  if (typeof v.createdAt !== "number" || typeof v.updatedAt !== "number") {
    throw new Error("TaskMeta.createdAt/updatedAt: numbers required");
  }
  if (typeof v.updateCount !== "number" || v.updateCount < 0) {
    throw new Error("TaskMeta.updateCount: non-negative number required");
  }
  if (!Array.isArray(v.updateUris) || !v.updateUris.every((u) => typeof u === "string")) {
    throw new Error("TaskMeta.updateUris: string[]");
  }
  if (!Array.isArray(v.resourceUris) || !v.resourceUris.every((u) => typeof u === "string")) {
    throw new Error("TaskMeta.resourceUris: string[]");
  }
  if (!isStringOrUndef(v.contentRef)) throw new Error("TaskMeta.contentRef: string?");
  if (!isStringOrUndef(v.parent)) throw new Error("TaskMeta.parent: string?");
  if (!isStringOrUndef(v.ownerPubkey)) throw new Error("TaskMeta.ownerPubkey: string?");
  if (
    v.tags !== undefined &&
    (!Array.isArray(v.tags) || !v.tags.every((t) => typeof t === "string"))
  ) {
    throw new Error("TaskMeta.tags: string[]?");
  }
}

export function validateTaskUpdate(value: unknown): asserts value is TaskUpdate {
  if (!value || typeof value !== "object") throw new Error("TaskUpdate: not an object");
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== "string" || !isValidTaskId(v.taskId)) {
    throw new Error("TaskUpdate.taskId: invalid");
  }
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) {
    throw new Error("TaskUpdate.seq: non-negative integer required");
  }
  if (typeof v.ts !== "number") throw new Error("TaskUpdate.ts: number required");
  if (typeof v.kind !== "string" || !UPDATE_KINDS.includes(v.kind as UpdateKind)) {
    throw new Error(`TaskUpdate.kind: must be one of ${UPDATE_KINDS.join(", ")}`);
  }
}

export function validateTaskResource(value: unknown): asserts value is TaskResource {
  if (!value || typeof value !== "object") throw new Error("TaskResource: not an object");
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== "string" || !isValidTaskId(v.taskId)) {
    throw new Error("TaskResource.taskId: invalid");
  }
  if (typeof v.name !== "string" || !RESOURCE_NAME_RE.test(v.name)) {
    throw new Error("TaskResource.name: invalid");
  }
  if (typeof v.kind !== "string" || v.kind.length === 0) {
    throw new Error("TaskResource.kind: non-empty string required");
  }
  if (typeof v.ts !== "number") throw new Error("TaskResource.ts: number required");
}

// ---------- id generation ----------

/** Short URL-safe random id: 10 lowercase alphanumerics (~50 bits). */
export function generateTaskId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
