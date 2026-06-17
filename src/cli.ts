#!/usr/bin/env -S deno run -A
/**
 * taskwatch CLI — in-process rig with FS storage.
 *
 *   taskwatch new "<title>" [--description -|<text>] [--tag <t>]... [--parent <uri>]
 *                           [--worktree <p>] [--repo <r>] [--branch <b>] [--pr <url>]
 *                           [--agent <a>]
 *   taskwatch list [--json]
 *   taskwatch view <addr> [--json]
 *   taskwatch status <addr> <to> [--note <msg>]
 *   taskwatch progress <addr> <message...>
 *   taskwatch note <addr> <message...>
 *   taskwatch resource <addr> <name> [--url <url> | --body -|<text>]
 *   taskwatch tag <addr> <tag> [--remove]
 *   taskwatch ctx <addr> <field> <value>
 *   taskwatch rot <addr> [--note <msg>]
 *   taskwatch rename <addr> "<new title>"
 *   taskwatch delete <addr> [--hard]
 *
 * <addr> is `<ts>-<slug>` or, if unambiguous, just `<slug>`.
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";

import { createRig } from "./rig.ts";
import {
  addResource,
  appendEntry,
  appendStatus,
  createTask,
  getTask,
  hardDelete,
  listTasksWithStatus,
  resolveAddress,
  setContext,
  setDescription as _setDescription,
  setTag,
  setTitle,
} from "./service.ts";
import {
  TASK_STATUSES,
  type TaskAddress,
  type TaskStatus,
} from "./protocol.ts";

function usage(): never {
  console.error(
    `usage:
  taskwatch new "<title>" [--description -|<text>] [--tag <t>]... [--parent <uri>]
                          [--worktree <p>] [--repo <r>] [--branch <b>] [--pr <url>] [--agent <a>]
  taskwatch list [--json]
  taskwatch view <addr> [--json]
  taskwatch status <addr> <to> [--note <msg>]
  taskwatch progress <addr> <message...>
  taskwatch note <addr> <message...>
  taskwatch resource <addr> <name> [--url <url> | --body -|<text>]
  taskwatch tag <addr> <tag> [--remove]
  taskwatch ctx <addr> <field> <value>
  taskwatch rot <addr> [--note <msg>]
  taskwatch rename <addr> "<new title>"
  taskwatch delete <addr> [--hard]

env:
  TASKWATCH_DATA      storage root (default: $HOME/.taskwatch/data)
  TASKWATCH_BASEPATH  rig mount point (default: taskwatch://)`,
  );
  Deno.exit(2);
}

async function readStdin(): Promise<string> {
  const buf = await new Response(Deno.stdin.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) usage();
  return v;
}

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function multi(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) {
      const v = args[i + 1];
      if (v === undefined) usage();
      out.push(v);
    }
  }
  return out;
}

async function bodyArg(args: string[], name: string): Promise<string | undefined> {
  const v = arg(args, name);
  if (v === undefined) return undefined;
  return v === "-" ? await readStdin() : v;
}

async function mustResolve(
  node: ProtocolInterfaceNode,
  basepath: string,
  raw: string,
): Promise<TaskAddress> {
  const addr = await resolveAddress(node, basepath, raw);
  if (!addr) {
    console.error(`could not resolve task: ${raw}`);
    Deno.exit(1);
  }
  return addr;
}

function formatAddr(addr: TaskAddress): string {
  return `${addr.ts}-${addr.slug}`;
}

// ─── commands ──────────────────────────────────────────────────────

async function cmdNew(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const title = args[0];
  if (!title) usage();
  const rest = args.slice(1);
  const description = await bodyArg(rest, "description");
  const tags = multi(rest, "tag");
  const parent = arg(rest, "parent");
  const context: Record<string, string> = {};
  for (const k of ["worktree", "repo", "branch", "pr", "agent"]) {
    const v = arg(rest, k);
    if (v) context[k] = v;
  }
  const result = await createTask(node, basepath, {
    title,
    description,
    tags: tags.length > 0 ? tags : undefined,
    parent,
    context: Object.keys(context).length > 0 ? context : undefined,
  });
  console.log(result.uri);
  console.log(`addr: ${formatAddr(result.addr)}`);
}

async function cmdList(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const asJson = flag(args, "json");
  const tasks = await listTasksWithStatus(node, basepath);
  if (asJson) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (tasks.length === 0) {
    console.log("(no tasks)");
    return;
  }
  for (const t of tasks) {
    const updatedAt = t.updatedAt
      ? `${t.updatedAt.slice(0, 8)} ${t.updatedAt.slice(8, 14)}`
      : "";
    console.log(
      `${formatAddr(t.addr).padEnd(28)}  ${t.status.padEnd(10)}  ${updatedAt}  ${t.title}`,
    );
  }
}

async function cmdView(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  if (!ref) usage();
  const asJson = flag(args, "json");
  const addr = await mustResolve(node, basepath, ref);
  const view = await getTask(node, basepath, addr);
  if (!view) {
    console.error(`task not found: ${ref}`);
    Deno.exit(1);
  }
  if (asJson) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  console.log(`${view.uri}`);
  console.log(`status: ${view.status}    addr: ${formatAddr(view.addr)}`);
  console.log(`title:  ${view.title}`);
  if (view.parent) console.log(`parent: ${view.parent}`);
  if (Object.keys(view.context).length > 0) {
    console.log("context:");
    for (const [k, v] of Object.entries(view.context)) {
      console.log(`  ${k}: ${v}`);
    }
  }
  if (view.tags.length > 0) {
    console.log(`tags: ${view.tags.join(", ")}`);
  }
  if (view.description) {
    console.log("\ndescription:");
    console.log("  " + view.description.split("\n").join("\n  "));
  }
  if (view.entries.length > 0) {
    console.log("\nentries:");
    for (const e of view.entries) {
      console.log(`  ${e.ts} ${e.kind}${e.body ? "  " + e.body.split("\n")[0] : ""}`);
      if (e.body && e.body.includes("\n")) {
        const tail = e.body.split("\n").slice(1).join("\n    ");
        console.log("    " + tail);
      }
    }
  }
  if (view.resources.length > 0) {
    console.log("\nresources:");
    for (const r of view.resources) {
      console.log(`  ${r.name}: ${r.body}`);
    }
  }
}

async function cmdStatus(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  const to = args[1] as TaskStatus | undefined;
  if (!ref || !to) usage();
  if (!TASK_STATUSES.includes(to)) {
    console.error(`invalid status: ${to}`);
    Deno.exit(2);
  }
  const note = arg(args.slice(2), "note") ?? "";
  const addr = await mustResolve(node, basepath, ref);
  const uri = await appendStatus(node, basepath, addr, to, note);
  console.log(uri);
}

async function cmdEntry(
  node: ProtocolInterfaceNode,
  basepath: string,
  args: string[],
  kind: string,
) {
  const ref = args[0];
  const message = args.slice(1).join(" ");
  if (!ref || !message) usage();
  const addr = await mustResolve(node, basepath, ref);
  const uri = await appendEntry(node, basepath, addr, kind, message);
  console.log(uri);
}

async function cmdResource(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  const name = args[1];
  if (!ref || !name) usage();
  const rest = args.slice(2);
  const url = arg(rest, "url");
  const body = url ?? await bodyArg(rest, "body") ?? "";
  const addr = await mustResolve(node, basepath, ref);
  const uri = await addResource(node, basepath, addr, name, body);
  console.log(uri);
}

async function cmdTag(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  const tag = args[1];
  if (!ref || !tag) usage();
  const remove = flag(args.slice(2), "remove");
  const addr = await mustResolve(node, basepath, ref);
  const uri = await setTag(node, basepath, addr, tag, !remove);
  console.log(uri);
}

async function cmdCtx(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  const field = args[1];
  const value = args.slice(2).join(" ");
  if (!ref || !field || !value) usage();
  const addr = await mustResolve(node, basepath, ref);
  const uri = await setContext(node, basepath, addr, field, value);
  console.log(uri);
}

async function cmdRot(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  if (!ref) usage();
  const note = arg(args.slice(1), "note") ?? "";
  const addr = await mustResolve(node, basepath, ref);
  const uri = await appendStatus(node, basepath, addr, "rotting", note);
  console.log(uri);
}

async function cmdRename(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  const newTitle = args.slice(1).join(" ");
  if (!ref || !newTitle) usage();
  const addr = await mustResolve(node, basepath, ref);
  await setTitle(node, basepath, addr, newTitle);
  console.log(`renamed ${formatAddr(addr)}`);
}

async function cmdDelete(node: ProtocolInterfaceNode, basepath: string, args: string[]) {
  const ref = args[0];
  if (!ref) usage();
  const hard = flag(args.slice(1), "hard");
  const addr = await mustResolve(node, basepath, ref);
  if (hard) {
    const n = await hardDelete(node, basepath, addr);
    console.log(`hard-deleted ${n} uris under ${formatAddr(addr)}`);
  } else {
    const uri = await appendStatus(node, basepath, addr, "abandoned", "deleted via cli");
    console.log(uri);
  }
}

async function main() {
  const [cmd, ...rest] = Deno.args;
  if (!cmd) usage();
  const { rig, basepath } = await createRig();
  switch (cmd) {
    case "new":
      await cmdNew(rig, basepath, rest);
      break;
    case "list":
      await cmdList(rig, basepath, rest);
      break;
    case "view":
      await cmdView(rig, basepath, rest);
      break;
    case "status":
      await cmdStatus(rig, basepath, rest);
      break;
    case "progress":
      await cmdEntry(rig, basepath, rest, "progress");
      break;
    case "note":
      await cmdEntry(rig, basepath, rest, "note");
      break;
    case "resource":
      await cmdResource(rig, basepath, rest);
      break;
    case "tag":
      await cmdTag(rig, basepath, rest);
      break;
    case "ctx":
      await cmdCtx(rig, basepath, rest);
      break;
    case "rot":
      await cmdRot(rig, basepath, rest);
      break;
    case "rename":
      await cmdRename(rig, basepath, rest);
      break;
    case "delete":
      await cmdDelete(rig, basepath, rest);
      break;
    default:
      usage();
  }
}

if (import.meta.main) await main();
