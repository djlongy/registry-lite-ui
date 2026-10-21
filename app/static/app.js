"use strict";
// All data is rendered with textContent, never innerHTML, so registry names cannot inject markup.
const $ = (id) => document.getElementById(id);
let cfg = {};
let recent = { events: [], lastChanged: {}, persistent: false, seq: 0 };
let shown = 0; // rows revealed in the current list
let updated = null;

// Preferences only, no data or secrets. Storage may be blocked, so every access is guarded.
// expanded and selected are the tree state (node ids and the location hash), sidebar is its width in px.
const DEFAULTS = { theme: "system", sort: "recent", live: true, interval: 30, pageSize: 50, runtime: "podman", showEmpty: false, tool: "pip", os: "linux", show: "all", sidebar: 280, selected: "/recent", expanded: [] };
const CHOICES = { theme: ["system", "light", "dark"], sort: ["recent", "name"], runtime: ["podman", "docker"], tool: ["pip", "uv"], os: ["linux", "windows"], show: ["all", "containers", "python"], interval: [10, 30, 60, 300], pageSize: [25, 50, 100, 200] };
const MAX_EXPANDED = 500;
const SIDEBAR = [180, 640];
let prefs = { ...DEFAULTS };
const pref = {
  expanded: (v) => Array.isArray(v) && v.length <= MAX_EXPANDED && v.every((s) => typeof s === "string" && s.length < 300),
  selected: (v) => typeof v === "string" && v.startsWith("/") && v.length < 300,
  sidebar: (v) => typeof v === "number" && v >= SIDEBAR[0] && v <= SIDEBAR[1],
};
function prefValid(k, v) {
  if (pref[k]) return pref[k](v);
  if (CHOICES[k]) return CHOICES[k].includes(v);
  return typeof v === typeof DEFAULTS[k];
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("registry-lite-ui") || "{}");
    for (const k of Object.keys(DEFAULTS)) {
      if (prefValid(k, p[k])) prefs[k] = p[k];
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
  arrow: [["s", "M8 12.5v-9M4.5 7L8 3.5 11.5 7"]],
  chart: [["s", "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM8 1.8v4.6M8 9.6v4.6M2.6 4.9l4 2.3M9.4 8.8l4 2.3M2.6 11.1l4-2.3M9.4 7.2l4-2.3"]],
  box: [["s", "M3 3h10v10H3z"]],
  artifact: [["s", "M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.5 4.8L8 7.8l5.5-3M8 7.8v6.4"]],
  clock: [["s", "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.8V8l2.2 1.4"]],
  pkg: [["s", "M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.5 4.8L8 7.8l5.5-3M8 7.8v6.4"]],
  tag: [["s", "M2 2.5h5.2l6.3 6.3-4.7 4.7L2.5 7.2V2.5zM5 5h.01"]],
  pypi: [["", "M8 1.5l5.6 3.1L8 7.7 2.4 4.6z"], ["s", "M2.4 5.5v5.9L8 14.5V8.6zM13.6 5.5v5.9L8 14.5"]],
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
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}

function banner(text, err) {
  $("banner").hidden = !text;
  $("banner").className = err ? "err" : "";
  $("banner").textContent = text || "";
}

// One dialog for every action. fields: {name, label, value, type: text|checkbox|select, options}. Resolves to the values, or null on cancel.
let paneStale = false; // the pane changed while a dialog was open
const modalOpen = () => !!document.querySelector("dialog[open]"); // any dialog: confirm, settings, help, copy, move or delete
// A pane redraw that was held back while a dialog was open runs when the last one closes. (close does not bubble, so listen in the capture phase.)
document.addEventListener("close", () => { if (paneStale && !modalOpen()) { paneStale = false; void renderPane(); } }, true);
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

// ---- Tree model ------------------------------------------------------------------------------------------------
// Nodes: root (the registry), node (a path segment, a folder, a repository or both), tag, plat (one platform of an index).
// Only what is expanded is rendered, and tags and platforms are fetched when their parent first opens.
const tree = {
  root: null, proot: null, byKey: new Map(), byId: new Map(), byPath: new Map(), sel: null, focus: null,
  filter: "", matches: null, closed: new Set(), flashes: new Map(), tagIndex: new Map(), empty: new Set(), emptyKey: "", tm: new Map(), pathHit: new Set(), indexStale: true, truncated: false,
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
  while (n?.kind === "node" && !n.repo && !n.kids.size) {
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
  for (const n of tree.byPath.values()) {
    if (n.repo && !want.has(n.path)) { n.repo = false; n.fresh = false; for (const t of n.tagList) { tree.byId.delete(t.id); } n.tagList = []; n.tagMap.clear(); changed = true; pruneUp(n); }
  }
  tree.names = names;
  tree.matches = null;
  return changed;
}
function kidsOf(n) {
  if (n.kind === "proot") return pkgSort(n.kids);
  if (n.kind === "pkg") return n.verList;
  if (n.kind === "ver") return [];
  if (n.kind === "tag") return n.plats || [];
  if (n.kind === "plat") return [];
  const k = visibleKids(n);
  return n.kind === "node" && n.repo ? [...k, ...n.tagList] : k;
}
function folderKids(n) { // the child folders and repositories, by name, kept until they change
  if (!n.sortedKids) n.sortedKids = [...n.kids.values()].sort(byName);
  return n.sortedKids;
}
// Repositories with no tags are left out unless Settings says to show them. Whether one is empty comes from what is already known: its tags
// if they are loaded, else the poller's list of repositories it walked and found empty (/api/tagnames). Unknown counts as not empty, so it shows.
function isEmptyRepo(n) {
  if (!n.repo) return false;
  if (n.fresh && !n.err) return n.tagList.length === 0;
  return tree.empty.has(n.path) && !tree.tagIndex.has(n.path);
}
let hiddenMemo = new Map();
const resetHidden = () => { hiddenMemo = new Map(); };
function isHidden(n) { // an empty repository, or a folder that holds only those
  if (prefs.showEmpty || n.kind !== "node") return false;
  if (!hiddenMemo.has(n.id)) hiddenMemo.set(n.id, (!n.repo || isEmptyRepo(n)) && [...n.kids.values()].every((k) => isHidden(k)));
  return hiddenMemo.get(n.id);
}
const visibleKids = (n) => folderKids(n).filter((k) => !isHidden(k));
function expandable(n) {
  if (n.kind === "root" || n.kind === "proot" || n.kind === "pkg") return true;
  if (n.kind === "node") return n.kids.size > 0 || n.repo;
  if (n.kind === "tag") return n.index !== false && (n.plats === null || n.plats.length > 0); // a tag that is not an index has no platforms to show
  return false;
}
const folderLike = (n) => n.kind === "root" || (n.kind === "node" && !n.repo && n.kids.size > 0);
// A repository that matches only through its tags opens by itself while filtering, as long as few do: each one costs a tags call.
const AUTO_OPEN_MAX = 10;
const tagOnly = (n) => n.kind === "node" && n.repo && tree.tm.has(n.path) && !tree.pathHit.has(n.path);
const autoOpen = (n) => !!tree.filter && (folderLike(n) || (tagOnly(n) && tree.tm.size <= AUTO_OPEN_MAX));
function isOpen(n) {
  if (n.kind === "pkg" && tree.filter && verHit(n, tree.filter.toLowerCase())) return !tree.closed.has(n.id); // a version matched
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
  tree.matches = set;
  return set;
}
let indexLoading = null;
function loadTagIndex() { // one small request, made when the filter is first used and again after a change
  if (indexLoading) return;
  indexLoading = api("/api/tagnames").then((o) => {
    tree.tagIndex = new Map(Object.entries(o.repos));
    tree.truncated = o.truncated;
    const empty = o.empty || [], key = empty.join("\n");
    const changed = key !== tree.emptyKey;
    tree.empty = new Set(empty);
    tree.emptyKey = key;
    tree.indexStale = false;
    tree.matches = null;
    if (changed) { resetHidden(); void renderPane(); } // what is hidden changed, so the lists change too
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
function dropTag(t) {
  tree.byId.delete(t.id);
  for (const p of t.plats || []) tree.byId.delete(p.id);
}
function upsertTag(n, r, flashChanges) {
  let t = n.tagMap.get(r.tag);
  if (!t) {
    t = mk("tag", `t:${n.path}:${r.tag}`, r.tag, n, { tag: r.tag, digest: r.digest, changed: r.changed, index: r.index, akind: r.kind, plats: null });
    n.tagMap.set(r.tag, t);
    if (flashChanges) flash(t);
  } else if (t.digest !== r.digest) {
    for (const p of t.plats || []) tree.byId.delete(p.id);
    Object.assign(t, { digest: r.digest, plats: null });
    if (flashChanges) flash(t);
  }
  Object.assign(t, { changed: r.changed, index: r.index, akind: r.kind }); // what the tag list says is right on first render, before any manifest is read
}
function reconcileTags(n, rows, flashChanges) {
  const seen = new Set(rows.map((r) => r.tag));
  for (const r of rows) upsertTag(n, r, flashChanges);
  for (const [k, t] of n.tagMap) {
    if (!seen.has(k)) { n.tagMap.delete(k); dropTag(t); }
  }
  n.tagList = [...n.tagMap.values()].sort(byName);
}
function getManifest(path, ref, digest, fresh) {
  const key = `${path}@${digest}`;
  if (!fresh && manifests.has(key)) return Promise.resolve(manifests.get(key));
  if (!fresh && inflight.has(key)) return inflight.get(key);
  // tags=0 skips the server's tag lookup (one listing and a HEAD per tag). Only a fresh read, for delete and move, asks for it.
  const p = api(`/api/manifest?repo=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}${fresh ? "" : "&tags=0"}`).then((m) => { manifests.set(key, m); scheduleTree(); return m; }).finally(() => inflight.delete(key));
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
  await Promise.all(paths.map((p) => { const n = tree.byPath.get(p); dropManifests(p); return n?.repo ? ensureTags(Object.assign(n, { fresh: false }), true) : null; }));
}
function dropManifests(path) {
  for (const k of manifests.keys()) {
    if (k.startsWith(path + "@")) manifests.delete(k);
  }
}

// ---- Tree rendering ----------------------------------------------------------------------------------------------
const RECENT = { kind: "recent", id: "recent", name: "Recent" };
let rows = []; // visible entries, in order
function visible() {
  rows = [];
  const filtering = !!tree.filter, ok = filtering ? matchSet() : null;
  if (tree.indexStale && (filtering || !prefs.showEmpty)) loadTagIndex();
  if (filtering && !ok.size && showsType("containers")) { rows.push({ info: "No repositories or tags match" + (tree.truncated ? " (tag search covers only the first 5000 tags)" : ""), depth: 0, anc: [], last: true }); pypiRows(); return; }
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
  if (showsType("containers")) walk(tree.root, 0, [], 1, 1, true);
  pypiRows();
  if (filtering && tree.truncated) rows.push({ info: "Tag search covers only the first 5000 tags.", depth: 0, anc: [], last: true });
}
function guidesFor(r) { // the connector lines of a row: a vertical for each ancestor with more siblings, then the elbow
  const guides = [];
  for (let i = 0; i < r.depth - 1; i++) guides.push(el("span", { className: "g" + (r.anc[i] ? " v" : "") }));
  if (r.depth) guides.push(el("span", { className: "g e" + (r.last ? " last" : "") }));
  return guides;
}
function iconFor(n, open) {
  if (n.kind === "root") return icon("registry");
  if (n.kind === "proot") return icon("pypi");
  if (n.kind === "pkg") return icon("pkg");
  if (n.kind === "ver") return icon("tag");
  if (n.kind === "tag") return kindIcon(tagKind(n));
  if (n.kind === "plat") return icon("chip");
  return icon(open ? "folderOpen" : "folder");
}
function rowTitle(n) {
  if (n.kind === "root") return cfg.registry || "";
  if (n.kind === "proot") return pypiLabel();
  return n.kind === "node" ? n.path : n.name;
}
const rowLabel = (n) => (n.kind === "root" ? (cfg.registry || "Registry").replace(/^https?:\/\//, "") : n.kind === "proot" ? pypiLabel() : n.name);
function rowEl(r) {
  const n = r.n, guides = guidesFor(r);
  if (r.info) return el("div", { className: "row info", role: "none" }, ...guides, el("span", { className: "chev" }), el("span", { className: "lbl", textContent: r.info }));
  const open = expandable(n) && isOpen(n);
  const row = el("div", {
    className: "row", role: "treeitem", id: "ti-" + n.id, tabIndex: n.id === tree.focus ? 0 : -1,
    "aria-level": r.depth + 1, "aria-posinset": r.pos, "aria-setsize": r.count, "aria-selected": String(n.id === tree.sel),
  }, ...guides, el("span", { className: "chev" }, expandable(n) ? icon("chev") : null), iconFor(n, open), el("span", { className: "lbl", textContent: rowLabel(n) }));
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
function rowSig(r) { // what a row looks like, so an unchanged one is reused
  const n = r.n;
  const own = n ? [isOpen(n), n.kind === "node" && n.repo, n.id === tree.sel, n.id === tree.focus, n.name, expandable(n), n.kind === "tag" && tagKind(n)] : [];
  return [r.depth, r.anc.join(""), r.last, r.pos, r.count, ...own].join("|");
}
function cachedRow(r, keep) {
  const id = r.n ? r.n.id : "info:" + r.depth + ":" + r.info;
  const flashing = !!r.n && tree.flashes.has(r.n.id);
  const sig = rowSig(r), old = rowCache.get(id);
  const e = old?.sig === sig && !flashing && !old.flashing ? old.e : rowEl(r);
  keep.set(id, { sig, e, flashing });
  return e;
}
function renderTree() {
  resetHidden();
  const box = $("tree");
  const hadFocus = box.contains(document.activeElement);
  const top = box.scrollTop;
  visible();
  const ids = new Set(rows.map((r) => (r.n ? r.n.id : "")));
  ids.add("recent");
  if (!tree.focus || !ids.has(tree.focus)) tree.focus = ids.has(tree.sel) ? tree.sel : "recent";
  const keep = new Map();
  const els = rows.map((r) => cachedRow(r, keep));
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
  if (n.kind === "proot") return "#/pypi";
  if (n.kind === "pkg") return "#/pypi/" + n.key;
  if (n.kind === "ver") return `#/pypi/${n.parent.key}@${n.version}`;
  if (n.kind === "root") return "#/";
  if (n.kind === "node") return (n.repo ? "#/repo/" : "#/dir/") + n.path;
  if (n.kind === "tag") return `#/repo/${n.parent.path}:${n.tag}`;
  return `#/repo/${n.parent.parent.path}:${n.parent.tag}@${n.digest}`;
}
function go(n) { if (location.hash === hashOf(n)) void navigate(); else location.hash = hashOf(n); }
function toggle(n, force) {
  const open = force === undefined ? !isOpen(n) : force;
  const set = autoOpen(n) ? tree.closed : expanded; // while filtering, a folder's state is kept apart from the saved one
  const add = autoOpen(n) ? !open : open;
  if (add) set.add(n.id);
  else set.delete(n.id);
  prefs.expanded = [...expanded].slice(-MAX_EXPANDED);
  savePrefs();
  renderTree();
}
const rowOf = (target) => target.closest(".row[data-id]");
// The full path is a tooltip only while the label is cut off, so it never covers the row above for a name that fits.
$("tree").addEventListener("mouseover", (e) => {
  const row = rowOf(e.target), n = row && tree.byId.get(row.dataset.id), lbl = row?.querySelector(".lbl");
  if (!n || !lbl) return;
  if (lbl.scrollWidth > lbl.clientWidth) row.title = rowTitle(n);
  else row.removeAttribute("title");
});
$("tree").addEventListener("click", (e) => {
  const row = rowOf(e.target);
  if (!row) return;
  const n = row.dataset.id === "recent" ? RECENT : tree.byId.get(row.dataset.id);
  if (!n) return;
  if (e.target.closest(".chev")) {
    tree.focus = n.id;
    if (expandable(n)) {
      toggle(n);
    } else {
      renderTree();
    }
    return;
  }
  go(n);
});
$("tree").addEventListener("dblclick", (e) => {
  const row = rowOf(e.target), n = row && tree.byId.get(row.dataset.id);
  if (n && expandable(n) && !e.target.closest(".chev")) toggle(n);
});
// Where an arrow key goes from list[i], for the main tree and the folder picker. ops: {expandable, isOpen, setOpen}.
// Returns the node to focus, null to stay (opening or closing is done here), or undefined for a key it does not handle.
function arrowTarget(key, list, i, ops) {
  switch (key) {
    case "ArrowDown": return list[Math.min(i + 1, list.length - 1)].n;
    case "ArrowUp": return list[Math.max(i - 1, 0)].n;
    case "Home": return list[0].n;
    case "End": return list.at(-1).n;
    case "ArrowRight": return arrowRight(list, i, ops);
    case "ArrowLeft": return arrowLeft(list[i].n, ops);
    default: return undefined;
  }
}
function arrowRight(list, i, ops) {
  const n = list[i].n;
  if (!ops.expandable(n)) return null;
  if (!ops.isOpen(n)) { ops.setOpen(n, true); return null; }
  const next = list[i + 1];
  return next && next.depth > list[i].depth ? next.n : null;
}
function arrowLeft(n, ops) {
  if (ops.expandable(n) && ops.isOpen(n)) { ops.setOpen(n, false); return null; }
  return n.parent || null;
}
const treeOps = { expandable, isOpen, setOpen: toggle };
function focusRow(n) {
  tree.focus = n.id;
  renderTree();
  const row = $("ti-" + n.id);
  row?.focus();
  row?.scrollIntoView({ block: "nearest" });
}
$("tree").addEventListener("keydown", (e) => {
  const row = rowOf(e.target);
  if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
  const list = [{ n: RECENT }, ...rows.filter((r) => r.n)];
  const i = list.findIndex((r) => r.n.id === row.dataset.id);
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(list[i].n); return; }
  const to = arrowTarget(e.key, list, i, treeOps);
  if (to === undefined) return;
  e.preventDefault();
  if (to) focusRow(to);
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
// Copies with the clipboard API. Where it is missing (a page that is neither localhost nor HTTPS) the text is selected instead,
// and false tells the caller to ask the user to press Ctrl/Cmd+C.
async function copyText(text, node) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* refused: fall back to selecting */ }
  }
  const range = document.createRange(), sel = getSelection();
  range.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(range);
  return false;
}
// A value with a small copy button beside it: the text alone, no command around it.
// An icon button with its "Copied" note. node is what gets selected when the clipboard API is missing, so it must hold the copied text.
function copyControls(text, label, node) {
  let timer = 0;
  const done = el("span", { className: "done", "aria-live": "polite" });
  const btn = el("button", { type: "button", className: "iconbtn", "aria-label": label, title: label }, icon("copy"));
  btn.onclick = async (e) => {
    e.stopPropagation(); // a copy icon in a table row must not act on the row
    done.textContent = (await copyText(text, node)) ? "Copied" : "Press Ctrl/Cmd+C";
    clearTimeout(timer);
    timer = setTimeout(() => { done.textContent = ""; }, 1600);
  };
  return [btn, done];
}
function copyValue(text, label, shown) { // shown: what to display when it is shorter than what is copied
  const value = code(shown || text);
  return el("span", { className: "copyval" }, value, ...copyControls(text, label, value));
}
// A copy icon that shows on row hover or focus, with the full text kept (invisibly) as the thing to select.
function rowCopy(text, label) {
  const full = el("span", { className: "vh", textContent: text, "aria-hidden": "true" }); // selectable, but not read out twice
  return el("span", { className: "rowcopy" }, ...copyControls(text, label, full), full);
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
    btn.textContent = (await copyText(text, pre)) ? "Copied" : "Press Ctrl/Cmd+C";
    clearTimeout(timer);
    timer = setTimeout(() => { btn.textContent = "Copy"; }, 1600);
  };
  return el("figure", { className: "code" }, el("figcaption", {}, el("span", { textContent: label }), btn), pre);
}
// tag is empty at repository level, where <TAG> stands in. digest is empty unless a tag is selected.
// The command tabs for each kind of thing a tag can be. ctx: {host, path, tag, digest}; tag is "" at repository level. Returns the tabs,
// what each shows (given the podman or docker choice), whether that choice matters, and a heading.
const cmdNote = (t) => el("p", { className: "mut", textContent: t });
function imageCommands({ host, path, tag, digest }) {
  const image = `${host}/${path}:${tag || "<TAG>"}`;
  return {
    heading: tag ? "Use this image" : "Use this repository", tool: true,
    names: [["pull", "Pull"], ["push", "Push"], ["configure", "Configure"]],
    content: {
      pull: (rt) => [cmdNote(`Run ${rt} pull with the image and tag.`), codeBlock("Pull by tag", [`${rt} pull ${image}`]),
        ...(digest ? [cmdNote("A digest always gives the same image, even if the tag is later moved."), codeBlock("Pull by digest", [`${rt} pull ${host}/${path}@${digest}`])] : [])],
      push: (rt) => [cmdNote("Tag a local image with the registry address, then push it."), codeBlock("Tag and push", [`${rt} tag <local-image> ${image}`, `${rt} push ${image}`])],
      configure: (rt) => {
        const dir = (rt === "docker" ? "/etc/docker" : "/etc/containers") + "/certs.d/" + host;
        return [cmdNote(`If the registry uses a certificate your machine does not trust, put its CA certificate where ${rt} looks for it.`),
          codeBlock("Trust the registry certificate", [`sudo mkdir -p ${dir}`, `sudo cp ca.crt ${dir}/ca.crt`]),
          cmdNote("When the registry needs a login, sign in once."), codeBlock("Log in", [`${rt} login ${host}`])];
      },
    },
  };
}
function helmCommands({ host, path, tag }) {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const version = tag || "<VERSION>";
  return {
    heading: tag ? "Use this chart" : "Use this repository", tool: false,
    names: [["pull", "Pull"], ["push", "Push"], ["configure", "Configure"]],
    content: {
      pull: () => [cmdNote("The tag is the chart version."), codeBlock("Pull the chart", [`helm pull oci://${host}/${path} --version ${version}`])],
      push: () => [cmdNote(`Package the chart, then push the archive. The chart's name is added to the path, so it lands in ${path}.`),
        codeBlock("Push the chart", [`helm push <chart>.tgz oci://${host}${parent ? "/" + parent : ""}`])],
      configure: () => [cmdNote("When the registry needs a login, sign in once."), codeBlock("Log in", [`helm registry login ${host}`]),
        cmdNote("If the registry uses a certificate your machine does not trust, add --ca-file with its CA certificate to each helm command."),
        codeBlock("With a private CA", [`helm registry login ${host} --ca-file ca.crt`, `helm pull oci://${host}/${path} --version ${version} --ca-file ca.crt`])],
    },
  };
}
function artifactCommands({ host, path, tag, digest }) {
  return {
    heading: "Use this artifact", tool: false, names: [["pull", "Pull"]],
    content: { pull: () => [cmdNote("An OCI artifact, not an image. Pull it with oras."), codeBlock("Pull by tag", [`oras pull ${host}/${path}:${tag || "<TAG>"}`]),
      ...(digest ? [codeBlock("Pull by digest", [`oras pull ${host}/${path}@${digest}`])] : [])] },
  };
}
const COMMAND_SETS = { image: imageCommands, helm: helmCommands, artifact: artifactCommands };
function commandsEl(path, tag, digest, kind = "image") {
  const host = cfg.registryHost || "<REGISTRY>";
  const sets = COMMAND_SETS[kind]({ host, path, tag, digest }), names = sets.names;
  const tabs = el("div", { role: "tablist", className: "tabs", "aria-label": "Command helpers" });
  const seg = el("div", { className: "seg", role: "group", "aria-label": "Command line tool", hidden: !sets.tool });
  const panel = el("div", { role: "tabpanel", className: "cmd-panel" });
  const draw = () => {
    const cur = names.some(([k]) => k === cmdTab) ? cmdTab : names[0][0];
    tabs.replaceChildren(...names.map(([k, text]) => el("button", {
      type: "button", role: "tab", textContent: text, id: "tab-" + k, tabIndex: k === cur ? 0 : -1, "aria-selected": String(k === cur), "aria-controls": "cmd-panel",
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
    panel.setAttribute("aria-labelledby", "tab-" + cur);
    panel.replaceChildren(...sets.content[cur](prefs.runtime),
      ...(cfg.registryHostSet ? [] : [el("p", { className: "hint", textContent: `The address ${host} comes from REGISTRY_URL because UI_REGISTRY_HOST is not set. Set it to the address your clients use.` })]));
  };
  draw();
  return el("section", { className: "cmds" }, el("h3", { textContent: sets.heading }), el("div", { className: "cmd-bar" }, tabs, seg), panel);
}

// ---- Right pane --------------------------------------------------------------------------------------------------
let paneSeq = 0;
function crumbs(n) {
  const parts = [];
  for (let x = n; x && x.kind !== "root"; x = x.parent) parts.unshift(x);
  const reg = (cfg.registry || "Registry").replace(/^https?:\/\//, "");
  return el("nav", { className: "crumbs", "aria-label": "Path" }, el("a", { href: "#/", textContent: reg }),
    ...parts.map((x, i) => crumbNode(x, i === parts.length - 1)));
}
function crumbNode(x, last) {
  if (last) return el("span", { className: x.kind === "node" ? "" : "t", textContent: crumbText(x) });
  return el("a", { href: hashOf(x), className: x.kind === "tag" ? "t" : "", textContent: crumbText(x) });
}
function crumbText(x) {
  if (x.kind === "tag") return ":" + x.name;
  return x.kind === "plat" ? "@" + x.name : x.name;
}
function lastChange(n) {
  if (n.kind === "node" && n.repo && recent.lastChanged[n.path]) return recent.lastChanged[n.path];
  return Math.max(0, ...[...(n.kids || [])].map(([, k]) => lastChange(k)));
}
const link = (n, text) => el("a", { href: hashOf(n), textContent: text || n.name });
function showMain(...kids) { $("main").replaceChildren(...kids); }

// ---- Sortable, filterable, paged lists: the tags of a repository and the folders and repositories under a folder -----------------
// Sort state is kept per view in memory only. A header click cycles ascending, descending, then back to the default order.
const viewState = new Map();
function stateOf(id) {
  if (!viewState.has(id)) viewState.set(id, { sort: null, filter: "", shown: 0 });
  return viewState.get(id);
}
function resetShown() {
  shown = 0;
  for (const st of viewState.values()) st.shown = 0;
}
// Tag order that knows versions: 1.10.0 after 1.9.0, a pre-release before its release, then names that are not versions.
const SEMVER = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function parseTag(tag) {
  const m = SEMVER.exec(tag);
  if (!m) return null;
  return { nums: m[1].split(".").map(Number), pre: m[2] ? m[2].split(".") : [] };
}
function cmpNums(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}
function cmpPreId(x, y) {
  const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
  if (xn && yn) return Number(x) - Number(y);
  if (xn) return -1;
  if (yn) return 1;
  return x.localeCompare(y);
}
function cmpPre(a, b) {
  if (!a.length || !b.length) return b.length - a.length; // no pre-release sorts after one
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = cmpPreId(a[i], b[i]);
    if (d) return d;
  }
  return a.length - b.length;
}
function tagCompare(a, b) {
  const pa = parseTag(a), pb = parseTag(b);
  if (pa && pb) return cmpNums(pa.nums, pb.nums) || cmpPre(pa.pre, pb.pre) || collator.compare(a, b);
  if (pa) return -1;
  if (pb) return 1;
  return collator.compare(a, b);
}
const numCmp = (x, y) => x - y;
const loadedManifest = (t) => manifests.get(`${t.parent.path}@${t.digest}`);
// What a manifest holds, from the media type of its config: a container image (also what an index and an unknown manifest count as),
// a Helm chart, or some other OCI artifact.
const IMAGE_CONFIGS = new Set(["application/vnd.docker.container.image.v1+json", "application/vnd.oci.image.config.v1+json"]);
const HELM_CONFIG = "application/vnd.cncf.helm.config.v1+json";
function artifactKind(m) {
  const type = m?.configType;
  if (!type || IMAGE_CONFIGS.has(type)) return "image";
  return type === HELM_CONFIG ? "helm" : "artifact";
}
const tagKind = (t) => { const m = loadedManifest(t); return m ? artifactKind(m) : t.akind || "unknown"; }; // unknown until the poller has read it
const KIND_ICON = { image: ["whale", "whale"], helm: ["chart", "chart"], artifact: ["artifact", ""], unknown: ["box", ""] };
const kindIcon = (kind) => icon(...KIND_ICON[kind]);
const KIND_LABEL = { image: "Container image", helm: "Helm chart", artifact: "OCI artifact" };
const createdMs = (m) => (m?.created ? Date.parse(m.created) : Number.NaN);
const createdOf = (t) => { const ms = createdMs(loadedManifest(t)); return Number.isNaN(ms) ? null : ms; };
const sizeOf = (t) => { const m = loadedManifest(t); return m && !m.index ? layersTotal(m) : null; };
const platformsOf = (t) => { const m = loadedManifest(t); return m ? detailCells(m)[0] || null : null; };
// Columns: val(item) is the sort key or null (a row without one goes last in either direction), cmp compares two keys.
const TAG_COLUMNS = [
  { key: "tag", label: "Tag", val: (t) => t.tag, cmp: tagCompare },
  { key: "digest", label: "Digest", tip: "Groups the tags that share a digest", val: (t) => t.digest, cmp: collator.compare },
  { key: "size", label: "Size", tip: "Sorts loaded rows. A multi-arch index has no size of its own.", val: sizeOf, cmp: numCmp },
  { key: "platforms", label: "Platforms", tip: "Sorts loaded rows", val: platformsOf, cmp: collator.compare },
  { key: "created", label: "Created", tip: "Sorts loaded rows. When the image was built, from its config. A multi-arch index has none.", val: createdOf, cmp: numCmp },
  { key: "changed", label: "Changed", tip: "When this UI saw the tag change", val: (t) => t.changed || null, cmp: numCmp },
];
const tagDefault = (a, b) => (prefs.sort === "recent" ? (b.changed || 0) - (a.changed || 0) : 0) || tagCompare(a.tag, b.tag);
function sortItems(items, col, dir, tie) {
  const keyed = items.filter((i) => col.val(i) != null);
  const blank = items.filter((i) => col.val(i) == null);
  keyed.sort((a, b) => dir * col.cmp(col.val(a), col.val(b)) || tie(a, b));
  return [...keyed, ...blank.sort(tie)];
}
function cycleSort(st, key) {
  if (st.sort?.key !== key) st.sort = { key, dir: 1 };
  else if (st.sort.dir === 1) st.sort.dir = -1;
  else st.sort = null;
}
const FILTER_MIN = 1; // the filter and count show for any list with more than one row
function sortHeader(st, col, redraw) {
  const active = st.sort?.key === col.key;
  const dir = st.sort?.dir;
  const direction = dir < 0 ? "desc" : "";
  const button = el("button", { type: "button", className: "thbtn", title: col.tip || "", onclick: () => { cycleSort(st, col.key); redraw(); } }, col.label, active ? icon("arrow", direction) : null);
  let aria = "none";
  if (active) aria = dir < 0 ? "descending" : "ascending";
  return el("th", { "aria-sort": aria }, button);
}
function orderedItems(spec, st, list) {
  if (!st.sort) return [...list].sort(spec.defaultCmp);
  return sortItems(list, spec.columns.find((c) => c.key === st.sort.key), st.sort.dir, spec.tie);
}
const countText = (shownN, total, all, filtered) => `Showing ${shownN} of ${total}` + (filtered ? ` matching, ${all} in all` : "");
const noMatches = (cols) => el("tr", {}, el("td", { colSpan: cols, className: "mut", textContent: "No matches." }));
// spec: {id, items, columns, defaultCmp, tie, match(item, lowerText), row(item) -> tr, placeholder, onDraw(visibleItems),
// lateKeys (columns whose data arrives after drawing) and onLate(redraw) to be told how to redraw once it has}
function listView(spec) {
  const st = stateOf(spec.id);
  const input = el("input", { type: "search", className: "listfilter", placeholder: spec.placeholder, "aria-label": spec.placeholder, value: st.filter, autocomplete: "off", spellcheck: false });
  const count = el("p", { className: "mut listcount" });
  const head = el("tr"), body = el("tbody"), more = el("p");
  function draw() {
    const text = st.filter.toLowerCase();
    const list = text ? spec.items.filter((i) => spec.match(i, text)) : spec.items;
    const page = st.shown || prefs.pageSize;
    const visible = orderedItems(spec, st, list).slice(0, page);
    head.replaceChildren(...spec.columns.map((c) => sortHeader(st, c, draw)));
    body.replaceChildren(...(visible.length ? visible.map((item) => spec.row(item)) : [noMatches(spec.columns.length)]));
    count.textContent = countText(visible.length, list.length, spec.items.length, !!text);
    const left = list.length - visible.length;
    more.replaceChildren(...(left > 0 ? [el("button", { type: "button", textContent: `Show more (${left} left)`, onclick: () => { st.shown = page + prefs.pageSize; draw(); } })] : []));
    spec.onDraw?.(visible);
  }
  input.oninput = () => { st.filter = input.value.trim(); st.shown = 0; draw(); };
  spec.onLate?.(() => { if (st.sort && spec.lateKeys.includes(st.sort.key)) draw(); });
  draw();
  return [...(spec.items.length > FILTER_MIN ? [input, count] : []), el("table", { className: "sortable" }, el("thead", {}, head), body), more];
}

// Size and platforms of the rows on screen are filled in as they scroll into view: one manifest request per row, tags=0, at most four at once.
const LAZY_MAX = 4;
const lazy = { queue: [], active: 0, io: null, seen: new WeakSet(), redraw: null }; // redraw: re-sort a list sorted by a column the fill just completed
function lazyReset() {
  lazy.redraw = null;
  lazy.io?.disconnect();
  lazy.queue = [];
  lazy.seen = new WeakSet();
  lazy.io = window.IntersectionObserver ? new IntersectionObserver(lazyHit, { root: $("main"), rootMargin: "150px" }) : null;
}
function lazyHit(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazy.io.unobserve(e.target);
    lazy.queue.push(e.target.rowEntry);
  }
  lazyPump();
}
function lazyPump() {
  while (lazy.active < LAZY_MAX && lazy.queue.length) {
    const r = lazy.queue.shift();
    if (r.done || (r.t && !tree.byId.has(r.t.id))) continue;
    lazy.active++;
    (r.load ? r.load() : getManifest(r.t.parent.path, r.t.tag, r.t.digest)).then(r.apply).catch(() => { /* the row keeps its blanks */ }).finally(() => { lazy.active--; lazyPump(); if (!lazy.active && !lazy.queue.length) lazy.redraw?.(); });
  }
}
function lazyWatch(r) {
  if (r.done || lazy.seen.has(r)) return;
  lazy.seen.add(r);
  if (lazy.io) {
    r.tr.rowEntry = r;
    lazy.io.observe(r.tr);
  } else {
    lazy.queue.push(r); // no IntersectionObserver: fill the rows that are shown
    lazyPump();
  }
}

function tagRow(t) { // a table row for a tag, whose kind, size, platforms and build time fill in later
  const plat = el("td", { className: "mut" }), sz = el("td", { className: "mut" }), built = el("td", { className: "mut" });
  const ico = el("span", { className: "ico" }, kindIcon(tagKind(t)), link(t, t.tag));
  const r = { t, done: false };
  r.apply = (m) => {
    [plat.textContent, sz.textContent] = detailCells(m);
    const ms = createdMs(m);
    built.textContent = Number.isNaN(ms) ? "" : ago(ms / 1000);
    built.title = Number.isNaN(ms) ? "" : new Date(ms).toLocaleString();
    ico.firstChild.replaceWith(kindIcon(artifactKind(m)));
    r.done = true;
  };
  const cached = loadedManifest(t);
  if (cached) r.apply(cached);
  const ref = `${cfg.registryHost || "<REGISTRY>"}/${t.parent.path}:${t.tag}`;
  r.tr = el("tr", {}, el("td", {}, ico, rowCopy(ref, `Copy image reference for ${t.tag}`)),
    el("td", { className: "nw" }, code(short(t.digest)), rowCopy(t.digest, `Copy digest for ${t.tag}`)), sz, plat, built, el("td", { className: "mut", textContent: ago(t.changed) }));
  return r;
}
function tagsList(n) {
  lazyReset();
  const rowsOf = new Map();
  const entry = (t) => {
    if (!rowsOf.has(t)) rowsOf.set(t, tagRow(t));
    return rowsOf.get(t);
  };
  return listView({
    id: "tags:" + n.path, items: n.tagList, columns: TAG_COLUMNS, defaultCmp: tagDefault, tie: (a, b) => tagCompare(a.tag, b.tag),
    match: (t, text) => t.tag.toLowerCase().includes(text), placeholder: "Filter tags",
    row: (t) => entry(t).tr, onDraw: (vis) => vis.forEach((t) => lazyWatch(entry(t))),
    lateKeys: ["size", "platforms", "created"], onLate: (redraw) => { lazy.redraw = redraw; },
  });
}

function childrenList(n) {
  const items = visibleKids(n);
  const changed = new Map(items.map((k) => [k, lastChange(k)]));
  const kindOf = (k) => (k.repo ? "repository" : "folder");
  const byRecent = (a, b) => changed.get(b) - changed.get(a) || byName(a, b);
  return listView({
    id: "kids:" + n.id, items, tie: byName, defaultCmp: prefs.sort === "recent" ? byRecent : byName,
    columns: [
      { key: "name", label: "Name", val: (k) => k.name, cmp: collator.compare },
      { key: "type", label: "Type", val: kindOf, cmp: collator.compare },
      { key: "changed", label: "Last change", val: (k) => changed.get(k) || null, cmp: numCmp },
    ],
    match: (k, text) => k.name.toLowerCase().includes(text), placeholder: "Filter",
    row: (k) => el("tr", {}, el("td", {}, el("span", { className: "ico" }, icon("folder"), link(k, k.name))), el("td", { className: "mut", textContent: kindOf(k) }), el("td", { className: "mut", textContent: ago(changed.get(k)) })),
  });
}

function recentPane() {
  // Container changes come from the poller's history; PyPI uploads carry GitLab's upload time. One list, newest first.
  const items = [];
  if (showsType("containers")) {
    for (const e of recent.events) items.push({ t: e.t, el: () => el("tr", {},
      el("td", { textContent: ago(e.t), title: new Date(e.t * 1000).toLocaleString() }),
      el("td", {}, el("span", { className: "ico" }, icon("whale", "whale")), el("span", { className: "badge " + e.type, textContent: e.type })),
      el("td", {}, e.type === "deleted" ? code(e.ref) : el("a", { href: "#/repo/" + e.ref, textContent: e.ref })),
      el("td", {}, code(short(e.digest || e.prev)))) });
  }
  if (cfg.pypi && showsType("python") && pypi.loaded) {
    for (const u of pypi.packages) {
      const pkg = tree.byKey.get(u.key), ver = pkg?.versions.get(u.version);
      items.push({ t: secs(u.created) || 0, el: () => el("tr", {},
        el("td", { textContent: ago(secs(u.created)), title: u.created ? new Date(u.created).toLocaleString() : "" }),
        el("td", {}, el("span", { className: "ico" }, icon("pypi")), el("span", { className: "badge new", textContent: "upload" })),
        el("td", {}, ver ? link(ver, `${u.name}==${u.version}`) : code(`${u.name}==${u.version}`)),
        el("td", { className: "mut", textContent: u.project })) });
    }
  }
  items.sort((x, y) => y.t - x.t);
  const parts = [];
  if (showsType("containers")) parts.push((recent.persistent ? "Container history is saved to disk." : "Container history is in memory only and resets when the UI restarts.")
    + ` Watching since ${new Date(recent.since * 1000).toLocaleString()}; times are when the UI saw the change.`);
  if (cfg.pypi && showsType("python")) parts.push(pypi.denied ? "Log in to see Python uploads." : "Python upload times come from GitLab.");
  const empty = recent.baselined ? "No changes seen yet." : "Reading the registry for the first time.";
  showMain(el("h2", { textContent: "Recent changes" }), el("p", { className: "mut", textContent: parts.join(" ") }),
    ...(items.length ? paged(items.map((i) => i.el()), ["When", "Change", "Item", "Detail"]) : [el("p", { className: "mut", textContent: empty })]));
}
function rootPane(n) {
  const repos = tree.names.filter((p) => !isHidden(tree.byPath.get(p))).length, hidden = tree.names.length - repos;
  const hiddenNote = hidden ? " (" + hidden + " empty hidden)" : "";
  showMain(crumbs(n), el("h2", { textContent: "Repositories" }), el("p", { className: "mut", textContent: `${repos} repositories${hiddenNote}, ${recent.tags} tags known to the poller.` }),
    ...(visibleKids(n).length ? childrenList(n) : [el("p", { className: "mut", textContent: "The catalog is empty." })]));
}
// size and platforms of a tag, from its manifest. Fetched on demand, because the manifest call lists every tag in the repo.
const layersTotal = (m) => m.layers.reduce((a, l) => a + (l.size || 0), 0);
function detailCells(m) {
  if (m.index) { // attestation manifests show as unknown/unknown and are not platforms
    const names = [...new Set(m.platforms.map((p) => platName(p)).filter((p) => p !== "unknown/unknown"))];
    return [names.length > 4 ? names.slice(0, 4).join(", ") + ` +${names.length - 4}` : names.join(", "), ""];
  }
  return [m.platform ? `${m.platform.os}/${m.platform.architecture}` : "", size(layersTotal(m))];
}
function repoKind(n) { // a repository of charts or artifacts, as far as the loaded tags tell
  return n.tagList.map((t) => tagKind(t)).find((k) => k !== "image" && k !== "unknown") || "image";
}
const trimSlash = (p) => (p.endsWith("/") ? p.slice(0, -1) : p);
// A volume name is not a path: relative to the current directory it could delete the wrong thing, so ask the tool where the volume is.
function rmRepoCommand(repo) {
  const sub = `/docker/registry/v2/repositories/${repo}`;
  const storage = cfg.registryStorage || "<registry-storage>";
  if (cfg.registryStorage && !storage.startsWith("/")) return `rm -r "$(${prefs.runtime} volume inspect -f '{{.Mountpoint}}' '${storage}')${sub}"`;
  return `rm -r '${trimSlash(storage)}${sub}'`;
}
const storageHint = () => (cfg.registryStorage ? [] : [el("p", { className: "hint", textContent: "UI_REGISTRY_STORAGE is not set, so the command has the placeholder <registry-storage>. Replace it with the host path or volume name of the registry data, or set UI_REGISTRY_STORAGE." })]);
// The registry API cannot delete a repository, and the catalog lists one whose tags are all gone. Its directory has to be removed with the registry stopped.
function emptyRepoNote(n) {
  if (!n.fresh || n.loading) return [el("p", { className: "mut", textContent: "Loading..." })];
  const note = el("p", { className: "mut", textContent: "No tags. The registry API cannot delete a repository. To remove it, stop the registry and delete its directory." });
  if (repoError(n.path)) return [note]; // never put an odd name into a command
  return [note, codeBlock("Remove the empty repository (registry stopped)", [rmRepoCommand(n.path)]), ...storageHint()];
}
function repoPane(n) {
  const tags = n.tagList.length ? tagsList(n) : emptyRepoNote(n);
  const kids = visibleKids(n).length ? [el("h3", { textContent: "Folders" }), ...childrenList(n)] : [];
  showMain(crumbs(n), el("h2", {}, el("span", { className: "ico" }, icon("folderOpen")), n.path), el("p", { className: "reporef" }, copyValue(`${cfg.registryHost || "<REGISTRY>"}/${n.path}`, "Copy repository reference")),
    ...(n.err ? [el("p", { className: "mut", textContent: n.err })] : []), ...tags, ...kids, commandsEl(n.path, "", "", repoKind(n)));
}
function folderPane(n) {
  showMain(crumbs(n), el("h2", {}, el("span", { className: "ico" }, icon("folderOpen")), n.path), ...(visibleKids(n).length ? childrenList(n) : []));
}

function actions(repo, ref, digest) {
  // The tagged indexes this digest is a child of. The server refuses the delete or move anyway, this says so before the click.
  const parentInfo = async () => {
    try {
      return await api(`/api/parents?repo=${encodeURIComponent(repo)}&digest=${encodeURIComponent(digest)}`);
    } catch (e) {
      return null; // no warning then: the server refuses a bad delete or move itself
    }
  };
  const blockText = (r) => {
    if (!r?.parents.length) return "";
    const plats = [...new Set(r.parents.map((p) => p.platform).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const tags = r.parents.map((p) => p.tag).join(", ") + (r.more ? ` and ${r.more} more` : "");
    return `This manifest is ${plats.length ? plats.join(", ") : "a child"} inside ${tags}. Delete or retag those first.`;
  };
  const copy = (move) => async () => {
    let m;
    try { m = await getManifest(repo, ref, digest, move); } catch (e) { banner(e.message, true); return; } // a move needs the authoritative tag list
    const v = await transfer({ move, repo, ref, digest, m, sharing: move ? m.tags : [], block: move ? blockText(await parentInfo()) : "" });
    if (v) await run(() => api(move ? "/api/move" : "/api/copy", { src: repo, srcRef: ref, dst: v.dst, dstRef: v.dstRef }), async () => { await touch(repo, v.dst); location.hash = `#/repo/${v.dst}:${v.dstRef}`; });
  };
  const del = async () => {
    let m;
    try { m = await getManifest(repo, ref, digest, true); } catch (e) { banner(e.message, true); return; }
    const info = await parentInfo();
    const v = await confirmDelete({ repo, ref, digest, m, info, block: blockText(info) });
    if (v) await run(() => api("/api/delete", { repo, digest, children: v.children }), async () => { await touch(repo); location.hash = "#/repo/" + repo; });
  };
  const b = (text, fn, cls) => el("button", { textContent: text, className: cls || "", onclick: fn });
  return el("div", { className: "bar" }, ...(!canWrite() ? [] : [b("Copy to...", copy(false)), b("Move to...", copy(true)), b("Delete", del, "danger")]));
}

const tableRow = (k, v) => el("tr", {}, el("th", { textContent: k }), el("td", {}, v));
const subTable = (title, head, items) => (items.length ? [el("h3", { textContent: title }), el("table", {}, el("tr", {}, ...head.map((h) => el("th", { textContent: h }))), ...items)] : []);
function manifestProps(n, m, path, sharing) {
  const host = cfg.registryHost || "<REGISTRY>";
  const props = [];
  const kind = artifactKind(m);
  if (kind !== "image") props.push(tableRow("Type", kind === "helm" ? KIND_LABEL.helm : `${KIND_LABEL.artifact}, ${m.configType}`));
  if (n.kind === "tag") props.push(tableRow("Image", copyValue(`${host}/${path}:${n.tag}`, "Copy image reference")));
  props.push(tableRow("Pinned", copyValue(`${host}/${path}@${m.digest}`, "Copy pinned image reference")), tableRow("Digest", copyValue(m.digest, "Copy digest")),
    tableRow("Media type", code(m.mediaType)), tableRow("Manifest size", size(m.size)));
  if (m.layers.length) props.push(tableRow("Layers size", size(layersTotal(m))));
  if (m.created) props.push(tableRow("Created", el("span", { title: new Date(m.created).toLocaleString(), textContent: ago(createdMs(m) / 1000) })));
  props.push(tableRow("Tags", sharing.join(", ") || "none"));
  if (n.kind === "tag" && n.changed) props.push(tableRow("Changed", el("span", { title: new Date(n.changed * 1000).toLocaleString(), textContent: ago(n.changed) })));
  if (m.platform) props.push(tableRow("Platform", `${m.platform.os}/${m.platform.architecture}`));
  if (m.config) props.push(tableRow("Config", code(m.config)));
  return props;
}
function platformSections(n, m) {
  const real = m.platforms.filter((p) => !isAtt(p)), atts = m.platforms.length - real.length;
  const node = (p) => (n.kind === "tag" && n.plats ? n.plats.find((x) => x.digest === p.digest) : null);
  const row = (p) => el("tr", {}, el("td", {}, node(p) ? link(node(p), platName(p)) : platName(p)), el("td", {}, code(short(p.digest))), el("td", { textContent: size(p.size) }));
  const note = `+${atts} attestation${atts > 1 ? "s" : ""}, hidden from the list. Copy and delete handle them with the image.`;
  return [...subTable("Platforms", ["Platform", "Digest", "Size"], real.map((p) => row(p))), ...(atts ? [el("p", { className: "mut", textContent: note })] : [])];
}
function manifestHeading(n, t, path, kind) {
  const isTag = n.kind === "tag";
  return el("h2", {}, el("span", { className: "ico" }, isTag ? kindIcon(kind) : icon("chip")), isTag ? `${path}:${n.tag}` : `${path}:${t.tag} ${n.name}`);
}
async function manifestPane(n, seq) {
  const t = n.kind === "tag" ? n : n.parent, path = t.parent.path;
  const ref = n.kind === "tag" ? n.tag : n.digest;
  const m = await getManifest(path, ref, n.digest);
  if (n.kind === "tag") await ensurePlats(n);
  if (seq !== paneSeq) return;
  const sharing = t.parent.tagList.filter((x) => x.digest === m.digest).map((x) => x.tag); // from the tag list the pane already holds
  showMain(crumbs(n), manifestHeading(n, t, path, artifactKind(m)), actions(path, ref, m.digest), el("table", { className: "props" }, ...manifestProps(n, m, path, sharing)),
    ...(n.kind === "tag" ? [commandsEl(path, n.tag, m.digest, artifactKind(m))] : []), ...platformSections(n, m),
    ...subTable("Layers", ["Digest", "Size"], m.layers.map((l) => el("tr", {}, el("td", {}, code(l.digest)), el("td", { textContent: size(l.size) })))));
}

function notFoundPane() {
  showMain(el("h2", { textContent: "Not found" }), el("p", { className: "mut" }, "That repository or tag is not in the registry. ", el("a", { href: "#/", textContent: "Back to the registry" })));
}
async function drawPane(n, seq) {
  resetHidden();
  if (!n) return notFoundPane();
  if (n === RECENT) return recentPane();
  if (n.kind === "root") return rootPane(n);
  if (n.kind === "proot") return prootPane(n);
  if (n.kind === "pkg") return pkgPane(n);
  if (n.kind === "ver") return verPane(n);
  if (n.kind !== "node") return manifestPane(n, seq);
  if (!n.repo) return folderPane(n);
  await ensureTags(n);
  if (seq === paneSeq) repoPane(n);
}
async function renderPane(force) { // force: a setting changed under an open panel and the page behind it should show the effect
  if (!force && modalOpen()) { paneStale = true; return; }
  const seq = ++paneSeq, n = tree.sel === "recent" ? RECENT : tree.byId.get(tree.sel);
  try {
    await drawPane(n, seq);
    updated = new Date();
    liveLabel();
  } catch (e) { if (seq === paneSeq) banner(e.message, true); }
}

const canWrite = () => !cfg.readonly && (!cfg.login || cfg.user); // with an auth proxy, changes need a login
function notice() {
  if (cfg.readonly) return "Read-only mode.";
  if (!canWrite()) return "Log in to copy, move or delete.";
  return cfg.deleteEnabled ? "" : "Deletion is disabled on this registry (REGISTRY_STORAGE_DELETE_ENABLED is not true). Move and Delete will fail.";
}

// ---- Routing: #/ (registry), #/recent, #/dir/<path>, #/repo/<name>[:<tag>[@<digest>]] ---------------------------------------
function parseHash() {
  let h = "/";
  try { h = decodeURIComponent(location.hash.slice(1)) || prefs.selected; } catch (e) { /* malformed escape: show the registry */ }
  const m = /^\/(?:repo|dir)\/([^:@]+)(?::([^@]+))?(?:@(.+))?$/.exec(h);
  if (h === "/recent") return { kind: "recent" };
  if (h === "/pypi") return { kind: "proot" };
  const py = /^\/pypi\/([^@]+)(?:@(.+))?$/.exec(h);
  if (py) return { kind: "pypi", key: py[1].toLowerCase().replace(/[-_.]+/g, "-"), version: py[2] };
  return m ? { kind: "path", path: m[1], tag: m[2], digest: m[3] } : { kind: "root" };
}
let navSeq = 0;
async function resolve(r) {
  if (r.kind === "recent") return RECENT;
  if (r.kind === "root") return tree.root;
  if (r.kind === "proot") return cfg.pypi ? tree.proot : null;
  if (r.kind === "pypi") {
    if (!pypi.loaded) await pypiSync();
    const p = tree.byKey.get(r.key);
    return p && r.version ? p.versions.get(r.version) : p;
  }
  let n = tree.byPath.get(r.path);
  if (!n) { await sync(); n = tree.byPath.get(r.path); }
  if (!n || !r.tag) return n;
  await ensureTags(n);
  let t = n.tagMap.get(r.tag);
  const missedAt = n.missing?.get(r.tag);
  const recentlyMissing = missedAt !== undefined && missedAt > Date.now() - 30000;
  if (!t && !recentlyMissing) { // a link to a tag that is not there is checked once, then remembered for 30 s
    await ensureTags(n, true);
    t = n.tagMap.get(r.tag);
    if (!t) {
      if (!n.missing) n.missing = new Map();
      n.missing.set(r.tag, Date.now());
    }
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
  resetShown();
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
function pathFromId(id) { // the repository path in a node id such as t:lab/app:1.0 or p:lab/app:1.0@sha256:...
  const rest = id.slice(2), cut = rest.search(/[:@]/);
  return cut < 0 ? rest : rest.slice(0, cut);
}
function refreshTouched(touched, gap) { // reload the tags of every changed repository that is loaded, and flash the ones that are not
  const jobs = [];
  for (const n of tree.byPath.values()) {
    if (!n.repo || !(gap || touched.has(n.path))) continue;
    dropManifests(n.path);
    if (n.tagList.length || n.loading) jobs.push(ensureTags(Object.assign(n, { fresh: false }), true)); // reconciling flashes what changed
    else flash(n);
  }
  return Promise.all(jobs);
}
function leaveGoneNode() { // the selected node is gone: fall back to what holds it
  if (!tree.sel || tree.sel === "recent" || tree.byId.has(tree.sel)) return;
  const n = tree.byPath.get(pathFromId(tree.sel));
  location.hash = n ? hashOf(n) : "#/";
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
  await refreshTouched(touched, gap);
  leaveGoneNode();
  banner(notice());
  renderTree();
  if (pickerSync) pickerSync();
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
    es.onmessage = () => {
      if (document.hidden) stale = true;
      else syncSoon();
    };
    es.onerror = () => { state = "connecting"; liveLabel(); }; // the browser reconnects by itself
    es.addEventListener("pypi", () => { if (document.hidden) stale = true; else void pypiSync(); });
  }
  liveLabel();
}
let pollTimer = 0;
function startPoll() { // the fallback while the stream is down, every `interval` seconds. Restarted when the interval changes.
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!prefs.live || document.hidden || modalOpen()) return;
    if (state === "live") return;
    try { const r = await api("/api/recent?limit=1"); if (r.seq !== lastSeq) void sync(); } catch (e) { /* shown by the next sync() */ }
    if (cfg.pypi && !pypi.denied) try { const r = await api("/api/pypi/seq"); if (r.seq !== pypi.seq) void pypiSync(); } catch (e) { /* shown by the next pypiSync() */ }
  }, 1000 * Math.max(5, prefs.interval));
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && stale) { stale = false; void sync(); void pypiSync(); } });

// ---- Copy to / Move to: source card, destination path with a folder picker, promote chips, tag and a preview -----------------
// The same name rules as the server (registry.py), so a bad name is caught while typing. The server stays the authority.
const REPO_PART = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const TAG_NAME = /^\w[\w.-]{0,127}$/;
const DIGEST_REF = /^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/;
function repoError(path) {
  if (!path) return "Enter a destination repository.";
  if (path.length > 255 || !path.split("/").every((p) => REPO_PART.test(p))) return "Use lowercase letters, digits and . _ - in each part, parts separated by /.";
  return "";
}
const tagError = (t) => (TAG_NAME.test(t) || DIGEST_REF.test(t) ? "" : "A tag starts with a letter, digit or _ and holds letters, digits, . _ and - (up to 128).");
let pickerSync = null; // set while the dialog is open, so live changes to the catalog reach its picker

// The card at the top of the transfer and delete dialogs: what is being acted on.
function sourceCard(o, copyDigest) {
  const [platforms, sizeText] = o.m ? detailCells(o.m) : ["", ""];
  const digest = copyDigest ? copyValue(o.digest, "Copy digest", short(o.digest) + "...") : el("span", { textContent: short(o.digest) + "..." });
  return el("div", { className: "srccard" },
    el("div", { className: "srcname" }, el("span", { className: "ico" }, icon("whale", "whale")), el("code", { textContent: `${o.repo}:${o.ref}` })),
    el("div", { className: "srcmeta mut" }, digest, ...(platforms ? [el("span", { textContent: platforms })] : []), ...(sizeText ? [el("span", { textContent: sizeText })] : [])));
}

// The same delete as a call to this UI's own API, for a script. The repository and digest are checked first, so nothing odd is put in the command.
// It is the UI's origin on purpose: the call keeps every guard of the button. The registry's own DELETE is not shown.
function deleteScript(repo, digest, children) {
  const origin = location.origin;
  if (origin === "null" || repoError(repo) || !DIGEST_REF.test(digest)) return null;
  const body = `{"repo":"${repo}","digest":"${digest}"${children ? ',"children":true' : ""}}`;
  return [`TOKEN=$(curl -s "${origin}/api/config" | jq -r .csrf)`,
    `curl -X POST "${origin}/api/delete" -H "Origin: ${origin}" -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' -d '${body}'`];
}
function scriptSection(o, children) { // children: a function that says whether the platform images switch is on
  const holder = el("div");
  const draw = () => {
    const lines = deleteScript(o.repo, o.digest, children());
    holder.replaceChildren(...(lines ? [codeBlock("Delete from a script", lines)] : []));
  };
  draw();
  const box = el("details", { className: "script" }, el("summary", { textContent: "Delete from a script" }),
    el("p", { className: "mut", textContent: "The call keeps the same guards as the button: the CSRF token, read-only mode and the refusal to delete a child of an index. With an auth override in front of the UI it needs credentials too." }), holder);
  box.redraw = draw;
  return box;
}

// Delete: says what goes and what does not. o: {repo, ref, digest, m (a fresh manifest, with its tags), block, info (the /api/parents answer)}.
// Resolves to {children} or null.
function confirmDelete(o) {
  return new Promise((resolve) => {
    let result = null, children = false;
    const m = o.m, isIndex = !!m.index, removable = o.info ? o.info.removable : 0;
    const others = tree.names.filter((p) => p !== o.repo);
    const example = others.find((p) => p.split("/")[0] !== o.repo.split("/")[0]) || others[0];
    const suchAs = example ? ", such as " + example : "";
    const sw = el("button", { type: "button", role: "switch", className: "switch", "aria-labelledby": "d-sw", "aria-checked": "false", disabled: !removable,
      onclick: () => { children = !children; sw.setAttribute("aria-checked", String(children)); script.redraw(); } });
    const script = scriptSection(o, () => children);
    const go = el("button", { type: "button", className: "primary dangerfill", textContent: "Delete", disabled: !!o.block });
    go.onclick = () => {
      if (go.disabled) return;
      result = { children };
      dlg.close();
    };
    const dlg = el("dialog", { className: "settings transfer", "aria-labelledby": "d-title" },
      el("div", { className: "shead" }, el("h2", { id: "d-title", textContent: "Delete manifest" }),
        el("button", { type: "button", className: "iconbtn", "aria-label": "Close", onclick: () => dlg.close() }, icon("close"))),
      el("div", { className: "sbody" },
        sourceCard(o, true),
        ...(o.block ? [el("p", { className: "dlg-warn", role: "alert", textContent: o.block })] : []),
        el("p", { className: "scope", textContent: `Deletes this manifest from ${o.repo} only. Other repositories${suchAs}, are not affected, even if they hold the same image.` }),
        el("div", { className: "xlabel", textContent: "Tags removed with it" }),
        el("div", { className: "tagchips" }, ...(m.tags.length ? m.tags.map((t) => el("span", { className: "tagchip", textContent: t })) : [el("span", { className: "mut", textContent: "none, this digest has no tag" })])),
        ...(isIndex ? [el("div", { className: "srow" }, switchLabel(sw, el("div", { className: "slabel", id: "d-sw", textContent: "Also delete platform images" }),
          el("div", { className: "sdesc", textContent: removable ? `Index children that no other tag in this repository uses. ${removable} of ${o.info.children} would be removed.` : "Every child is used by another tag in this repository, so none would be removed." })), el("div", { className: "sctl" }, sw))] : []),
        el("p", { className: "mut", textContent: "Disk space is freed by garbage collection, not by this action." }), script),
      el("div", { className: "sfoot" }, el("button", { type: "button", textContent: "Cancel", onclick: () => dlg.close() }), go));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    (o.block ? dlg.querySelector(".sfoot button") : go).focus(); // never land on Delete by default when it is blocked
  });
}

// The destination folder picker: folders and repositories from the main tree's data, no tags. Click selects, the chevron opens.
function createPicker(st, onChoose) {
  const open = new Set(); // ids of open folders
  let focusId = null;
  const box = el("div", { className: "picker", role: "tree", "aria-label": "Folders and repositories" });
  const flat = () => {
    const out = [];
    const walk = (n, depth, anc, last) => {
      out.push({ n, depth, anc, last });
      if (!open.has(n.id)) return;
      const k = visibleKids(n);
      const below = depth === 0 ? [] : [...anc, !last];
      k.forEach((c, i) => walk(c, depth + 1, below, i === k.length - 1));
    };
    const top = visibleKids(tree.root);
    top.forEach((n, i) => walk(n, 0, [], i === top.length - 1));
    return out;
  };
  const rowFor = (r) => {
    const n = r.n, isOpen = open.has(n.id);
    const row = el("div", {
      className: "row", role: "treeitem", id: "px-" + n.id, tabIndex: n.id === focusId ? 0 : -1,
      "aria-level": r.depth + 1, "aria-selected": String(n.path === st.path),
    }, ...guidesFor(r), el("span", { className: "chev" }, n.kids.size ? icon("chev") : null), icon(isOpen ? "folderOpen" : "folder"), el("span", { className: "lbl", textContent: n.name }));
    row.dataset.id = n.id;
    if (n.kids.size) row.setAttribute("aria-expanded", String(isOpen));
    return row;
  };
  const draw = () => {
    const hadFocus = box.contains(document.activeElement);
    const rows = flat(), ids = rows.map((r) => r.n.id);
    const sel = tree.byPath.get(st.path);
    if (!ids.includes(focusId)) focusId = ids.includes(sel?.id) ? sel.id : ids[0];
    box.replaceChildren(...rows.map((r) => rowFor(r)));
    if (hadFocus) $("px-" + focusId)?.focus();
  };
  const reveal = (path) => { // open every existing folder above the longest existing prefix of path
    for (let q = path; q; q = q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "") {
      const n = tree.byPath.get(q);
      if (!n) continue;
      for (let x = n.parent; x && x !== tree.root; x = x.parent) open.add(x.id);
      return;
    }
  };
  const show = (node) => { // highlight node (if any), open the way to the path and scroll to it
    reveal(st.path);
    if (node) focusId = node.id;
    draw();
    $("px-" + node?.id)?.scrollIntoView({ block: "nearest" });
  };
  const nodeOf = (target) => { const r = target.closest(".row[data-id]"); return r && tree.byId.get(r.dataset.id); };
  const setOpen = (n, value) => {
    if (value) {
      open.add(n.id);
    } else {
      open.delete(n.id);
    }
    focusId = n.id;
    draw();
  };
  const ops = { expandable: (n) => n.kids.size > 0, isOpen: (n) => open.has(n.id), setOpen };
  box.addEventListener("click", (e) => {
    const n = nodeOf(e.target);
    if (!n) return;
    if (e.target.closest(".chev")) setOpen(n, !open.has(n.id)); // a click on the row only selects, the chevron opens
    else onChoose(n);
  });
  box.addEventListener("keydown", (e) => {
    const n = nodeOf(e.target);
    if (!n) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChoose(n); return; }
    const list = flat(), to = arrowTarget(e.key, list, list.findIndex((r) => r.n === n), ops);
    if (to === undefined) return;
    e.preventDefault();
    if (to && to !== tree.root) { focusId = to.id; draw(); $("px-" + to.id)?.focus(); }
  });
  return { box, show };
}

// The promote shortcuts. UI_ENVIRONMENTS is an ordered list of lifecycle stages, each a path prefix (prod, or team-a/prod). A chip
// replaces the stage prefix of the source with its own. A stage with no repositories yet is still offered, marked new.
const stageList = () => cfg.environments || [];
function stageOf(path) { // the longest stage that path is, or sits under
  const hits = stageList().filter((s) => path === s || path.startsWith(s + "/"));
  return hits.sort((a, b) => b.length - a.length)[0] || null;
}
const stageHasRepos = (s) => tree.names.some((p) => p === s || p.startsWith(s + "/"));
function stageChip(stage, o, from, next, st, focusStage) {
  const empty = !stageHasRepos(stage);
  return el("button", {
    type: "button", className: "chip" + (empty ? " empty" : ""), disabled: stage === from, tabIndex: stage === focusStage ? 0 : -1,
    "aria-pressed": String(stage === stageOf(st.path)), "aria-label": stage + (empty ? ", no repositories yet" : "") + (stage === next ? ", next stage" : ""), // for screen readers, nothing extra on screen
  }, stage);
}
function createChips(st, o, onPick) {
  const box = el("div", { className: "chips", role: "group", "aria-label": "Promote to" });
  const wrap = el("div", { className: "xchips" }, el("span", { className: "xlabel", textContent: "Promote to" }), box);
  const from = stageOf(o.repo), stages = stageList();
  wrap.hidden = !from;
  const draw = () => {
    if (!from) return;
    const next = stages[stages.indexOf(from) + 1];
    const focusStage = next ?? stages.find((s) => s !== from); // the next stage is where Tab lands
    box.replaceChildren(...stages.map((s) => stageChip(s, o, from, next, st, focusStage)));
  };
  box.addEventListener("click", (e) => {
    const stage = e.target.closest(".chip")?.firstChild?.textContent;
    if (stage && stage !== from) onPick(stage + o.repo.slice(from.length));
  });
  box.addEventListener("keydown", (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const chips = [...box.querySelectorAll(".chip:not(:disabled)")], i = chips.indexOf(document.activeElement);
    if (!d || i < 0) return;
    e.preventDefault();
    chips.forEach((c) => { c.tabIndex = -1; });
    const to = chips[(i + d + chips.length) % chips.length];
    to.tabIndex = 0;
    to.focus();
  });
  return { wrap, draw };
}

const destError = (o, path) => repoError(path) || (o.move && path === o.repo ? "Move needs a different repository than the source." : "");
// What the destination tag says: an error, or a warning when the tag is already there, and whether that blocks the action.
function tagNote(o, st, node, dstErr, tErr) {
  if (tErr) return { cls: "xerr", text: tErr, block: true };
  if (dstErr) return null;
  if (!o.move && st.path === o.repo && st.tag === o.ref) return { cls: "xerr", text: "The destination is the source.", block: true };
  const there = node?.repo ? node.tagMap.get(st.tag) : null;
  if (!there) return null;
  const name = `${st.path}:${st.tag}`;
  if (there.digest !== o.digest) return { cls: "xwarn", text: `${name} exists (${short(there.digest)}...). ${o.move ? "Moving" : "Copying"} replaces it.` };
  if (o.move) return { cls: "xwarn", text: `${name} already holds this digest. Only the source is removed.` };
  return { cls: "xwarn", text: `${name} is already identical, nothing to copy.`, block: true };
}
function pathBadge(dstErr, exists) {
  if (dstErr) return el("span", { className: "xerr", textContent: dstErr });
  return el("span", { className: "tagbadge" + (exists ? "" : " new"), textContent: exists ? "existing repository" : "new repository" });
}
function transferLead(o) {
  if (!o.move) return "Blobs are mounted, so no data is uploaded.";
  const goes = o.sharing.length ? ` Tags that go with it: ${o.sharing.join(", ")}.` : "";
  return "The source digest is deleted after the copy is verified." + goes;
}
function previewEls(err, ref) {
  return [el("span", { className: "mut", textContent: "Result" }), err ? el("span", { className: "mut", textContent: "Fix the errors above." }) : copyValue(ref, "Copy resulting reference")];
}

// o: {move, repo, ref, digest, m (manifest), sharing (tags that go with the digest), block (why a move is refused, or "")}.
// Resolves to {dst, dstRef} or null.
function transfer(o) {
  return new Promise((resolve) => {
    const verb = o.move ? "Move" : "Copy";
    const st = { path: o.repo, tag: o.ref };
    let result = null;
    const pathIn = el("input", { type: "text", className: "xin", id: "x-path", value: st.path, autocomplete: "off", spellcheck: false, "aria-describedby": "x-pathstat" });
    const tagIn = el("input", { type: "text", className: "xin", id: "x-tag", value: st.tag, autocomplete: "off", spellcheck: false, "aria-describedby": "x-tagstat" });
    const pathStat = el("div", { className: "xstat", id: "x-pathstat", "aria-live": "polite" });
    const tagStat = el("div", { className: "xstat", id: "x-tagstat", "aria-live": "polite" });
    const preview = el("div", { className: "preview" });
    const go = el("button", { type: "button", className: "primary", textContent: verb });
    const setPath = (path) => { st.path = path; pathIn.value = path; update(); };
    const picker = createPicker(st, (n) => setPath(n.path));
    const chips = createChips(st, o, setPath);
    function update() {
      const dstErr = destError(o, st.path), tErr = tagError(st.tag);
      const node = tree.byPath.get(st.path), exists = !dstErr && !!node?.repo;
      const note = tagNote(o, st, node, dstErr, tErr);
      pathStat.replaceChildren(pathBadge(dstErr, exists));
      tagStat.replaceChildren(...(note ? [el("span", { className: note.cls, textContent: note.text })] : []));
      go.disabled = !!(o.block || dstErr || note?.block);
      preview.replaceChildren(...previewEls(dstErr || tErr, `${cfg.registryHost || "<REGISTRY>"}/${st.path}:${st.tag}`));
      if (exists && !node.fresh) void ensureTags(node).then(update); // the tags of an existing destination, to tell whether the tag is taken
      chips.draw();
      picker.show(dstErr ? null : node);
    }
    pickerSync = update;
    pathIn.oninput = () => { st.path = pathIn.value.trim(); update(); };
    tagIn.oninput = () => { st.tag = tagIn.value.trim(); update(); };
    const confirm = () => {
      if (go.disabled) return;
      result = { dst: st.path, dstRef: st.tag };
      dlg.close();
    };
    go.onclick = confirm;
    for (const i of [pathIn, tagIn]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } });
    const lead = transferLead(o);
    const dlg = el("dialog", { className: "settings transfer", "aria-labelledby": "x-title" },
      el("div", { className: "shead" }, el("h2", { id: "x-title", textContent: verb + " to..." }),
        el("button", { type: "button", className: "iconbtn", "aria-label": "Close", onclick: () => dlg.close() }, icon("close"))),
      el("div", { className: "sbody" },
        sourceCard(o, false),
        ...(o.block ? [el("p", { className: "dlg-warn", role: "alert", textContent: o.block })] : []),
        el("p", { className: "mut", textContent: lead }),
        el("label", { className: "xlabel", htmlFor: "x-path", textContent: "Destination repository" }), pathIn, pathStat, picker.box, chips.wrap,
        el("label", { className: "xlabel", htmlFor: "x-tag", textContent: "Destination tag" }), tagIn, tagStat,
        preview),
      el("div", { className: "sfoot" }, el("button", { type: "button", textContent: "Cancel", onclick: () => dlg.close() }), go));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => { pickerSync = null; dlg.remove(); resolve(result); });
    document.body.append(dlg);
    update();
    dlg.showModal();
    pathIn.focus();
    pathIn.select();
  });
}

// ---- Help: how to free disk space with garbage collection, and the keys. Room for more sections later. -------------------------------
// The same registry:2 digest as compose.yml. The command is shown for the host to run, never run from here, and never with --delete-untagged
// (in registry:2.8 it deletes the child manifests of multi-arch images).
const REGISTRY_IMAGE = "registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
function gcCommand(tool, storage, dry) {
  return `${tool} run --rm -v ${storage}:/var/lib/registry:Z ${REGISTRY_IMAGE} registry garbage-collect${dry ? " --dry-run" : ""} /etc/docker/registry/config.yml`;
}
function gcSection() {
  const box = el("div", { className: "gcsteps" });
  const draw = () => {
    const storage = cfg.registryStorage || "<registry-storage>";
    const tool = prefs.runtime;
    const seg = el("div", { className: "seg", role: "group", "aria-label": "Command line tool" }, ...CHOICES.runtime.map((rt) => el("button", {
      type: "button", textContent: rt, "aria-pressed": String(rt === tool), onclick: () => { applyPrefs({ runtime: rt }); draw(); },
    })));
    box.replaceChildren(
      el("p", { textContent: "Garbage collection frees disk space from deleted images. It needs the registry stopped, so it runs on the host, not from this page." }),
      seg,
      el("ol", { className: "steps" },
        el("li", { textContent: "Stop the registry the way you normally do (systemd, compose or Quadlet)." }),
        el("li", {}, "Dry run, which lists what would be deleted.", codeBlock("Dry run", [gcCommand(tool, storage, true)])),
        el("li", {}, "Collect.", codeBlock("Collect", [gcCommand(tool, storage, false)])),
        el("li", { textContent: "Start the registry again." })),
      el("p", { className: "mut", textContent: "Never add --delete-untagged: it deletes the child manifests of multi-arch images and breaks them." }),
      el("p", { className: "slabel", textContent: "Remove an empty repository (registry stopped)" }),
      el("p", { className: "mut", textContent: "The registry API cannot delete a repository, and garbage collection leaves its empty directory behind. With the registry stopped, remove the directory yourself:" }),
      codeBlock("Remove an empty repository", [rmRepoCommand("<repo>")]),
      ...(cfg.registryStorage ? [] : [el("p", { className: "hint", textContent: "UI_REGISTRY_STORAGE is not set, so the command has the placeholder <registry-storage>. Replace it with the host path or volume name of the registry data, or set UI_REGISTRY_STORAGE." })]));
  };
  draw();
  return el("section", {}, el("h3", { className: "ssec", textContent: "Garbage collection" }), box);
}
const SHORTCUTS = [
  ["Up, Down", "Move through the tree"], ["Right", "Open a folder, repository or tag, then move to its first child"], ["Left", "Close it, then move to its parent"],
  ["Home, End", "First or last row"], ["Enter, Space", "Select the row and show its details"], ["Esc", "Close a panel, or the tree on a phone"],
];
function shortcutsSection() {
  return el("section", {}, el("h3", { className: "ssec", textContent: "Shortcuts" }),
    el("table", { className: "keys" }, ...SHORTCUTS.map(([k, what]) => el("tr", {}, el("th", {}, el("kbd", { textContent: k })), el("td", { textContent: what })))));
}
function helpPanel() {
  const dlg = el("dialog", { className: "settings help", "aria-labelledby": "h-title" },
    el("div", { className: "shead" }, el("h2", { id: "h-title", textContent: "Help" }),
      el("button", { type: "button", className: "iconbtn", "aria-label": "Close help", onclick: () => dlg.close() }, icon("close"))),
    el("div", { className: "sbody" }, gcSection(), shortcutsSection()),
    el("div", { className: "sfoot" }, el("span"), el("button", { type: "button", className: "primary", textContent: "Done", onclick: () => dlg.close() })));
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---- Settings: one panel, changes apply as you make them ----------------------------------------------------------------
const SETTING_KEYS = ["theme", "runtime", "tool", "os", "show", "sort", "live", "interval", "pageSize", "showEmpty"];
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
// The label text of a switch row flips the switch too. The button keeps role=switch, so Space and Enter still work on it.
const switchLabel = (sw, ...kids) => el("div", { className: "tap", onclick: () => { if (!sw.disabled) sw.click(); } }, ...kids);
function selectEl(labelId, key, values, text, apply) {
  const sel = el("select", { "aria-labelledby": labelId, onchange: () => apply({ [key]: +sel.value }) }, ...values.map((v) => el("option", { value: String(v), textContent: text(v) })));
  const wrap = el("span", { className: "selwrap" }, sel, icon("chev"));
  wrap.draw = (off = false) => { sel.value = String(prefs[key]); sel.disabled = off; };
  wrap.draw(false);
  return wrap;
}
function lifecycleRow() { // read only: the stages are set by the server
  const stages = stageList();
  return el("div", { className: "srow" }, el("div", {}, el("div", { className: "slabel", textContent: "Lifecycle" }), el("div", { className: "sdesc", textContent: "Set by the server (UI_ENVIRONMENTS)." })),
    el("div", { className: "sctl" }, el("code", { className: "stages", textContent: stages.length ? stages.join(" \u2192 ") : "none" })));
}
function applyPrefs(change) { // save a change and do what it needs, at once
  const before = { ...prefs };
  Object.assign(prefs, change);
  savePrefs();
  if (prefs.theme !== before.theme) applyTheme();
  if (prefs.live !== before.live) startLive();
  if (prefs.interval !== before.interval) startPoll();
  if (prefs.showEmpty !== before.showEmpty || prefs.show !== before.show) { resetHidden(); renderTree(); drawTypes(); }
  if (prefs.runtime !== before.runtime || prefs.tool !== before.tool || prefs.os !== before.os || prefs.show !== before.show || prefs.sort !== before.sort || prefs.pageSize !== before.pageSize || prefs.showEmpty !== before.showEmpty) { resetShown(); void renderPane(true); }
}
function settings() {
  const controls = [];
  const apply = (change) => {
    applyPrefs(change);
    controls.forEach((c) => c.draw());
    pollCtl.draw(!prefs.live); // the poll only runs while the stream is down, so it means nothing with auto-refresh off
    pollRow.dataset.off = String(!prefs.live);
  };
  const row = (id, label, desc, control) => {
    controls.push(control);
    const text = [el("div", { className: "slabel", id, textContent: label }), el("div", { className: "sdesc", textContent: desc })];
    return el("div", { className: "srow" }, control.getAttribute?.("role") === "switch" ? switchLabel(control, ...text) : el("div", {}, ...text), el("div", { className: "sctl" }, control));
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
      section("Commands", row("s-rt", "Container tool", "Used in the copyable container commands.", segmented("s-rt", [["podman", "podman"], ["docker", "docker"]], "runtime", apply)),
        ...(cfg.pypi ? [row("s-tool", "Python installer", "Used in the copyable Python commands.", segmented("s-tool", [["pip", "pip"], ["uv", "uv"]], "tool", apply)),
          row("s-os", "Operating system", "Linux and macOS get shell commands, Windows gets PowerShell.", segmented("s-os", [["linux", "Linux/macOS"], ["windows", "Windows"]], "os", apply))] : [])),
      section("Lists", row("s-sort", "Sort by", "Order of tags and folders in lists.", segmented("s-sort", [["recent", "Recent"], ["name", "Name"]], "sort", apply)),
        row("s-rows", "Rows per page", "Rows a list shows before Show more.", selectEl("s-rows", "pageSize", CHOICES.pageSize, String, apply)),
        row("s-empty", "Show empty repositories", "Repositories with no tags. The registry cannot delete them.", switchEl("s-empty", "showEmpty", apply))),
      section("Lifecycle", lifecycleRow()),
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

// ---- PyPI source: one GitLab group's PyPI packages (server/pypi.py), shown as a second root in the tree ----------------------------
// Nodes: proot (the group), pkg (a project name, as pip normalises it), ver (one version of it, across every GitLab project).
let pypi = { packages: [], seq: 0, group: null, truncated: false, loaded: null, error: "", denied: false };
const pypiFiles = new Map(); // upload id -> files, or a promise while loading
const secs = (iso) => (iso ? Date.parse(iso) / 1000 : null);
const when = (iso, never = "") => (iso ? el("span", { title: new Date(iso).toLocaleString(), textContent: ago(secs(iso)) }) : never);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const shortProject = (p) => p.split("/").pop();
const showsType = (t) => prefs.show === "all" || prefs.show === t; // the sidebar's type filter: all, containers or python

// Versions in PEP 440 order: 1.0.dev1 < 1.0a1 < 1.0b2 < 1.0rc1 < 1.0 < 1.0.post1, numeric parts compared as numbers.
const PEP440 = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;
const PRE = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };
const verKeys = new Map();
function verKey(v) {
  if (verKeys.has(v)) return verKeys.get(v);
  const m = PEP440.exec(v);
  let k = null;
  if (m) {
    const post = m[5] ?? m[6], dev = m[7];
    const pre = m[3] ? [PRE[m[3].toLowerCase()], +(m[4] || 0)] : dev !== undefined && post === undefined ? [-1, 0] : [3, 0];
    k = { epoch: +(m[1] || 0), rel: m[2].split(".").map(Number), rest: [...pre, post === undefined ? -1 : +(post || 0), dev === undefined ? 1 : 0, +(dev || 0)] };
  }
  verKeys.set(v, k);
  return k;
}
function verCompare(a, b) { // ascending; versions pip cannot parse go after those it can
  const x = verKey(a), y = verKey(b);
  if (x && y) return x.epoch - y.epoch || cmpNums(x.rel, y.rel) || cmpNums(x.rest, y.rest) || collator.compare(a, b);
  if (x) return -1;
  if (y) return 1;
  return collator.compare(a, b);
}
const isPre = (v) => { const k = verKey(v); return !!k && (k.rest[0] < 3 || k.rest[3] === 0); }; // a pre-release or dev release

const latestUpload = (rows) => rows.reduce((a, b) => ((b.created || "") > (a.created || "") ? b : a));
// Rebuild packages and versions from the upload list. Nodes keep their identity, so open ones stay open. Returns the ids that are new.
function applyPypi(list, flashNew) {
  const fresh = new Set(), groups = new Map();
  for (const p of list) {
    if (!groups.has(p.key)) groups.set(p.key, []);
    groups.get(p.key).push(p);
  }
  for (const [key, uploads] of groups) {
    let n = tree.byKey.get(key);
    if (!n) {
      n = mk("pkg", "k:" + key, uploads[0].name, tree.proot, { key, versions: new Map() });
      tree.byKey.set(key, n);
      fresh.add(n.id);
    }
    n.uploads = uploads;
    n.name = latestUpload(uploads).name; // the spelling of the newest upload
    const byVer = new Map();
    for (const u of uploads) {
      if (!byVer.has(u.version)) byVer.set(u.version, []);
      byVer.get(u.version).push(u);
    }
    for (const [v, us] of byVer) {
      let vn = n.versions.get(v);
      if (!vn) {
        vn = mk("ver", `v:${key}@${v}`, v, n, { version: v });
        n.versions.set(v, vn);
        fresh.add(vn.id);
      }
      vn.uploads = us.sort((a, b) => (b.created || "").localeCompare(a.created || "") || a.project.localeCompare(b.project));
      vn.created = vn.uploads[0].created;
      vn.downloaded = us.map((u) => u.downloaded).filter(Boolean).sort().pop() || null;
    }
    for (const [v, vn] of n.versions) if (!byVer.has(v)) { n.versions.delete(v); tree.byId.delete(vn.id); }
    n.verList = [...n.versions.values()].sort((a, b) => verCompare(b.version, a.version));
    n.latest = (n.verList.find((x) => !isPre(x.version)) || n.verList[0]).version; // what pip installs without --pre
    n.created = n.uploads.map((u) => u.created).filter(Boolean).sort().pop() || null;
    n.downloaded = n.uploads.map((u) => u.downloaded).filter(Boolean).sort().pop() || null;
    n.projects = [...new Set(n.uploads.map((u) => u.project))].sort();
  }
  for (const [key, n] of tree.byKey) {
    if (!groups.has(key)) { tree.byKey.delete(key); tree.byId.delete(n.id); for (const vn of n.versions.values()) tree.byId.delete(vn.id); }
  }
  tree.proot.kids = [...tree.byKey.values()];
  if (flashNew) for (const id of fresh) flash(tree.byId.get(id));
  return fresh;
}
const pypiLabel = () => "PyPI · " + (pypi.group ? pypi.group.path : cfg.pypi?.groupRef || "");
const pkgSort = (list) => [...list].sort(prefs.sort === "recent" ? (a, b) => (b.created || "").localeCompare(a.created || "") || byName(a, b) : byName);
const pkgHit = (n, term) => n.key.includes(term) || n.name.toLowerCase().includes(term);
const verHit = (n, term) => !pkgHit(n, term) && n.verList.some((v) => v.version.toLowerCase().includes(term));
// The PyPI rows of the tree, after the registry's: the same row shape, so rendering and keys work unchanged.
function pypiRows() {
  if (!cfg.pypi || !showsType("python")) return;
  const term = tree.filter.toLowerCase(), root = tree.proot;
  rows.push({ n: root, depth: 0, anc: [], pos: 1, count: 1, last: true });
  if (!isOpen(root)) return;
  if (pypi.denied) { rows.push({ info: "Log in to see Python packages", depth: 1, anc: [], last: true }); return; }
  if (!pypi.loaded) { rows.push({ info: pypi.error || "Loading...", depth: 1, anc: [], last: true }); return; }
  let kids = pkgSort(root.kids);
  if (term) kids = kids.filter((k) => pkgHit(k, term) || verHit(k, term));
  if (term && !kids.length) rows.push({ info: "No packages or versions match", depth: 1, anc: [], last: true });
  kids.forEach((k, i) => {
    const last = i === kids.length - 1;
    rows.push({ n: k, depth: 1, anc: [], pos: i + 1, count: kids.length, last });
    if (!isOpen(k)) return;
    const vers = term && verHit(k, term) ? k.verList.filter((v) => v.version.toLowerCase().includes(term)) : k.verList;
    vers.forEach((v, j) => rows.push({ n: v, depth: 2, anc: [!last], pos: j + 1, count: vers.length, last: j === vers.length - 1 }));
  });
}

// ---- PyPI files: fetched per upload when a row scrolls into view, through the same lazy queue as the registry's manifests ---------
function filesOf(u) {
  if (!pypiFiles.has(u.id)) {
    const p = api(`/api/pypi/files?id=${u.id}`).then((fs) => { pypiFiles.set(u.id, fs); return fs; }, (e) => { pypiFiles.delete(u.id); throw e; });
    pypiFiles.set(u.id, p);
  }
  return Promise.resolve(pypiFiles.get(u.id));
}
const loadedFiles = (u) => { const f = pypiFiles.get(u.id); return Array.isArray(f) ? f : null; };
const platLabel = (p) => (p.os === "any" ? "any" : `${p.os.split(" ")[0]} ${p.arch}`);
const summary = (fs) => ({
  platforms: uniq(fs.flatMap((f) => f.platforms.map(platLabel))).join(", "),
  requires: uniq(fs.map((f) => f.requires)).join(", "),
  built: uniq(fs.map((f) => f.python)).join(", "),
  size: fs.reduce((n, f) => n + (f.size || 0), 0),
  count: fs.length,
});
// A version over every copy of it: Requires-Python as recorded by any copy, and how many copies lack it.
function versionSummary(v) {
  const all = v.uploads.map(loadedFiles);
  if (all.some((fs) => !fs)) return null;
  const s = summary(all[0]);
  s.missing = all.filter((fs) => fs.length && fs.every((f) => !f.requires)).length;
  s.requires = uniq(all.flat().map((f) => f.requires)).join(", ");
  return s;
}

// ---- PyPI commands: Install, Configure and Upload, for pip or uv, on Linux/macOS (shell) or Windows (PowerShell) ----------------
// Checked against pip 26.2, uv 0.13 and twine 7.0: uv takes --default-index and UV_DEFAULT_INDEX (UV_INDEX_URL is deprecated),
// and pip and uv both read ~/.netrc on every OS. <TOKEN> marks where a token goes; this page never holds one.
const pypiHost = () => (cfg.pypi?.gitlab || "").replace(/^https?:\/\//, "");
const groupIndex = () => `${cfg.pypi.gitlab}/api/v4/groups/${pypi.group ? pypi.group.id : "<GROUP_ID>"}/-/packages/pypi/simple`;
const projectIndex = (id) => `${cfg.pypi.gitlab}/api/v4/projects/${id}/packages/pypi/simple`;
const publicIndex = () => cfg.pypi?.indexAuth === "none"; // GitLab serves the index without a login
const withToken = (url) => (publicIndex() ? url : url.replace(/^(https?:\/\/)/, "$1__token__:<TOKEN>@"));
let pyTab = "install";
function pypiCommandSets({ name, version, project }) {
  const spec = name ? (version ? `${name}==${version}` : name) : "<package>";
  const index = withToken(groupIndex());
  const win = prefs.os === "windows";
  const pipOf = (tool) => (tool === "uv" ? "uv pip" : win ? "py -m pip" : "python3 -m pip");
  const indexFlag = (tool) => (tool === "uv" ? "--default-index" : "--index-url");
  const install = (tool) => [
    cmdNote("From the group index, which lists every project's packages. GitLab asks pypi.org for anything it does not hold, if the group allows it."),
    codeBlock("Install", [`${pipOf(tool)} install ${indexFlag(tool)} ${index} ${spec}`]),
    ...(version ? [cmdNote(tool === "uv" ? "Download the files only, without installing. uv has no download command, so this is pip." : "Download the files only, without installing."),
      codeBlock("Download", [`${pipOf("pip")} download --no-deps --index-url ${index} ${spec}`])] : []),
    ...(project ? [cmdNote("From one project's index only, when several projects hold the same version."), codeBlock("Install from this project", [`${pipOf(tool)} install ${indexFlag(tool)} ${withToken(projectIndex(project))} ${spec}`])] : [])];
  const netrcLine = `machine ${pypiHost().split("/")[0]} login __token__ password <TOKEN>`;
  const configure = (tool) => {
    const idx = tool === "uv"
      ? (win ? codeBlock("uv (PowerShell, kept for your user)", [`[Environment]::SetEnvironmentVariable("UV_DEFAULT_INDEX", "${groupIndex()}", "User")`])
        : codeBlock("uv (add to ~/.profile to keep it)", [`export UV_DEFAULT_INDEX=${groupIndex()}`]))
      : codeBlock("pip (written to your user's pip config)", [`${pipOf("pip")} config --user set global.index-url ${groupIndex()}`]);
    const netrc = win
      ? [cmdNote("Keep the token out of the URL and out of shell history: put it in %USERPROFILE%\\.netrc, which pip and uv both read."),
        codeBlock(".netrc (PowerShell)", [`Add-Content -Path "$HOME\\.netrc" -Value "${netrcLine}"`])]
      : [cmdNote("Keep the token out of the URL and out of shell history: put it in ~/.netrc, which pip and uv both read."),
        codeBlock("~/.netrc", [`printf '%s\\n' '${netrcLine}' >> ~/.netrc`, "chmod 600 ~/.netrc"])];
    return [cmdNote("Set the index once instead of passing it every time. Prefer index-url over extra-index-url: with an extra index, pip may take a public package of the same name instead of yours."),
      idx, ...(publicIndex() ? [] : netrc), ...(win ? [cmdNote("Open a new PowerShell window afterwards: a variable set for your user reaches new windows only.")] : [])];
  };
  const upload = () => {
    const url = `${cfg.pypi.gitlab}/api/v4/projects/${project || "<PROJECT_ID>"}/packages/pypi`;
    return [cmdNote(project ? `Upload to the project that holds the newest ${name}. A token with write_package_registry.` : "Upload to a project's index: its numeric id is on the project page. A token with write_package_registry."),
      win ? codeBlock("twine (PowerShell)", ['$env:TWINE_USERNAME = "__token__"', '$env:TWINE_PASSWORD = "<TOKEN>"', `py -m twine upload --repository-url ${url} dist\\*`])
        : codeBlock("twine", [`TWINE_USERNAME=__token__ TWINE_PASSWORD=<TOKEN> python3 -m twine upload --repository-url ${url} dist/*`]),
      cmdNote("In a GitLab pipeline the username must be gitlab-ci-token, with the job's own token."),
      codeBlock("twine in .gitlab-ci.yml", ["TWINE_USERNAME=gitlab-ci-token TWINE_PASSWORD=${CI_JOB_TOKEN} python3 -m twine upload --repository-url ${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/pypi dist/*"]),
      cmdNote("twine sends Requires-Python from the wheel's metadata. A bare curl upload does not, and pip then cannot tell which Python a version needs.")];
  };
  return { names: [["install", "Install"], ["configure", "Configure"], ["upload", "Upload"]], content: { install, configure, upload } };
}
function pypiCommandsEl(ctx, heading) {
  const names = pypiCommandSets(ctx).names;
  const tabs = el("div", { role: "tablist", className: "tabs", "aria-label": "Command helpers" });
  const seg = el("div", { className: "seg", role: "group", "aria-label": "Installer" });
  const osSeg = el("div", { className: "seg", role: "group", "aria-label": "Operating system" });
  const panel = el("div", { role: "tabpanel", className: "cmd-panel" });
  const draw = () => {
    const cur = names.some(([k]) => k === pyTab) ? pyTab : names[0][0];
    tabs.replaceChildren(...names.map(([k, text]) => el("button", {
      type: "button", role: "tab", textContent: text, id: "ptab-" + k, tabIndex: k === cur ? 0 : -1, "aria-selected": String(k === cur), "aria-controls": "pcmd-panel",
      onclick: () => { pyTab = k; draw(); },
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        pyTab = names[(names.findIndex((x) => x[0] === k) + d + names.length) % names.length][0];
        draw();
        $("ptab-" + pyTab).focus();
      },
    })));
    seg.hidden = cur === "upload";
    seg.replaceChildren(...CHOICES.tool.map((t) => el("button", { type: "button", textContent: t, "aria-pressed": String(t === prefs.tool), onclick: () => { prefs.tool = t; savePrefs(); draw(); } })));
    osSeg.replaceChildren(...[["linux", "Linux/macOS"], ["windows", "Windows"]].map(([o, text]) => el("button", { type: "button", textContent: text, "aria-pressed": String(o === prefs.os), onclick: () => { prefs.os = o; savePrefs(); draw(); } })));
    panel.id = "pcmd-panel";
    panel.setAttribute("aria-labelledby", "ptab-" + cur);
    panel.replaceChildren(...pypiCommandSets(ctx).content[cur](prefs.tool)); // built again: the OS choice changes every command
  };
  draw();
  return el("section", { className: "cmds" }, el("h3", { textContent: heading }), el("div", { className: "cmd-bar" }, tabs, el("div", { className: "segs" }, osSeg, seg)), panel);
}

// ---- PyPI panes ----------------------------------------------------------------------------------------------------------
function pypiCrumbs(n) {
  const parts = [];
  for (let x = n; x && x.kind !== "proot"; x = x.parent) parts.unshift(x);
  return el("nav", { className: "crumbs", "aria-label": "Path" }, el("a", { href: "#/pypi", textContent: pypiLabel() }),
    ...parts.map((x, i) => (i === parts.length - 1 ? el("span", { className: x.kind === "ver" ? "t" : "", textContent: x.kind === "ver" ? "==" + x.name : x.name })
      : el("a", { href: hashOf(x), textContent: x.name }))));
}
const gitlabLink = (path, text) => (path ? el("a", { href: cfg.pypi.gitlab + path, target: "_blank", rel: "noopener noreferrer", textContent: text }) : null);
const stats = (...items) => el("p", { className: "stats" }, ...items.filter(Boolean).map((t) => el("span", { className: "stat", textContent: t })));
const paneTabs = new Map(); // the chosen tab per view, for this page's life
function tabSet(id, tabs) { // tabs: [key, label, build() -> nodes]
  const bar = el("div", { role: "tablist", className: "tabs panetabs", "aria-label": "Sections" }), panel = el("div", { role: "tabpanel", className: "tabpanel" });
  const draw = (focus) => {
    const cur = tabs.some(([k]) => k === paneTabs.get(id)) ? paneTabs.get(id) : tabs[0][0];
    bar.replaceChildren(...tabs.map(([k, label]) => el("button", {
      type: "button", role: "tab", textContent: label, id: `pt-${k}`, tabIndex: k === cur ? 0 : -1, "aria-selected": String(k === cur),
      onclick: () => { paneTabs.set(id, k); draw(); },
      onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        paneTabs.set(id, tabs[(tabs.findIndex((t) => t[0] === k) + d + tabs.length) % tabs.length][0]);
        draw(true);
      },
    })));
    panel.setAttribute("aria-labelledby", "pt-" + cur);
    lazyReset();
    panel.replaceChildren(...[tabs.find((t) => t[0] === cur)[2]()].flat());
    if (focus) bar.querySelector("[aria-selected=true]").focus();
  };
  draw();
  return [bar, panel];
}
function pypiNotice(n) { // in place of a pane when the list cannot be shown
  if (pypi.denied) return [pypiCrumbs(n), el("h2", { textContent: "Python packages" }), el("p", { className: "mut" }, "Log in to see the Python packages. ", ...(cfg.login ? [el("a", { href: cfg.login, textContent: "Log in" })] : []))];
  if (!pypi.loaded) return [pypiCrumbs(n), el("h2", { textContent: "Python packages" }), el("p", { className: "mut", textContent: pypi.error || "Reading the group from GitLab..." })];
  return null;
}
function prootPane(n) {
  const blocked = pypiNotice(n);
  if (blocked) return showMain(...blocked);
  const pkgs = n.kids, projects = uniq(pypi.packages.map((u) => u.project));
  showMain(pypiCrumbs(n), el("h2", {}, el("span", { className: "ico" }, icon("pypi")), pypiLabel()),
    stats(plural(pkgs.length, "package"), plural(pypi.packages.length, "upload"), plural(projects.length, "project"), pypi.truncated ? "newest uploads only (UI_PYPI_MAX_PACKAGES)" : ""),
    el("p", { className: "reporef" }, copyValue(groupIndex(), "Copy the group index URL")),
    ...listView({
      id: "pkgs", items: pkgs, tie: byName, defaultCmp: prefs.sort === "recent" ? (a, b) => (b.created || "").localeCompare(a.created || "") || byName(a, b) : byName,
      columns: [
        { key: "name", label: "Package", val: (p) => p.key, cmp: collator.compare },
        { key: "latest", label: "Latest", val: (p) => p.latest, cmp: verCompare },
        { key: "versions", label: "Versions", val: (p) => p.verList.length, cmp: numCmp },
        { key: "projects", label: "Projects", val: (p) => p.projects.length, cmp: numCmp, tip: "GitLab projects that hold a copy" },
        { key: "created", label: "Last upload", val: (p) => secs(p.created), cmp: numCmp },
        { key: "downloaded", label: "Last download", val: (p) => secs(p.downloaded), cmp: numCmp },
      ],
      match: (p, t) => pkgHit(p, t), placeholder: "Filter packages",
      row: (p) => el("tr", {}, el("td", {}, el("span", { className: "ico" }, icon("pkg"), link(p))), el("td", { className: "nw" }, code(p.latest)),
        el("td", { textContent: p.verList.length }), el("td", { className: "mut", textContent: p.projects.length }),
        el("td", { className: "mut" }, when(p.created)), el("td", { className: "mut" }, when(p.downloaded, "never"))),
    }),
    pypiCommandsEl({ name: "", version: "", project: "" }, "Use this index"));
}
function versionRow(v) { // a table row for a version, whose Python, platforms, files and size fill in from its copies
  const req = el("td", { className: "mut nw" }), built = el("td", { className: "mut" }), plat = el("td", { className: "mut" }), count = el("td", { className: "mut" }), sz = el("td", { className: "mut nw" });
  const r = { done: false, load: () => Promise.all(v.uploads.map(filesOf)) };
  r.apply = () => {
    const s = versionSummary(v);
    if (!s) return;
    req.replaceChildren(s.requires || "not recorded", ...(s.requires && s.missing ? [el("span", { className: "badge deleted", textContent: ` missing in ${s.missing} of ${v.uploads.length}` })] : []));
    req.title = s.missing ? "Some copies were uploaded without Requires-Python, so pip cannot tell from them which Python this version needs" : "Requires-Python";
    built.textContent = s.built;
    plat.textContent = s.platforms;
    count.textContent = s.count;
    sz.textContent = size(s.size);
    r.done = true;
  };
  r.apply();
  r.tr = el("tr", {}, el("td", {}, el("span", { className: "ico" }, icon("tag"), link(v, v.version)), rowCopy(`${v.parent.name}==${v.version}`, `Copy ${v.parent.name}==${v.version}`)),
    req, built, plat, count, sz, el("td", { className: "mut", textContent: v.uploads.length }),
    el("td", { className: "mut" }, when(v.created)), el("td", { className: "mut" }, when(v.downloaded, "never")));
  return r;
}
const fileSort = (key) => (v) => { const s = versionSummary(v); return s ? s[key] || null : null; };
function projectsList(n) { // which GitLab projects hold a copy of the package, and of which versions
  const rows = n.projects.map((path) => {
    const ups = n.uploads.filter((u) => u.project === path);
    const vers = ups.map((u) => u.version).sort(verCompare).reverse();
    return { path, vers, created: ups.map((u) => u.created).filter(Boolean).sort().pop() || null, downloaded: ups.map((u) => u.downloaded).filter(Boolean).sort().pop() || null };
  });
  return listView({
    id: "projects:" + n.key, items: rows, tie: (a, b) => collator.compare(a.path, b.path), defaultCmp: (a, b) => collator.compare(a.path, b.path),
    columns: [
      { key: "path", label: "Project", val: (r) => r.path, cmp: collator.compare },
      { key: "count", label: "Versions", val: (r) => r.vers.length, cmp: numCmp },
      { key: "newest", label: "Newest held", val: (r) => r.vers[0], cmp: verCompare },
      { key: "created", label: "Last upload", val: (r) => secs(r.created), cmp: numCmp },
      { key: "downloaded", label: "Last download", val: (r) => secs(r.downloaded), cmp: numCmp },
    ],
    match: (r, t) => r.path.toLowerCase().includes(t), placeholder: "Filter projects",
    row: (r) => el("tr", {}, el("td", {}, gitlabLink(`/${r.path}/-/packages`, r.path)), el("td", { textContent: r.vers.length, title: r.vers.join(", ") }),
      el("td", {}, link(n.versions.get(r.vers[0]), r.vers[0])), el("td", { className: "mut" }, when(r.created)), el("td", { className: "mut" }, when(r.downloaded, "never"))),
  });
}
function pkgPane(n) {
  const blocked = pypiNotice(n);
  if (blocked) return showMain(...blocked);
  const entries = new Map();
  const entry = (v) => {
    if (!entries.has(v)) entries.set(v, versionRow(v));
    return entries.get(v);
  };
  const versions = () => listView({
    id: "vers:" + n.key, items: n.verList, tie: (a, b) => verCompare(b.version, a.version), defaultCmp: (a, b) => verCompare(b.version, a.version),
    columns: [
      { key: "version", label: "Version", val: (v) => v.version, cmp: verCompare },
      { key: "requires", label: "Requires Python", val: fileSort("requires"), cmp: collator.compare, tip: "Sorts loaded rows. Requires-Python, as the uploader recorded it" },
      { key: "built", label: "Built for", val: fileSort("built"), cmp: collator.compare, tip: "Sorts loaded rows. From the wheel tags" },
      { key: "platforms", label: "Platforms", val: fileSort("platforms"), cmp: collator.compare, tip: "Sorts loaded rows" },
      { key: "count", label: "Files", val: fileSort("count"), cmp: numCmp, tip: "Sorts loaded rows" },
      { key: "size", label: "Size", val: fileSort("size"), cmp: numCmp, tip: "Sorts loaded rows. All files of the newest copy" },
      { key: "copies", label: "Copies", val: (v) => v.uploads.length, cmp: numCmp, tip: "GitLab projects that hold this version" },
      { key: "created", label: "Uploaded", val: (v) => secs(v.created), cmp: numCmp },
      { key: "downloaded", label: "Last download", val: (v) => secs(v.downloaded), cmp: numCmp },
    ],
    match: (v, t) => v.version.toLowerCase().includes(t), placeholder: "Filter versions",
    row: (v) => entry(v).tr, onDraw: (vis) => vis.forEach((v) => lazyWatch(entry(v))),
    lateKeys: ["requires", "built", "platforms", "count", "size"], onLate: (redraw) => { lazy.redraw = redraw; },
  });
  showMain(pypiCrumbs(n), el("h2", {}, el("span", { className: "ico" }, icon("pkg")), `${n.name} `, el("span", { className: "mut", textContent: n.latest })),
    stats(plural(n.verList.length, "version"), plural(n.uploads.length, "upload"), plural(n.projects.length, "project")),
    ...tabSet("pkg", [["versions", "Versions", versions], ["projects", `Projects (${n.projects.length})`, () => projectsList(n)]]),
    pypiCommandsEl({ name: n.name, version: "", project: latestUpload(n.uploads).projectId }, "Use this package"));
}
function filesTable(fs) {
  return el("table", {}, el("tr", {}, ...["File", "Type", "Requires Python", "Built for", "ABI", "Platform", "Size", "SHA-256"].map((h) => el("th", { textContent: h }))),
    ...fs.map((f) => el("tr", {},
      el("td", {}, code(f.name), rowCopy(f.name, "Copy file name")), el("td", { className: "mut", textContent: f.kind }),
      el("td", { className: "nw", textContent: f.requires || "", title: f.requires ? "" : "Not recorded by the uploader" }), el("td", { textContent: f.python }),
      el("td", {}, code(f.abi)), el("td", { textContent: f.platforms.map((p) => (p.os === "any" ? "any" : `${p.os} ${p.arch}`)).join(", ") }),
      el("td", { className: "nw", textContent: size(f.size) }), el("td", { className: "nw" }, f.sha256 ? copyValue(f.sha256, "Copy SHA-256", f.sha256.slice(0, 12) + "…") : ""))));
}
function uploadSection(u) {
  const body = el("div", {}, el("p", { className: "mut", textContent: "Loading files..." }));
  const props = el("table", { className: "props" },
    tableRow("Project", u.project), tableRow("Uploaded", when(u.created)), tableRow("Last download", when(u.downloaded, "never")),
    tableRow("Links", el("span", {}, gitlabLink(u.webPath, "Package in GitLab"),
      ...(u.pipeline ? [" · ", gitlabLink(`/${u.project}/-/pipelines/${u.pipeline.id}`, `Pipeline ${u.pipeline.id}`), u.pipeline.sha ? el("span", { className: "mut", textContent: ` (${u.pipeline.ref} ${u.pipeline.sha.slice(0, 8)})` }) : null] : [el("span", { className: "mut", textContent: " · uploaded outside a pipeline" })]))));
  filesOf(u).then((fs) => {
    const s = summary(fs);
    props.append(tableRow("Files", `${s.count}, ${size(s.size)} in all`), tableRow("Requires Python", s.requires || "not recorded by the uploader"),
      tableRow("Built for", s.built), tableRow("Platforms", s.platforms));
    body.replaceChildren(filesTable(fs));
  }, (e) => body.replaceChildren(el("p", { className: "mut", textContent: e.message })));
  return el("section", { className: "upload" }, props, body);
}
// One row per project that holds the version: filtered and paged like every list, so a thousand copies stay one table.
function copiesList(n) {
  const detail = el("div", { className: "copydetail" }), rowsOf = new Map();
  const show = (u) => {
    for (const [id, tr] of rowsOf) tr.setAttribute("aria-selected", String(id === u.id));
    detail.replaceChildren(el("h3", { textContent: u.project }), uploadSection(u));
  };
  const rowOf = (u) => {
    if (!rowsOf.has(u.id)) {
      rowsOf.set(u.id, el("tr", { className: "pick", tabIndex: 0, "aria-selected": "false", onclick: () => show(u), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(u); } } },
        el("td", { textContent: u.project }), el("td", { className: "mut" }, when(u.created)), el("td", { className: "mut" }, when(u.downloaded, "never")),
        el("td", { className: "mut", textContent: u.pipeline ? `pipeline ${u.pipeline.id}` : "outside a pipeline" })));
    }
    return rowsOf.get(u.id);
  };
  const list = listView({
    id: "copies:" + n.id, items: n.uploads, tie: (a, b) => collator.compare(a.project, b.project), defaultCmp: (a, b) => (b.created || "").localeCompare(a.created || "") || collator.compare(a.project, b.project),
    columns: [
      { key: "project", label: "Project", val: (u) => u.project, cmp: collator.compare },
      { key: "created", label: "Uploaded", val: (u) => secs(u.created), cmp: numCmp },
      { key: "downloaded", label: "Last download", val: (u) => secs(u.downloaded), cmp: numCmp },
      { key: "by", label: "Uploaded by", val: (u) => (u.pipeline ? "pipeline" : "other"), cmp: collator.compare },
    ],
    match: (u, t) => u.project.toLowerCase().includes(t), placeholder: "Filter projects", row: rowOf,
  });
  show(n.uploads[0]);
  return [el("h3", { textContent: `Copies (${n.uploads.length})` }), el("p", { className: "mut", textContent: "Select a copy to see its files." }), ...list, detail];
}
function verPane(n) {
  const blocked = pypiNotice(n);
  if (blocked) return showMain(...blocked);
  const pkg = n.parent, newer = pkg.verList.filter((x) => verCompare(x.version, n.version) > 0 && !isPre(x.version));
  showMain(pypiCrumbs(n), el("h2", {}, el("span", { className: "ico" }, icon("tag")), `${pkg.name} ${n.version}`),
    el("p", { className: "reporef" }, copyValue(`${pkg.name}==${n.version}`, "Copy requirement")),
    ...(isPre(n.version) ? [el("p", { className: "hint", textContent: "A pre-release: pip installs it only when asked for this version or given --pre." })] : []),
    ...(newer.length ? [el("p", { className: "mut" }, "Newer: ", ...newer.slice(-3).reverse().flatMap((x, i) => [i ? ", " : "", link(x, x.version)]))] : []),
    stats(n.uploads.length > 1 ? `${n.uploads.length} copies` : "", "uploaded " + ago(secs(n.created)), n.downloaded ? "downloaded " + ago(secs(n.downloaded)) : "never downloaded"),
    ...(n.uploads.length > 1 ? [el("p", { className: "hint", textContent: "Several projects hold this version. The group index serves one of them, and their files can differ." })] : []),
    pypiCommandsEl({ name: pkg.name, version: n.version, project: n.uploads[0].projectId }, "Use this version"),
    ...(n.uploads.length > 1 ? copiesList(n) : [el("h3", { textContent: "Files" }), uploadSection(n.uploads[0])]));
}

// ---- PyPI live updates: a named "pypi" event on the same stream, and /api/pypi/seq while the stream is down ----------------
let pypiSyncing = null;
async function pypiSync() {
  if (!cfg.pypi) return;
  if (pypiSyncing) return pypiSyncing;
  pypiSyncing = (async () => {
    try {
      const snap = await api("/api/pypi/packages");
      const first = !pypi.loaded;
      if (!first && snap.seq === pypi.seq && snap.error === pypi.error) return;
      pypi = { ...snap, denied: false };
      if (!snap.loaded) { setTimeout(() => void pypiSync(), 2000); renderTree(); return; }
      const fresh = applyPypi(snap.packages, !first);
      if (tree.sel && /^[kv]:/.test(tree.sel) && !tree.byId.has(tree.sel)) { location.hash = "#/pypi"; return; } // the package or version is gone
      renderTree();
      if (first || fresh.size || /^(proot|[kv]:)/.test(tree.sel || "") || tree.sel === "recent") void renderPane();
    } catch (e) {
      pypi.denied = e.status === 401;
      pypi.error = e.message;
      renderTree();
    } finally { pypiSyncing = null; }
  })();
  return pypiSyncing;
}

// The sidebar's type filter: all, containers or python. Shown only when the PyPI source is on.
function drawTypes() {
  const box = $("types");
  box.hidden = !cfg.pypi;
  if (!cfg.pypi) return;
  box.replaceChildren(segmented("t-types", [["all", "All"], ["containers", "Containers"], ["python", "Python"]], "show", (c) => applyPrefs(c)));
}

loadPrefs(); applyTheme();
setWidth(prefs.sidebar, false);
for (const id of prefs.expanded) expanded.add(id);
$("prefs").onclick = () => settings();
$("help").onclick = () => helpPanel();
tree.root = { kind: "root", id: "root", name: "Registry", parent: null, kids: new Map(), sortedKids: null };
tree.byId.set("root", tree.root);
tree.proot = { kind: "proot", id: "proot", name: "PyPI", parent: null, kids: [] };
tree.byId.set("proot", tree.proot);
tree.names = [];
try { cfg = await api("/api/config"); $("reg").textContent = cfg.registry; $("ver").textContent = `v${cfg.version} · ${cfg.revision.slice(0, 7)}`; banner(notice());
  if (cfg.login) $("who").replaceChildren(...(cfg.user ? [cfg.user, " ", el("a", { href: cfg.logout, textContent: "Log out" })] : [el("a", { href: cfg.login, textContent: "Log in", className: "btn" })]));
}  catch (e) { banner(e.message, true); }
expanded.add("root");
expanded.add("proot");
drawTypes();
await sync();
await pypiSync();
addEventListener("hashchange", () => void navigate());
startLive();
startPoll();
await navigate();
