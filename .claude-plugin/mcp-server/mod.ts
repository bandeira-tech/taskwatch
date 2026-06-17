#!/usr/bin/env -S deno run -A
/**
 * Taskwatch MCP server — pure b3nd PIN over stdio.
 *
 * Exposes the taskwatch rig via the standard b3nd MCP tools
 * (`b3nd_receive`, `b3nd_read`, `b3nd_status`). The MCP surface stays
 * uniform with every other b3nd transport — agents talk to the rig
 * via the protocol shape, not through bespoke taskwatch verbs.
 *
 * Storage:
 *   TASKWATCH_DATA      — local FS root (default: ~/.taskwatch/data)
 *   TASKWATCH_BACKEND   — HTTP URL of a remote b3nd rig. When set,
 *                         the local rig delegates to that remote node
 *                         instead of writing to disk, so a shared rig
 *                         can be fronted by this MCP process.
 *
 * Status chatter goes to stderr; stdout is reserved for MCP JSON-RPC.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "@bandeira-tech/b3nd-move/mcp/service";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";

import { createRig, defaultDataDir } from "../../src/rig.ts";

const VERSION = "0.0.1";

async function buildRig(): Promise<Rig> {
  const remote = Deno.env.get("TASKWATCH_BACKEND");
  if (remote && remote.startsWith("http")) {
    const client = new HttpClient({ url: remote }) as unknown as ProtocolInterfaceNode;
    const conn = connection(client, ["task://**", "hash://**"]);
    return new Rig({
      routes: { receive: [conn], read: [conn], observe: [conn] },
    });
  }
  return await createRig();
}

async function main() {
  console.error(
    `taskwatch-mcp ${VERSION} — backend: ${
      Deno.env.get("TASKWATCH_BACKEND") ?? defaultDataDir()
    }`,
  );
  const rig = await buildRig();
  const server = buildMcpServer(rig, { name: "taskwatch", version: VERSION });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("taskwatch-mcp connected via stdio");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("fatal:", err);
    Deno.exit(1);
  });
}
