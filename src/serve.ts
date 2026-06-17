#!/usr/bin/env -S deno run -A
/**
 * taskwatch serve — host the rig over HTTP and serve the web UI from
 * the same port.
 *
 *   /api/v1/*    → standard b3nd HTTP service (the protocol surface)
 *   /            → web UI (vanilla page; pure b3nd consumer)
 *
 *   PORT                default 7474
 *   TASKWATCH_BASEPATH  rig mount (default: taskwatch://)
 *   TASKWATCH_DATA      FS root  (default: ~/.taskwatch/data)
 *   TASKWATCH_CORS      Access-Control-Allow-Origin (default '*')
 */

import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { contentType } from "jsr:@std/media-types@^1";
import { extname, fromFileUrl, join } from "@std/path";

import { createRig, defaultDataDir } from "./rig.ts";

const VERSION = "0.1.1";
const HERE = fromFileUrl(new URL("../web", import.meta.url));

function corsHeaders(): HeadersInit {
  const origin = Deno.env.get("TASKWATCH_CORS") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v as string);
  return new Response(res.body, { status: res.status, headers });
}

async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path === "/" || path === "") path = "/index.html";
  if (path.startsWith("/static/")) path = path.slice("/static".length);
  if (path.includes("..")) return new Response("forbidden", { status: 403 });

  const file = join(HERE, path);
  try {
    const data = await Deno.readFile(file);
    const ext = extname(file);
    const type = contentType(ext) ?? "application/octet-stream";
    return new Response(data, {
      status: 200,
      headers: { "Content-Type": type, "Cache-Control": "no-cache" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function main() {
  const port = Number(Deno.env.get("PORT") ?? "7474");
  const { rig, basepath } = await createRig();
  const api = httpApi(rig);

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    // /config exposes the basepath for the UI (rig.status drops details).
    if (url.pathname === "/config" || url.pathname === "/config.json") {
      return withCors(
        new Response(
          JSON.stringify({ basepath, version: VERSION, protocol: "taskwatch" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.pathname.startsWith("/api/")) {
      const res = await api(req);
      return withCors(res);
    }
    const res = await serveStatic(req);
    return withCors(res);
  };

  console.error(`taskwatch-serve ${VERSION} on :${port}`);
  console.error(`  basepath: ${basepath}`);
  console.error(`  data:     ${defaultDataDir()}`);
  console.error(`  ui:       http://localhost:${port}/`);
  console.error(`  b3nd:     http://localhost:${port}/api/v1/`);

  Deno.serve({ port }, handler);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("fatal:", err);
    Deno.exit(1);
  });
}
