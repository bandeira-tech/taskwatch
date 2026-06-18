/**
 * TaskwatchNode — paper-trail PIN over an EntityStore.
 *
 * Stores plain UTF-8 text payloads at any URI under the configured
 * basepath. No JSON envelope, no per-URI special-casing on write.
 *
 * On read, payloads come back as UTF-8 strings. Listing locators
 * (`?fn=ls`) pass through to the store and the resulting URI arrays
 * or `[uri, bytes]` tuples are normalised (bytes → string per entry).
 *
 * One synthetic read locator: `{basepath}task/{ts}/{slug}?fn=view`
 * fans out into the per-task reads (title, description, parent,
 * context/*, tags/*, entries/*, resources/*) and returns the folded
 * TaskView so callers can render in one round trip.
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
  contextListLocator,
  type EntryRef,
  entriesListLocator,
  foldEntries,
  normalizeBasepath,
  nowTs,
  parseTs,
  parseUri,
  parseUri as _parseUri,
  readFn,
  resourcesListLocator,
  type TaskAddress,
  type TaskView,
  tagsListLocator,
  taskFieldUri,
  taskRootUri,
} from "../protocol.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return enc.encode(payload);
  if (payload === undefined || payload === null) return new Uint8Array(0);
  return enc.encode(String(payload));
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

function bytesToString(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  return dec.decode(bytes);
}

export interface TaskwatchNodeOptions {
  basepath: string;
  store: EntityStore;
}

export class TaskwatchNode extends ObserveEmitter implements ProtocolInterfaceNode {
  readonly basepath: string;
  readonly store: EntityStore;
  readonly meta: EntityMeta;

  constructor(opts: TaskwatchNodeOptions) {
    super();
    this.basepath = normalizeBasepath(opts.basepath);
    this.store = opts.store;
    this.meta = opts.store.entitySupport(BYTES_ENTITY);
  }

  // ──────────────────────────────────────────────────────────────────
  // receive — plain pass-through; UTF-8 text in, bytes to store

  async receive(msgs: Output<unknown>[]): Promise<ReceiveResult[]> {
    const results: ReceiveResult[] = new Array(msgs.length);
    const writeEntries: { uri: string; record: EntityRecord; index: number }[] = [];
    const deleteEntries: { uri: string; index: number }[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const [uri, payload] = msgs[i];
      if (!uri.startsWith(this.basepath)) {
        results[i] = { accepted: false, error: `outside basepath: ${uri}` };
        continue;
      }
      // Shape validation — must resolve to a known URI shape (no verbs).
      const parsed = parseUri(this.basepath, uri);
      if (!parsed) {
        results[i] = { accepted: false, error: `unsupported uri shape: ${uri}` };
        continue;
      }
      if (
        parsed.kind === "task-list-root" ||
        parsed.kind === "task-list-task" ||
        parsed.kind === "index-root"
      ) {
        results[i] = {
          accepted: false,
          error: `cannot write to a listing locator: ${uri}`,
        };
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
        results[idx] = w.success
          ? { accepted: true }
          : { accepted: false, error: w.error ?? "write failed" };
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
        results[idx] = d.success
          ? { accepted: true }
          : { accepted: false, error: d.error ?? "delete failed" };
      }
    }

    for (let i = 0; i < msgs.length; i++) {
      if (results[i]?.accepted) {
        try {
          this._emit(msgs[i][0], msgs[i][1]);
        } catch { /* observe is best-effort */ }
      }
    }
    return results;
  }

  // ──────────────────────────────────────────────────────────────────
  // read — direct, listing, or ?fn=view synthetic

  async read<T = unknown>(locators: string[]): Promise<Output<T>[]> {
    const out: Output<T>[] = new Array(locators.length);
    await Promise.all(
      locators.map(async (loc, i) => {
        if (!loc.startsWith(this.basepath)) {
          out[i] = [loc, undefined as T];
          return;
        }
        const fn = readFn(loc);
        if (fn?.fn === "view") {
          const root = loc.split("?")[0];
          const parsed = parseUri(this.basepath, root);
          if (parsed?.kind !== "task-root") {
            out[i] = [loc, undefined as T];
            return;
          }
          const view = await this.resolveView(parsed.addr);
          out[i] = [loc, view as T];
          return;
        }
        // Pass-through to store (handles ?fn=ls / ?fn=count + direct reads).
        const [entry] = await this.store.read(this.meta, [loc]);
        const [, raw] = entry ?? [loc, undefined];
        out[i] = [loc, await this.normaliseReadResult(raw) as T];
      }),
    );
    return out;
  }

  /**
   * Convert a store read result into the wire shape:
   * - direct read  → UTF-8 string (or empty when missing)
   * - fn=ls&format=uris → string[]
   * - fn=ls&format=full → [uri, string][]
   * - fn=count → number
   */
  private async normaliseReadResult(raw: unknown): Promise<unknown> {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "number") return raw;
    if (raw instanceof Uint8Array || raw instanceof ReadableStream) {
      const bytes = await recordToBytes(raw);
      return bytesToString(bytes);
    }
    if (Array.isArray(raw)) {
      // fn=ls&format=uris → string[]
      if (raw.length === 0 || typeof raw[0] === "string") {
        return raw as string[];
      }
      // fn=ls&format=full → [uri, record][]
      const decoded: [string, string | undefined][] = [];
      for (const item of raw) {
        if (Array.isArray(item) && item.length === 2) {
          const [u, rec] = item as [string, unknown];
          const bytes = await recordToBytes(rec);
          decoded.push([u, bytes ? bytesToString(bytes) : undefined]);
        }
      }
      return decoded;
    }
    if (typeof raw === "object") {
      // Plain record from the store — unwrap payload.
      const bytes = await recordToBytes(raw);
      return bytes ? bytesToString(bytes) : undefined;
    }
    return raw;
  }

  // ──────────────────────────────────────────────────────────────────
  // status — surface basepath so agents can discover the mount point

  async status(): Promise<StatusResult> {
    const live = await this.store.entityStatus(this.meta);
    return {
      status: live === "live" ? "healthy" : "degraded",
      message: `taskwatch (basepath ${this.basepath}) — store ${live}`,
      schema: [`${this.basepath}**`],
      details: {
        basepath: this.basepath,
        protocol: "taskwatch",
        version: 1,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // ?fn=view — resolve a full TaskView in one call

  private async resolveView(addr: TaskAddress): Promise<TaskView | undefined> {
    const root = taskRootUri(this.basepath, addr);
    const titleLoc = taskFieldUri(this.basepath, addr, "title");
    const descLoc = taskFieldUri(this.basepath, addr, "description");
    const parentLoc = taskFieldUri(this.basepath, addr, "parent");
    const ctxLoc = contextListLocator(this.basepath, addr, "full");
    const tagsLoc = tagsListLocator(this.basepath, addr);
    const entriesLoc = entriesListLocator(this.basepath, addr, "full");
    const resLoc = resourcesListLocator(this.basepath, addr, "full");

    const reads = await this.store.read(this.meta, [
      titleLoc,
      descLoc,
      parentLoc,
      ctxLoc,
      tagsLoc,
      entriesLoc,
      resLoc,
    ]);

    const [titleRaw, descRaw, parentRaw, ctxRaw, tagsRaw, entriesRaw, resRaw] =
      await Promise.all(reads.map(([, r]) => this.normaliseReadResult(r)));

    const title = typeof titleRaw === "string" ? titleRaw : "";
    if (!title) {
      // No title → task doesn't exist (or is half-created).
      return undefined;
    }
    const description = typeof descRaw === "string" ? descRaw : "";
    const parent = typeof parentRaw === "string" && parentRaw ? parentRaw : undefined;

    const context: Record<string, string> = {};
    if (Array.isArray(ctxRaw)) {
      for (const item of ctxRaw as [string, string | undefined][]) {
        const parsed = parseUri(this.basepath, item[0]);
        if (parsed?.kind === "task-context" && item[1] !== undefined) {
          context[parsed.field] = item[1];
        }
      }
    }

    const tags: string[] = [];
    if (Array.isArray(tagsRaw)) {
      for (const uri of tagsRaw as string[]) {
        const parsed = parseUri(this.basepath, uri);
        if (parsed?.kind === "task-tag") tags.push(parsed.tag);
      }
      tags.sort();
    }

    const entriesOut: TaskView["entries"] = [];
    const entryRefs: EntryRef[] = [];
    if (Array.isArray(entriesRaw)) {
      for (const item of entriesRaw as [string, string | undefined][]) {
        const parsed = parseUri(this.basepath, item[0]);
        if (parsed?.kind !== "task-entry") continue;
        const body = item[1] ?? "";
        entriesOut.push({
          uri: item[0],
          ts: parsed.entryTs,
          kind: parsed.entryKind,
          body,
        });
        entryRefs.push({
          uri: item[0],
          entryTs: parsed.entryTs,
          entryKind: parsed.entryKind,
          body,
        });
      }
      entriesOut.sort((a, b) => a.ts.localeCompare(b.ts));
    }

    const resourcesOut: TaskView["resources"] = [];
    if (Array.isArray(resRaw)) {
      for (const item of resRaw as [string, string | undefined][]) {
        const parsed = parseUri(this.basepath, item[0]);
        if (parsed?.kind !== "task-resource") continue;
        resourcesOut.push({
          uri: item[0],
          name: parsed.resource,
          body: item[1] ?? "",
        });
      }
      resourcesOut.sort((a, b) => a.name.localeCompare(b.name));
    }

    const folded = foldEntries(entryRefs);
    const createdAt = parseTs(addr.ts);
    const updatedAt = folded.latestTs ? parseTs(folded.latestTs) : createdAt;

    // Record the access as another entry on the timeline. Fire-and-forget
    // via receive so observers see it; it shows up on the next view.
    const accessUri = `${root}/entries/${nowTs()}-accessed`;
    this.receive([[accessUri, ""]]).catch(() => {});

    return {
      basepath: this.basepath,
      addr,
      uri: root,
      title,
      description,
      status: folded.status,
      parent,
      context,
      tags,
      entries: entriesOut,
      resources: resourcesOut,
      createdAt,
      updatedAt,
    };
  }
}
