/**
 * Service layer — high-level operations over any ProtocolInterfaceNode.
 *
 * Each operation is a URI-construction exercise. No JSON envelope, no
 * read-modify-write meta document. Same code drives the CLI in-process,
 * the web UI over HTTP, and any agent over MCP.
 */

import type { Output, ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";

import {
  contextUri,
  type EntryRef,
  entriesListLocator,
  foldEntries,
  indexListLocator,
  indexUri,
  isValidEntryKind,
  isValidTag,
  nowTs,
  parseUri,
  resourceUri,
  slugify,
  type TaskAddress,
  type TaskStatus,
  type TaskView,
  taskFieldUri,
  taskRootUri,
  tagUri,
  viewLocator,
} from "./protocol.ts";

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  tags?: string[];
  parent?: string;
  /** Free-form fields under `context/`. */
  context?: Record<string, string>;
  /** Override the auto-generated address. */
  addr?: TaskAddress;
}

export interface CreateTaskResult {
  addr: TaskAddress;
  uri: string;
  writes: string[];
}

function expectAccepted(uri: string, results: { accepted: boolean; error?: string }[]) {
  for (const r of results) {
    if (!r.accepted) {
      throw new Error(`receive rejected for ${uri}: ${r.error ?? "unknown"}`);
    }
  }
}

async function readOne<T>(node: ProtocolInterfaceNode, uri: string): Promise<T | undefined> {
  const [[, payload]] = await node.read<T>([uri]);
  return payload === undefined || payload === null ? undefined : payload;
}

/**
 * Generate a `TaskAddress` for a new task. Slug derives from title;
 * timestamp is the current UTC second. If the resulting address is
 * already taken, the timestamp is bumped by one second and retried.
 */
export async function pickAddress(
  node: ProtocolInterfaceNode,
  basepath: string,
  title: string,
): Promise<TaskAddress> {
  const baseSlug = slugify(title);
  let ts = nowTs();
  for (let attempt = 0; attempt < 5; attempt++) {
    const addr = { ts, slug: baseSlug };
    const existing = await readOne<string>(node, indexUri(basepath, addr));
    if (!existing) return addr;
    // Bump by one second and retry.
    const next = new Date(
      Date.UTC(
        Number(ts.slice(0, 4)),
        Number(ts.slice(4, 6)) - 1,
        Number(ts.slice(6, 8)),
        Number(ts.slice(8, 10)),
        Number(ts.slice(10, 12)),
        Number(ts.slice(12, 14)) + 1,
      ),
    );
    ts = `${next.getUTCFullYear()}${
      String(next.getUTCMonth() + 1).padStart(2, "0")
    }${String(next.getUTCDate()).padStart(2, "0")}${
      String(next.getUTCHours()).padStart(2, "0")
    }${String(next.getUTCMinutes()).padStart(2, "0")}${
      String(next.getUTCSeconds()).padStart(2, "0")
    }`;
  }
  throw new Error(`address collision could not be resolved for slug=${baseSlug}`);
}

/** Create a new task. One batched write, no read-modify-write. */
export async function createTask(
  node: ProtocolInterfaceNode,
  basepath: string,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  if (!input.title || !input.title.trim()) {
    throw new Error("createTask: title required");
  }
  const title = input.title.trim();
  const addr = input.addr ?? await pickAddress(node, basepath, title);
  const messages: Output<string>[] = [];

  messages.push([taskFieldUri(basepath, addr, "title"), title]);
  if (input.description && input.description.length > 0) {
    messages.push([taskFieldUri(basepath, addr, "description"), input.description]);
  }
  if (input.parent) {
    messages.push([taskFieldUri(basepath, addr, "parent"), input.parent]);
  }
  if (input.context) {
    for (const [field, value] of Object.entries(input.context)) {
      if (value && value.length > 0) {
        messages.push([contextUri(basepath, addr, field), value]);
      }
    }
  }
  if (input.tags) {
    for (const tag of input.tags) {
      if (isValidTag(tag)) messages.push([tagUri(basepath, addr, tag), ""]);
    }
  }
  if (input.status && input.status !== "active") {
    // Initial status other than active recorded as the first entry.
    messages.push([
      `${taskRootUri(basepath, addr)}/entries/${addr.ts}-status-${input.status}`,
      `initial status: ${input.status}`,
    ]);
  }
  // Index entry carries the title for cheap listing.
  messages.push([indexUri(basepath, addr), title]);

  const results = await node.receive(messages);
  expectAccepted(taskRootUri(basepath, addr), results);

  return {
    addr,
    uri: taskRootUri(basepath, addr),
    writes: messages.map(([u]) => u),
  };
}

/** Append a status entry — single write, no read. */
export async function appendStatus(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  to: TaskStatus,
  note: string = "",
): Promise<string> {
  const uri = `${taskRootUri(basepath, addr)}/entries/${nowTs()}-status-${to}`;
  const results = await node.receive([[uri, note]]);
  expectAccepted(uri, results);
  return uri;
}

/** Append a free-form entry — single write. */
export async function appendEntry(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  kind: string,
  body: string,
): Promise<string> {
  if (!isValidEntryKind(kind)) throw new Error(`invalid entry kind: ${kind}`);
  const uri = `${taskRootUri(basepath, addr)}/entries/${nowTs()}-${kind}`;
  const results = await node.receive([[uri, body]]);
  expectAccepted(uri, results);
  return uri;
}

/** Attach a resource — single write. */
export async function addResource(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  name: string,
  body: string,
): Promise<string> {
  const uri = resourceUri(basepath, addr, name);
  const results = await node.receive([[uri, body]]);
  expectAccepted(uri, results);
  return uri;
}

/** Add or remove a tag (empty payload = present, null = delete). */
export async function setTag(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  tag: string,
  present: boolean,
): Promise<string> {
  const uri = tagUri(basepath, addr, tag);
  const results = await node.receive([[uri, present ? "" : null]]);
  expectAccepted(uri, results);
  return uri;
}

/** Set a context field. Last-write-wins on the URI. */
export async function setContext(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  field: string,
  value: string,
): Promise<string> {
  const uri = contextUri(basepath, addr, field);
  const results = await node.receive([[uri, value]]);
  expectAccepted(uri, results);
  return uri;
}

/** Rename the title. Updates the index payload + appends a title-changed entry. */
export async function setTitle(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  newTitle: string,
): Promise<void> {
  const prev = await readOne<string>(node, taskFieldUri(basepath, addr, "title"));
  const entryUri =
    `${taskRootUri(basepath, addr)}/entries/${nowTs()}-title-changed`;
  const messages: Output<string>[] = [
    [taskFieldUri(basepath, addr, "title"), newTitle],
    [indexUri(basepath, addr), newTitle],
    [entryUri, prev ? `was: ${prev}` : ""],
  ];
  const results = await node.receive(messages);
  expectAccepted(taskFieldUri(basepath, addr, "title"), results);
}

/** Replace the description. Appends a description-changed entry. */
export async function setDescription(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  newDescription: string,
): Promise<void> {
  const entryUri =
    `${taskRootUri(basepath, addr)}/entries/${nowTs()}-description-changed`;
  const messages: Output<string>[] = [
    [taskFieldUri(basepath, addr, "description"), newDescription],
    [entryUri, ""],
  ];
  const results = await node.receive(messages);
  expectAccepted(taskFieldUri(basepath, addr, "description"), results);
}

/** Fetch the folded TaskView in one round trip (via `?fn=view`). */
export async function getTask(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
): Promise<TaskView | undefined> {
  return await readOne<TaskView>(node, viewLocator(basepath, addr));
}

export interface TaskListEntry {
  addr: TaskAddress;
  title: string;
  uri: string;
}

/** List all tasks via the maintained index URI prefix. */
export async function listTasks(
  node: ProtocolInterfaceNode,
  basepath: string,
): Promise<TaskListEntry[]> {
  const locator = indexListLocator(basepath, "full");
  const out = await node.read<[string, string | undefined][]>([locator]);
  const rows = out[0]?.[1] ?? [];
  const tasks: TaskListEntry[] = [];
  for (const [uri, title] of rows) {
    const parsed = parseUri(basepath, uri);
    if (parsed?.kind !== "index-entry") continue;
    tasks.push({
      addr: parsed.addr,
      title: title ?? "",
      uri: taskRootUri(basepath, parsed.addr),
    });
  }
  tasks.sort((a, b) => b.addr.ts.localeCompare(a.addr.ts));
  return tasks;
}

/** List tasks with their derived status (N+1 reads — one per task). */
export async function listTasksWithStatus(
  node: ProtocolInterfaceNode,
  basepath: string,
): Promise<(TaskListEntry & { status: TaskStatus; updatedAt: string })[]> {
  const tasks = await listTasks(node, basepath);
  const reads = await Promise.all(
    tasks.map(async (t) => {
      const out = await node.read<string[]>([entriesListLocator(basepath, t.addr, "uris")]);
      const uris = out[0]?.[1] ?? [];
      const refs: EntryRef[] = [];
      for (const u of uris) {
        const parsed = parseUri(basepath, u);
        if (parsed?.kind === "task-entry") {
          refs.push({ uri: u, entryTs: parsed.entryTs, entryKind: parsed.entryKind });
        }
      }
      const folded = foldEntries(refs);
      return {
        ...t,
        status: folded.status,
        updatedAt: folded.latestTs ?? t.addr.ts,
      };
    }),
  );
  return reads;
}

/** Soft delete — append a status-abandoned entry. */
export async function softDelete(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
  note: string = "",
): Promise<string> {
  return await appendStatus(node, basepath, addr, "abandoned", note);
}

/**
 * Hard delete — enumerate every URI under the task root, plus the
 * index entry, and write null to delete each.
 */
export async function hardDelete(
  node: ProtocolInterfaceNode,
  basepath: string,
  addr: TaskAddress,
): Promise<number> {
  const root = taskRootUri(basepath, addr);
  // List each leaf directory.
  const leafs = await Promise.all([
    node.read<string[]>([`${root}/entries/?fn=ls&format=uris`]),
    node.read<string[]>([`${root}/resources/?fn=ls&format=uris`]),
    node.read<string[]>([`${root}/context/?fn=ls&format=uris`]),
    node.read<string[]>([`${root}/tags/?fn=ls&format=uris`]),
  ]);
  const allUris = new Set<string>();
  allUris.add(taskFieldUri(basepath, addr, "title"));
  allUris.add(taskFieldUri(basepath, addr, "description"));
  allUris.add(taskFieldUri(basepath, addr, "parent"));
  allUris.add(indexUri(basepath, addr));
  for (const r of leafs) {
    const uris = r[0]?.[1] ?? [];
    for (const u of uris) allUris.add(u);
  }
  const messages: Output<null>[] = [...allUris].map((u) => [u, null]);
  if (messages.length === 0) return 0;
  await node.receive(messages);
  return messages.length;
}

/** Look up a task by slug. Returns null if absent or ambiguous (need ts to disambiguate). */
export async function resolveAddress(
  node: ProtocolInterfaceNode,
  basepath: string,
  slugOrTsSlug: string,
): Promise<TaskAddress | null> {
  // Already in `ts-slug` form?
  const tsSlug = slugOrTsSlug.match(/^([0-9]{14})-(.+)$/);
  if (tsSlug) return { ts: tsSlug[1], slug: tsSlug[2] };
  // Look up by slug.
  const tasks = await listTasks(node, basepath);
  const hits = tasks.filter((t) => t.addr.slug === slugOrTsSlug);
  if (hits.length === 1) return hits[0].addr;
  return null;
}
