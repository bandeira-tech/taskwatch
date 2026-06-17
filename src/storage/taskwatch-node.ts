/**
 * TaskwatchNode — a ProtocolInterfaceNode over an EntityStore.
 *
 * Stores everything as bytes via b3nd-save's BYTES_ENTITY. Structured
 * payloads (TaskMeta / TaskUpdate / TaskResource) are JSON-encoded on
 * write and JSON-decoded on read. Raw bytes pass through for
 * `hash://sha256/...` content.
 *
 * The `task://list[?...]` synthetic index is resolved here.
 */

import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { ObserveEmitter } from "@bandeira-tech/b3nd-core";
import type { EntityStore } from "@bandeira-tech/b3nd-save/entity-store";
import {
  BYTES_ENTITY,
  type EntityMeta,
  type EntityRecord,
} from "@bandeira-tech/b3nd-save/entity";

import {
  HASH_SCHEME,
  parseUri,
  TASK_PREFIX,
  TASK_SCHEME,
  type TaskMeta,
} from "../protocol.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return enc.encode(payload);
  return enc.encode(JSON.stringify(payload));
}

async function recordToBytes(record: unknown): Promise<Uint8Array | undefined> {
  if (record === undefined || record === null) return undefined;
  const payload = (record as { payload?: unknown }).payload ?? record;
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ReadableStream) {
    const buf = await new Response(payload).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (typeof payload === "string") return enc.encode(payload);
  return undefined;
}

function decodeForUri(uri: string, bytes: Uint8Array): unknown {
  const parsed = parseUri(uri);
  if (parsed?.kind === "hash") return bytes;
  return JSON.parse(dec.decode(bytes));
}

export class TaskwatchNode extends ObserveEmitter implements ProtocolInterfaceNode {
  readonly store: EntityStore;
  readonly meta: EntityMeta;

  constructor(store: EntityStore) {
    super();
    this.store = store;
    this.meta = store.entitySupport(BYTES_ENTITY);
  }

  async receive(msgs: Output<unknown>[]): Promise<ReceiveResult[]> {
    const results: ReceiveResult[] = new Array(msgs.length);
    const writeEntries: { uri: string; record: EntityRecord; index: number }[] = [];
    const deleteEntries: { uri: string; index: number }[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const [uri, payload] = msgs[i];
      if (!parseUri(uri)) {
        results[i] = { accepted: false, error: `unsupported uri: ${uri}` };
        continue;
      }
      if (payload === null) {
        deleteEntries.push({ uri, index: i });
        continue;
      }
      try {
        const bytes = toBytes(payload);
        writeEntries.push({ uri, record: { payload: bytes }, index: i });
      } catch (err) {
        results[i] = {
          accepted: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (writeEntries.length > 0) {
      const writeResults = await this.store.write(
        this.meta,
        writeEntries.map((e) => ({ uri: e.uri, record: e.record })),
      );
      for (let k = 0; k < writeEntries.length; k++) {
        const w = writeResults[k];
        const idx = writeEntries[k].index;
        if (w.success) {
          results[idx] = { accepted: true };
        } else {
          results[idx] = { accepted: false, error: w.error ?? "write failed" };
        }
      }
    }

    if (deleteEntries.length > 0) {
      const deleteResults = await this.store.delete(
        this.meta,
        deleteEntries.map((e) => e.uri),
      );
      for (let k = 0; k < deleteEntries.length; k++) {
        const d = deleteResults[k];
        const idx = deleteEntries[k].index;
        if (d.success) {
          results[idx] = { accepted: true };
        } else {
          results[idx] = { accepted: false, error: d.error ?? "delete failed" };
        }
      }
    }

    // Best-effort observe notifications for accepted writes/deletes.
    for (let i = 0; i < msgs.length; i++) {
      if (results[i]?.accepted) {
        try {
          this._emit(msgs[i][0], msgs[i][1]);
        } catch { /* observe is best-effort */ }
      }
    }

    return results;
  }

  async read<T = unknown>(locators: string[]): Promise<Output<T>[]> {
    const out: Output<T>[] = new Array(locators.length);
    await Promise.all(
      locators.map(async (loc, i) => {
        const parsed = parseUri(loc);
        if (parsed?.kind === "index") {
          const list = await this.listTasks(parsed.query);
          out[i] = [loc, list as T];
          return;
        }
        const [entry] = await this.store.read(this.meta, [loc]);
        const [, record] = entry ?? [loc, undefined];
        const bytes = await recordToBytes(record);
        if (bytes === undefined) {
          out[i] = [loc, undefined as T];
          return;
        }
        try {
          out[i] = [loc, decodeForUri(loc, bytes) as T];
        } catch {
          out[i] = [loc, bytes as T];
        }
      }),
    );
    return out;
  }

  async status(): Promise<StatusResult> {
    const live = await this.store.entityStatus(this.meta);
    return {
      status: live === "live" ? "healthy" : "degraded",
      message: `taskwatch store ${live}`,
      schema: [TASK_SCHEME + "**", HASH_SCHEME + "**"],
    };
  }

  private async listTasks(query: URLSearchParams): Promise<TaskMeta[]> {
    const lsLocator = `${TASK_PREFIX}?fn=ls&format=uris`;
    const [entry] = await this.store.read(this.meta, [lsLocator]);
    const [, payload] = entry ?? [lsLocator, undefined];
    const uris = Array.isArray(payload) ? (payload as string[]) : [];
    const taskUris = uris.filter((u) => parseUri(u)?.kind === "task");

    if (taskUris.length === 0) return [];

    const records = await this.store.read(this.meta, taskUris);
    const metas: TaskMeta[] = [];
    for (const [, record] of records) {
      const bytes = await recordToBytes(record);
      if (!bytes) continue;
      try {
        const decoded = JSON.parse(dec.decode(bytes)) as TaskMeta;
        metas.push(decoded);
      } catch { /* skip malformed */ }
    }

    const status = query.get("status");
    const tag = query.get("tag");
    const parent = query.get("parent");
    let filtered = metas;
    if (status) filtered = filtered.filter((m) => m.status === status);
    if (tag) filtered = filtered.filter((m) => (m.tags ?? []).includes(tag));
    if (parent) filtered = filtered.filter((m) => m.parent === parent);

    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    return filtered;
  }
}
