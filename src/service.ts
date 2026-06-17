/**
 * Service layer — high-level operations over any ProtocolInterfaceNode.
 *
 * Same surface works against a local in-process rig (CLI), a rig hosted
 * over HTTP (web UI), or a rig reached via MCP. Operations decompose
 * into a small number of `receive` / `read` calls so the wire stays
 * uniform across transports.
 */

import type { Output, ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";

import {
  generateTaskId,
  HASH_SCHEME,
  isValidTaskId,
  parseUri,
  resourceUri,
  taskUri,
  type TaskContext,
  type TaskMeta,
  type TaskResource,
  type TaskStatus,
  type TaskUpdate,
  type UpdateKind,
  updateUri,
  validateTaskMeta,
  validateTaskResource,
  validateTaskUpdate,
} from "./protocol.ts";

const enc = new TextEncoder();

async function sha256Hex(input: Uint8Array): Promise<string> {
  const copy = new Uint8Array(input);
  const buf = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compute the content-addressed URI for a payload (utf8 string). */
export async function hashUriFor(text: string): Promise<string> {
  const bytes = enc.encode(text);
  return `${HASH_SCHEME}${await sha256Hex(bytes)}`;
}

function expectAccepted(uri: string, results: { accepted: boolean; error?: string }[]) {
  for (const r of results) {
    if (!r.accepted) {
      throw new Error(`receive rejected for ${uri}: ${r.error ?? "unknown"}`);
    }
  }
}

/** Read a single URI; returns the decoded payload or undefined. */
async function readOne<T>(node: ProtocolInterfaceNode, uri: string): Promise<T | undefined> {
  const [[, payload]] = await node.read<T>([uri]);
  return payload === undefined || payload === null ? undefined : payload;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  parent?: string;
  tags?: string[];
  context?: TaskContext;
  ownerPubkey?: string;
  /** Override the generated id (must be valid). */
  id?: string;
}

export interface CreateTaskResult {
  uri: string;
  meta: TaskMeta;
}

/** Create a new task. Writes the description as content-addressed bytes, then the metadata. */
export async function createTask(
  node: ProtocolInterfaceNode,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  if (!input.title || !input.title.trim()) {
    throw new Error("createTask: title required");
  }
  const id = input.id ?? generateTaskId();
  if (!isValidTaskId(id)) throw new Error(`invalid task id: ${id}`);

  let contentRef: string | undefined;
  if (input.description && input.description.length > 0) {
    contentRef = await hashUriFor(input.description);
    const r1 = await node.receive([[contentRef, enc.encode(input.description)]]);
    expectAccepted(contentRef, r1);
  }

  const now = Date.now();
  const meta: TaskMeta = {
    id,
    title: input.title.trim(),
    status: input.status ?? "active",
    createdAt: now,
    updatedAt: now,
    ownerPubkey: input.ownerPubkey,
    contentRef,
    parent: input.parent,
    tags: input.tags && input.tags.length > 0 ? [...input.tags] : undefined,
    context: input.context,
    updateCount: 0,
    updateUris: [],
    resourceUris: [],
  };
  validateTaskMeta(meta);
  const uri = taskUri(id);
  const r2 = await node.receive([[uri, meta]]);
  expectAccepted(uri, r2);
  return { uri, meta };
}

export async function getTask(
  node: ProtocolInterfaceNode,
  id: string,
): Promise<TaskMeta | undefined> {
  return await readOne<TaskMeta>(node, taskUri(id));
}

export async function getContent(
  node: ProtocolInterfaceNode,
  contentRef: string,
): Promise<string | undefined> {
  if (parseUri(contentRef)?.kind !== "hash") return undefined;
  const payload = await readOne<unknown>(node, contentRef);
  if (payload === undefined) return undefined;
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

export async function listTasks(
  node: ProtocolInterfaceNode,
  filter: { status?: TaskStatus; tag?: string; parent?: string } = {},
): Promise<TaskMeta[]> {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.tag) q.set("tag", filter.tag);
  if (filter.parent) q.set("parent", filter.parent);
  const locator = `task://t/list${q.toString() ? `?${q.toString()}` : ""}`;
  const result = await readOne<TaskMeta[]>(node, locator);
  return result ?? [];
}

export interface AppendUpdateInput {
  taskId: string;
  kind: UpdateKind;
  message?: string;
  body?: string;
  /** Optional structured payload merged into the update record. */
  payload?: Record<string, unknown>;
  /** Optional status the parent task should move to. */
  newStatus?: TaskStatus;
  ownerPubkey?: string;
}

export interface AppendUpdateResult {
  uri: string;
  update: TaskUpdate;
  meta: TaskMeta;
}

export async function appendUpdate(
  node: ProtocolInterfaceNode,
  input: AppendUpdateInput,
): Promise<AppendUpdateResult> {
  const meta = await getTask(node, input.taskId);
  if (!meta) throw new Error(`task not found: ${input.taskId}`);

  let contentRef: string | undefined;
  if (input.body && input.body.length > 0) {
    contentRef = await hashUriFor(input.body);
    const r1 = await node.receive([[contentRef, enc.encode(input.body)]]);
    expectAccepted(contentRef, r1);
  }

  const seq = meta.updateCount;
  const uri = updateUri(meta.id, seq);
  const update: TaskUpdate = {
    taskId: meta.id,
    seq,
    ts: Date.now(),
    kind: input.kind,
    ownerPubkey: input.ownerPubkey,
    message: input.message,
    contentRef,
    payload: input.payload,
  };
  validateTaskUpdate(update);
  const r2 = await node.receive([[uri, update]]);
  expectAccepted(uri, r2);

  const nextMeta: TaskMeta = {
    ...meta,
    status: input.newStatus ?? meta.status,
    updatedAt: update.ts,
    updateCount: seq + 1,
    updateUris: [...meta.updateUris, uri],
  };
  validateTaskMeta(nextMeta);
  const r3 = await node.receive([[taskUri(meta.id), nextMeta]]);
  expectAccepted(taskUri(meta.id), r3);

  return { uri, update, meta: nextMeta };
}

export async function listUpdates(
  node: ProtocolInterfaceNode,
  taskId: string,
): Promise<TaskUpdate[]> {
  const meta = await getTask(node, taskId);
  if (!meta) return [];
  const reads = await node.read<TaskUpdate>(meta.updateUris);
  const out: TaskUpdate[] = [];
  for (const [, u] of reads) {
    if (u && typeof u === "object") out.push(u);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export interface AddResourceInput {
  taskId: string;
  name: string;
  kind: string;
  url?: string;
  body?: string;
  payload?: Record<string, unknown>;
}

export interface AddResourceResult {
  uri: string;
  resource: TaskResource;
  meta: TaskMeta;
}

export async function addResource(
  node: ProtocolInterfaceNode,
  input: AddResourceInput,
): Promise<AddResourceResult> {
  const meta = await getTask(node, input.taskId);
  if (!meta) throw new Error(`task not found: ${input.taskId}`);

  let contentRef: string | undefined;
  if (input.body && input.body.length > 0) {
    contentRef = await hashUriFor(input.body);
    const r1 = await node.receive([[contentRef, enc.encode(input.body)]]);
    expectAccepted(contentRef, r1);
  }

  const uri = resourceUri(meta.id, input.name);
  const resource: TaskResource = {
    taskId: meta.id,
    name: input.name,
    kind: input.kind,
    ts: Date.now(),
    url: input.url,
    contentRef,
    payload: input.payload,
  };
  validateTaskResource(resource);
  const r2 = await node.receive([[uri, resource]]);
  expectAccepted(uri, r2);

  const nextResourceUris = meta.resourceUris.includes(uri)
    ? meta.resourceUris
    : [...meta.resourceUris, uri];
  const nextMeta: TaskMeta = {
    ...meta,
    updatedAt: resource.ts,
    resourceUris: nextResourceUris,
  };
  const r3 = await node.receive([[taskUri(meta.id), nextMeta]]);
  expectAccepted(taskUri(meta.id), r3);

  return { uri, resource, meta: nextMeta };
}

export async function listResources(
  node: ProtocolInterfaceNode,
  taskId: string,
): Promise<TaskResource[]> {
  const meta = await getTask(node, taskId);
  if (!meta) return [];
  const reads = await node.read<TaskResource>(meta.resourceUris);
  const out: TaskResource[] = [];
  for (const [, r] of reads) {
    if (r && typeof r === "object") out.push(r);
  }
  return out;
}

/** Convenience: status-only update. */
export function setStatus(
  node: ProtocolInterfaceNode,
  taskId: string,
  to: TaskStatus,
  note?: string,
): Promise<AppendUpdateResult> {
  return appendUpdate(node, {
    taskId,
    kind: "status",
    newStatus: to,
    message: note ?? `status → ${to}`,
    payload: { to },
  });
}

/** Helper for routes that need both the rig and the node — the rig is fine. */
export type Node = ProtocolInterfaceNode;
export type { Output };
