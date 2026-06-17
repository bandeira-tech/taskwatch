// Minimal b3nd HTTP client (browser). Speaks the wire shape served by
// @bandeira-tech/b3nd-move/http/service:
//
//   POST /api/v1/receive?u=<urlsafe-b64-url-list>
//        body: bytes-list (u32 BE length prefix per payload, concatenated)
//   POST /api/v1/read?u=<urlsafe-b64-url-list>
//        no body; response: JSON Output[] (one [uri, payload] per requested url)
//   GET  /api/v1/status
//
// Encoders match ../../b3nd-move/src/codecs/{url-list,bytes-list}.ts.
//
// The taskwatch web UI is one consumer of this surface; the protocol
// shape (URIs, payload types) lives in src/protocol.ts and the SKILL.md.

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToBase64Urlsafe(bytes) {
  // btoa can't take the whole binary string for large inputs; chunk it.
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  let s = btoa(bin);
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeUrlList(urls) {
  const parts = urls.map((u) => enc.encode(u));
  let total = 0;
  for (const p of parts) {
    if (p.length > 0xffff) throw new Error("url too long");
    total += 2 + p.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out[off++] = (p.length >> 8) & 0xff;
    out[off++] = p.length & 0xff;
    out.set(p, off);
    off += p.length;
  }
  return bytesToBase64Urlsafe(out);
}

function encodeBytesList(payloads) {
  let total = 0;
  for (const p of payloads) total += 4 + p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of payloads) {
    const n = p.length;
    out[off++] = (n >>> 24) & 0xff;
    out[off++] = (n >>> 16) & 0xff;
    out[off++] = (n >>> 8) & 0xff;
    out[off++] = n & 0xff;
    out.set(p, off);
    off += n;
  }
  return out;
}

function toBytes(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return enc.encode(payload);
  return enc.encode(JSON.stringify(payload));
}

export class B3ndHttpClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async status() {
    const res = await fetch(`${this.baseUrl}/api/v1/status`);
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    return await res.json();
  }

  async receive(messages) {
    if (messages.length === 0) return [];
    const uris = messages.map(([uri]) => uri);
    const payloads = messages.map(([, p]) => toBytes(p));
    const u = encodeUrlList(uris);
    const body = encodeBytesList(payloads);
    const res = await fetch(`${this.baseUrl}/api/v1/receive?u=${u}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    if (!res.ok) throw new Error(`receive ${res.status}: ${await res.text()}`);
    return await res.json();
  }

  async read(urls) {
    if (urls.length === 0) return [];
    const u = encodeUrlList(urls);
    const res = await fetch(`${this.baseUrl}/api/v1/read?u=${u}`, { method: "POST" });
    if (!res.ok) throw new Error(`read ${res.status}: ${await res.text()}`);
    return await res.json();
  }
}

export function decodeHashContent(payload) {
  // Payloads at hash://sha256/... come back as Uint8Array on the wire;
  // over JSON they may be {0: ..., 1: ...} object shapes or base64.
  // The taskwatch HTTP server JSON-encodes hash:// payloads — they
  // arrive here as plain string when the bytes are valid UTF-8 (most
  // body content) or as a numeric-keyed object otherwise.
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && payload.constructor === Object) {
    try {
      const arr = Object.values(payload).map((v) => Number(v));
      return dec.decode(new Uint8Array(arr));
    } catch { /* fall through */ }
  }
  if (payload instanceof Uint8Array) return dec.decode(payload);
  return String(payload ?? "");
}

export async function sha256HexUtf8(text) {
  const bytes = enc.encode(text);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newTaskId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
