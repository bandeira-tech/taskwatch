/**
 * Taskwatch rig factory.
 *
 * Mounts the TaskwatchNode under an operator-chosen basepath so the
 * same code can host the protocol at any prefix:
 *
 *   - Default:           taskwatch://
 *   - Multi-tenant:      app://work/  · app://side-projects/
 *   - Composed:          b3nd://node/personal/
 *
 * Storage is injected. The default entrypoints (CLI, serve, MCP) wire
 * `FsStore` rooted at `$TASKWATCH_DATA` (or `~/.taskwatch/data`).
 */

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type { EntityStore } from "@bandeira-tech/b3nd-save/entity-store";
import { FsStore } from "@bandeira-tech/b3nd-save/fs";
import { BYTES_ENTITY } from "@bandeira-tech/b3nd-save/entity";
import { join } from "@std/path";

import { createDenoFsExecutor } from "./storage/fs-executor.ts";
import { TaskwatchNode } from "./storage/taskwatch-node.ts";
import { DEFAULT_BASEPATH, normalizeBasepath } from "./protocol.ts";

export interface CreateRigOptions {
  /** Operator-chosen mount point. Default `taskwatch://`. */
  basepath?: string;
  /** Concrete store backing the node. Defaults to FsStore at `defaultDataDir()`. */
  store?: EntityStore;
  /** Skip store provisioning. Default: provision before returning. */
  skipProvision?: boolean;
}

export function defaultBasepath(): string {
  return Deno.env.get("TASKWATCH_BASEPATH") ?? DEFAULT_BASEPATH;
}

export function defaultDataDir(): string {
  const env = (typeof Deno !== "undefined" ? Deno.env.get("TASKWATCH_DATA") : undefined) ??
    undefined;
  if (env) return env;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("TASKWATCH_DATA or HOME/USERPROFILE must be set");
  return join(home, ".taskwatch", "data");
}

export interface CreateRigResult {
  rig: Rig;
  node: TaskwatchNode;
  basepath: string;
}

/**
 * Build the taskwatch rig.
 *
 * Returns the rig, the node it wraps, and the normalized basepath so
 * callers (CLI / MCP / serve / tests) can share the same value with
 * the service layer.
 */
export async function createRig(opts: CreateRigOptions = {}): Promise<CreateRigResult> {
  const basepath = normalizeBasepath(opts.basepath ?? defaultBasepath());
  const store = opts.store ?? new FsStore(defaultDataDir(), createDenoFsExecutor());

  if (!opts.skipProvision) {
    const meta = store.entitySupport(BYTES_ENTITY);
    const status = await store.entityStatus(meta);
    if (status !== "live") {
      await store.provisionEntity(meta);
    }
  }

  const node = new TaskwatchNode({ basepath, store });
  const conn = connection(node, [`${basepath}**`]);

  const rig = new Rig({
    routes: {
      receive: [conn],
      read: [conn],
      observe: [conn],
    },
  });

  return { rig, node, basepath };
}

export default createRig;
