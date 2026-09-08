/* Research Vault — vanilla JS. No frameworks, no build step.
   Chrome is monochrome; colour marks status only (seed / active / parked). */

"use strict";

// ---------------------------------------------------------------- helpers

const $ = (s, r = document) => r.querySelector(s);

function el(spec, attrs = {}, ...children) {
  const [tag, ...cls] = spec.split(".");
  const n = document.createElement(tag || "div");
  if (cls.length) n.className = cls.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;         // only ever server-rendered markdown
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

const label = t => el("span.label", {}, t);
const hr = () => el("span.hr");
const grow = () => el("span.grow");

async function api(method, path, body, isForm = false) {
  const o = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) o.body = body;
    else { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
  }
  const r = await fetch(path, o);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.detail || `${method} ${path} → ${r.status}`);
  }
  return r.json();
}

function debounce(fn, ms) {
  let t;
  const w = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  w.flush = (...a) => { clearTimeout(t); fn(...a); };
  return w;
}

let toastT;
function toast(msg) {
  const n = $("#toast");
  n.textContent = msg;
  n.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => n.classList.remove("show"), 1700);
}

const DAY = 86400000;
const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
function ago(iso) {
  if (!iso) return "—";
  const d = daysSince(iso);
  if (d <= 0) return "today";
  if (d === 1) return "1d";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}
const fullDate = iso => iso ? new Date(iso).toLocaleDateString(undefined,
  { day: "2-digit", month: "short", year: "numeric" }) : "—";

const STATUSES = ["seed", "active", "parked"];
const SLABEL = { seed: "Seed", active: "Active", parked: "Parked" };
const UNFILED = "Unfiled";

/** Segmented progress: one tick per plan step, completed ticks go bright. */
function meter(done, total) {
  if (!total) return el("span.meter-none", {}, "—");
  const n = Math.min(total, 14);
  const on = Math.round((done / total) * n);
  return el("div.meter", { title: `${done} of ${total} steps complete` },
    el("div.meter-track", {}, ...Array.from({ length: n }, (_, i) => el("span.tick" + (i < on ? ".on" : "")))),
    el("span.meter-n", {}, `${done}/${total}`));
}

// ---------------------------------------------------------------- state

const state = {
  ideas: [],
  taxonomy: {},
  open: new Set(),
  q: "",
  hits: null,
  sort: localStorage.getItem("rv-sort") || "priority",
};

async function refreshIndex() {
  [state.ideas, state.taxonomy] = await Promise.all([
    api("GET", "/api/ideas"),
    api("GET", "/api/taxonomy"),
  ]);
}

const isDetail = () => (location.hash || "").startsWith("#/idea/");
const isHero = () => !isDetail() && state.open.size === 0 && !state.q;

function applyMode() {
  const shell = $("#shell");
  shell.classList.toggle("hero", isHero());
  shell.classList.toggle("work", !isHero());
}

function groupedIdeas() {
  const q = state.q.toLowerCase();
  const hits = new Set(state.hits || []);
  let list = state.ideas;
  if (q) {
    list = list.filter(i =>
      i.title.toLowerCase().includes(q) || i.subfield.toLowerCase().includes(q) ||
      i.field.toLowerCase().includes(q) || hits.has(i.slug));
  }
  const groups = new Map();
  for (const i of list) {
    const f = i.field || UNFILED;
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(i);
  }
  const cmp = {
    priority: (a, b) => a.order - b.order || a.created.localeCompare(b.created),
    subfield: (a, b) => (a.subfield || "￿").localeCompare(b.subfield || "￿") || a.title.localeCompare(b.title),
    updated: (a, b) => b.updated.localeCompare(a.updated),
    title: (a, b) => a.title.localeCompare(b.title),
    progress: (a, b) => (b.plan_total ? b.plan_done / b.plan_total : -1) - (a.plan_total ? a.plan_done / a.plan_total : -1),
  }[state.sort];
  for (const arr of groups.values()) arr.sort(cmp);
  return [...groups.entries()].sort((a, b) =>
    a[0] === UNFILED ? 1 : b[0] === UNFILED ? -1 : a[0].localeCompare(b[0]));
}

/** Return to the untouched landing state. */
function goLanding() {
  state.open.clear();
  state.q = "";
  state.hits = null;
  const box = $("#search");
  if (box) box.value = "";
  if (location.hash && location.hash !== "#/") location.hash = "#/";
  else renderHome();          // already on "#/", so no hashchange fires — render directly
}

// ---------------------------------------------------------------- home

function renderHome() {
  applyMode();
  const groups = groupedIdeas();
  const total = groups.reduce((a, g) => a + g[1].length, 0);
  const main = $("#main");
  main.replaceChildren();

  if (!isHero()) {
    const sortSel = el("select.sel.sel-quiet", {
      onchange: e => { state.sort = e.target.value; localStorage.setItem("rv-sort", state.sort); renderHome(); },
    }, ...[["priority", "Priority"], ["subfield", "Subfield"], ["updated", "Updated"],
           ["title", "Title"], ["progress", "Progress"]].map(([v, t]) => {
      const o = el("option", { value: v }, t);
      if (v === state.sort) o.selected = true;
      return o;
    }));
    main.append(el("div.listbar", {},
      el("h2", {}, state.q ? `Search: “${state.q}”` : "Ideas"),
      el("span.count", {}, `${total} of ${state.ideas.length}`),
      grow(), label("order by"), sortSel));
  } else {
    main.append(el("div.home-lead", {}, grow(),
      el("span.count.label", {}, `${state.ideas.length} total`)));
  }

  if (!groups.length) {
    main.append(el("div.blank", {},
      el("div.blank-h", {}, state.ideas.length ? "No matches" : "Vault empty"),
      state.ideas.length ? "Nothing matches that search." : "Press N to create your first idea."));
    return;
  }
  for (const [field, items] of groups) main.append(groupBlock(field, items));
}

function groupBlock(field, items) {
  const open = state.open.has(field) || !!state.q;
  const box = el("div.grp" + (open ? ".open" : ""));
  const head = el("button.grp-head", {
    onclick: () => {
      if (state.open.has(field)) state.open.delete(field); else state.open.add(field);
      renderHome();
    },
  },
    el("span.caret", {}, "▶"),
    el("span.grp-name", {}, field),
    el("span.grp-n", {}, String(items.length)));

  const body = el("div.grp-body", {},
    ...(items.length
      ? items.map((i, ix) => ideaRow(i, ix, items.length))
      : [el("div.grp-empty", {}, "No ideas in this field yet.")]));

  box.append(head, body);
  return box;
}

function ideaRow(i, ix, count) {
  const canMove = state.sort === "priority" && !state.q;
  const arrow = (dir, disabled, glyph) => el("button", {
    title: disabled ? "" : `Move ${dir}`,
    disabled: disabled || undefined,
    onclick: async e => {
      e.preventDefault(); e.stopPropagation();
      await api("POST", `/api/ideas/${i.slug}/move`, { direction: dir });
      await refreshIndex();
      renderHome();
    },
  }, glyph);

  return el("a.irow", { href: `#/idea/${i.slug}` },
    el(`span.irow-rail.bg-${i.status}`, { title: SLABEL[i.status] }),
    el("div.irow-main", {}, el("div.irow-title", {}, i.title)),
    el("div.irow-field" + (i.subfield ? "" : ".irow-none"), {}, i.subfield || "—"),
    el("div", {}, meter(i.plan_done, i.plan_total)),
    canMove
      ? el("div.prio", {}, arrow("up", ix === 0, "▲"), arrow("down", ix === count - 1, "▼"))
      : el("div"));
}

// ---------------------------------------------------------------- prose box

/**
 * Click-to-edit markdown block — same interaction as the title.
 * One box: the rendered view is replaced in place by a textarea, no toolbar and
 * no second preview pane. Autosaves while typing; blur or Esc returns to view.
 */
function proseBox({ slug, key, text0, html0, placeholder = "", small, tall, onFigure, figures = true }) {
  let value = text0;
  let editing = false;

  const ph = () => el("div.ph", {}, placeholder);
  const view = el("div.md", { html: html0 });
  if (!value.trim()) view.replaceChildren(ph());

  const box = el("div.prose-box" + (small ? ".small" : "") + (tall ? ".tall" : ""),
    { title: "Click to edit" }, view);

  const ta = el("textarea", { placeholder, spellcheck: "false" });
  const figBtn = el("button.btn.btn-sm", {
    onmousedown: e => e.preventDefault(),        // keep textarea focus when clicked
    onclick: () => {
      const fi = el("input", { type: "file", accept: "image/*,.pdf", style: "display:none" });
      fi.addEventListener("change", () => fi.files[0] && upload(fi.files[0]));
      fi.click();
    },
  }, "+ Figure");
  const foot = figures ? el("div.edit-foot", {}, figBtn) : null;

  const autosize = () => {
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight, tall ? 300 : 90) + "px";
  };

  const doSave = debounce(async () => {
    await api("PUT", `/api/ideas/${slug}/text`, { [key]: ta.value });
  }, 700);

  async function upload(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "pasted.png");
    const { markdown, filename } = await api("POST", `/api/ideas/${slug}/figures`, fd, true);
    const p = ta.selectionStart;
    ta.value = ta.value.slice(0, p) + markdown + "\n" + ta.value.slice(p);
    autosize();
    doSave();
    if (onFigure) onFigure(filename);
    toast("figure added");
  }

  function enter() {
    if (editing) return;                          // guard: never open twice
    editing = true;
    ta.value = value;
    box.classList.add("editing");
    box.removeAttribute("title");
    box.replaceChildren(...(foot ? [ta, foot] : [ta]));
    autosize();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  async function exit() {
    if (!editing) return;
    editing = false;
    doSave.flush();
    value = ta.value;
    box.classList.remove("editing");
    box.setAttribute("title", "Click to edit");
    const { html } = await api("POST", "/api/render", { text: value, slug });
    view.innerHTML = html;
    if (!value.trim()) view.replaceChildren(ph());
    box.replaceChildren(view);
  }

  box.addEventListener("click", e => {
    // Let links and images inside rendered markdown behave normally.
    if (e.target.closest("a")) return;
    enter();
  });
  ta.addEventListener("blur", exit);
  ta.addEventListener("input", () => { autosize(); doSave(); });
  ta.addEventListener("keydown", e => { if (e.key === "Escape") ta.blur(); });
  if (figures) {
    ta.addEventListener("paste", e => {
      const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith("image/"));
      if (f) { e.preventDefault(); upload(f); }
    });
    ta.addEventListener("dragover", e => e.preventDefault());
    ta.addEventListener("drop", e => {
      const f = [...(e.dataTransfer?.files || [])][0];
      if (f) { e.preventDefault(); upload(f); }
    });
  }

  box.flush = () => { if (editing) doSave.flush(); };
  return box;
}

// ---------------------------------------------------------------- detail

async function renderDetail(slug) {
  applyMode();
  let data;
  try { data = await api("GET", `/api/ideas/${slug}`); }
  catch {
    $("#main").replaceChildren(el("div.blank", {}, el("div.blank-h", {}, "Not found"), "This idea does not exist."));
    return;
  }
  const meta = data.meta;
  let figures = data.figures;

  async function patch(p) {
    const up = await api("PATCH", `/api/ideas/${slug}`, p);
    // The server echoes the whole meta, so a plain Object.assign would swap in a
    // brand-new plan array. Rendered plan rows hold references into the live one,
    // so replacing it on an unrelated patch (a link, a status, a field) would
    // silently orphan every checkbox. Keep the array identity unless we changed it.
    const livePlan = meta.plan;
    const liveLinks = meta.links;
    Object.assign(meta, up);
    if (!("plan" in p)) meta.plan = livePlan;
    if (!("links" in p)) meta.links = liveLinks;
    const ix = state.ideas.findIndex(x => x.slug === slug);
    if (ix >= 0) state.ideas[ix] = { ...up };
    return up;
  }

  // --- bar: back, dates, delete
  const bar = el("div.dbar", {},
    el("a.back", { href: "#/" }, "←", "Ideas"),
    grow(),
    el("span.meta", {}, `created ${fullDate(meta.created)}`),
    el("span.vline"),
    el("span.meta", { title: fullDate(meta.updated) }, `edited ${ago(meta.updated)}`),
    el("span.vline"),
    el("button.btn.btn-quiet.btn-sm.btn-danger", {
      onclick: async () => {
        if (!confirm(`Delete “${meta.title}”?\n\nIt moves to ideas/.trash/ — not gone forever.`)) return;
        await api("DELETE", `/api/ideas/${slug}`);
        await refreshIndex();
        location.hash = "#/";
        toast("moved to trash");
      },
    }, "Delete"));

  // --- title
  const h1 = el("h1.title", { title: "Click to edit" }, meta.title);
  h1.addEventListener("click", () => {
    const inp = el("input.title-in");
    inp.value = meta.title;
    h1.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = async () => {
      const t = inp.value.trim();
      if (t && t !== meta.title) { await patch({ title: t }); h1.textContent = t; }
      inp.replaceWith(h1);
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") inp.blur();
      if (e.key === "Escape") { inp.value = meta.title; inp.blur(); }
    });
  });

  // --- status
  const states = el("div.states");
  function renderStates() {
    states.replaceChildren(...STATUSES.map(s =>
      el("button.state-btn" + (s === meta.status ? ".on" : ""), {
        onclick: async () => { if (s !== meta.status) { await patch({ status: s }); renderStates(); } },
      }, el(`span.sw.bg-${s}`), SLABEL[s])));
  }
  renderStates();

  // --- prose blocks (unlabelled: the form says what they are)
  const onFigure = name => {
    if (!figures.includes(name)) { figures = [...figures, name].sort(); renderGallery(); }
  };
  // 1. Figures are not accepted in the description — only in the long box and notes.
  const descBox = proseBox({
    slug, key: "description", text0: data.description, html0: data.description_html,
    figures: false,
  });
  const detailBox = proseBox({
    slug, key: "detail", text0: data.detail, html0: data.detail_html,
    small: true, tall: true, onFigure,
  });

  // --- plan: an outliner. Type, Enter for the next step, Tab to nest.
  const planBox = el("div.plan");
  const planMeter = el("div.meter");

  const isTop = it => (it.level || 0) === 0;
  /** Index range [start, end) of a step plus any sub-steps it owns. */
  function blockRange(plan, ix) {
    if (!isTop(plan[ix])) return [ix, ix + 1];
    let end = ix + 1;
    while (end < plan.length && !isTop(plan[end])) end++;
    return [ix, end];
  }
  const hasChildren = (plan, ix) => blockRange(plan, ix)[1] > ix + 1;
  const normalizeLevels = plan => { if (plan.length) plan[0].level = 0; return plan; };

  function refreshMeter() {
    const tops = meta.plan.filter(isTop);
    const total = tops.length;
    const done = tops.filter(s => s.checked).length;
    planMeter.replaceChildren(total
      ? el("span", { style: "display:flex;align-items:center;gap:9px;width:100%" },
          meter(done, total), el("span.meter-n", {}, `${Math.round(100 * done / total)}%`))
      : el("span.meter-none", {}, ""));
  }
  async function savePlan() { await patch({ plan: meta.plan }); refreshMeter(); }

  let dragIx = null;
  let editIx = null;        // index currently being typed into
  let caretEnd = true;      // where to place the caret after a re-render
  let suppressBlur = false; // set while a keystroke drives its own re-render

  function renderPlan() {
    let topN = 0, subN = 0;
    const rows = meta.plan.map((item, ix) => {
      const top = isTop(item);
      if (top) { topN++; subN = 0; } else { subN++; }
      const num = top ? String(topN).padStart(2, "0") : `${String(topN).padStart(2, "0")}.${subN}`;

      const cb = el("input", { type: "checkbox" });
      cb.checked = item.checked;
      cb.addEventListener("change", async () => {
        meta.plan[ix].checked = cb.checked;
        await savePlan();
        renderPlan();
      });

      const handle = el("span.step-n", { title: "Drag to reorder" }, num);
      const row = el("div.step" + (top ? ".top" : ".sub") + (item.checked ? ".checked" : "")
        + (ix === editIx ? ".editing" : ""), {}, handle, cb);

      if (ix === editIx) {
        const inp = el("input.step-edit", { spellcheck: "false" });
        inp.value = item.text;

        const commitText = () => {
          const v = inp.value.trim();
          item.text = v;
          return v;
        };
        const rerender = async (save = true) => {
          suppressBlur = true;
          if (save) await savePlan();
          renderPlan();
        };

        inp.addEventListener("keydown", async e => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitText();
            if (!item.text) { editIx = null; await rerender(); return; }
            // Continue the list: a sibling at the same level. A step that owns
            // sub-steps gets its sibling after the whole block, not above its children.
            const at = blockRange(meta.plan, ix)[1];
            meta.plan.splice(at, 0, { text: "", checked: false, level: item.level });
            editIx = at;
            await rerender();
            return;
          }
          if (e.key === "Tab") {
            e.preventDefault();
            commitText();
            if (!e.shiftKey && top && ix > 0 && !hasChildren(meta.plan, ix)) item.level = 1;
            else if (e.shiftKey && !top) item.level = 0;
            normalizeLevels(meta.plan);
            await rerender();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            commitText();
            if (!item.text) meta.plan.splice(ix, 1);
            editIx = null;
            normalizeLevels(meta.plan);
            await rerender();
            return;
          }
          // Backspace on an empty row removes just that row. Any sub-steps it had
          // survive and re-attach to the step above — never a silent cascade delete.
          if (e.key === "Backspace" && inp.value === "") {
            e.preventDefault();
            meta.plan.splice(ix, 1);
            editIx = ix > 0 ? ix - 1 : null;
            normalizeLevels(meta.plan);
            await rerender();
            return;
          }
          if (e.key === "ArrowUp" && ix > 0) {
            e.preventDefault(); commitText(); editIx = ix - 1; await rerender();
            return;
          }
          if (e.key === "ArrowDown" && ix < meta.plan.length - 1) {
            e.preventDefault(); commitText(); editIx = ix + 1; await rerender();
            return;
          }
        });

        inp.addEventListener("blur", async () => {
          if (suppressBlur) return;
          commitText();
          if (!item.text) meta.plan.splice(ix, 1);
          editIx = null;
          normalizeLevels(meta.plan);
          await savePlan();
          renderPlan();
        });

        row.append(inp);
      } else {
        const t = el("span.step-t", { title: "Click to edit" }, item.text);
        t.addEventListener("click", () => { editIx = ix; caretEnd = true; renderPlan(); });
        row.append(t,
          el("button.del", { title: "Delete step", onclick: async () => {
            const [a, b] = blockRange(meta.plan, ix);
            meta.plan.splice(a, b - a);          // a step takes its sub-steps with it
            normalizeLevels(meta.plan);
            await savePlan(); renderPlan();
          } }, "\u00d7"));
      }

      row.draggable = false;
      handle.addEventListener("mousedown", () => { row.draggable = true; });
      handle.addEventListener("mouseup", () => { row.draggable = false; });
      row.addEventListener("dragstart", () => { dragIx = ix; row.classList.add("dragging"); });
      row.addEventListener("dragend", () => {
        dragIx = null; row.classList.remove("dragging"); row.draggable = false;
      });
      row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("over"); });
      row.addEventListener("dragleave", () => row.classList.remove("over"));
      row.addEventListener("drop", async e => {
        e.preventDefault(); row.classList.remove("over");
        if (dragIx === null || dragIx === ix) return;
        // Dragging a high-level step carries its sub-steps along as one block.
        const [a, b] = blockRange(meta.plan, dragIx);
        if (ix >= a && ix < b) return;
        const block = meta.plan.slice(a, b);
        const rest = [...meta.plan.slice(0, a), ...meta.plan.slice(b)];
        const target = ix > a ? ix - (b - a) : ix;
        rest.splice(target, 0, ...block);
        meta.plan = normalizeLevels(rest);
        await savePlan(); renderPlan();
      });
      return row;
    });

    const addLine = el("div.add-row", {
      onclick: () => {
        meta.plan.push({ text: "", checked: false, level: 0 });
        editIx = meta.plan.length - 1;
        renderPlan();
      },
    }, el("span.plus", {}, "+"), el("span.add-hint", {}, "add step"));

    planBox.replaceChildren(...rows, addLine);

    // Restore focus into the row being typed, then re-arm blur handling.
    if (editIx !== null) {
      const inp = planBox.querySelectorAll(".step-edit")[0];
      if (inp) {
        inp.focus();
        const pos = caretEnd ? inp.value.length : 0;
        inp.setSelectionRange(pos, pos);
      }
    }
    suppressBlur = false;
  }

  renderPlan(); refreshMeter();

  const planSec = el("div.sec", {},
    el("div.sec-head", {}, hr(), planMeter),
    planBox);

  // --- links & reading: two columns — the name you give it, and the link itself
  const linkList = el("div.links");
  function renderLinks() {
    const rows = meta.links.map((l, ix) =>
      el("div.link-row", {},
        el("span.link-name", { title: l.title || l.url }, l.title || l.url),
        el("a", { href: l.url, target: "_blank", rel: "noopener", title: l.url }, "Link"),
        el("button.del", { title: "Remove",
          onclick: async () => { meta.links.splice(ix, 1); await patch({ links: meta.links }); renderLinks(); } }, "\u00d7")));

    const nameIn = el("input", { placeholder: "name of the paper or resource", spellcheck: "false" });
    const urlIn = el("input.url-in", { placeholder: "paste URL", spellcheck: "false" });
    const add = async () => {
      const url = urlIn.value.trim();
      if (!url) { urlIn.focus(); return; }
      let title = nameIn.value.trim();
      if (!title) {
        // No name given — fall back to something readable rather than the raw URL.
        const ax = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/);
        if (ax) title = "arXiv:" + ax[1];
        else { try { title = new URL(url).hostname.replace(/^www\./, ""); } catch { title = url; } }
      }
      meta.links.push({ title, url });
      await patch({ links: meta.links });
      renderLinks();
      linkList.querySelector(".link-add input")?.focus();
    };
    for (const i of [nameIn, urlIn]) {
      i.addEventListener("keydown", e => { if (e.key === "Enter") add(); });
    }
    linkList.replaceChildren(
      ...(rows.length ? rows : [el("div.link-empty", {}, "")]),
      el("div.link-add", {}, nameIn, urlIn, el("span")));
  }
  renderLinks();

  // --- figures
  const gallery = el("div.gallery");
  const figSec = el("div.sec", {}, gallery);
  function renderGallery() {
    const imgs = figures.filter(f => !f.endsWith(".pdf"));
    gallery.replaceChildren(...imgs.map(f =>
      el("div.fig", { onclick: () => window.open(`/figures/${slug}/${f}`, "_blank") },
        el("img", { src: `/figures/${slug}/${f}`, alt: f, loading: "lazy" }),
        el("div.fig-cap", { title: f }, f))));
    figSec.style.display = imgs.length ? "" : "none";
  }
  renderGallery();

  // --- filing (field / subfield) — moved off the top bar, kept so an idea can
  //     still be recategorised after creation.
  const filing = el("div.filing");
  function renderFiling() {
    const mkSel = (key, opts, placeholder, newLabel, onNew) => {
      const sel = el("select.sel.sel-quiet");
      const add = (v, t, on) => { const o = el("option", { value: v }, t); if (on) o.selected = true; sel.append(o); };
      add("", placeholder, !meta[key]);
      for (const o of opts) add(o, o, o === meta[key]);
      if (meta[key] && !opts.includes(meta[key])) add(meta[key], meta[key], true);
      add("__new__", newLabel);
      sel.addEventListener("change", async () => {
        if (sel.value === "__new__") {
          const name = (prompt(newLabel.replace(/^\+\s*/, "") + ":") || "").trim();
          if (!name) { renderFiling(); return; }
          await onNew(name);
          await patch(key === "field" ? { field: name, subfield: "" } : { subfield: name });
        } else {
          await patch(key === "field" ? { field: sel.value, subfield: "" } : { subfield: sel.value });
        }
        renderFiling();
      });
      return sel;
    };
    const fSel = mkSel("field", Object.keys(state.taxonomy), "Unfiled", "+ New field…",
      async n => { state.taxonomy = await api("POST", "/api/taxonomy", { field: n }); });
    const sSel = mkSel("subfield", state.taxonomy[meta.field] || [],
      meta.field ? "No subfield" : "—", "+ New subfield…",
      async n => { state.taxonomy = await api("POST", "/api/taxonomy", { field: meta.field, subfield: n }); });
    sSel.disabled = !meta.field;
    filing.replaceChildren(fSel, el("span", { style: "color:var(--ink-3)" }, "/"), sSel);
  }
  renderFiling();

  const page = el("div", {}, bar, h1, filing, states,
    descBox, detailBox, planSec, linkList, figSec);
  page.flushAll = () => { descBox.flush(); detailBox.flush(); };
  $("#main").replaceChildren(page);
}

// ---------------------------------------------------------------- modals

function modal({ heading, body, actions }) {
  const root = $("#modal-root");
  const close = () => root.replaceChildren();
  const box = el("div.modal", {},
    el("div.modal-head", {}, label(heading)),
    el("div.modal-body", {}, ...body),
    el("div.modal-foot", {}, ...actions(close)));
  box.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  const ov = el("div.overlay", { onclick: e => { if (e.target === ov) close(); } }, box);
  root.replaceChildren(ov);
  return { close, box };
}

function openNewIdea() {
  const titleIn = el("input.txt", { placeholder: "e.g. Gaussian-splat loop closure", spellcheck: "false" });
  const fSel = el("select.sel");
  const sSel = el("select.sel");
  const stSel = el("select.sel", ...STATUSES.map(s => {
    const o = el("option", { value: s }, SLABEL[s]);
    if (s === "seed") o.selected = true;
    return o;
  }));

  const fillF = () => fSel.replaceChildren(el("option", { value: "" }, "Unfiled"),
    ...Object.keys(state.taxonomy).map(f => el("option", { value: f }, f)),
    el("option", { value: "__new__" }, "+ New field…"));
  const fillS = () => {
    const subs = state.taxonomy[fSel.value] || [];
    sSel.replaceChildren(el("option", { value: "" }, subs.length ? "No subfield" : "—"),
      ...subs.map(s => el("option", { value: s }, s)),
      fSel.value && fSel.value !== "__new__" ? el("option", { value: "__new__" }, "+ New subfield…") : null);
    sSel.disabled = !fSel.value || fSel.value === "__new__";
  };
  fSel.addEventListener("change", async () => {
    if (fSel.value === "__new__") {
      const name = (prompt("New field:") || "").trim();
      if (name) { state.taxonomy = await api("POST", "/api/taxonomy", { field: name }); fillF(); fSel.value = name; }
      else fSel.value = "";
    }
    fillS();
  });
  sSel.addEventListener("change", async () => {
    if (sSel.value !== "__new__") return;
    const name = (prompt("New subfield:") || "").trim();
    if (name) {
      state.taxonomy = await api("POST", "/api/taxonomy", { field: fSel.value, subfield: name });
      fillS(); sSel.value = name;
    } else sSel.value = "";
  });
  fillF(); fillS();

  const { close, box } = modal({
    heading: "New Idea",
    body: [
      el("div.fld", {}, label("Title"), titleIn),
      el("div.two", {},
        el("div.fld", {}, label("Field"), fSel),
        el("div.fld", {}, label("Subfield"), sSel)),
      el("div.fld", {}, label("Status"), stSel),
    ],
    actions: c => [
      el("button.btn", { onclick: c }, "Cancel"),
      el("button.btn.btn-solid", { onclick: () => create() }, "Create Idea"),
    ],
  });

  async function create() {
    const title = titleIn.value.trim();
    if (!title) { titleIn.focus(); return; }
    const m = await api("POST", "/api/ideas", {
      title,
      field: fSel.value === "__new__" ? "" : fSel.value,
      subfield: sSel.value === "__new__" ? "" : sSel.value,
      status: stSel.value,
    });
    close();
    await refreshIndex();
    location.hash = `#/idea/${m.slug}`;
    toast("idea created");
  }
  box.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.tagName === "INPUT") create(); });
  titleIn.focus();
}

function openTaxonomy() {
  const listBox = el("div.ref-list", { style: "max-height:46vh;overflow-y:auto" });
  const countFor = (f, s) => state.ideas.filter(i => i.field === f && (!s || i.subfield === s)).length;
  async function reload() { state.taxonomy = await api("GET", "/api/taxonomy"); draw(); }

  async function remove(field, subfield) {
    if (!confirm(`Remove “${subfield ? field + " / " + subfield : field}” from the taxonomy?`)) return;
    try {
      await api("DELETE", `/api/taxonomy?field=${encodeURIComponent(field)}&subfield=${encodeURIComponent(subfield || "")}`);
      await reload(); toast("removed");
    } catch (err) { alert(err.message); }
  }

  function draw() {
    const rows = [];
    for (const [f, subs] of Object.entries(state.taxonomy)) {
      rows.push(el("div.ref-row", { style: "background:var(--surface-2)" },
        el("span.rel-t", { style: "font-weight:600" }, f),
        el("span.ref-host", {}, `${countFor(f)} idea${countFor(f) === 1 ? "" : "s"}`),
        el("button.del", { style: "visibility:visible", title: "Remove field", onclick: () => remove(f, "") }, "×")));
      for (const s of subs) {
        rows.push(el("div.ref-row", {},
          el("span.ref-i", {}, "└"),
          el("span.rel-t", {}, s),
          el("span.ref-host", {}, String(countFor(f, s))),
          el("button.del", { style: "visibility:visible", title: "Remove subfield", onclick: () => remove(f, s) }, "×")));
      }
    }
    const fIn = el("input.txt", { placeholder: "New field" });
    const pick = el("select.sel", el("option", { value: "" }, "— or into —"),
      ...Object.keys(state.taxonomy).map(f => el("option", { value: f }, f)));
    const sIn = el("input.txt", { placeholder: "New subfield" });
    const addBtn = el("button.btn.btn-sm", { onclick: async () => {
      const field = fIn.value.trim() || pick.value;
      if (!field) { fIn.focus(); return; }
      try {
        await api("POST", "/api/taxonomy", { field, subfield: sIn.value.trim() });
        fIn.value = ""; sIn.value = "";
        await reload(); toast("added");
      } catch (err) { alert(err.message); }
    } }, "Add");
    for (const i of [fIn, sIn]) i.addEventListener("keydown", e => { if (e.key === "Enter") addBtn.click(); });
    listBox.replaceChildren(...rows, el("div.ref-add", { style: "flex-wrap:wrap" }, fIn, pick, sIn, addBtn));
  }
  draw();

  modal({
    heading: "Fields & Subfields",
    body: [
      el("div", { style: "font-size:12.5px;color:var(--ink-3);margin-bottom:11px" },
        "These group your ideas and fill the dropdowns. A field still used by an idea cannot be removed."),
      listBox,
    ],
    actions: c => [el("button.btn.btn-solid", { onclick: () => { c(); if (!isDetail()) renderHome(); } }, "Done")],
  });
}

function renderLegend() {
  $("#legend").replaceChildren(...STATUSES.map(s =>
    el("span.lg", {}, el(`span.sw.bg-${s}`), SLABEL[s])));
}

// ---------------------------------------------------------------- routing

function render() {
  const m = (location.hash || "#/").match(/^#\/idea\/([a-z0-9-]+)/);
  if (m) renderDetail(m[1]); else renderHome();
}

const doSearch = debounce(async q => {
  state.hits = q.length >= 2 ? (await api("GET", `/api/search?q=${encodeURIComponent(q)}`)).slugs : null;
  if (!isDetail()) renderHome();
}, 250);

function boot() {
  const savedTheme = localStorage.getItem("rv-theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("#theme-btn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("rv-theme", next);
  });

  $("#new-btn").addEventListener("click", openNewIdea);
  $("#tax-btn").addEventListener("click", openTaxonomy);
  $("#wordmark").addEventListener("click", e => { e.preventDefault(); goLanding(); });

  $("#search").addEventListener("input", e => {
    state.q = e.target.value.trim();
    if (isDetail() && state.q) location.hash = "#/";
    else if (!isDetail()) renderHome();
    doSearch(state.q);
  });

  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      const p = $("#main").firstChild;
      if (p && p.flushAll) { p.flushAll(); toast("saved"); }
      return;
    }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if (e.key === "n" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openNewIdea(); }
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    if (e.key === "Escape" && !isDetail()) goLanding();
  });

  window.addEventListener("hashchange", render);
  renderLegend();
  refreshIndex().then(render);
}

boot();
