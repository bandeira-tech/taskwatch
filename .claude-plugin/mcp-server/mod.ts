#!/usr/bin/env -S deno run -A
/**
 * Taskwatch MCP server — pure b3nd PIN over stdio.
 *
 * Exposes the taskwatch rig via the standard b3nd MCP tools
 * (`b3nd_receive`, `b3nd_read`, `b3nd_status`). The MCP surface stays
 * uniform with every other b3nd transport — agents talk to the rig
 * via the protocol shape (taught by the bundled skill), not through
 * bespoke taskwatch verbs.
 *
 * The basepath is operator-chosen and surfaced via b3nd_status so
 * agents can discover the mount point:
 *
 *   TASKWATCH_BASEPATH  rig mount (default: taskwatch://)
 *   TASKWATCH_DATA      local FS root (default: ~/.taskwatch/data)
 *   TASKWATCH_BACKEND   when set to an HTTP URL, the local rig
 *                       delegates to the remote node instead of
 *                       writing to disk — shared scope.
 *
 * Logs go to stderr; stdout is reserved for the MCP JSON-RPC stream.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "@bandeira-tech/b3nd-move/mcp/service";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";

import { createRig, defaultBasepath, defaultDataDir } from "../../src/rig.ts";
import { normalizeBasepath } from "../../src/protocol.ts";

const VERSION = "0.1.0";

interface BuildResult {
  rig: Rig;
  basepath: string;
}

async function buildRig(): Promise<BuildResult> {
  const basepath = normalizeBasepath(defaultBasepath());
  const remote = Deno.env.get("TASKWATCH_BACKEND");
  if (remote && remote.startsWith("http")) {
    const client = new HttpClient({ url: remote }) as unknown as ProtocolInterfaceNode;
    const conn = connection(client, [`${basepath}**`]);
    const rig = new Rig({
      routes: { receive: [conn], read: [conn], observe: [conn] },
    });
    return { rig, basepath };
  }
  const built = await createRig({ basepath });
  return { rig: built.rig, basepath: built.basepath };
}

async function main() {
  const { rig, basepath } = await buildRig();
  console.error(
    `taskwatch-mcp ${VERSION} — basepath ${basepath} — backend: ${
      Deno.env.get("TASKWATCH_BACKEND") ?? defaultDataDir()
    }`,
  );
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
