#!/usr/bin/env -S deno run -A
/**
 * taskwatch serve — host the rig (or proxy a remote one) over HTTP
 * and serve the web UI from the same port.
 *
 *   /api/v1/*    → b3nd HTTP service (local rig, or transparent
 *                  reverse proxy to TASKWATCH_BACKEND)
 *   /config      → { basepath, version, protocol, backend? }
 *   /            → web UI (vanilla page; pure b3nd consumer)
 *
 *   PORT                default 7474
 *   TASKWATCH_BASEPATH  local rig mount (default: taskwatch://)
 *                       in backend mode, the *remote* basepath
 *                       discovered from the backend's /config
 *                       takes precedence — fallback to env / default.
 *   TASKWATCH_DATA      FS root (local-rig mode only; default ~/.taskwatch/data)
 *   TASKWATCH_BACKEND   when set to an HTTP URL of a taskwatch /
 *                       b3nd HTTP rig, /api/v1/* is reverse-proxied
 *                       to that URL. No local rig is started.
 *   TASKWATCH_CORS      Access-Control-Allow-Origin (default '*')
 */

import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { contentType } from "jsr:@std/media-types@^1";
import { extname, fromFileUrl, join } from "@std/path";

import { createRig, defaultBasepath, defaultDataDir } from "./rig.ts";
import { normalizeBasepath } from "./protocol.ts";

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

/** Try to read the remote /config to discover its basepath. */
async function discoverRemoteBasepath(backend: string): Promise<string | null> {
  try {
    const res = await fetch(new URL("/config", backend).href, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const cfg = await res.json();
    if (typeof cfg.basepath === "string" && cfg.basepath.includes("://")) {
      return normalizeBasepath(cfg.basepath);
    }
  } catch {
    // Backend doesn't speak /config — fall back to env override below.
  }
  return null;
}

/** Reverse-proxy /api/v1/* requests to a remote backend. */
function makeProxyHandler(backend: string) {
  const base = new URL(backend);
  return async (req: Request): Promise<Response> => {
    const incoming = new URL(req.url);
    const target = new URL(incoming.pathname + incoming.search, base);
    const headers = new Headers(req.headers);
    // Strip hop-by-hop headers and override Host so the remote sees its own
    // canonical name.
    headers.delete("host");
    headers.delete("connection");
    const init: RequestInit = {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    };
    // body is a ReadableStream — fetch needs duplex: 'half' to forward streams.
    // deno-lint-ignore no-explicit-any
    if (init.body) (init as any).duplex = "half";
    try {
      const upstream = await fetch(target, init);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `upstream ${target.host}: ${(err as Error).message}` }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  };
}

async function main() {
  const port = Number(Deno.env.get("PORT") ?? "7474");
  const rawBackend = Deno.env.get("TASKWATCH_BACKEND");
  const backend = rawBackend && rawBackend.length > 0 ? rawBackend : undefined;

  let basepath: string;
  let apiHandler: (req: Request) => Promise<Response>;
  let dataLine: string;

  if (backend) {
    const remoteBasepath = await discoverRemoteBasepath(backend);
    basepath = remoteBasepath ?? normalizeBasepath(defaultBasepath());
    apiHandler = makeProxyHandler(backend);
    dataLine = `proxy → ${backend}`;
  } else {
    const built = await createRig();
    basepath = built.basepath;
    apiHandler = httpApi(built.rig);
    dataLine = defaultDataDir();
  }

  const configBody = JSON.stringify({
    basepath,
    version: VERSION,
    protocol: "taskwatch",
    backend: backend ?? null,
  });

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname === "/config" || url.pathname === "/config.json") {
      return withCors(
        new Response(configBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.pathname.startsWith("/api/")) {
      const res = await apiHandler(req);
      return withCors(res);
    }
    const res = await serveStatic(req);
    return withCors(res);
  };

  console.error(`taskwatch-serve ${VERSION} on :${port}`);
  console.error(`  basepath: ${basepath}`);
  console.error(`  data:     ${dataLine}`);
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
