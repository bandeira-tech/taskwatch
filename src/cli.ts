#!/usr/bin/env -S deno run -A
/**
 * taskwatch CLI — local in-process rig over FsStore by default.
 *
 *   taskwatch new "title" [--description -|<text>] [--tag <t>]... [--parent <id>]
 *                         [--worktree <p>] [--repo <r>] [--branch <b>] [--pr <url>]
 *                         [--agent <a>] [--id <id>]
 *   taskwatch list [--status <s>] [--tag <t>] [--parent <id>] [--json]
 *   taskwatch view <id> [--json]
 *   taskwatch update <id> --message <msg> [--kind <k>] [--status <s>] [--body -|<text>]
 *   taskwatch status <id> <to> [--note <msg>]
 *   taskwatch resource <id> <name> --kind <k> [--url <u>] [--body -|<text>]
 *   taskwatch rot <id> [--note <msg>]
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";

import { createRig } from "./rig.ts";
import {
  addResource,
  appendUpdate,
  createTask,
  getContent,
  getTask,
  listResources,
  listTasks,
  listUpdates,
  setStatus,
} from "./service.ts";
import {
  TASK_STATUSES,
  type TaskMeta,
  type TaskStatus,
  type UpdateKind,
} from "./protocol.ts";

function usage(): never {
  console.error(
    `usage:
  taskwatch new "<title>" [--description -|<text>] [--tag <t>]... [--parent <id>]
                          [--worktree <p>] [--repo <r>] [--branch <b>] [--pr <url>]
                          [--agent <a>] [--id <id>]
  taskwatch list [--status <s>] [--tag <t>] [--parent <id>] [--json]
  taskwatch view <id> [--json]
  taskwatch update <id> --message <msg> [--kind <k>] [--status <s>] [--body -|<text>]
  taskwatch status <id> <to> [--note <msg>]
  taskwatch resource <id> <name> --kind <k> [--url <u>] [--body -|<text>]
  taskwatch rot <id> [--note <msg>]

env:
  TASKWATCH_DATA  storage root (default: $HOME/.taskwatch/data)`,
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

function formatStatus(s: TaskStatus): string {
  return s;
}

function formatTask(m: TaskMeta): string {
  const lines = [
    `${m.id}  ${formatStatus(m.status).padEnd(10)}  ${m.title}`,
  ];
  if (m.tags?.length) lines.push(`  tags: ${m.tags.join(", ")}`);
  if (m.context?.worktree) lines.push(`  worktree: ${m.context.worktree}`);
  if (m.context?.branch || m.context?.repo) {
    lines.push(`  repo: ${m.context.repo ?? "-"}  branch: ${m.context.branch ?? "-"}`);
  }
  if (m.context?.pr) lines.push(`  pr: ${m.context.pr}`);
  if (m.parent) lines.push(`  parent: ${m.parent}`);
  lines.push(
    `  updates: ${m.updateCount}  resources: ${m.resourceUris.length}  updated: ${
      new Date(m.updatedAt).toISOString()
    }`,
  );
  return lines.join("\n");
}

async function cmdNew(rig: Rig, args: string[]) {
  const title = args[0];
  if (!title) usage();
  const rest = args.slice(1);
  const description = await bodyArg(rest, "description");
  const tags = multi(rest, "tag");
  const parent = arg(rest, "parent");
  const worktree = arg(rest, "worktree");
  const repo = arg(rest, "repo");
  const branch = arg(rest, "branch");
  const pr = arg(rest, "pr");
  const agent = arg(rest, "agent");
  const id = arg(rest, "id");

  const result = await createTask(rig, {
    title,
    description,
    tags: tags.length > 0 ? tags : undefined,
    parent,
    context: worktree || repo || branch || pr || agent
      ? { worktree, repo, branch, pr, agent }
      : undefined,
    id,
  });
  console.log(result.uri);
}

async function cmdList(rig: Rig, args: string[]) {
  const status = arg(args, "status") as TaskStatus | undefined;
  const tag = arg(args, "tag");
  const parent = arg(args, "parent");
  const asJson = flag(args, "json");
  const tasks = await listTasks(rig, { status, tag, parent });
  if (asJson) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (tasks.length === 0) {
    console.log("(no tasks)");
    return;
  }
  for (const t of tasks) {
    console.log(formatTask(t));
    console.log();
  }
}

async function cmdView(rig: Rig, args: string[]) {
  const id = args[0];
  if (!id) usage();
  const asJson = flag(args, "json");
  const meta = await getTask(rig, id);
  if (!meta) {
    console.error(`task not found: ${id}`);
    Deno.exit(1);
  }
  const updates = await listUpdates(rig, id);
  const resources = await listResources(rig, id);
  const content = meta.contentRef ? await getContent(rig, meta.contentRef) : undefined;

  if (asJson) {
    console.log(JSON.stringify({ meta, content, updates, resources }, null, 2));
    return;
  }
  console.log(formatTask(meta));
  if (content) {
    console.log();
    console.log("description:");
    console.log("  " + content.split("\n").join("\n  "));
  }
  if (updates.length > 0) {
    console.log();
    console.log("updates:");
    for (const u of updates) {
      const ts = new Date(u.ts).toISOString();
      const msg = u.message ? ` ${u.message}` : "";
      console.log(`  [${String(u.seq).padStart(3, "0")}] ${ts} ${u.kind}${msg}`);
      if (u.contentRef) {
        const body = await getContent(rig, u.contentRef);
        if (body) console.log("    " + body.split("\n").join("\n    "));
      }
    }
  }
  if (resources.length > 0) {
    console.log();
    console.log("resources:");
    for (const r of resources) {
      console.log(`  ${r.name}  (${r.kind})${r.url ? "  " + r.url : ""}`);
    }
  }
}

async function cmdUpdate(rig: Rig, args: string[]) {
  const id = args[0];
  if (!id) usage();
  const rest = args.slice(1);
  const message = arg(rest, "message");
  if (!message) usage();
  const kind = (arg(rest, "kind") ?? "note") as UpdateKind;
  const newStatus = arg(rest, "status") as TaskStatus | undefined;
  if (newStatus && !TASK_STATUSES.includes(newStatus)) {
    console.error(`invalid status: ${newStatus}`);
    Deno.exit(2);
  }
  const body = await bodyArg(rest, "body");
  const result = await appendUpdate(rig, {
    taskId: id,
    kind,
    message,
    body,
    newStatus,
  });
  console.log(result.uri);
}

async function cmdStatus(rig: Rig, args: string[]) {
  const id = args[0];
  const to = args[1] as TaskStatus | undefined;
  if (!id || !to) usage();
  if (!TASK_STATUSES.includes(to)) {
    console.error(`invalid status: ${to}`);
    Deno.exit(2);
  }
  const note = arg(args.slice(2), "note");
  const result = await setStatus(rig, id, to, note);
  console.log(result.uri);
}

async function cmdResource(rig: Rig, args: string[]) {
  const id = args[0];
  const name = args[1];
  if (!id || !name) usage();
  const rest = args.slice(2);
  const kind = arg(rest, "kind");
  if (!kind) usage();
  const url = arg(rest, "url");
  const body = await bodyArg(rest, "body");
  const result = await addResource(rig, { taskId: id, name, kind, url, body });
  console.log(result.uri);
}

async function cmdRot(rig: Rig, args: string[]) {
  const id = args[0];
  if (!id) usage();
  const note = arg(args.slice(1), "note");
  const result = await setStatus(rig, id, "rotting", note);
  console.log(result.uri);
}

async function main() {
  const [cmd, ...rest] = Deno.args;
  if (!cmd) usage();
  const rig = await createRig();
  switch (cmd) {
    case "new":
      await cmdNew(rig, rest);
      break;
    case "list":
      await cmdList(rig, rest);
      break;
    case "view":
      await cmdView(rig, rest);
      break;
    case "update":
      await cmdUpdate(rig, rest);
      break;
    case "status":
      await cmdStatus(rig, rest);
      break;
    case "resource":
      await cmdResource(rig, rest);
      break;
    case "rot":
      await cmdRot(rig, rest);
      break;
    default:
      usage();
  }
}

if (import.meta.main) await main();
