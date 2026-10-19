"use strict";
// All data is rendered with textContent, never innerHTML, so registry names cannot inject markup.
const $ = (id) => document.getElementById(id);
let cfg = {};
let recent = { events: [], lastChanged: {}, persistent: false, seq: 0 };
let shown = 0; // rows revealed in the current list
let updated = null;

// Preferences only, no data or secrets. Storage may be blocked, so every access is guarded.
// expanded and selected are the tree state (node ids and the location hash), sidebar is its width in px.
const DEFAULTS = { theme: "system", sort: "recent", live: true, interval: 30, pageSize: 50, runtime: "podman", sidebar: 280, selected: "/recent", expanded: [] };
const CHOICES = { theme: ["system", "light", "dark"], sort: ["recent", "name"], runtime: ["podman", "docker"], interval: [10, 30, 60, 300], pageSize: [25, 50, 100, 200] };
const MAX_EXPANDED = 500;
const SIDEBAR = [180, 640];
let prefs = { ...DEFAULTS };
const pref = {
  expanded: (v) => Array.isArray(v) && v.length <= MAX_EXPANDED && v.every((s) => typeof s === "string" && s.length < 300),
  selected: (v) => typeof v === "string" && v.startsWith("/") && v.length < 300,
  sidebar: (v) => typeof v === "number" && v >= SIDEBAR[0] && v <= SIDEBAR[1],
};
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("registry-lite-ui") || "{}");
    for (const k of Object.keys(DEFAULTS)) {
      const ok = pref[k] ? pref[k](p[k]) : CHOICES[k] ? CHOICES[k].includes(p[k]) : typeof p[k] === typeof DEFAULTS[k];
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
  for (const [k, v] of Object.entries(props || {})) { if (k === "role" || k.includes("-")) n.setAttribute(k, v); else n[k] = v; }
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
}
const short = (d) => (d || "").slice(0, 19);
function size(n) {
  if (n == null) return "";
  return n < 1048576 ? (n / 1024).toFixed(1) + " KiB" : (n / 1048576).toFixed(1) + " MiB";
}
const code = (t) => el("code", { textContent: t });
function ago(t) {
  if (!t) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return s + " s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a, b) => collator.compare(a.name, b.name);
const isAtt = (p) => p.os === "unknown" && p.architecture === "unknown"; // buildx attestation manifests, not platforms
const platName = (p) => [p.os, p.architecture, p.variant].filter(Boolean).join("/");

// Icons are built from path data with the DOM API. s marks stroked paths, cut marks the cut-outs that take the background colour.
const SVGNS = "http://www.w3.org/2000/svg";
const ICONS = {
  chev: [["s", "M6 3.5l4.5 4.5L6 12.5"]],
  folder: [["", "M1.5 4a1 1 0 0 1 1-1h3.2l1.6 1.6h6.2a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"]],
  folderOpen: [["", "M1.5 4a1 1 0 0 1 1-1h3.2l1.6 1.6h5.2a1 1 0 0 1 1 1V6H4.1a1 1 0 0 0-.95.7L1.5 11.5z"], ["", "M4.3 7.2h10.4a.5.5 0 0 1 .47.67l-1.6 4.4a1 1 0 0 1-.94.65H2.3z"]],
  registry: [["", "M2 2h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"], ["cut", "M4 4.5h8v1.4H4z"]],
  whale: [["", "M1 8.2h11.6c.5-.3.9-.9 1-1.6.6.1 1.1.4 1.4.8-.2.8-.8 1.2-1.5 1.4C11.8 11.6 9.6 13 6.9 13 3.9 13 1.7 11.3 1 8.2z"],
    ["", "M2.6 5.7h1.8v1.8H2.6zM4.8 5.7h1.8v1.8H4.8zM7 5.7h1.8v1.8H7zM9.2 5.7H11v1.8H9.2zM4.8 3.5h1.8v1.8H4.8zM7 3.5h1.8v1.8H7zM7 1.3h1.8v1.8H7z"]],
  chip: [["", "M4.5 4.5h7v7h-7z"], ["s", "M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14"]],
  copy: [["s", "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7"]],
  sun: [["s", "M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"]],
  moon: [["s", "M13 9.4A5.4 5.4 0 0 1 6.6 3a5.4 5.4 0 1 0 6.4 6.4z"]],
  monitor: [["s", "M2.5 3h11v7.5h-11zM6 13.5h4M8 10.5v3"]],
  close: [["s", "M4 4l8 8M12 4l-8 8"]],
  clock: [["s", "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.8V8l2.2 1.4"]],
};
const iconCache = new Map();
function icon(name, cls) { // built once per name and class, then cloned: a long tree makes thousands of them
  const key = name + "|" + (cls || "");
  if (!iconCache.has(key)) iconCache.set(key, buildIcon(name, cls));
  return iconCache.get(key).cloneNode(true);
}
function buildIcon(name, cls) {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", "i " + (cls || ""));
  s.setAttribute("aria-hidden", "true");
  for (const [kind, d] of ICONS[name]) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    if (kind) p.setAttribute("class", kind);
    s.append(p);
  }
  return s;
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
let paneStale = false; // the pane changed while a dialog was open
// A blocked dialog shows `block` as a warning and leaves Confirm disabled.
function ask(title, lines, fields, danger, block) {
  const form = $("form");
  form.replaceChildren(el("h3", { textContent: title }), ...(block ? [el("p", { className: "dlg-warn", role: "alert", textContent: block })] : []), ...lines.map((l) => el("p", { textContent: l })));
  const option = (f) => (o) => el("option", { value: String(o), textContent: String(o), selected: String(o) === String(f.value) });
  const input = (f) => {
    if (f.type === "checkbox") return el("input", { type: "checkbox", name: f.name, checked: f.value !== false });
    if (f.type === "select") return el("select", { name: f.name }, ...f.options.map(option(f)));
    return el("input", { type: "text", name: f.name, value: f.value, required: true });
  };
  fields.forEach((f) => form.append(el("label", {}, f.label + " ", input(f))));
  form.append(el("menu", {}, el("button", { textContent: "Cancel", value: "cancel" }), el("button", { textContent: "Confirm", value: "ok", className: danger ? "danger" : "", disabled: !!block })));
  return new Promise((resolve) => {
    $("dlg").onclose = () => {
      const v = Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? form[f.name].checked : form[f.name].value]));
      resolve($("dlg").returnValue === "ok" ? v : null);
      if (paneStale) { paneStale = false; void renderPane(); }
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
  if (rows.length > n) out.push(el("p", {}, el("button", { textContent: `Show more (${rows.length - n} left)`, onclick: () => { shown = n + prefs.pageSize; void renderPane(); } })));
  return out;
}

function sorted(items, key) { // items sorted by recency of key(item) when the pref says so, else by name
  return prefs.sort === "recent" ? [...items].sort((a, b) => (key(b) || 0) - (key(a) || 0) || byName(a, b)) : [...items].sort(byName);
}

// ---- Tree model ------------------------------------------------------------------------------------------------
// Nodes: root (the registry), node (a path segment, a folder, a repository or both), tag, plat (one platform of an index).
// Only what is expanded is rendered, and tags and platforms are fetched when their parent first opens.
const tree = {
  root: null, byId: new Map(), byPath: new Map(), sel: null, focus: null,
  filter: "", matches: null, closed: new Set(), flashes: new Map(), tagIndex: new Map(), tm: new Map(), pathHit: new Set(), indexStale: true, truncated: false,
};
const expanded = new Set();
const manifests = new Map(); // "repo@digest" -> manifest JSON; cleared for a repo when it changes
const inflight = new Map();
const repoOf = (ref) => ref.slice(0, ref.lastIndexOf(":"));

function mk(kind, id, name, parent, extra) {
  const n = { kind, id, name, parent, ...extra };
  tree.byId.set(id, n);
  return n;
}
function pathNode(path) {
  let n = tree.byPath.get(path);
  if (n) return n;
  const i = path.lastIndexOf("/");
  const parent = i < 0 ? tree.root : pathNode(path.slice(0, i));
  n = mk("node", "n:" + path, path.slice(i + 1), parent, { path, repo: false, kids: new Map(), tagList: [], tagMap: new Map(), fresh: false, loading: null, err: "", sortedKids: null });
  tree.byPath.set(path, n);
  parent.kids.set(n.name, n);
  parent.sortedKids = null;
  return n;
}
function dropNode(n) {
  tree.byId.delete(n.id);
  for (const t of n.tagList || []) { tree.byId.delete(t.id); for (const p of t.plats || []) tree.byId.delete(p.id); }
}
function pruneUp(n) { // remove a node that is no longer a repository and holds nothing
  while (n && n.kind === "node" && !n.repo && !n.kids.size) {
    n.parent.kids.delete(n.name);
    n.parent.sortedKids = null;
    tree.byPath.delete(n.path);
    dropNode(n);
    n = n.parent;
  }
}
// Reconcile the node tree with the catalog. Returns whether anything was added or removed.
function applyCatalog(names, flashNew) {
  const want = new Set(names);
  let changed = false;
  for (const p of names) {
    const n = pathNode(p);
    if (!n.repo) { n.repo = true; changed = true; if (flashNew) flash(n); }
  }
  for (const n of [...tree.byPath.values()]) {
    if (n.repo && !want.has(n.path)) { n.repo = false; n.fresh = false; for (const t of n.tagList) { tree.byId.delete(t.id); } n.tagList = []; n.tagMap.clear(); changed = true; pruneUp(n); }
  }
  tree.names = names;
  tree.matches = null;
  return changed;
}
function kidsOf(n) {
  if (n.kind === "tag") return n.plats || [];
  if (n.kind === "plat") return [];
  if (!n.sortedKids) n.sortedKids = [...n.kids.values()].sort(byName);
  return n.kind === "node" && n.repo ? [...n.sortedKids, ...n.tagList] : n.sortedKids;
}
function expandable(n) {
  if (n.kind === "root") return true;
  if (n.kind === "node") return n.kids.size > 0 || n.repo;
  if (n.kind === "tag") return n.plats === null || n.plats.length > 0;
  return false;
}
const folderLike = (n) => n.kind === "root" || (n.kind === "node" && !n.repo && n.kids.size > 0);
// A repository that matches only through its tags opens by itself while filtering, as long as few do: each one costs a tags call.
const AUTO_OPEN_MAX = 10;
const tagOnly = (n) => n.kind === "node" && n.repo && tree.tm.has(n.path) && !tree.pathHit.has(n.path);
const autoOpen = (n) => !!tree.filter && (folderLike(n) || (tagOnly(n) && tree.tm.size <= AUTO_OPEN_MAX));
function isOpen(n) {
  if (autoOpen(n)) return !tree.closed.has(n.id);
  return expanded.has(n.id);
}
// What the filter keeps: repository paths and the folders above them (matches), and for each repository the tag names that
// match (tm). Tag names come from the poller's index, plus the tags of any repository already loaded.
function matchSet() {
  if (tree.matches) return tree.matches;
  const term = tree.filter.toLowerCase(), set = new Set(), tm = new Map(), hit = new Set();
  const up = (p) => { for (let q = p; q; q = q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "") set.add(q); };
  for (const p of tree.names || []) {
    if (p.toLowerCase().includes(term)) { hit.add(p); up(p); }
    const loaded = tree.byPath.get(p);
    const names = new Set([...(tree.tagIndex.get(p) || []), ...(loaded ? loaded.tagMap.keys() : [])]);
    const found = [...names].filter((t) => t.toLowerCase().includes(term));
    if (found.length) { tm.set(p, new Set(found)); up(p); }
  }
  tree.tm = tm;
  tree.pathHit = hit;
  return (tree.matches = set);
}
let indexLoading = null;
function loadTagIndex() { // one small request, made when the filter is first used and again after a change
  if (indexLoading) return;
  indexLoading = api("/api/tagnames").then((o) => {
    tree.tagIndex = new Map(Object.entries(o.repos));
    tree.truncated = o.truncated;
    tree.indexStale = false;
    tree.matches = null;
  }).catch(() => { /* the filter then matches repository names only */ }).finally(() => { indexLoading = null; scheduleTree(); });
}

// ---- Loading -------------------------------------------------------------------------------------------------------
function flash(n) {
  const now = Date.now();
  for (let x = n; x && x !== tree.root; x = x.parent) tree.flashes.set(x.id, now);
  setTimeout(() => { for (const [k, t] of tree.flashes) if (Date.now() - t > 4000) tree.flashes.delete(k); }, 4200);
}
function ensureTags(n, force) {
  if (n.fresh && !force) return Promise.resolve();
  if (n.loading) return n.loading;
  n.loading = api("/api/tags?repo=" + encodeURIComponent(n.path)).then((rows) => {
    const first = !n.tagList.length && !n.tagMap.size;
    reconcileTags(n, rows, !first);
    n.err = "";
    n.fresh = true;
    if (tree.filter) tree.matches = null;
  }).catch((e) => { n.err = e.message; n.fresh = true; }).finally(() => { n.loading = null; scheduleTree(); });
  scheduleTree();
  return n.loading;
}
function reconcileTags(n, rows, flashChanges) {
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.tag);
    let t = n.tagMap.get(r.tag);
    if (!t) {
      t = mk("tag", `t:${n.path}:${r.tag}`, r.tag, n, { tag: r.tag, digest: r.digest, changed: r.changed, plats: null });
      n.tagMap.set(r.tag, t);
      if (flashChanges) flash(t);
    } else if (t.digest !== r.digest) {
      for (const p of t.plats || []) tree.byId.delete(p.id);
      Object.assign(t, { digest: r.digest, plats: null });
      if (flashChanges) flash(t);
    }
    t.changed = r.changed;
  }
  for (const [k, t] of n.tagMap) if (!seen.has(k)) { n.tagMap.delete(k); tree.byId.delete(t.id); for (const p of t.plats || []) tree.byId.delete(p.id); }
  n.tagList = [...n.tagMap.values()].sort(byName);
}
function getManifest(path, ref, digest, fresh) {
  const key = `${path}@${digest}`;
  if (!fresh && manifests.has(key)) return Promise.resolve(manifests.get(key));
  if (!fresh && inflight.has(key)) return inflight.get(key);
  // tags=0 skips the server's tag lookup (one listing and a HEAD per tag). Only a fresh read, for delete and move, asks for it.
  const p = api(`/api/manifest?repo=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}${fresh ? "" : "&tags=0"}`).then((m) => { manifests.set(key, m); return m; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
function ensurePlats(t) {
  if (t.plats) return Promise.resolve();
  return getManifest(t.parent.path, t.tag, t.digest).then((m) => {
    const real = m.platforms.filter((p) => !isAtt(p));
    t.atts = m.platforms.length - real.length;
    t.plats = m.index ? real.map((p) => mk("plat", `p:${t.parent.path}:${t.tag}@${p.digest}`, platName(p) || short(p.digest), t, { digest: p.digest })) : [];
  }).catch(() => { t.plats = []; }).finally(scheduleTree);
}
// After our own change, reload what it touched now instead of waiting for the poller's event.
async function touch(...paths) {
  await sync();
  await Promise.all(paths.map((p) => { const n = tree.byPath.get(p); dropManifests(p); return n && n.repo ? ensureTags(Object.assign(n, { fresh: false }), true) : null; }));
}
function dropManifests(path) { for (const k of [...manifests.keys()]) if (k.startsWith(path + "@")) manifests.delete(k); }

// ---- Tree rendering ----------------------------------------------------------------------------------------------
const RECENT = { kind: "recent", id: "recent", name: "Recent" };
let rows = []; // visible entries, in order
function visible() {
  rows = [];
  const filtering = !!tree.filter, ok = filtering ? matchSet() : null;
  if (filtering && tree.indexStale) loadTagIndex();
  if (filtering && !ok.size) { rows.push({ info: "No repositories or tags match" + (tree.truncated ? " (tag search covers only the first 5000 tags)" : ""), depth: 0, anc: [], last: true }); return; }
  const walk = (n, depth, anc, pos, count, last) => {
    rows.push({ n, depth, anc, pos, count, last });
    if (!isOpen(n)) return;
    if (n.kind === "node" && n.repo && !n.fresh) { void ensureTags(n); }
    if (n.kind === "tag" && n.plats === null) { void ensurePlats(n); }
    let kids = kidsOf(n);
    if (filtering && (n.kind === "root" || n.kind === "node")) {
      const tags = tagOnly(n) ? tree.tm.get(n.path) : null;
      kids = kids.filter((k) => (k.kind === "tag" ? !tags || tags.has(k.tag) : k.kind !== "node" || ok.has(k.path)));
    }
    const down = depth === 0 ? [] : [...anc, !last];
    kids.forEach((k, i) => walk(k, depth + 1, down, i + 1, kids.length, i === kids.length - 1));
    if (n.kind === "node" && n.repo && (n.loading || n.err)) rows.push({ info: n.err || "Loading...", depth: depth + 1, anc: down, last: true });
    if (n.kind === "tag" && n.plats === null) rows.push({ info: "Loading...", depth: depth + 1, anc: down, last: true });
  };
  walk(tree.root, 0, [], 1, 1, true);
  if (filtering && tree.truncated) rows.push({ info: "Tag search covers only the first 5000 tags.", depth: 0, anc: [], last: true });
}
function rowEl(r) {
  const n = r.n, guides = [];
  for (let i = 0; i < r.depth - 1; i++) guides.push(el("span", { className: "g" + (r.anc[i] ? " v" : "") }));
  if (r.depth) guides.push(el("span", { className: "g e" + (r.last ? " last" : "") }));
  if (r.info) return el("div", { className: "row info", role: "none" }, ...guides, el("span", { className: "chev" }), el("span", { className: "lbl", textContent: r.info }));
  const open = expandable(n) && isOpen(n);
  const ico = n.kind === "root" ? icon("registry") : n.kind === "tag" ? icon("whale", "whale") : n.kind === "plat" ? icon("chip") : icon(open ? "folderOpen" : "folder");
  const row = el("div", {
    className: "row", role: "treeitem", id: "ti-" + n.id, tabIndex: n.id === tree.focus ? 0 : -1, title: n.kind === "root" ? cfg.registry || "" : n.kind === "node" ? n.path : n.name,
    "aria-level": r.depth + 1, "aria-posinset": r.pos, "aria-setsize": r.count, "aria-selected": String(n.id === tree.sel),
  }, ...guides, el("span", { className: "chev" }, expandable(n) ? icon("chev") : null), ico, el("span", { className: "lbl", textContent: n.kind === "root" ? (cfg.registry || "Registry").replace(/^https?:\/\//, "") : n.name }));
  row.dataset.id = n.id;
  if (expandable(n)) row.setAttribute("aria-expanded", String(open));
  const t = tree.flashes.get(n.id);
  if (t && Date.now() - t < 4000) { row.classList.add("flash"); row.style.animationDelay = `-${(Date.now() - t) / 1000}s`; }
  return row;
}
function recentEl() {
  const row = el("div", { className: "row", role: "treeitem", id: "ti-recent", tabIndex: tree.focus === "recent" ? 0 : -1, "aria-level": 1, "aria-posinset": 1, "aria-setsize": 2, "aria-selected": String(tree.sel === "recent") },
    el("span", { className: "chev" }), icon("clock"), el("span", { className: "lbl", textContent: "Recent" }));
  row.dataset.id = "recent";
  return row;
}
let rowCache = new Map(); // rows are reused between renders when nothing about them changed
let treeQueued = false;
function scheduleTree() { if (!treeQueued) { treeQueued = true; requestAnimationFrame(() => { treeQueued = false; renderTree(); }); } }
function renderTree() {
  const box = $("tree");
  const hadFocus = box.contains(document.activeElement);
  const top = box.scrollTop;
  visible();
  const ids = new Set(rows.map((r) => (r.n ? r.n.id : "")));
  ids.add("recent");
  if (!tree.focus || !ids.has(tree.focus)) tree.focus = ids.has(tree.sel) ? tree.sel : "recent";
  const keep = new Map();
  const els = rows.map((r) => {
    const id = r.n ? r.n.id : "info:" + r.depth + ":" + r.info;
    const flashing = r.n && tree.flashes.has(r.n.id);
    const sig = [r.depth, r.anc.join(""), r.last, r.pos, r.count, r.n && isOpen(r.n), r.n && r.n.kind === "node" && r.n.repo, r.n && r.n.id === tree.sel, r.n && r.n.id === tree.focus, r.n && r.n.name, r.n && expandable(r.n)].join("|");
    const old = rowCache.get(id);
    const e = old && old.sig === sig && !flashing && !old.flashing ? old.e : rowEl(r);
    keep.set(id, { sig, e, flashing });
    return e;
  });
  rowCache = keep;
  box.replaceChildren(recentEl(), ...els);
  box.scrollTop = top;
  if (hadFocus) $("ti-" + tree.focus)?.focus();
}
function select(id, reveal) {
  tree.sel = id;
  tree.focus = id;
  renderTree();
  if (reveal) $("ti-" + id)?.scrollIntoView({ block: "nearest" });
}

function hashOf(n) {
  if (n.kind === "recent") return "#/recent";
  if (n.kind === "root") return "#/";
  if (n.kind === "node") return (n.repo ? "#/repo/" : "#/dir/") + n.path;
  if (n.kind === "tag") return `#/repo/${n.parent.path}:${n.tag}`;
  return `#/repo/${n.parent.parent.path}:${n.parent.tag}@${n.digest}`;
}
function go(n) { if (location.hash === hashOf(n)) void navigate(); else location.hash = hashOf(n); }
function toggle(n, force) {
  const open = force === undefined ? !isOpen(n) : force;
  if (autoOpen(n)) { if (open) tree.closed.delete(n.id); else tree.closed.add(n.id); }
  else if (open) expanded.add(n.id); else expanded.delete(n.id);
  prefs.expanded = [...expanded].slice(-MAX_EXPANDED);
  savePrefs();
  renderTree();
}
const rowOf = (target) => target.closest(".row[data-id]");
function entryOf(id) { return id === "recent" ? { n: RECENT } : rows.find((r) => r.n && r.n.id === id); }
$("tree").addEventListener("click", (e) => {
  const row = rowOf(e.target);
  if (!row) return;
  const n = row.dataset.id === "recent" ? RECENT : tree.byId.get(row.dataset.id);
  if (!n) return;
  if (e.target.closest(".chev")) { tree.focus = n.id; if (expandable(n)) toggle(n); else renderTree(); return; }
  go(n);
});
$("tree").addEventListener("dblclick", (e) => {
  const row = rowOf(e.target), n = row && tree.byId.get(row.dataset.id);
  if (n && expandable(n) && !e.target.closest(".chev")) toggle(n);
});
$("tree").addEventListener("keydown", (e) => {
  const row = rowOf(e.target);
  if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
  const list = [{ n: RECENT }, ...rows.filter((r) => r.n)];
  const i = list.findIndex((r) => r.n.id === row.dataset.id);
  const cur = list[i], n = cur.n;
  let to = null;
  switch (e.key) {
    case "ArrowDown": to = list[Math.min(i + 1, list.length - 1)].n; break;
    case "ArrowUp": to = list[Math.max(i - 1, 0)].n; break;
    case "Home": to = list[0].n; break;
    case "End": to = list[list.length - 1].n; break;
    case "ArrowRight":
      if (n !== RECENT && expandable(n)) { if (!isOpen(n)) { toggle(n, true); return e.preventDefault(); } to = list[i + 1] && list[i + 1].depth > cur.depth ? list[i + 1].n : null; }
      break;
    case "ArrowLeft":
      if (n !== RECENT && expandable(n) && isOpen(n)) { toggle(n, false); return e.preventDefault(); }
      to = n.parent && n.parent !== tree.root.parent ? n.parent : null;
      break;
    case "Enter": case " ": e.preventDefault(); return go(n);
    default: return;
  }
  e.preventDefault();
  if (to) { tree.focus = to.id; renderTree(); $("ti-" + to.id)?.focus(); $("ti-" + to.id)?.scrollIntoView({ block: "nearest" }); }
});
let filterTimer = 0;
$("filter").addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { tree.filter = $("filter").value.trim(); tree.matches = null; tree.closed.clear(); renderTree(); }, 80);
});

// ---- Sidebar width and phone drawer ------------------------------------------------------------------------------
function setWidth(px, save) {
  prefs.sidebar = Math.round(Math.min(SIDEBAR[1], Math.max(SIDEBAR[0], px)));
  document.documentElement.style.setProperty("--sw", prefs.sidebar + "px");
  if (save) savePrefs();
}
$("grip").addEventListener("pointerdown", (e) => {
  $("grip").setPointerCapture(e.pointerId);
  $("grip").classList.add("drag");
});
$("grip").addEventListener("pointermove", (e) => { if ($("grip").hasPointerCapture(e.pointerId)) setWidth(e.clientX - $("side").getBoundingClientRect().left, false); });
$("grip").addEventListener("pointerup", (e) => { $("grip").releasePointerCapture(e.pointerId); $("grip").classList.remove("drag"); savePrefs(); });
$("grip").addEventListener("keydown", (e) => {
  const step = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
  if (step) { e.preventDefault(); setWidth(prefs.sidebar + step, true); }
});
function drawer(open) {
  document.body.classList.toggle("drawer", open);
  $("menu").setAttribute("aria-expanded", String(open));
}
$("menu").onclick = () => drawer(!document.body.classList.contains("drawer"));
$("scrim").onclick = () => drawer(false);
addEventListener("keydown", (e) => { if (e.key === "Escape") drawer(false); });

// ---- Command helpers: Pull, Push and Configure tabs, each a code block with a Copy button ------------------------------
let cmdTab = "pull";
async function copyText(text, node) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall back to selecting */ }
  const range = document.createRange(), sel = getSelection();
  range.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(range);
  try { return document.execCommand("copy"); } catch (e) { return false; }
}
// A value with a small copy button beside it: the text alone, no command around it.
function copyValue(text, label) {
  const value = code(text);
  let timer = 0;
  const done = el("span", { className: "done", "aria-live": "polite" });
  const btn = el("button", { type: "button", className: "iconbtn", "aria-label": label, title: label }, icon("copy"));
  btn.onclick = async () => {
    done.textContent = (await copyText(text, value)) ? "Copied" : "Press Ctrl+C";
    clearTimeout(timer);
    timer = setTimeout(() => { done.textContent = ""; }, 1600);
  };
  return el("span", { className: "copyval" }, value, btn, done);
}
function codeBlock(label, lines) {
  const text = lines.join("\n");
  const pre = el("pre", { tabIndex: 0 }, ...lines.map((l) => {
    const i = l.indexOf(" ");
    return el("span", { className: "ln" }, el("span", { className: "cmd", textContent: l.slice(0, i) }), l.slice(i));
  }));
  let timer = 0;
  const btn = el("button", { type: "button", className: "copy", textContent: "Copy", "aria-label": "Copy " + label, "aria-live": "polite" });
  btn.onclick = async () => {
    btn.textContent = (await copyText(text, pre)) ? "Copied" : "Press Ctrl+C";
    clearTimeout(timer);
    timer = setTimeout(() => { btn.textContent = "Copy"; }, 1600);
  };
  return el("figure", { className: "code" }, el("figcaption", {}, el("span", { textContent: label }), btn), pre);
}
// tag is empty at repository level, where <TAG> stands in. digest is empty unless a tag is selected.
function commandsEl(path, tag, digest) {
  const host = cfg.registryHost || "<REGISTRY>";
  const image = `${host}/${path}:${tag || "<TAG>"}`;
  const note = (t) => el("p", { className: "mut", textContent: t });
  const content = {
    pull: (rt) => [note(`Run ${rt} pull with the image and tag.`), codeBlock("Pull by tag", [`${rt} pull ${image}`]),
      ...(digest ? [note("A digest always gives the same image, even if the tag is later moved."), codeBlock("Pull by digest", [`${rt} pull ${host}/${path}@${digest}`])] : [])],
    push: (rt) => [note(`Tag a local image with the registry address, then push it.`), codeBlock("Tag and push", [`${rt} tag <local-image> ${image}`, `${rt} push ${image}`])],
    configure: (rt) => {
      const dir = (rt === "docker" ? "/etc/docker" : "/etc/containers") + "/certs.d/" + host;
      return [note(`If the registry uses a certificate your machine does not trust, put its CA certificate where ${rt} looks for it.`),
        codeBlock("Trust the registry certificate", [`sudo mkdir -p ${dir}`, `sudo cp ca.crt ${dir}/ca.crt`]),
        note("When the registry needs a login, sign in once."), codeBlock("Log in", [`${rt} login ${host}`])];
    },
  };
  const names = [["pull", "Pull"], ["push", "Push"], ["configure", "Configure"]];
  const tabs = el("div", { role: "tablist", className: "tabs", "aria-label": "Command helpers" });
  const seg = el("div", { className: "seg", role: "group", "aria-label": "Command line tool" });
  const panel = el("div", { role: "tabpanel", className: "cmd-panel" });
  const draw = () => {
    tabs.replaceChildren(...names.map(([k, text]) => el("button", {
      type: "button", role: "tab", textContent: text, id: "tab-" + k, tabIndex: k === cmdTab ? 0 : -1, "aria-selected": String(k === cmdTab), "aria-controls": "cmd-panel",
      onclick: () => { cmdTab = k; draw(); },
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        cmdTab = names[(names.findIndex((x) => x[0] === k) + d + names.length) % names.length][0];
        draw();
        $("tab-" + cmdTab).focus();
      },
    })));
    seg.replaceChildren(...CHOICES.runtime.map((rt) => el("button", {
      type: "button", textContent: rt, "aria-pressed": String(rt === prefs.runtime),
      onclick: () => { prefs.runtime = rt; savePrefs(); draw(); },
    })));
    panel.id = "cmd-panel";
    panel.setAttribute("aria-labelledby", "tab-" + cmdTab);
    panel.replaceChildren(...content[cmdTab](prefs.runtime),
      ...(cfg.registryHostSet ? [] : [el("p", { className: "hint", textContent: `The address ${host} comes from REGISTRY_URL because UI_REGISTRY_HOST is not set. Set it to the address your clients use.` })]));
  };
  draw();
  return el("section", { className: "cmds" }, el("h3", { textContent: tag ? "Use this image" : "Use this repository" }), el("div", { className: "cmd-bar" }, tabs, seg), panel);
}

// ---- Right pane --------------------------------------------------------------------------------------------------
let paneSeq = 0;
function crumbs(n) {
  const parts = [];
  for (let x = n; x && x.kind !== "root"; x = x.parent) parts.unshift(x);
  const reg = (cfg.registry || "Registry").replace(/^https?:\/\//, "");
  return el("nav", { className: "crumbs", "aria-label": "Path" }, el("a", { href: "#/", textContent: reg }),
    ...parts.map((x, i) => (i === parts.length - 1 ? el("span", { className: x.kind === "node" ? "" : "t", textContent: x.kind === "tag" ? ":" + x.name : x.kind === "plat" ? "@" + x.name : x.name }) : el("a", { href: hashOf(x), className: x.kind === "tag" ? "t" : "", textContent: x.kind === "tag" ? ":" + x.name : x.name }))));
}
function lastChange(n) {
  if (n.kind === "node" && n.repo && recent.lastChanged[n.path]) return recent.lastChanged[n.path];
  return Math.max(0, ...[...(n.kids || [])].map(([, k]) => lastChange(k)));
}
const link = (n, text) => el("a", { href: hashOf(n), textContent: text || n.name });
function childTable(n) {
  const kids = sorted([...n.kids.values()], lastChange);
  const trs = kids.map((k) => el("tr", {}, el("td", {}, el("span", { className: "ico" }, icon("folder"), link(k, k.name))),
    el("td", { className: "mut", textContent: k.repo ? "repository" : "folder" }), el("td", { className: "mut", textContent: ago(lastChange(k)) })));
  return trs.length ? paged(trs, ["Name", "Type", "Last change"]) : [];
}
function showMain(...kids) { $("main").replaceChildren(...kids); }

function recentPane() {
  const rows = recent.events.map((e) => el("tr", {},
    el("td", { textContent: ago(e.t), title: new Date(e.t * 1000).toLocaleString() }),
    el("td", {}, el("span", { className: "badge " + e.type, textContent: e.type })),
    el("td", {}, e.type === "deleted" ? code(e.ref) : el("a", { href: "#/repo/" + e.ref, textContent: e.ref })),
    el("td", {}, code(short(e.digest || e.prev)))));
  const note = (recent.persistent ? "History is saved to disk." : "History is in memory only and resets when the UI restarts.")
    + ` Watching since ${new Date(recent.since * 1000).toLocaleString()}. Times are when the UI saw the change, not when it was pushed or built.`;
  showMain(el("h2", { textContent: "Recent changes" }), el("p", { className: "mut", textContent: note }),
    ...(rows.length ? paged(rows, ["When", "Change", "Image", "Digest"]) : [el("p", { className: "mut", textContent: recent.baselined ? "No changes seen yet." : "Reading the registry for the first time." })]));
}
function rootPane(n) {
  const kids = childTable(n);
  showMain(crumbs(n), el("h2", { textContent: "Repositories" }), el("p", { className: "mut", textContent: `${tree.names.length} repositories, ${recent.tags} tags known to the poller.` }),
    ...(kids.length ? kids : [el("p", { className: "mut", textContent: "The catalog is empty." })]));
}
// size and platforms of a tag, from its manifest. Fetched on demand, because the manifest call lists every tag in the repo.
const layersTotal = (m) => m.layers.reduce((a, l) => a + (l.size || 0), 0);
function detailCells(m) {
  if (m.index) { // attestation manifests show as unknown/unknown and are not platforms
    const names = [...new Set(m.platforms.map(platName).filter((p) => p !== "unknown/unknown"))];
    return [names.length > 4 ? names.slice(0, 4).join(", ") + ` +${names.length - 4}` : names.join(", "), ""];
  }
  return [m.platform ? `${m.platform.os}/${m.platform.architecture}` : "", size(layersTotal(m))];
}
function repoPane(n) {
  const trs = sorted(n.tagList, (t) => t.changed).map((t) => {
    const plat = el("td", { className: "mut" }), sz = el("td", { className: "mut" });
    const cached = manifests.get(`${n.path}@${t.digest}`);
    const fill = (m) => { [plat.textContent, sz.textContent] = detailCells(m); };
    if (cached) fill(cached);
    const tr = el("tr", {}, el("td", {}, el("span", { className: "ico" }, icon("whale", "whale"), link(t, t.tag))), el("td", { className: "nw" }, code(short(t.digest))), sz, plat, el("td", { className: "mut", textContent: ago(t.changed) }));
    return { tr, t, fill, done: !!cached };
  });
  const view = trs.slice(0, shown || prefs.pageSize);
  const todo = view.filter((r) => !r.done);
  const load = async (btn) => {
    if (btn) btn.disabled = true;
    const q = [...todo];
    await Promise.all([0, 1, 2].map(async () => { for (let r = q.shift(); r; r = q.shift()) { if (tree.byId.get(r.t.id) !== r.t) continue; try { r.fill(await getManifest(n.path, r.t.tag, r.t.digest)); } catch (e) { /* the row keeps its blanks */ } } }));
    if (btn) btn.hidden = true;
  };
  const btn = el("button", { textContent: "Load size and platforms", onclick: () => void load(btn), title: "One manifest request per row" });
  const kids = n.kids.size ? [el("h3", { textContent: "Folders" }), ...childTable(n)] : [];
  showMain(crumbs(n), el("h2", {}, el("span", { className: "ico" }, icon("folderOpen")), n.path), el("p", { className: "reporef" }, copyValue(`${cfg.registryHost || "<REGISTRY>"}/${n.path}`, "Copy repository reference")),
    ...(n.err ? [el("p", { className: "mut", textContent: n.err })] : []),
    ...(trs.length ? [...paged(trs.map((r) => r.tr), ["Tag", "Digest", "Size", "Platforms", "Changed"]), ...(todo.length > 20 ? [el("p", {}, btn)] : [])] : [el("p", { className: "mut", textContent: n.fresh && !n.loading ? "No tags." : "Loading..." })]), ...kids, commandsEl(n.path, "", ""));
  if (todo.length && todo.length <= 20) void load(null);
}
function folderPane(n) {
  const kids = childTable(n);
  showMain(crumbs(n), el("h2", {}, el("span", { className: "ico" }, icon("folderOpen")), n.path), ...kids);
}

function actions(repo, ref, digest) {
  // The tagged indexes this digest is a child of. The server refuses the delete or move anyway, this says so before the click.
  const blocked = async () => {
    try {
      const r = await api(`/api/parents?repo=${encodeURIComponent(repo)}&digest=${encodeURIComponent(digest)}`);
      if (!r.parents.length) return "";
      const plats = [...new Set(r.parents.map((p) => p.platform).filter(Boolean))].sort();
      const tags = r.parents.map((p) => p.tag).join(", ") + (r.more ? ` and ${r.more} more` : "");
      return `This manifest is ${plats.length ? plats.join(", ") : "a child"} inside ${tags}. Delete or retag those first.`;
    } catch (e) { return ""; }
  };
  const copy = (move) => async () => {
    let sharing = [];
    if (move) { try { sharing = (await getManifest(repo, ref, digest, true)).tags; } catch (e) { banner(e.message, true); return; } }
    const block = move ? await blocked() : "";
    const shared = sharing.length > 1 ? ` Every tag on it goes: ${sharing.join(", ")}.` : "";
    const note = move ? "The source digest is deleted after the copy is verified." + shared : "Blobs are mounted, so no data is uploaded.";
    const v = await ask(move ? "Move to..." : "Copy to...", [`From ${repo}:${ref}`, note],
      [{ name: "dst", label: "Destination repository", value: repo }, { name: "dstRef", label: "Destination tag", value: ref }], move, block);
    if (v) await run(() => api(move ? "/api/move" : "/api/copy", { src: repo, srcRef: ref, dst: v.dst, dstRef: v.dstRef }), async () => { await touch(repo, v.dst); location.hash = `#/repo/${v.dst}:${v.dstRef}`; });
  };
  const del = async () => {
    let sharing = [];
    try { sharing = (await getManifest(repo, ref, digest, true)).tags; } catch (e) { banner(e.message, true); return; }
    const also = sharing.length ? ` Tags removed with it: ${sharing.join(", ")}.` : "";
    const block = await blocked();
    const v = await ask("Delete manifest", [`Deletes ${digest} from ${repo}. The registry deletes by digest, so every tag pointing at it goes.${also}`, "Disk space is freed by garbage collection, not by this action."],
      [{ name: "children", type: "checkbox", label: "Also delete index children that no other tag uses" }], true, block);
    if (v) await run(() => api("/api/delete", { repo, digest, children: v.children }), async () => { await touch(repo); location.hash = "#/repo/" + repo; });
  };
  const b = (text, fn, cls) => el("button", { textContent: text, className: cls || "", onclick: fn });
  return el("div", { className: "bar" }, ...(cfg.readonly ? [] : [b("Copy to...", copy(false)), b("Move to...", copy(true)), b("Delete", del, "danger")]));
}

async function manifestPane(n, seq) {
  const t = n.kind === "tag" ? n : n.parent, path = t.parent.path;
  const ref = n.kind === "tag" ? n.tag : n.digest;
  const m = await getManifest(path, ref, n.digest);
  if (n.kind === "tag") await ensurePlats(n);
  if (seq !== paneSeq) return;
  const row = (k, v) => el("tr", {}, el("th", { textContent: k }), el("td", {}, v));
  const host = cfg.registryHost || "<REGISTRY>";
  const props = [];
  if (n.kind === "tag") props.push(row("Image", copyValue(`${host}/${path}:${n.tag}`, "Copy image reference")));
  props.push(row("Pinned", copyValue(`${host}/${path}@${m.digest}`, "Copy pinned image reference")), row("Digest", copyValue(m.digest, "Copy digest")),
    row("Media type", code(m.mediaType)), row("Manifest size", size(m.size)));
  if (m.layers.length) props.push(row("Layers size", size(layersTotal(m))));
  const sharing = t.parent.tagList.filter((x) => x.digest === m.digest).map((x) => x.tag); // from the tag list the pane already holds
  props.push(row("Tags", sharing.join(", ") || "none"));
  if (n.kind === "tag" && n.changed) props.push(row("Changed", el("span", { title: new Date(n.changed * 1000).toLocaleString(), textContent: ago(n.changed) })));
  if (m.platform) props.push(row("Platform", `${m.platform.os}/${m.platform.architecture}`));
  if (m.config) props.push(row("Config", code(m.config)));
  const sub = (title, head, items) => items.length ? [el("h3", { textContent: title }), el("table", {}, el("tr", {}, ...head.map((h) => el("th", { textContent: h }))), ...items)] : [];
  const real = m.platforms.filter((p) => !isAtt(p)), atts = m.platforms.length - real.length;
  const plat = (p) => (n.kind === "tag" && n.plats ? n.plats.find((x) => x.digest === p.digest) : null);
  showMain(crumbs(n), el("h2", {}, el("span", { className: "ico" }, icon(n.kind === "tag" ? "whale" : "chip", n.kind === "tag" ? "whale" : "")), n.kind === "tag" ? `${path}:${n.tag}` : `${path}:${t.tag} ${n.name}`),
    actions(path, ref, m.digest), el("table", { className: "props" }, ...props),
    ...(n.kind === "tag" ? [commandsEl(path, n.tag, m.digest)] : []),
    ...sub("Platforms", ["Platform", "Digest", "Size"], real.map((p) => el("tr", {},
      el("td", {}, plat(p) ? link(plat(p), platName(p)) : platName(p)), el("td", {}, code(short(p.digest))), el("td", { textContent: size(p.size) })))),
    ...(atts ? [el("p", { className: "mut", textContent: `+${atts} attestation${atts > 1 ? "s" : ""}, hidden from the list. Copy and delete handle them with the image.` })] : []),
    ...sub("Layers", ["Digest", "Size"], m.layers.map((l) => el("tr", {}, el("td", {}, code(l.digest)), el("td", { textContent: size(l.size) })))));
}

async function renderPane() {
  if ($("dlg").open) { paneStale = true; return; }
  const seq = ++paneSeq, n = tree.sel === "recent" ? RECENT : tree.byId.get(tree.sel);
  try {
    if (!n) showMain(el("h2", { textContent: "Not found" }), el("p", { className: "mut" }, "That repository or tag is not in the registry. ", el("a", { href: "#/", textContent: "Back to the registry" })));
    else if (n === RECENT) recentPane();
    else if (n.kind === "root") rootPane(n);
    else if (n.kind === "node") { if (n.repo) { await ensureTags(n); if (seq === paneSeq) repoPane(n); } else folderPane(n); }
    else await manifestPane(n, seq);
    updated = new Date();
    liveLabel();
  } catch (e) { if (seq === paneSeq) banner(e.message, true); }
}

function notice() {
  if (cfg.readonly) return "Read-only mode.";
  return cfg.deleteEnabled ? "" : "Deletion is disabled on this registry (REGISTRY_STORAGE_DELETE_ENABLED is not true). Move and Delete will fail.";
}

// ---- Routing: #/ (registry), #/recent, #/dir/<path>, #/repo/<name>[:<tag>[@<digest>]] ---------------------------------------
function parseHash() {
  let h = "/";
  try { h = decodeURIComponent(location.hash.slice(1)) || prefs.selected; } catch (e) { /* malformed escape: show the registry */ }
  const m = /^\/(?:repo|dir)\/([^:@]+)(?::([^@]+))?(?:@(.+))?$/.exec(h);
  if (h === "/recent") return { kind: "recent" };
  return m ? { kind: "path", path: m[1], tag: m[2], digest: m[3] } : { kind: "root" };
}
let navSeq = 0;
async function resolve(r) {
  if (r.kind === "recent") return RECENT;
  if (r.kind === "root") return tree.root;
  let n = tree.byPath.get(r.path);
  if (!n) { await sync(); n = tree.byPath.get(r.path); }
  if (!n || !r.tag) return n;
  await ensureTags(n);
  let t = n.tagMap.get(r.tag);
  if (!t && !(n.missing && n.missing.get(r.tag) > Date.now() - 30000)) { // a link to a tag that is not there is checked once, then remembered for 30 s
    await ensureTags(n, true);
    t = n.tagMap.get(r.tag);
    if (!t) (n.missing = n.missing || new Map()).set(r.tag, Date.now());
  }
  if (!t || !r.digest) return t;
  await ensurePlats(t);
  return (t.plats || []).find((p) => p.digest === r.digest);
}
async function navigate() {
  if ($("dlg").open) return;
  const seq = ++navSeq;
  const n = await resolve(parseHash());
  if (seq !== navSeq) return;
  if (n) {
    for (let x = n.parent; x && x !== tree.root.parent; x = x.parent) expanded.add(x.id);
    prefs.expanded = [...expanded].slice(-MAX_EXPANDED);
  }
  if (n) prefs.selected = hashOf(n).slice(1);
  savePrefs();
  select(n ? n.id : null, true);
  shown = 0;
  drawer(false);
  void renderPane();
}

// ---- Live updates ---------------------------------------------------------------------------------------------------
// Server-Sent Events from the poller. Plain polling of /api/recent is the fallback while the stream is down.
// SSE was kept because the stdlib server needs only one thread per client and nginx needs two proxy settings (see auth/nginx-basic.conf).
// Each event is applied to the tree in place: the catalog, and the tags of every repository that changed and is open.
let es = null;
let state = "off";
let lastSeq = null;
let syncing = null, again = false;
function liveLabel() {
  const t = updated ? ` updated ${updated.toLocaleTimeString()}` : "";
  const label = { live: "live", off: "auto-refresh off" }[state] || "reconnecting";
  $("live").textContent = label + t;
}
function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = doSync().catch((e) => banner(e.message, true)).finally(() => { syncing = null; if (again) { again = false; void sync(); } });
  return syncing;
}
async function doSync() {
  const [rc, names] = await Promise.all([api("/api/recent"), api("/api/repos")]);
  const first = lastSeq === null;
  recent = rc;
  const evs = first ? [] : rc.events.filter((e) => e.seq > lastSeq);
  const gap = !first && rc.seq - lastSeq > evs.length; // history was pruned, so refresh everything open
  lastSeq = rc.seq;
  const grew = applyCatalog(names, !first);
  const touched = new Set(evs.map((e) => repoOf(e.ref)));
  if (evs.length || gap) { tree.indexStale = true; tree.matches = null; }
  const jobs = [];
  for (const n of tree.byPath.values()) {
    if (!n.repo || !(gap || touched.has(n.path))) continue;
    dropManifests(n.path);
    if (n.tagList.length || n.loading) jobs.push(ensureTags(Object.assign(n, { fresh: false }), true)); // reconciling flashes what changed
    else flash(n);
  }
  await Promise.all(jobs);
  if (tree.sel && tree.sel !== "recent" && !tree.byId.has(tree.sel)) { // the selected node is gone: fall back to what holds it
    const n = tree.byPath.get(tree.sel.replace(/^[ntp]:/, "").replace(/[:@].*$/, ""));
    location.hash = n ? hashOf(n) : "#/";
  }
  banner(notice());
  renderTree();
  if (!first && (grew || evs.length || gap)) void renderPane();
  updated = new Date();
  liveLabel();
}
let stale = false;
let syncTimer = 0;
function syncSoon() { // a burst of events (a multi-arch push is many) becomes one sync: one catalog read and one tag list per open repository
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void sync(), 400);
}
function startLive() {
  if (es) es.close();
  es = null;
  state = "off";
  if (prefs.live && window.EventSource) {
    state = "connecting";
    es = new EventSource("/api/events");
    es.onopen = () => { state = "live"; liveLabel(); };
    es.onmessage = () => { if (document.hidden) stale = true; else syncSoon(); };
    es.onerror = () => { state = "connecting"; liveLabel(); }; // the browser reconnects by itself
  }
  liveLabel();
}
let pollTimer = 0;
function startPoll() { // the fallback while the stream is down, every `interval` seconds. Restarted when the interval changes.
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!prefs.live || document.hidden || $("dlg").open) return;
    if (state === "live") return;
    try { const r = await api("/api/recent?limit=1"); if (r.seq !== lastSeq) void sync(); } catch (e) { /* shown by the next sync() */ }
  }, 1000 * Math.max(5, prefs.interval));
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && stale) { stale = false; void sync(); } });

// ---- Settings: one panel, changes apply as you make them ----------------------------------------------------------------
const SETTING_KEYS = ["theme", "runtime", "sort", "live", "interval", "pageSize"];
function segmented(labelId, options, key, apply) { // options: [value, text, iconName?]. Arrow keys move and select, like radio buttons.
  const box = el("div", { className: "seg", role: "radiogroup", "aria-labelledby": labelId });
  const draw = () => box.replaceChildren(...options.map(([v, text, ico]) => el("button", {
    type: "button", role: "radio", tabIndex: v === prefs[key] ? 0 : -1, "aria-checked": String(v === prefs[key]),
    onclick: () => { apply({ [key]: v }); },
    onkeydown: (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const next = options[(options.findIndex((o) => o[0] === v) + d + options.length) % options.length][0];
      apply({ [key]: next });
      box.querySelector("[aria-checked=true]").focus();
    },
  }, ...(ico ? [icon(ico)] : []), text)));
  box.draw = draw;
  draw();
  return box;
}
function switchEl(labelId, key, apply) {
  const b = el("button", { type: "button", role: "switch", className: "switch", "aria-labelledby": labelId, onclick: () => apply({ [key]: !prefs[key] }) });
  b.draw = () => b.setAttribute("aria-checked", String(prefs[key]));
  b.draw();
  return b;
}
function selectEl(labelId, key, values, text, apply) {
  const sel = el("select", { "aria-labelledby": labelId, onchange: () => apply({ [key]: +sel.value }) }, ...values.map((v) => el("option", { value: String(v), textContent: text(v) })));
  const wrap = el("span", { className: "selwrap" }, sel, icon("chev"));
  wrap.draw = (off = false) => { sel.value = String(prefs[key]); sel.disabled = off; };
  wrap.draw(false);
  return wrap;
}
function settings() {
  const controls = [];
  const apply = (change) => {
    const before = { ...prefs };
    Object.assign(prefs, change);
    savePrefs();
    if (prefs.theme !== before.theme) applyTheme();
    if (prefs.live !== before.live) startLive();
    if (prefs.interval !== before.interval) startPoll();
    if (prefs.runtime !== before.runtime || prefs.sort !== before.sort || prefs.pageSize !== before.pageSize) { shown = 0; void renderPane(); }
    controls.forEach((c) => c.draw());
    pollCtl.draw(!prefs.live); // the poll only runs while the stream is down, so it means nothing with auto-refresh off
    pollRow.dataset.off = String(!prefs.live);
  };
  const row = (id, label, desc, control) => {
    controls.push(control);
    return el("div", { className: "srow" }, el("div", {}, el("div", { className: "slabel", id, textContent: label }), el("div", { className: "sdesc", textContent: desc })), el("div", { className: "sctl" }, control));
  };
  const section = (title, ...rows) => el("section", {}, el("h3", { className: "ssec", textContent: title }), ...rows);
  const pollCtl = selectEl("s-poll", "interval", CHOICES.interval, (v) => v + " s", apply);
  const pollRow = row("s-poll", "Fallback poll", "Seconds between checks while the live stream is down.", pollCtl);
  const dlg = el("dialog", { className: "settings", "aria-labelledby": "s-title" },
    el("div", { className: "shead" }, el("h2", { id: "s-title", textContent: "Settings" }),
      el("button", { type: "button", className: "iconbtn", "aria-label": "Close settings", onclick: () => dlg.close() }, icon("close"))),
    el("div", { className: "sbody" },
      el("p", { className: "mut", textContent: "Saved in this browser only." }),
      section("Appearance", row("s-theme", "Theme", "System, light or dark.", segmented("s-theme", [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]], "theme", apply))),
      section("Commands", row("s-rt", "Command line tool", "Used in the copyable commands.", segmented("s-rt", [["podman", "podman"], ["docker", "docker"]], "runtime", apply))),
      section("Lists", row("s-sort", "Sort by", "Order of tags and folders in lists.", segmented("s-sort", [["recent", "Recent"], ["name", "Name"]], "sort", apply)),
        row("s-rows", "Rows per page", "Rows a list shows before Show more.", selectEl("s-rows", "pageSize", CHOICES.pageSize, String, apply))),
      section("Live updates", row("s-live", "Auto-refresh", "Update the tree and lists as the registry changes.", switchEl("s-live", "live", apply)), pollRow)),
    el("div", { className: "sfoot" },
      el("button", { type: "button", className: "linkbtn", textContent: "Reset to defaults", onclick: () => apply(Object.fromEntries(SETTING_KEYS.map((k) => [k, DEFAULTS[k]]))) }),
      el("button", { type: "button", className: "primary", textContent: "Done", onclick: () => dlg.close() })));
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // a click on the backdrop
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  apply({}); // draws the poll row state
  dlg.showModal();
}

loadPrefs(); applyTheme();
setWidth(prefs.sidebar, false);
for (const id of prefs.expanded) expanded.add(id);
$("prefs").onclick = () => settings();
tree.root = { kind: "root", id: "root", name: "Registry", parent: null, kids: new Map(), sortedKids: null };
tree.byId.set("root", tree.root);
tree.names = [];
try { cfg = await api("/api/config"); $("reg").textContent = cfg.registry; banner(notice()); } catch (e) { banner(e.message, true); }
expanded.add("root");
await sync();
addEventListener("hashchange", () => void navigate());
startLive();
startPoll();
await navigate();
