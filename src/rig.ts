/**
 * Taskwatch rig factory.
 *
 * Composes a TaskwatchNode (bytes-backed store with `task://list?...`
 * synthesis) into a Rig wired across `receive`, `read`, `observe` for
 * `task://**` and `hash://**`.
 *
 * Storage is injected. The default entrypoint (CLI, serve, MCP) wires
 * `FsStore` rooted at `$TASKWATCH_DATA` (or `~/.taskwatch/data`).
 */

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type { EntityStore } from "@bandeira-tech/b3nd-save/entity-store";
import { FsStore } from "@bandeira-tech/b3nd-save/fs";
import { BYTES_ENTITY } from "@bandeira-tech/b3nd-save/entity";
import { join } from "@std/path";

import { createDenoFsExecutor } from "./storage/fs-executor.ts";
import { TaskwatchNode } from "./storage/taskwatch-node.ts";

export interface CreateRigOptions {
  /** Concrete store backing the node. Defaults to FsStore at `defaultDataDir()`. */
  store?: EntityStore;
  /** Skip store provisioning. Default: provision before returning. */
  skipProvision?: boolean;
}

export function defaultDataDir(): string {
  const env = (typeof Deno !== "undefined" ? Deno.env.get("TASKWATCH_DATA") : undefined) ??
    undefined;
  if (env) return env;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("TASKWATCH_DATA or HOME/USERPROFILE must be set");
  return join(home, ".taskwatch", "data");
}

export async function createRig(opts: CreateRigOptions = {}): Promise<Rig> {
  const store = opts.store ?? new FsStore(defaultDataDir(), createDenoFsExecutor());

  if (!opts.skipProvision) {
    const meta = store.entitySupport(BYTES_ENTITY);
    const status = await store.entityStatus(meta);
    if (status !== "live") {
      await store.provisionEntity(meta);
    }
  }

  const node = new TaskwatchNode(store);
  const conn = connection(node, ["task://**", "hash://**"]);

  return new Rig({
    routes: {
      receive: [conn],
      read: [conn],
      observe: [conn],
    },
  });
}

/** The bnd CLI rig-loader convention: default export is a factory. */
export default createRig;
