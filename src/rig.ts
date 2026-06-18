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
import type { Program } from "@bandeira-tech/b3nd-core/types";
import type { EntityStore } from "@bandeira-tech/b3nd-save/entity-store";
import { FsStore } from "@bandeira-tech/b3nd-save/fs";
import { BYTES_ENTITY } from "@bandeira-tech/b3nd-save/entity";
import { join } from "@std/path";

import { createDenoFsExecutor } from "./storage/fs-executor.ts";
import { TaskwatchNode } from "./storage/taskwatch-node.ts";
import { DEFAULT_BASEPATH, normalizeBasepath, parseUri } from "./protocol.ts";

export interface CreateRigOptions {
  /** Operator-chosen mount point. Default `taskwatch://`. */
  basepath?: string;
  /** Concrete store backing the node. Defaults to FsStore at `defaultDataDir()`. */
  store?: EntityStore;
  /** Skip store provisioning. Default: provision before returning. */
  skipProvision?: boolean;
}

export function defaultBasepath(): string {
  const env = Deno.env.get("TASKWATCH_BASEPATH");
  return env && env.length > 0 ? env : DEFAULT_BASEPATH;
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

  // URI-shape validation runs at the pipeline stage as a Program.
  //
  // Without this, malformed URIs that the node would reject during
  // dispatch get silently lost: the rig's pipeline-ack resolves
  // `accepted: true` *before* per-route dispatch runs, so the node's
  // `accepted: false` reply is fire-and-forget over event channels
  // and never reaches the caller of `rig.receive()`. A bad write then
  // returns success at the MCP boundary while no file lands on disk.
  //
  // By moving validation into a Program, refuses short-circuit the
  // pipeline and propagate as `{ accepted: false, error }` on the
  // awaited result — which is what every MCP / HTTP / in-process
  // caller actually wants.
  //
  // See: b3nd-core/src/rig/rig.ts (_runPipeline) for the pipeline-ack
  // vs dispatch split.
  const validateUriShape: Program = ([uri]) => {
    if (!uri.startsWith(basepath)) {
      return Promise.resolve({
        code: "refuse:outside-basepath",
        error: `outside basepath: ${uri}`,
      });
    }
    const parsed = parseUri(basepath, uri);
    if (!parsed) {
      return Promise.resolve({
        code: "refuse:bad-shape",
        error: `unsupported uri shape: ${uri}`,
      });
    }
    if (
      parsed.kind === "task-list-root" ||
      parsed.kind === "task-list-task" ||
      parsed.kind === "index-root"
    ) {
      return Promise.resolve({
        code: "refuse:listing-locator",
        error: `cannot write to a listing locator: ${uri}`,
      });
    }
    return Promise.resolve({ code: "ok" });
  };

  // The rig's program matcher uses `uri === prefix || uri.startsWith(prefix + "/")`,
  // so we strip the trailing slash from the basepath before registering — that
  // way `prefix + "/"` reconstructs the basepath and matches everything under it.
  const programPrefix = basepath.endsWith("/")
    ? basepath.slice(0, -1)
    : basepath;

  const rig = new Rig({
    routes: {
      receive: [conn],
      read: [conn],
      observe: [conn],
    },
    programs: { [programPrefix]: validateUriShape },
  });

  return { rig, node, basepath };
}

export default createRig;
