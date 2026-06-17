import { B3ndHttpClient } from "/static/b3nd-http.js";

const BASE = location.origin;
const client = new B3ndHttpClient(BASE);

// Discovered at boot via b3nd_status.
let BASEPATH = "taskwatch://";

const $list = document.getElementById("list");
const $detail = document.getElementById("detail");
const $error = document.getElementById("error");
const $filterStatus = document.getElementById("filter-status");
const $basepathLabel = document.getElementById("basepath-label");

function showError(msg) {
  $error.textContent = msg;
  $error.classList.remove("hidden");
  setTimeout(() => $error.classList.add("hidden"), 4000);
}

function relTime(ms) {
  const d = Date.now() - ms;
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function pill(status) {
  return `<span class="pill pill-${status}">${status}</span>`;
}

function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "") || "task";
}

function nowTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}

function parseTs(ts) {
  return Date.UTC(
    Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1,
    Number(ts.slice(6, 8)), Number(ts.slice(8, 10)),
    Number(ts.slice(10, 12)), Number(ts.slice(12, 14)),
  );
}

function parseIndexUri(uri) {
  if (!uri.startsWith(BASEPATH + "index/")) return null;
  const tail = uri.slice((BASEPATH + "index/").length);
  const m = tail.match(/^([0-9]{14})-(.+)$/);
  if (!m) return null;
  return { ts: m[1], slug: m[2] };
}

function parseEntryUri(uri) {
  // {basepath}task/{ts}/{slug}/entries/{ts2}-{kind}
  const prefix = BASEPATH + "task/";
  if (!uri.startsWith(prefix)) return null;
  const parts = uri.slice(prefix.length).split("/");
  if (parts.length !== 4 || parts[2] !== "entries") return null;
  const m = parts[3].match(/^([0-9]{14})-(.+)$/);
  if (!m) return null;
  return { ts: parts[0], slug: parts[1], entryTs: m[1], kind: m[2] };
}

function statusFromKind(kind) {
  if (!kind.startsWith("status-")) return null;
  return kind.slice("status-".length);
}

function taskRootUri(addr) {
  return `${BASEPATH}task/${addr.ts}/${addr.slug}`;
}

function indexUri(addr) {
  return `${BASEPATH}index/${addr.ts}-${addr.slug}`;
}

// ─── status discovery ─────────────────────────────────────────────

async function discoverBasepath() {
  try {
    const res = await fetch(`${BASE}/config`);
    if (res.ok) {
      const cfg = await res.json();
      if (typeof cfg.basepath === "string" && cfg.basepath.includes("://")) {
        BASEPATH = cfg.basepath.endsWith("/") ? cfg.basepath : cfg.basepath + "/";
      }
    }
    if ($basepathLabel) {
      $basepathLabel.textContent = BASEPATH;
    }
  } catch (err) {
    showError("config fetch failed: " + err.message);
  }
}

// ─── list ─────────────────────────────────────────────────────────

async function loadList() {
  $detail.classList.add("hidden");
  $list.classList.remove("hidden");

  try {
    const indexLoc = `${BASEPATH}index/?fn=ls&format=full`;
    const out = await client.read([indexLoc]);
    const rows = out[0]?.[1] ?? [];

    // Each row: [uri, title]
    const tasks = [];
    for (const [uri, title] of rows) {
      const addr = parseIndexUri(uri);
      if (!addr) continue;
      tasks.push({ addr, title: title ?? "" });
    }

    // Fetch derived status for each.
    const statuses = await Promise.all(tasks.map((t) => deriveStatus(t.addr)));
    for (let i = 0; i < tasks.length; i++) {
      tasks[i].status = statuses[i].status;
      tasks[i].updatedAt = statuses[i].updatedAt;
    }

    // Filter by status if requested.
    const filter = $filterStatus.value;
    const filtered = filter ? tasks.filter((t) => t.status === filter) : tasks;

    // Sort newest-updated first.
    filtered.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (!filtered.length) {
      $list.innerHTML = `<div class="text-stone-500 text-center py-12">no tasks ${filter ? "with status " + filter : "yet"}</div>`;
      return;
    }
    $list.innerHTML = filtered.map(taskCard).join("");
    for (const el of $list.querySelectorAll("[data-addr]")) {
      el.addEventListener("click", () => {
        const [ts, ...slugParts] = el.dataset.addr.split("-");
        loadDetail({ ts, slug: slugParts.join("-") });
      });
    }
  } catch (err) {
    showError("list failed: " + err.message);
  }
}

async function deriveStatus(addr) {
  try {
    const loc = `${taskRootUri(addr)}/entries/?fn=ls&format=uris`;
    const out = await client.read([loc]);
    const uris = out[0]?.[1] ?? [];
    let latestTs;
    let latestStatusTs;
    let status = "active";
    for (const u of uris) {
      const parsed = parseEntryUri(u);
      if (!parsed) continue;
      if (!latestTs || parsed.entryTs > latestTs) latestTs = parsed.entryTs;
      const st = statusFromKind(parsed.kind);
      if (st && (!latestStatusTs || parsed.entryTs > latestStatusTs)) {
        latestStatusTs = parsed.entryTs;
        status = st;
      }
    }
    const updatedAt = latestTs ? parseTs(latestTs) : parseTs(addr.ts);
    return { status, updatedAt };
  } catch {
    return { status: "active", updatedAt: parseTs(addr.ts) };
  }
}

function taskCard(t) {
  return `
    <div class="bg-white border border-stone-200 rounded-lg p-4 hover:border-stone-300 cursor-pointer" data-addr="${t.addr.ts}-${t.addr.slug}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            ${pill(t.status)}
            <h3 class="font-medium truncate">${escapeHtml(t.title)}</h3>
          </div>
          <div class="mono text-xs text-stone-400 mt-1 truncate">${t.addr.ts}-${escapeHtml(t.addr.slug)}</div>
        </div>
        <div class="text-xs text-stone-500 whitespace-nowrap">
          ${relTime(t.updatedAt)}
        </div>
      </div>
    </div>
  `;
}

// ─── detail ───────────────────────────────────────────────────────

async function loadDetail(addr) {
  try {
    const viewLoc = `${taskRootUri(addr)}?fn=view`;
    const out = await client.read([viewLoc]);
    const view = out[0]?.[1];
    if (!view || !view.title) {
      showError(`task not found: ${addr.ts}-${addr.slug}`);
      return;
    }
    renderDetail(view);
  } catch (err) {
    showError("view failed: " + err.message);
  }
}

function renderDetail(view) {
  $list.classList.add("hidden");
  $detail.classList.remove("hidden");

  const ctxRows = Object.entries(view.context ?? {}).map(([k, v]) =>
    `<div class="text-stone-500">${escapeHtml(k)}</div><div class="mono">${escapeHtml(v)}</div>`
  ).join("");

  const tagsHtml = (view.tags ?? []).map((t) =>
    `<span class="text-xs bg-stone-100 text-stone-700 px-2 py-0.5 rounded">${escapeHtml(t)}</span>`
  ).join(" ");

  const entriesHtml = (view.entries ?? []).map((e) => {
    const status = statusFromKind(e.kind);
    const kindBadge = status
      ? `<span class="pill pill-${status} mr-1">${e.kind}</span>`
      : `<span class="text-stone-400 mono">${e.kind}</span>`;
    return `
      <div class="border-l-2 border-stone-300 pl-3 py-1">
        <div class="text-xs text-stone-500">
          <span class="mono">${e.ts.slice(0,8)} ${e.ts.slice(8,14)}</span> ${kindBadge}
        </div>
        ${e.body ? `<div class="text-sm mt-0.5 whitespace-pre-wrap">${escapeHtml(e.body)}</div>` : ""}
      </div>
    `;
  }).join("");

  const resourcesHtml = (view.resources ?? []).map((r) => {
    const isUrl = /^https?:\/\//.test(r.body);
    const body = isUrl
      ? `<a target="_blank" class="text-blue-600 hover:underline" href="${escapeHtml(r.body)}">${escapeHtml(r.body)}</a>`
      : `<span class="mono">${escapeHtml(r.body)}</span>`;
    return `<div class="text-sm"><span class="mono text-stone-500">${escapeHtml(r.name)}</span> → ${body}</div>`;
  }).join("");

  $detail.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <button id="back" class="text-sm text-stone-600 hover:text-stone-900">&larr; back</button>
      <div class="flex gap-2">
        <button id="btn-entry" class="px-3 py-1 text-sm rounded bg-stone-900 text-white hover:bg-stone-700">append entry</button>
      </div>
    </div>
    <div class="bg-white border border-stone-200 rounded-lg p-6">
      <div class="flex items-center gap-2 mb-2">
        ${pill(view.status)}
        <h2 class="text-xl font-semibold">${escapeHtml(view.title)}</h2>
      </div>
      <div class="text-xs text-stone-500 mono">${escapeHtml(view.addr.ts)}-${escapeHtml(view.addr.slug)}</div>

      ${ctxRows ? `
        <div class="mt-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">${ctxRows}</div>
      ` : ""}

      ${tagsHtml ? `<div class="mt-3 flex gap-1 flex-wrap">${tagsHtml}</div>` : ""}

      ${view.description ? `
        <div class="mt-4">
          <div class="text-xs uppercase tracking-wide text-stone-500 mb-1">description</div>
          <div class="text-sm whitespace-pre-wrap">${escapeHtml(view.description)}</div>
        </div>
      ` : ""}

      ${entriesHtml ? `
        <div class="mt-6">
          <div class="text-xs uppercase tracking-wide text-stone-500 mb-2">entries</div>
          <div class="space-y-2">${entriesHtml}</div>
        </div>
      ` : ""}

      ${resourcesHtml ? `
        <div class="mt-6">
          <div class="text-xs uppercase tracking-wide text-stone-500 mb-2">resources</div>
          <div class="space-y-1">${resourcesHtml}</div>
        </div>
      ` : ""}
    </div>
  `;

  document.getElementById("back").addEventListener("click", loadList);
  document.getElementById("btn-entry").addEventListener("click", () => openEntry(view));
}

// ─── new task ─────────────────────────────────────────────────────

function openNew() { document.getElementById("new-modal").classList.remove("hidden"); }
function closeNew() {
  document.getElementById("new-modal").classList.add("hidden");
  document.getElementById("new-form").reset();
}

async function submitNew(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const title = String(f.get("title") ?? "").trim();
  if (!title) return;
  const description = String(f.get("description") ?? "");
  const tagsRaw = String(f.get("tags") ?? "");
  const tags = tagsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const context = {
    worktree: String(f.get("worktree") ?? "") || undefined,
    repo: String(f.get("repo") ?? "") || undefined,
    branch: String(f.get("branch") ?? "") || undefined,
    pr: String(f.get("pr") ?? "") || undefined,
    agent: String(f.get("agent") ?? "") || undefined,
  };

  try {
    const addr = { ts: nowTs(), slug: slugify(title) };
    const root = taskRootUri(addr);
    const messages = [[`${root}/title`, title]];
    if (description) messages.push([`${root}/description`, description]);
    for (const [k, v] of Object.entries(context)) {
      if (v) messages.push([`${root}/context/${k}`, v]);
    }
    for (const tag of tags) {
      messages.push([`${root}/tags/${tag}`, ""]);
    }
    messages.push([indexUri(addr), title]);

    const results = await client.receive(messages);
    const bad = results.find((r) => !r.accepted);
    if (bad) throw new Error(bad.error ?? "receive rejected");

    closeNew();
    await loadList();
  } catch (err) {
    showError("create failed: " + err.message);
  }
}

// ─── append entry ─────────────────────────────────────────────────

function openEntry(view) {
  const form = document.getElementById("entry-form");
  form.dataset.ts = view.addr.ts;
  form.dataset.slug = view.addr.slug;
  document.getElementById("entry-modal").classList.remove("hidden");
}
function closeEntry() {
  document.getElementById("entry-modal").classList.add("hidden");
  document.getElementById("entry-form").reset();
}

async function submitEntry(ev) {
  ev.preventDefault();
  const form = ev.target;
  const addr = { ts: form.dataset.ts, slug: form.dataset.slug };
  const f = new FormData(form);
  const kind = String(f.get("kind") ?? "note");
  const body = String(f.get("body") ?? "").trim();
  const newStatus = String(f.get("new_status") ?? "");

  try {
    const root = taskRootUri(addr);
    const ts = nowTs();
    const messages = [];
    if (body) {
      messages.push([`${root}/entries/${ts}-${kind}`, body]);
    } else if (!newStatus) {
      throw new Error("either a body or a new status is required");
    }
    if (newStatus) {
      const statusBody = body && kind === "status" ? body : "";
      messages.push([`${root}/entries/${ts}-status-${newStatus}`, statusBody]);
    }
    const results = await client.receive(messages);
    const bad = results.find((r) => !r.accepted);
    if (bad) throw new Error(bad.error ?? "receive rejected");

    closeEntry();
    await loadDetail(addr);
  } catch (err) {
    showError("append failed: " + err.message);
  }
}

// ─── wire up ──────────────────────────────────────────────────────

document.getElementById("btn-refresh").addEventListener("click", loadList);
document.getElementById("btn-new").addEventListener("click", openNew);
document.getElementById("new-cancel").addEventListener("click", closeNew);
document.getElementById("entry-cancel").addEventListener("click", closeEntry);
document.getElementById("new-form").addEventListener("submit", submitNew);
document.getElementById("entry-form").addEventListener("submit", submitEntry);
$filterStatus.addEventListener("change", loadList);

await discoverBasepath();
await loadList();
