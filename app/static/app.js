"use strict";
// All data is rendered with textContent, never innerHTML, so registry names cannot inject markup.
const $ = (id) => document.getElementById(id);
let cfg = {};

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props || {});
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
}
const short = (d) => (d || "").slice(0, 19);
const size = (n) => (n == null ? "" : n < 1048576 ? (n / 1024).toFixed(1) + " KiB" : (n / 1048576).toFixed(1) + " MiB");
const code = (t) => el("code", { textContent: t });

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

// One dialog for every action. fields: [{name, label, value}]. Resolves to the values, or null on cancel.
function ask(title, lines, fields, danger) {
  const form = $("form");
  form.replaceChildren(el("h3", { textContent: title }), ...lines.map((l) => el("p", { textContent: l })));
  fields.forEach((f) => form.append(el("label", {}, f.label, el("input", f.type === "checkbox" ? { type: "checkbox", name: f.name, checked: true } : { type: "text", name: f.name, value: f.value, required: true }))));
  const ok = el("button", { textContent: "Confirm", value: "ok", className: danger ? "danger" : "" });
  form.append(el("menu", {}, el("button", { textContent: "Cancel", value: "cancel" }), ok));
  return new Promise((resolve) => {
    $("dlg").onclose = () => {
      const v = Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? form[f.name].checked : form[f.name].value]));
      resolve($("dlg").returnValue === "ok" ? v : null);
    };
    $("dlg").showModal();
  });
}

async function run(job, done) {
  try { banner(""); await job(); await done(); } catch (e) { banner(e.message, true); }
}

async function catalog() {
  const repos = await api("/api/repos");
  $("main").replaceChildren(el("h2", { textContent: "Repositories" }),
    repos.length ? el("table", {}, ...repos.map((r) => el("tr", {}, el("td", {}, el("a", { href: "#/r/" + r, textContent: r }))))) : el("p", { className: "mut", textContent: "The catalog is empty." }));
}

async function tags(repo) {
  const rows = await api("/api/tags?repo=" + encodeURIComponent(repo));
  $("main").replaceChildren(el("h2", {}, el("a", { href: "#/", textContent: "Repositories" }), " / " + repo),
    el("table", {}, el("tr", {}, ...["Tag", "Digest", ""].map((h) => el("th", { textContent: h }))),
      ...rows.map((t) => el("tr", {},
        el("td", {}, el("a", { href: `#/m/${repo}@${t.tag}`, textContent: t.tag })),
        el("td", {}, code(short(t.digest))),
        el("td", {}, actions(repo, t.tag, t.digest, rows.filter((x) => x.digest === t.digest).map((x) => x.tag)))))));
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
      [{ name: "children", type: "checkbox", label: "Also delete index children that no other tag uses " }], true);
    if (v) await run(() => api("/api/delete", { repo, digest, children: v.children }), () => (location.hash = "#/r/" + repo));
  };
  const b = (text, fn, cls) => el("button", { textContent: text, className: cls || "", onclick: fn });
  const off = cfg.readonly;
  return el("span", {}, ...(off ? [] : [b("Copy", copy(false)), " ", b("Move", copy(true)), " ", b("Delete", del, "danger")]));
}

async function manifest(repo, ref) {
  const m = await api(`/api/manifest?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`);
  const row = (k, v) => el("tr", {}, el("th", { textContent: k }), el("td", {}, v));
  const rows = [row("Digest", code(m.digest)), row("Media type", code(m.mediaType)), row("Manifest size", size(m.size)),
    row("Tags", m.tags.join(", ") || "none")];
  if (m.platform) rows.push(row("Platform", `${m.platform.os}/${m.platform.architecture}`));
  if (m.config) rows.push(row("Config", code(m.config)));
  const sub = (title, head, items) => items.length ? [el("h3", { textContent: title }), el("table", {}, el("tr", {}, ...head.map((h) => el("th", { textContent: h }))), ...items)] : [];
  $("main").replaceChildren(el("h2", {}, el("a", { href: "#/", textContent: "Repositories" }), " / ", el("a", { href: "#/r/" + repo, textContent: repo }), ` : ${ref}`),
    el("table", {}, ...rows), el("p", {}, actions(repo, ref, m.digest, m.tags)),
    ...sub("Platforms", ["Platform", "Digest", "Size"], m.platforms.map((p) => el("tr", {},
      el("td", { textContent: [p.os, p.architecture, p.variant].filter(Boolean).join("/") }),
      el("td", {}, el("a", { href: `#/m/${repo}@${p.digest}`, textContent: short(p.digest) })), el("td", { textContent: size(p.size) })))),
    ...sub("Layers", ["Digest", "Size"], m.layers.map((l) => el("tr", {}, el("td", {}, code(l.digest)), el("td", { textContent: size(l.size) })))));
}

async function route() {
  const h = decodeURIComponent(location.hash.slice(1)) || "/";
  try {
    banner(cfg.readonly ? "Read-only mode." : cfg.deleteEnabled ? "" : "Deletion is disabled on this registry (REGISTRY_STORAGE_DELETE_ENABLED is not true). Move and Delete will fail.");
    if (h.startsWith("/m/")) { const [r, ref] = h.slice(3).split("@"); await manifest(r, ref); }
    else if (h.startsWith("/r/")) await tags(h.slice(3));
    else await catalog();
  } catch (e) { banner(e.message, true); }
}

(async () => {
  try { cfg = await api("/api/config"); $("reg").textContent = cfg.registry; } catch (e) { banner(e.message, true); }
  addEventListener("hashchange", route);
  route();
})();
