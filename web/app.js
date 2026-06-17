import { B3ndHttpClient } from "/static/b3nd-http.js";
import { marked } from "https://esm.sh/marked@13.0.3";

marked.setOptions({ gfm: true, breaks: true });

const BASE = location.origin;
const client = new B3ndHttpClient(BASE);

// Discovered at boot via /config.
let BASEPATH = "taskwatch://";

const STATUSES = ["active", "paused", "blocked", "rotting", "done", "abandoned", "superseded"];

const $ = (id) => document.getElementById(id);
const $list = $("list");
const $content = $("content");
const $tagsList = $("tags-list");
const $counts = $("counts");
const $basepathLabel = $("basepath-label");
const $versionLabel = $("version-label");
const $toast = $("toast");
const $clearFilters = $("clear-filters");

let TASKS = [];     // [{ addr, title, status, updatedAt, tags }]
let FILTERS = readHashFilters();
let OPEN_VIEW = null;

// ─── utilities ───────────────────────────────────────────────────

function showError(msg) {
  $toast.textContent = msg;
  $toast.classList.remove("hidden");
  clearTimeout(showError._t);
  showError._t = setTimeout(() => $toast.classList.add("hidden"), 4000);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderMarkdown(body) {
  if (!body) return "";
  try {
    return marked.parse(String(body), { async: false });
  } catch {
    return `<p>${escapeHtml(body)}</p>`;
  }
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

function fmtTsLocal(ts) {
  // YYYYMMDDhhmmss UTC → "YYYY-MM-DD HH:mm"
  const d = new Date(parseTs(ts));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  const prefix = BASEPATH + "task/";
  if (!uri.startsWith(prefix)) return null;
  const parts = uri.slice(prefix.length).split("/");
  if (parts.length !== 4 || parts[2] !== "entries") return null;
  const m = parts[3].match(/^([0-9]{14})-(.+)$/);
  if (!m) return null;
  return { ts: parts[0], slug: parts[1], entryTs: m[1], kind: m[2] };
}

function parseTagUri(uri) {
  const prefix = BASEPATH + "task/";
  if (!uri.startsWith(prefix)) return null;
  const parts = uri.slice(prefix.length).split("/");
  if (parts.length !== 4 || parts[2] !== "tags") return null;
  return parts[3];
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

function readHashFilters() {
  const sp = new URLSearchParams(location.hash.replace(/^#/, ""));
  return {
    status: sp.get("status") ?? "active",
    tag: sp.get("tag") ?? "",
    open: sp.get("open") ?? "", // "{ts}-{slug}"
  };
}

function writeHashFilters() {
  const sp = new URLSearchParams();
  if (FILTERS.status) sp.set("status", FILTERS.status);
  if (FILTERS.tag) sp.set("tag", FILTERS.tag);
  if (FILTERS.open) sp.set("open", FILTERS.open);
  const next = sp.toString();
  const url = next ? `#${next}` : location.pathname;
  history.replaceState(null, "", url);
}

// ─── config / boot ───────────────────────────────────────────────

async function discoverConfig() {
  try {
    const res = await fetch(`${BASE}/config`);
    if (res.ok) {
      const cfg = await res.json();
      if (typeof cfg.basepath === "string" && cfg.basepath.includes("://")) {
        BASEPATH = cfg.basepath.endsWith("/") ? cfg.basepath : cfg.basepath + "/";
      }
      if (cfg.version) $versionLabel.textContent = `v${cfg.version}`;
    }
  } catch (err) {
    showError("config fetch failed: " + err.message);
  }
  $basepathLabel.textContent = BASEPATH;
}

// ─── list load ───────────────────────────────────────────────────

async function loadList() {
  try {
    const indexLoc = `${BASEPATH}index/?fn=ls&format=full`;
    const out = await client.read([indexLoc]);
    const rows = out[0]?.[1] ?? [];
    const addrs = [];
    for (const [uri, title] of rows) {
      const addr = parseIndexUri(uri);
      if (!addr) continue;
      addrs.push({ addr, title: title ?? "" });
    }

    // Fetch entries + tags in parallel per task.
    const enriched = await Promise.all(addrs.map(async (t) => {
      const [entries, tags] = await Promise.all([
        readUris(`${taskRootUri(t.addr)}/entries/?fn=ls&format=uris`),
        readUris(`${taskRootUri(t.addr)}/tags/?fn=ls&format=uris`),
      ]);
      let latestTs;
      let latestStatusTs;
      let status = "active";
      for (const u of entries) {
        const p = parseEntryUri(u);
        if (!p) continue;
        if (!latestTs || p.entryTs > latestTs) latestTs = p.entryTs;
        const s = statusFromKind(p.kind);
        if (s && (!latestStatusTs || p.entryTs > latestStatusTs)) {
          latestStatusTs = p.entryTs;
          status = s;
        }
      }
      const tagNames = tags.map(parseTagUri).filter(Boolean);
      return {
        ...t,
        status,
        tags: tagNames,
        updatedAt: latestTs ? parseTs(latestTs) : parseTs(t.addr.ts),
      };
    }));

    TASKS = enriched;
    renderAll();
  } catch (err) {
    showError("list failed: " + err.message);
  }
}

async function readUris(loc) {
  try {
    const out = await client.read([loc]);
    return out[0]?.[1] ?? [];
  } catch {
    return [];
  }
}

// ─── render ──────────────────────────────────────────────────────

function filteredTasks() {
  return TASKS.filter((t) => {
    if (FILTERS.status && t.status !== FILTERS.status) return false;
    if (FILTERS.tag && !t.tags.includes(FILTERS.tag)) return false;
    return true;
  }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function renderAll() {
  renderTabs();
  renderTagSidebar();
  renderList();
  renderClearBtn();
  renderDetail();
  renderCounts();
}

function renderCounts() {
  const total = TASKS.length;
  const shown = filteredTasks().length;
  if (total === shown) {
    $counts.textContent = `${total} task${total === 1 ? "" : "s"}`;
  } else {
    $counts.textContent = `${shown} of ${total}`;
  }
}

function renderTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    const s = tab.dataset.status;
    tab.classList.toggle("is-active", s === FILTERS.status);
  }
}

function renderTagSidebar() {
  const counts = new Map();
  for (const t of TASKS) {
    if (FILTERS.status && t.status !== FILTERS.status) continue;
    for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const items = [
    `<li><button type="button" class="filter-item ${FILTERS.tag === "" ? "is-active" : ""}" data-tag="">all tags</button></li>`,
    ...tags.map(([tag, n]) =>
      `<li><button type="button" class="filter-item ${FILTERS.tag === tag ? "is-active" : ""}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} <span style="color:var(--muted);float:right;">${n}</span></button></li>`
    ),
  ];
  if (tags.length === 0 && FILTERS.tag === "") {
    items.length = 0;
    items.push(`<li style="padding:0.32rem 0.55rem;color:var(--muted);font-size:0.78rem;">no tags</li>`);
  }
  $tagsList.innerHTML = items.join("");
  for (const btn of $tagsList.querySelectorAll("[data-tag]")) {
    btn.addEventListener("click", () => {
      FILTERS.tag = btn.dataset.tag;
      writeHashFilters();
      renderAll();
    });
  }
}

function renderClearBtn() {
  $clearFilters.classList.toggle("hidden", !FILTERS.tag);
}

function renderList() {
  const tasks = filteredTasks();
  if (!tasks.length) {
    const msg = FILTERS.status
      ? `no ${FILTERS.status} tasks${FILTERS.tag ? ` tagged ${FILTERS.tag}` : ""}`
      : "no tasks yet";
    $list.innerHTML = `<li class="empty">${escapeHtml(msg)}</li>`;
    return;
  }
  const openKey = FILTERS.open;
  $list.innerHTML = tasks.map((t) => {
    const key = `${t.addr.ts}-${t.addr.slug}`;
    const isOpen = key === openKey;
    return `
      <li>
        <button type="button"
                class="row s-${t.status} ${isOpen ? "is-open" : ""}"
                role="option"
                aria-selected="${isOpen}"
                data-key="${key}">
          <span class="row-main">
            <span class="row-title">${escapeHtml(t.title || "(untitled)")}</span>
            <span class="row-sub">
              <span class="s-${t.status}">${t.status}</span>
              ${t.tags.slice(0, 3).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join(" ")}
            </span>
          </span>
          <span class="row-meta">
            <span class="ts">${relTime(t.updatedAt)}</span>
          </span>
        </button>
      </li>
    `;
  }).join("");

  for (const btn of $list.querySelectorAll("[data-key]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const dash = key.indexOf("-");
      const ts = key.slice(0, dash);
      const slug = key.slice(dash + 1);
      openTask({ ts, slug });
    });
  }
}

// ─── detail ──────────────────────────────────────────────────────

async function openTask(addr) {
  FILTERS.open = `${addr.ts}-${addr.slug}`;
  writeHashFilters();
  renderList();
  try {
    const viewLoc = `${taskRootUri(addr)}?fn=view`;
    const out = await client.read([viewLoc]);
    const view = out[0]?.[1];
    if (!view || !view.title) {
      showError(`task not found: ${addr.ts}-${addr.slug}`);
      return;
    }
    OPEN_VIEW = view;
    renderDetail();
  } catch (err) {
    showError("view failed: " + err.message);
  }
}

function renderDetail() {
  if (!OPEN_VIEW) {
    $content.innerHTML = `<div class="placeholder"><p>Select a task from the list to open it here.</p></div>`;
    return;
  }
  const v = OPEN_VIEW;
  const ctxEntries = Object.entries(v.context ?? {});
  const ctxHtml = ctxEntries.length
    ? `
      <div class="detail-section">
        <div class="detail-section-label">context</div>
        <div class="context-grid">
          ${ctxEntries.map(([k, val]) => `
            <span class="k">${escapeHtml(k)}</span>
            <span class="v">${escapeHtml(val)}</span>
          `).join("")}
        </div>
      </div>`
    : "";

  const tagsHtml = (v.tags ?? []).length
    ? `
      <div class="detail-section">
        <div class="detail-section-label">tags</div>
        <div class="tags-row">
          ${v.tags.map((t) => `<span class="tag-chip">#${escapeHtml(t)}</span>`).join("")}
        </div>
      </div>`
    : "";

  const descHtml = v.description
    ? `
      <div class="detail-section">
        <div class="detail-section-label">description</div>
        <div class="markdown">${renderMarkdown(v.description)}</div>
      </div>`
    : "";

  const sortedEntries = [...(v.entries ?? [])].sort((a, b) => b.ts.localeCompare(a.ts));
  const entriesHtml = sortedEntries.length
    ? `
      <div class="detail-section">
        <div class="detail-section-label">entries (${sortedEntries.length})</div>
        <div class="entries-list">
          ${sortedEntries.map((e) => {
            const status = statusFromKind(e.kind);
            const kindClass = status ? `kind-status s-${status}` : `kind-${escapeHtml(e.kind.split("-")[0])}`;
            return `
              <div class="entry ${kindClass}">
                <div class="entry-head">
                  <span class="ts">${fmtTsLocal(e.ts)}</span>
                  <span class="entry-kind">${escapeHtml(e.kind)}</span>
                </div>
                ${e.body ? `<div class="markdown compact">${renderMarkdown(e.body)}</div>` : ""}
              </div>`;
          }).join("")}
        </div>
      </div>`
    : "";

  const resourcesHtml = (v.resources ?? []).length
    ? `
      <div class="detail-section">
        <div class="detail-section-label">resources</div>
        ${v.resources.map((r) => {
          const isUrl = /^https?:\/\//.test(r.body);
          const body = isUrl
            ? `<a target="_blank" rel="noopener" href="${escapeHtml(r.body)}">${escapeHtml(r.body)}</a>`
            : escapeHtml(r.body);
          return `<div class="resource-row"><span class="name">${escapeHtml(r.name)}</span><span class="body">${body}</span></div>`;
        }).join("")}
      </div>`
    : "";

  $content.innerHTML = `
    <article class="detail">
      <header class="detail-head">
        <div class="detail-meta">
          <span class="detail-status s-${v.status}">${v.status}</span>
          <span class="ts" style="color:var(--muted);font-family:var(--mono);font-size:0.78rem;">
            updated ${relTime(new Date(v.updatedAt).getTime())}
          </span>
          <span style="margin-left:auto;display:flex;gap:0.4rem;">
            <button class="btn" id="btn-back" type="button">← list</button>
            <button class="btn primary" id="btn-entry" type="button">+ entry</button>
          </span>
        </div>
        <h2>${escapeHtml(v.title)}</h2>
        <div class="detail-uri">${escapeHtml(v.uri)}</div>
      </header>

      ${descHtml}
      ${ctxHtml}
      ${tagsHtml}
      ${entriesHtml}
      ${resourcesHtml}
    </article>
  `;

  $("btn-back").addEventListener("click", closeTask);
  $("btn-entry").addEventListener("click", () => openEntryModal(v));
}

function closeTask() {
  OPEN_VIEW = null;
  FILTERS.open = "";
  writeHashFilters();
  renderList();
  renderDetail();
}

// ─── new task modal ──────────────────────────────────────────────

function openNew() { $("new-modal").classList.remove("hidden"); }
function closeNew() {
  $("new-modal").classList.add("hidden");
  $("new-form").reset();
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
    await openTask(addr);
  } catch (err) {
    showError("create failed: " + err.message);
  }
}

// ─── append entry modal ──────────────────────────────────────────

function openEntryModal(view) {
  const form = $("entry-form");
  form.dataset.ts = view.addr.ts;
  form.dataset.slug = view.addr.slug;
  $("entry-modal").classList.remove("hidden");
}

function closeEntryModal() {
  $("entry-modal").classList.add("hidden");
  $("entry-form").reset();
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
      messages.push([`${root}/entries/${ts}-status-${newStatus}`, body && !messages.length ? body : ""]);
    }
    const results = await client.receive(messages);
    const bad = results.find((r) => !r.accepted);
    if (bad) throw new Error(bad.error ?? "receive rejected");

    closeEntryModal();
    await loadList();
    await openTask(addr);
  } catch (err) {
    showError("append failed: " + err.message);
  }
}

// ─── wire up ─────────────────────────────────────────────────────

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    FILTERS.status = tab.dataset.status;
    writeHashFilters();
    renderAll();
  });
}

$clearFilters.addEventListener("click", () => {
  FILTERS.tag = "";
  writeHashFilters();
  renderAll();
});

$("btn-refresh").addEventListener("click", () => loadList());
$("btn-new").addEventListener("click", openNew);
$("new-cancel").addEventListener("click", closeNew);
$("entry-cancel").addEventListener("click", closeEntryModal);
$("new-form").addEventListener("submit", submitNew);
$("entry-form").addEventListener("submit", submitEntry);

// Close modal on backdrop click.
for (const id of ["new-modal", "entry-modal"]) {
  $(id).addEventListener("click", (ev) => {
    if (ev.target.id === id) {
      id === "new-modal" ? closeNew() : closeEntryModal();
    }
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    $("new-modal").classList.add("hidden");
    $("entry-modal").classList.add("hidden");
  }
});

await discoverConfig();
await loadList();

if (FILTERS.open) {
  const dash = FILTERS.open.indexOf("-");
  const ts = FILTERS.open.slice(0, dash);
  const slug = FILTERS.open.slice(dash + 1);
  if (ts && slug) await openTask({ ts, slug });
}
