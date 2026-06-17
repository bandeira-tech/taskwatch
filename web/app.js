import {
  B3ndHttpClient,
  decodeHashContent,
  newTaskId,
  sha256HexUtf8,
} from "/static/b3nd-http.js";

const BASE = location.origin;
const client = new B3ndHttpClient(BASE);

const $list = document.getElementById("list");
const $detail = document.getElementById("detail");
const $error = document.getElementById("error");
const $filterStatus = document.getElementById("filter-status");

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

function taskCard(t) {
  const ctx = t.context ?? {};
  const ctxBits = [];
  if (ctx.repo) ctxBits.push(escapeHtml(ctx.repo));
  if (ctx.branch) ctxBits.push(`<span class="mono">${escapeHtml(ctx.branch)}</span>`);
  if (ctx.agent) ctxBits.push(`@${escapeHtml(ctx.agent)}`);
  const ctxLine = ctxBits.length ? `<div class="text-xs text-stone-500 mt-1">${ctxBits.join(" · ")}</div>` : "";
  const tags = (t.tags ?? []).map((t) => `<span class="text-xs bg-stone-100 text-stone-700 px-2 py-0.5 rounded">${escapeHtml(t)}</span>`).join(" ");
  return `
    <div class="bg-white border border-stone-200 rounded-lg p-4 hover:border-stone-300 cursor-pointer" data-id="${t.id}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            ${pill(t.status)}
            <h3 class="font-medium truncate">${escapeHtml(t.title)}</h3>
          </div>
          ${ctxLine}
          ${tags ? `<div class="mt-2 flex gap-1 flex-wrap">${tags}</div>` : ""}
        </div>
        <div class="text-xs text-stone-500 whitespace-nowrap">
          <div>${t.updateCount} update${t.updateCount === 1 ? "" : "s"}</div>
          <div>${relTime(t.updatedAt)}</div>
          <div class="mono text-stone-400 mt-1">${t.id}</div>
        </div>
      </div>
    </div>
  `;
}

async function loadList() {
  $detail.classList.add("hidden");
  $list.classList.remove("hidden");
  const status = $filterStatus.value;
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  const locator = `task://t/list${q}`;
  try {
    const out = await client.read([locator]);
    const tasks = (out[0]?.[1] ?? []);
    if (!tasks.length) {
      $list.innerHTML = `<div class="text-stone-500 text-center py-12">no tasks ${status ? "with status " + status : "yet"}</div>`;
      return;
    }
    $list.innerHTML = tasks.map(taskCard).join("");
    for (const el of $list.querySelectorAll("[data-id]")) {
      el.addEventListener("click", () => loadDetail(el.dataset.id));
    }
  } catch (err) {
    showError("list failed: " + err.message);
  }
}

async function loadDetail(id) {
  try {
    const metaOut = await client.read([`task://t/${id}`]);
    const meta = metaOut[0]?.[1];
    if (!meta) {
      showError(`task not found: ${id}`);
      return;
    }
    const subReads = [];
    if (meta.contentRef) subReads.push(meta.contentRef);
    subReads.push(...(meta.updateUris ?? []));
    subReads.push(...(meta.resourceUris ?? []));
    const subOut = subReads.length ? await client.read(subReads) : [];

    let content = "";
    const updates = [];
    const resources = [];
    let i = 0;
    if (meta.contentRef) {
      content = decodeHashContent(subOut[i++]?.[1]);
    }
    for (const _u of meta.updateUris ?? []) {
      const u = subOut[i++]?.[1];
      if (u) updates.push(u);
    }
    for (const _r of meta.resourceUris ?? []) {
      const r = subOut[i++]?.[1];
      if (r) resources.push(r);
    }

    // Fetch update bodies for any with contentRef.
    const bodyRefs = updates.filter((u) => u.contentRef).map((u) => u.contentRef);
    let bodyMap = new Map();
    if (bodyRefs.length) {
      const bodyOut = await client.read(bodyRefs);
      for (let k = 0; k < bodyRefs.length; k++) {
        bodyMap.set(bodyRefs[k], decodeHashContent(bodyOut[k]?.[1]));
      }
    }

    renderDetail(meta, content, updates, resources, bodyMap);
  } catch (err) {
    showError("view failed: " + err.message);
  }
}

function renderDetail(meta, content, updates, resources, bodyMap) {
  $list.classList.add("hidden");
  $detail.classList.remove("hidden");

  const ctx = meta.context ?? {};
  const ctxRows = [];
  if (ctx.worktree) ctxRows.push(["worktree", `<span class="mono">${escapeHtml(ctx.worktree)}</span>`]);
  if (ctx.repo) ctxRows.push(["repo", escapeHtml(ctx.repo)]);
  if (ctx.branch) ctxRows.push(["branch", `<span class="mono">${escapeHtml(ctx.branch)}</span>`]);
  if (ctx.pr) ctxRows.push(["pr", `<a class="text-blue-600 hover:underline" target="_blank" href="${escapeHtml(ctx.pr)}">${escapeHtml(ctx.pr)}</a>`]);
  if (ctx.agent) ctxRows.push(["agent", escapeHtml(ctx.agent)]);

  const updatesHtml = updates.sort((a, b) => a.seq - b.seq).map((u) => {
    const body = u.contentRef ? bodyMap.get(u.contentRef) : "";
    return `
      <div class="border-l-2 border-stone-300 pl-3 py-1">
        <div class="text-xs text-stone-500">
          <span class="mono">[${String(u.seq).padStart(3, "0")}]</span>
          ${new Date(u.ts).toISOString()} · ${escapeHtml(u.kind)}
        </div>
        <div class="text-sm mt-0.5">${escapeHtml(u.message ?? "")}</div>
        ${body ? `<div class="text-sm text-stone-700 mt-1 whitespace-pre-wrap">${escapeHtml(body)}</div>` : ""}
      </div>
    `;
  }).join("");

  const resourcesHtml = resources.map((r) => `
    <div class="text-sm">
      <span class="mono text-stone-500">${escapeHtml(r.name)}</span>
      <span class="text-stone-400 text-xs">(${escapeHtml(r.kind)})</span>
      ${r.url ? `<a target="_blank" class="text-blue-600 hover:underline ml-2" href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a>` : ""}
    </div>
  `).join("");

  $detail.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <button id="back" class="text-sm text-stone-600 hover:text-stone-900">&larr; back</button>
      <div class="flex gap-2">
        <button id="btn-update" class="px-3 py-1 text-sm rounded bg-stone-900 text-white hover:bg-stone-700">append update</button>
      </div>
    </div>
    <div class="bg-white border border-stone-200 rounded-lg p-6">
      <div class="flex items-center gap-2 mb-2">
        ${pill(meta.status)}
        <h2 class="text-xl font-semibold">${escapeHtml(meta.title)}</h2>
      </div>
      <div class="text-xs text-stone-500 mono">${escapeHtml(meta.id)} · updated ${relTime(meta.updatedAt)}</div>

      ${ctxRows.length ? `
        <div class="mt-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          ${ctxRows.map(([k, v]) => `<div class="text-stone-500">${k}</div><div>${v}</div>`).join("")}
        </div>
      ` : ""}

      ${(meta.tags ?? []).length ? `
        <div class="mt-3 flex gap-1 flex-wrap">
          ${(meta.tags ?? []).map((t) => `<span class="text-xs bg-stone-100 text-stone-700 px-2 py-0.5 rounded">${escapeHtml(t)}</span>`).join("")}
        </div>
      ` : ""}

      ${content ? `
        <div class="mt-4">
          <div class="text-xs uppercase tracking-wide text-stone-500 mb-1">description</div>
          <div class="text-sm whitespace-pre-wrap">${escapeHtml(content)}</div>
        </div>
      ` : ""}

      ${updates.length ? `
        <div class="mt-6">
          <div class="text-xs uppercase tracking-wide text-stone-500 mb-2">updates</div>
          <div class="space-y-2">${updatesHtml}</div>
        </div>
      ` : ""}

      ${resources.length ? `
        <div class="mt-6">
          <div class="text-xs uppercase tracking-wide text-stone-500 mb-2">resources</div>
          <div class="space-y-1">${resourcesHtml}</div>
        </div>
      ` : ""}
    </div>
  `;

  document.getElementById("back").addEventListener("click", loadList);
  document.getElementById("btn-update").addEventListener("click", () => openUpdate(meta));
}

// ---------- new task ----------

function openNew() {
  document.getElementById("new-modal").classList.remove("hidden");
}
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
  const ctx = {
    repo: String(f.get("repo") ?? "") || undefined,
    branch: String(f.get("branch") ?? "") || undefined,
    pr: String(f.get("pr") ?? "") || undefined,
    agent: String(f.get("agent") ?? "") || undefined,
  };
  const hasCtx = Object.values(ctx).some(Boolean);

  try {
    const id = newTaskId();
    const messages = [];
    let contentRef;
    if (description.trim()) {
      const hex = await sha256HexUtf8(description);
      contentRef = `hash://sha256/${hex}`;
      messages.push([contentRef, description]);
    }
    const now = Date.now();
    const meta = {
      id, title, status: "active",
      createdAt: now, updatedAt: now,
      contentRef,
      tags: tags.length ? tags : undefined,
      context: hasCtx ? ctx : undefined,
      updateCount: 0, updateUris: [], resourceUris: [],
    };
    messages.push([`task://t/${id}`, meta]);

    const results = await client.receive(messages);
    const bad = results.find((r) => !r.accepted);
    if (bad) throw new Error(bad.error ?? "receive rejected");

    closeNew();
    await loadList();
  } catch (err) {
    showError("create failed: " + err.message);
  }
}

// ---------- append update ----------

function openUpdate(meta) {
  const form = document.getElementById("update-form");
  form.querySelector('input[name="taskId"]').value = meta.id;
  document.getElementById("update-modal").classList.remove("hidden");
}
function closeUpdate() {
  document.getElementById("update-modal").classList.add("hidden");
  document.getElementById("update-form").reset();
}

async function submitUpdate(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const id = String(f.get("taskId") ?? "");
  const message = String(f.get("message") ?? "").trim();
  if (!id || !message) return;
  const kind = String(f.get("kind") ?? "note");
  const body = String(f.get("body") ?? "");
  const newStatus = String(f.get("new_status") ?? "") || undefined;

  try {
    const metaOut = await client.read([`task://t/${id}`]);
    const meta = metaOut[0]?.[1];
    if (!meta) throw new Error(`task ${id} not found`);

    const seq = meta.updateCount;
    const updateUri = `task://t/${id}/u/${String(seq).padStart(6, "0")}`;
    const ts = Date.now();

    const messages = [];
    let contentRef;
    if (body.trim()) {
      const hex = await sha256HexUtf8(body);
      contentRef = `hash://sha256/${hex}`;
      messages.push([contentRef, body]);
    }
    const update = { taskId: id, seq, ts, kind, message, contentRef };
    messages.push([updateUri, update]);

    const nextMeta = {
      ...meta,
      status: newStatus ?? meta.status,
      updatedAt: ts,
      updateCount: seq + 1,
      updateUris: [...meta.updateUris, updateUri],
    };
    messages.push([`task://t/${id}`, nextMeta]);

    const results = await client.receive(messages);
    const bad = results.find((r) => !r.accepted);
    if (bad) throw new Error(bad.error ?? "receive rejected");

    closeUpdate();
    await loadDetail(id);
  } catch (err) {
    showError("update failed: " + err.message);
  }
}

// ---------- wire up ----------

document.getElementById("btn-refresh").addEventListener("click", loadList);
document.getElementById("btn-new").addEventListener("click", openNew);
document.getElementById("new-cancel").addEventListener("click", closeNew);
document.getElementById("update-cancel").addEventListener("click", closeUpdate);
document.getElementById("new-form").addEventListener("submit", submitNew);
document.getElementById("update-form").addEventListener("submit", submitUpdate);
$filterStatus.addEventListener("change", loadList);

loadList();
