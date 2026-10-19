"use strict";
// All data is rendered with textContent, never innerHTML, so registry names cannot inject markup.
const $ = (id) => document.getElementById(id);
let cfg = {};
let recent = { events: [], lastChanged: {}, persistent: false, seq: 0 };
let shown = 0; // rows revealed in the current list
let updated = null;

// Preferences only, no data or secrets. Storage may be blocked, so every access is guarded.
const DEFAULTS = { theme: "system", view: "recent", sort: "recent", live: true, interval: 30, pageSize: 50 };
const CHOICES = { theme: ["system", "light", "dark"], view: ["recent", "repos"], sort: ["recent", "name"] };
let prefs = { ...DEFAULTS };
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("registry-lite-ui") || "{}");
    for (const k of Object.keys(DEFAULTS)) {
      const ok = CHOICES[k] ? CHOICES[k].includes(p[k]) : typeof p[k] === typeof DEFAULTS[k];
      if (ok) prefs[k] = p[k];
    }
  } catch (e) { /* blocked or corrupt: use defaults */ }
}
function savePrefs() { try { localStorage.setItem("registry-lite-ui", JSON.stringify(prefs)); } catch (e) { /* blocked */ } }
function applyTheme() {
  const c = document.documentElement.classList;
  c.remove("light", "dark");
  if (prefs.theme !== "system") c.add(prefs.theme);
}

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props || {});
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
}
const short = (d) => (d || "").slice(0, 19);
const size = (n) => (n == null ? "" : n < 1048576 ? (n / 1024).toFixed(1) + " KiB" : (n / 1048576).toFixed(1) + " MiB");
const code = (t) => el("code", { textContent: t });
function ago(t) {
  if (!t) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return s + " s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

async function api(path, body) {
  const opt = body ? { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": cfg.csrf }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opt);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function banner(text, err) {
  $("banner").hidden = !text;
  $("banner").className = err ? "err" : "";
  $("banner").textContent = text || "";
}

// One dialog for every action. fields: {name, label, value, type: text|checkbox|select, options}. Resolves to the values, or null on cancel.
function ask(title, lines, fields, danger) {
  const form = $("form");
  form.replaceChildren(el("h3", { textContent: title }), ...lines.map((l) => el("p", { textContent: l })));
  const input = (f) => f.type === "checkbox" ? el("input", { type: "checkbox", name: f.name, checked: f.value !== false })
    : f.type === "select" ? el("select", { name: f.name }, ...f.options.map((o) => el("option", { value: String(o), textContent: String(o), selected: String(o) === String(f.value) })))
    : el("input", { type: "text", name: f.name, value: f.value, required: true });
  fields.forEach((f) => form.append(el("label", {}, f.label + " ", input(f))));
  form.append(el("menu", {}, el("button", { textContent: "Cancel", value: "cancel" }), el("button", { textContent: "Confirm", value: "ok", className: danger ? "danger" : "" })));
  return new Promise((resolve) => {
    $("dlg").onclose = () => {
      const v = Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? form[f.name].checked : form[f.name].value]));
      resolve($("dlg").returnValue === "ok" ? v : null);
      route(); // anything skipped while the dialog was open
    };
    $("dlg").showModal();
  });
}

async function run(job, done) {
  try { banner(""); await job(); await done(); } catch (e) { banner(e.message, true); }
}

// A list that shows pageSize rows and a button for more.
function paged(rows, headers) {
  const n = shown || prefs.pageSize;
  const out = [el("table", {}, headers ? el("tr", {}, ...headers.map((h) => el("th", { textContent: h }))) : null, ...rows.slice(0, n))];
  if (rows.length > n) out.push(el("p", {}, el("button", { textContent: `Show more (${rows.length - n} left)`, onclick: () => { shown = n + prefs.pageSize; route(); } })));
  return out;
}

function recentView() {
  const rows = recent.events.map((e) => el("tr", {},
    el("td", { textContent: ago(e.t), title: new Date(e.t * 1000).toLocaleString() }),
    el("td", {}, el("span", { className: "badge " + e.type, textContent: e.type })),
    el("td", {}, e.type === "deleted" ? code(e.ref) : el("a", { href: "#/m/" + e.ref.replace(/:([^:]*)$/, "@$1"), textContent: e.ref })),
    el("td", {}, code(short(e.digest || e.prev)))));
  const note = (recent.persistent ? "History is saved to disk." : "History is in memory only and resets when the UI restarts.")
    + ` Watching since ${new Date(recent.since * 1000).toLocaleString()}. Times are when the UI saw the change, not when it was pushed or built.`;
  $("main").replaceChildren(el("h2", { textContent: "Recent changes" }), el("p", { className: "mut", textContent: note }),
    ...(rows.length ? paged(rows, ["When", "Change", "Image", "Digest"]) : [el("p", { className: "mut", textContent: recent.baselined ? "No changes seen yet." : "Reading the registry for the first time." })]));
}

function sorted(items, key) { // items sorted by recency of key(item) when the pref says so, else by name
  return prefs.sort === "recent" ? [...items].sort((a, b) => (key(b) || 0) - (key(a) || 0) || String(a.name).localeCompare(b.name)) : items;
}

async function repos() {
  const names = (await api("/api/repos")).map((name) => ({ name }));
  const rows = sorted(names, (r) => recent.lastChanged[r.name]).map((r) => el("tr", {},
    el("td", {}, el("a", { href: "#/r/" + r.name, textContent: r.name })), el("td", { className: "mut", textContent: ago(recent.lastChanged[r.name]) })));
  $("main").replaceChildren(el("h2", { textContent: "Repositories" }), ...(rows.length ? paged(rows, ["Repository", "Last change"]) : [el("p", { className: "mut", textContent: "The catalog is empty." })]));
}

async function tags(repo) {
  const rows = (await api("/api/tags?repo=" + encodeURIComponent(repo))).map((t) => ({ ...t, name: t.tag }));
  const trs = sorted(rows, (t) => t.changed).map((t) => el("tr", {},
    el("td", {}, el("a", { href: `#/m/${repo}@${t.tag}`, textContent: t.tag })), el("td", {}, code(short(t.digest))),
    el("td", { className: "mut", textContent: ago(t.changed) }), el("td", {}, actions(repo, t.tag, t.digest, rows.filter((x) => x.digest === t.digest).map((x) => x.tag)))));
  $("main").replaceChildren(el("h2", {}, el("a", { href: "#/repos", textContent: "Repositories" }), " / " + repo), ...paged(trs, ["Tag", "Digest", "Changed", ""]));
}

function actions(repo, ref, digest, sharing) {
  const copy = (move) => async () => {
    const v = await ask(move ? "Move image" : "Copy image", [`From ${repo}:${ref}`, move ? "The source digest is deleted after the copy is verified." : "Blobs are mounted, so no data is uploaded."],
      [{ name: "dst", label: "Destination repository", value: repo }, { name: "dstRef", label: "Destination tag", value: ref }], move);
    if (v) await run(() => api(move ? "/api/move" : "/api/copy", { src: repo, srcRef: ref, dst: v.dst, dstRef: v.dstRef }), () => (location.hash = `#/m/${v.dst}@${v.dstRef}`));
  };
  const del = async () => {
    const also = sharing.length ? ` Tags removed with it: ${sharing.join(", ")}.` : "";
    const v = await ask("Delete manifest", [`Deletes ${digest} from ${repo}. The registry deletes by digest, so every tag pointing at it goes.${also}`, "Disk space is freed by garbage collection, not by this action."],
      [{ name: "children", type: "checkbox", label: "Also delete index children that no other tag uses" }], true);
    if (v) await run(() => api("/api/delete", { repo, digest, children: v.children }), () => (location.hash = "#/r/" + repo));
  };
  const b = (text, fn, cls) => el("button", { textContent: text, className: cls || "", onclick: fn });
  return el("span", {}, ...(cfg.readonly ? [] : [b("Copy", copy(false)), " ", b("Move", copy(true)), " ", b("Delete", del, "danger")]));
}

async function manifest(repo, ref) {
  const m = await api(`/api/manifest?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`);
  const row = (k, v) => el("tr", {}, el("th", { textContent: k }), el("td", {}, v));
  const rows = [row("Digest", code(m.digest)), row("Media type", code(m.mediaType)), row("Manifest size", size(m.size)), row("Tags", m.tags.join(", ") || "none")];
  if (m.platform) rows.push(row("Platform", `${m.platform.os}/${m.platform.architecture}`));
  if (m.config) rows.push(row("Config", code(m.config)));
  const sub = (title, head, items) => items.length ? [el("h3", { textContent: title }), el("table", {}, el("tr", {}, ...head.map((h) => el("th", { textContent: h }))), ...items)] : [];
  $("main").replaceChildren(el("h2", {}, el("a", { href: "#/repos", textContent: "Repositories" }), " / ", el("a", { href: "#/r/" + repo, textContent: repo }), ` : ${ref}`),
    el("table", {}, ...rows), el("p", {}, actions(repo, ref, m.digest, m.tags)),
    ...sub("Platforms", ["Platform", "Digest", "Size"], m.platforms.map((p) => el("tr", {},
      el("td", { textContent: [p.os, p.architecture, p.variant].filter(Boolean).join("/") }),
      el("td", {}, el("a", { href: `#/m/${repo}@${p.digest}`, textContent: short(p.digest) })), el("td", { textContent: size(p.size) })))),
    ...sub("Layers", ["Digest", "Size"], m.layers.map((l) => el("tr", {}, el("td", {}, code(l.digest)), el("td", { textContent: size(l.size) })))));
}

async function route() {
  if ($("dlg").open) return; // never redraw under a dialog
  const h = decodeURIComponent(location.hash.slice(1)) || (prefs.view === "repos" ? "/repos" : "/recent");
  for (const [id, path] of [["n-recent", "/recent"], ["n-repos", "/repos"]]) $(id).className = h === path ? "on" : "";
  try {
    recent = await api("/api/recent");
    banner(cfg.readonly ? "Read-only mode." : cfg.deleteEnabled ? "" : "Deletion is disabled on this registry (REGISTRY_STORAGE_DELETE_ENABLED is not true). Move and Delete will fail.");
    if (h.startsWith("/m/")) { const [r, ref] = h.slice(3).split("@"); await manifest(r, ref); }
    else if (h.startsWith("/r/")) await tags(h.slice(3));
    else if (h === "/repos") await repos();
    else recentView();
    updated = new Date();
    liveLabel();
  } catch (e) { banner(e.message, true); }
}

// Live updates: Server-Sent Events from the poller. Plain polling of /api/recent is the fallback while the stream is down.
// SSE was kept because the stdlib server needs only one thread per client and nginx needs two proxy settings (see auth/nginx-basic.conf).
let es = null;
let state = "off";
function liveLabel() {
  const t = updated ? ` updated ${updated.toLocaleTimeString()}` : "";
  $("live").textContent = (state === "live" ? "live" : state === "off" ? "auto-refresh off" : "reconnecting") + t;
}
function startLive() {
  if (es) es.close();
  es = null;
  state = "off";
  if (prefs.live && window.EventSource) {
    state = "connecting";
    es = new EventSource("/api/events");
    es.onopen = () => { state = "live"; liveLabel(); };
    es.onmessage = () => { if (!document.hidden) route(); else stale = true; };
    es.onerror = () => { state = "connecting"; liveLabel(); }; // the browser reconnects by itself
  }
  liveLabel();
}
let stale = false;
let lastSeq = 0;
setInterval(async () => { // fallback and clock refresh, every `interval` seconds
  if (!prefs.live || document.hidden || $("dlg").open) return;
  if (state === "live") return;
  try { const r = await api("/api/recent?limit=1"); if (r.seq !== lastSeq) { lastSeq = r.seq; route(); } } catch (e) { /* shown by the next route() */ }
}, 1000 * Math.max(5, prefs.interval));
document.addEventListener("visibilitychange", () => { if (!document.hidden && stale) { stale = false; route(); } });

async function settings() {
  const v = await ask("Settings", ["Stored in this browser only. No data is stored."], [
    { name: "theme", label: "Theme", type: "select", options: CHOICES.theme, value: prefs.theme },
    { name: "view", label: "Landing page", type: "select", options: CHOICES.view, value: prefs.view },
    { name: "sort", label: "Sort lists by", type: "select", options: CHOICES.sort, value: prefs.sort },
    { name: "live", label: "Auto-refresh", type: "checkbox", value: prefs.live },
    { name: "interval", label: "Fallback poll seconds", type: "select", options: [10, 30, 60, 300], value: prefs.interval },
    { name: "pageSize", label: "Rows per page", type: "select", options: [25, 50, 100, 200], value: prefs.pageSize }]);
  if (!v) return;
  prefs = { ...v, live: v.live, interval: +v.interval, pageSize: +v.pageSize };
  savePrefs(); applyTheme(); startLive(); shown = 0; route();
}

(async () => {
  loadPrefs(); applyTheme();
  $("prefs").onclick = settings;
  try { cfg = await api("/api/config"); $("reg").textContent = cfg.registry; } catch (e) { banner(e.message, true); }
  addEventListener("hashchange", () => { shown = 0; route(); });
  startLive();
  route();
})();
