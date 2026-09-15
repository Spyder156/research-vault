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

/**
 * Typeset the formulas the server tagged. Only <span class="tex"> is rendered,
 * so the client never scans loose text and never mistakes prices for maths.
 */
function typeset(node) {
  if (!node || !window.katex) return;
  for (const span of node.querySelectorAll("span.tex:not([data-done])")) {
    const tex = span.getAttribute("data-tex") || span.textContent;
    try {
      window.katex.render(tex, span, {
        displayMode: span.getAttribute("data-display") === "1",
        throwOnError: false,
      });
    } catch {
      span.classList.add("tex-error");   // leave the source visible, never blank
    }
    span.setAttribute("data-done", "1");
  }
}

/**
 * Clean text copied out of a *rendered* page (ChatGPT, Wikipedia, arXiv HTML).
 * That kind of copy carries invisible layout spacers and Unicode maths glyphs
 * instead of LaTeX. Strip the invisibles and fold the glyphs back to ASCII so
 * the text is at least readable and editable.
 */
function sanitizePaste(text) {
  let out = text
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")   // zero-width + soft hyphen
    .replace(/\u2062|\u2061|\u2063|\u2064/g, "")          // invisible times/apply/separator
    .replace(/[\u2007\u202F\u2009\u200A\u205F]/g, " ");  // exotic spaces -> plain space
  // Unicode Mathematical Alphanumeric Symbols (U+1D400–U+1D7FF) -> ASCII
  out = out.replace(/[\u{1D400}-\u{1D7FF}]/gu, ch => {
    const cp = ch.codePointAt(0);
    for (const [base, from] of [[0x41, 0x1D400], [0x61, 0x1D41A]]) {
      for (let block = 0; block < 13; block++) {
        const start = from + block * 52;
        if (cp >= start && cp < start + 26) return String.fromCharCode(base + (cp - start));
      }
    }
    if (cp >= 0x1D7CE && cp <= 0x1D7FF) return String((cp - 0x1D7CE) % 10);  // digits
    return ch;
  });
  return out.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n");
}

/**
 * Grow a textarea to fit its content WITHOUT ever collapsing it.
 *
 * The usual trick — set height:auto, read scrollHeight, set height — shrinks the
 * box for one frame. That shortens the page, the browser clamps the scroll
 * position and drags the caret to the top of the box on every keystroke. Instead
 * the text is measured in an off-screen mirror that shares the textarea's
 * typography and width, so the real box is only ever assigned its final height
 * and the page never reflows underneath the caret.
 */
let _mirror = null;
function autoGrow(ta, min) {
  const width = ta.clientWidth;
  if (!width) {                                   // not laid out yet (or headless)
    if (!ta.style.height) ta.style.height = min + "px";
    return;
  }
  if (!_mirror) {
    _mirror = document.createElement("div");
    _mirror.setAttribute("aria-hidden", "true");
    Object.assign(_mirror.style, {
      position: "absolute", top: "0", left: "-99999px", visibility: "hidden",
      whiteSpace: "pre-wrap", wordWrap: "break-word", overflowWrap: "anywhere",
      height: "auto", pointerEvents: "none",
    });
    document.body.appendChild(_mirror);
  }
  const cs = getComputedStyle(ta);
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
                      "letterSpacing", "textIndent", "paddingTop", "paddingRight",
                      "paddingBottom", "paddingLeft", "borderTopWidth",
                      "borderBottomWidth", "boxSizing", "tabSize"]) {
    _mirror.style[prop] = cs[prop];
  }
  _mirror.style.width = width + "px";
  _mirror.textContent = ta.value + "\n";          // trailing line so a final \n counts
  const needed = Math.max(_mirror.offsetHeight, min);
  if (parseFloat(ta.style.height) !== needed) ta.style.height = needed + "px";
}

/**
 * Animate a DOM mutation: measure, mutate, then play every moved node back from
 * its old position (FLIP). Gives the list a real "things slide out of the way"
 * feel instead of snapping.
 */
function flipMove(nodes, mutate) {
  const before = new Map();
  for (const n of nodes) before.set(n, n.getBoundingClientRect().top);
  mutate();
  for (const n of nodes) {
    const dy = before.get(n) - n.getBoundingClientRect().top;
    if (!dy) continue;
    n.style.transition = "none";
    n.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      n.style.transition = "transform 150ms cubic-bezier(.2,.7,.3,1)";
      n.style.transform = "";
    });
  }
}

/**
 * Pointer-driven sortable list.
 *
 * Deliberately NOT HTML5 drag-and-drop: the rows are <a> elements, and a browser
 * answers a drag on a link with its own link-drag, which silently swallows the
 * gesture. Pointer events behave identically everywhere and let the list animate.
 *
 * expects: container holds the sortable children directly.
 *   itemSel   - selector for a sortable child
 *   handleSel - selector for the grab area inside a child (optional: whole child)
 *   canDrag   - (item) => bool, to exclude pinned rows
 *   onCommit  - (orderedItems) => Promise, called once on release if order changed
 */
function sortable(container, { itemSel, handleSel, canDrag, reject, onCommit }) {
  container.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (reject && reject(e.target)) return;
    const handle = handleSel ? e.target.closest(handleSel) : e.target.closest(itemSel);
    if (!handle || !container.contains(handle)) return;
    const item = handle.closest(itemSel);
    if (!item || (canDrag && !canDrag(item))) return;

    const siblings = () => [...container.querySelectorAll(":scope > " + itemSel)];
    const startOrder = siblings().map(n => n.dataset.key);
    const rect = item.getBoundingClientRect();
    const grabDY = e.clientY - rect.top;
    let moved = false;

    // Floating copy that follows the pointer.
    const ghost = item.cloneNode(true);
    ghost.classList.add("drag-ghost");
    Object.assign(ghost.style, {
      position: "fixed", left: rect.left + "px", top: rect.top + "px",
      width: rect.width + "px", margin: "0", pointerEvents: "none", zIndex: "999",
    });

    const onMove = ev => {
      if (!moved) {
        if (Math.abs(ev.clientY - e.clientY) < 4) return;   // ignore a plain click
        moved = true;
        document.body.appendChild(ghost);
        item.classList.add("drag-src");
        document.body.classList.add("dragging-now");
      }
      ghost.style.top = (ev.clientY - grabDY) + "px";

      const others = siblings().filter(n => n !== item);
      let target = null;
      for (const n of others) {
        const r = n.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { target = n; break; }
      }
      const nodes = siblings();
      if (target !== item.nextElementSibling) {
        flipMove(nodes, () => container.insertBefore(item, target));
      }
    };

    const finish = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!moved) return;
      // pointerup is followed by a click; without this a drag would also toggle
      // the subfield open or follow the idea link.
      const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      ghost.remove();
      item.classList.remove("drag-src");
      document.body.classList.remove("dragging-now");
      const now = siblings();
      if (now.map(n => n.dataset.key).join("\u0000") === startOrder.join("\u0000")) return;
      await onCommit(now);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

/** Wrap the selection (or the caret) in markdown delimiters. */
function wrapSelection(ta, before, after = before, placeholder = "text") {
  const a = ta.selectionStart, b = ta.selectionEnd;
  const sel = ta.value.slice(a, b) || placeholder;
  ta.value = ta.value.slice(0, a) + before + sel + after + ta.value.slice(b);
  ta.focus();
  ta.setSelectionRange(a + before.length, a + before.length + sel.length);
  ta.dispatchEvent(new Event("input"));
}

/** Set (or clear) a line-leading marker such as "## " or "- " on every selected line. */
function prefixLines(ta, marker) {
  const a = ta.selectionStart, b = ta.selectionEnd;
  const start = ta.value.lastIndexOf("\n", a - 1) + 1;
  let end = ta.value.indexOf("\n", b);
  if (end === -1) end = ta.value.length;
  const block = ta.value.slice(start, end);
  const strip = l => l.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|>\s+)/, "");
  const already = marker && block.split("\n").every(l => l.startsWith(marker));
  const out = block.split("\n")
    .map(l => (already || !marker ? strip(l) : marker + strip(l)))
    .join("\n");
  ta.value = ta.value.slice(0, start) + out + ta.value.slice(end);
  ta.focus();
  ta.setSelectionRange(start, start + out.length);
  ta.dispatchEvent(new Event("input"));
}

/**
 * Continue a "- " list on Enter, the way a document editor does, and end the list
 * when you press Enter on an empty bullet.
 */
function listContinuation(ta, e) {
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return false;
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return false;
  const lineStart = ta.value.lastIndexOf("\n", pos - 1) + 1;
  const line = ta.value.slice(lineStart, pos);
  const m = line.match(/^(\s*)([-*])\s+/);
  if (!m) return false;
  e.preventDefault();
  if (line.slice(m[0].length).trim() === "") {
    // empty bullet -> drop the marker and leave the list
    ta.value = ta.value.slice(0, lineStart) + ta.value.slice(pos);
    ta.setSelectionRange(lineStart, lineStart);
  } else {
    const ins = "\n" + m[1] + m[2] + " ";
    ta.value = ta.value.slice(0, pos) + ins + ta.value.slice(pos);
    ta.setSelectionRange(pos + ins.length, pos + ins.length);
  }
  ta.dispatchEvent(new Event("input"));
  return true;
}

/** The strip of controls shown under a prose editor while it is open. */
function editorToolbar(ta) {
  const btn = (glyph, title, fn, cls = "") =>
    el("button.tb" + cls, {
      title,
      onmousedown: e => e.preventDefault(),        // keep the textarea focused
      onclick: () => fn(),
    }, glyph);

  const sizeSel = el("select.tb-size", { onmousedown: e => e.stopPropagation() },
    ...[["", "Normal"], ["# ", "Heading 1"], ["## ", "Heading 2"], ["### ", "Heading 3"]]
      .map(([v, t]) => el("option", { value: v }, t)));
  sizeSel.addEventListener("change", () => {
    prefixLines(ta, sizeSel.value);
    sizeSel.value = "";
  });

  return el("div.toolbar", {},
    sizeSel,
    el("span.tb-sep"),
    btn("B", "Bold  (Ctrl+B)", () => wrapSelection(ta, "**"), ".tb-b"),
    btn("I", "Italic  (Ctrl+I)", () => wrapSelection(ta, "*"), ".tb-i"),
    btn("U", "Underline  (Ctrl+U)", () => wrapSelection(ta, "<u>", "</u>"), ".tb-u"),
    el("span.tb-sep"),
    btn("•", "Bullet list", () => prefixLines(ta, "- ")),
    btn("❝", "Quote", () => prefixLines(ta, "> ")),
    btn("<>", "Code", () => wrapSelection(ta, "`", "`", "code")),
    btn("🔗", "Link", () => wrapSelection(ta, "[", "](url)", "label")),
    el("span.tb-sep"),
    btn("∑", "Inline formula", () => wrapSelection(ta, "$", "$", "x_i")),
    btn("∑\u2261", "Display formula", () => wrapSelection(ta, "\n$$", "$$\n", "\\frac{a}{b}")));
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
  closedSubs: new Set(),   // sub-groups are open unless explicitly collapsed
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

// Idea rater. Every axis reads "higher is better", so one slider style fits all
// and the average across them is meaningful.
const RATINGS = [
  ["creativity",  "Creativity",           "CRE", "how original the angle is"],
  ["novelty",     "Novelty",              "NOV", "how unlike existing work"],
  ["feasibility", "Feasibility",          "FEA", "can you actually pull it off"],
  ["compute",     "Compute Efficiency",   "CMP", "10 = runs on what you have"],
  ["data",        "Data Availability",    "DAT", "10 = the data already exists"],
  ["impact",      "Profile Impact",       "IMP", "what it does for your name"],
  ["money",       "Monetary Value",       "MON", "fundable or commercialisable"],
  ["venue",       "Conference Placement", "VEN", "odds at a top venue"],
  ["speed",       "Time to Result",       "SPD", "10 = a first result lands fast"],
  ["interest",    "Personal Interest",    "INT", "how much you want to do it"],
];
const RATING_LABEL = Object.fromEntries(RATINGS.map(([k, l]) => [k, l]));

/** Mean of the axes that have actually been rated, or null. */
function ratingAvg(meta) {
  const vals = RATINGS.map(([k]) => meta.ratings?.[k]).filter(v => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** Small "7.4" chip on a list row; blank when nothing is rated. */
function ratingBadge(meta) {
  const avg = ratingAvg(meta);
  if (avg === null) return el("span");
  return el("span.score", { title: "average rating" }, avg.toFixed(1));
}

const NO_SUB = "\u2014";                  // heading for ideas with no subfield

/** field -> [ [subfield, ideas], ... ]. Fields A-Z, "Unfiled" last; the
 *  no-subfield bucket sorts last inside its field. */
function groupedIdeas() {
  const q = state.q.toLowerCase();
  const hits = new Set(state.hits || []);
  let list = state.ideas;
  if (q) {
    list = list.filter(i =>
      i.title.toLowerCase().includes(q) || i.subfield.toLowerCase().includes(q) ||
      i.field.toLowerCase().includes(q) || hits.has(i.slug));
  }

  const fields = new Map();
  for (const i of list) {
    const f = i.field || UNFILED;
    const sub = i.subfield || NO_SUB;
    if (!fields.has(f)) fields.set(f, new Map());
    const subs = fields.get(f);
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub).push(i);
  }

  // Rating sorts are "rating:<key>" (or "rating:avg"); unrated sinks to the bottom.
  let cmp;
  if (state.sort.startsWith("rating:")) {
    const key = state.sort.slice(7);
    const score = i => key === "avg" ? ratingAvg(i) : (i.ratings?.[key] ?? null);
    cmp = (a, b) => {
      const x = score(a), y = score(b);
      if (x === null && y === null) return a.title.localeCompare(b.title);
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x || a.title.localeCompare(b.title);
    };
  } else {
    cmp = {
      priority: (a, b) => a.order - b.order || a.created.localeCompare(b.created),
      subfield: (a, b) => a.title.localeCompare(b.title),
      updated: (a, b) => b.updated.localeCompare(a.updated),
      title: (a, b) => a.title.localeCompare(b.title),
      progress: (a, b) => (b.plan_total ? b.plan_done / b.plan_total : -1) - (a.plan_total ? a.plan_done / a.plan_total : -1),
    }[state.sort] || ((a, b) => a.order - b.order);
  }

  const out = [];
  for (const [f, subs] of fields) {
    for (const arr of subs.values()) arr.sort(cmp);
    // Subfield order comes from the taxonomy (drag-arranged); anything not listed
    // falls in after, alphabetically. The no-subfield bucket is always last.
    const known = state.taxonomy[f] || [];
    const rank = name => {
      const ix = known.indexOf(name);
      return ix < 0 ? known.length : ix;
    };
    const subList = [...subs.entries()].sort((a, b) =>
      a[0] === NO_SUB ? 1 : b[0] === NO_SUB ? -1
        : (rank(a[0]) - rank(b[0])) || a[0].localeCompare(b[0]));
    out.push([f, subList]);
  }
  return out.sort((a, b) =>
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
  const total = groups.reduce((a, [, subs]) => a + subs.reduce((n, [, arr]) => n + arr.length, 0), 0);
  const main = $("#main");
  main.replaceChildren();

  if (!isHero()) {
    const sortSel = el("select.sel.sel-quiet", {
      onchange: e => { state.sort = e.target.value; localStorage.setItem("rv-sort", state.sort); renderHome(); },
    });
    const opt = (v, t) => {
      const o = el("option", { value: v }, t);
      if (v === state.sort) o.selected = true;
      return o;
    };
    for (const [v, t] of [["priority", "Priority"], ["subfield", "Subfield"],
                          ["updated", "Updated"], ["title", "Title"], ["progress", "Progress"]]) {
      sortSel.append(opt(v, t));
    }
    const rg = el("optgroup", { label: "Rating" }, opt("rating:avg", "Overall"));
    for (const [k, lbl] of RATINGS) rg.append(opt("rating:" + k, lbl));
    sortSel.append(rg);
    main.append(el("div.listbar", {},
      el("h2", {}, state.q ? `Search: “${state.q}”` : "Ideas"),
      el("span.count", {}, `${total} of ${state.ideas.length}`),
      grow(),
      // Managing the taxonomy belongs next to the grouped list it reorganises.
      el("button.btn.btn-quiet.btn-sm", { onclick: openTaxonomy }, "Manage fields"),
      el("span.vline"),
      label("order by"), sortSel,
      state.sort === "priority"
        ? null
        : el("span.hint-note", { title: "Switch to Priority to drag ideas into your own order" },
            "drag needs Priority")));
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
  for (const [field, subs] of groups) main.append(groupBlock(field, subs));
}

function groupBlock(field, subs) {
  const count = subs.reduce((n, [, arr]) => n + arr.length, 0);
  const open = state.open.has(field) || !!state.q;
  const box = el("div.grp" + (open ? ".open" : ""), { "data-field": field });

  const head = el("button.grp-head", {
    onclick: () => {
      if (state.open.has(field)) state.open.delete(field); else state.open.add(field);
      renderHome();
    },
  },
    el("span.caret", {}, "\u25b6"),
    el("span.grp-name", {}, field),
    el("span.grp-n", {}, String(count)));

  const body = el("div.grp-body");
  if (!count) {
    body.append(el("div.grp-empty", {}, "No ideas in this field yet."));
  } else {
    for (const [sub, items] of subs) {
      const key = field + "/" + sub;
      const subOpen = !state.closedSubs.has(key);
      const real = sub !== NO_SUB;               // the "\u2014" bucket is not a real subfield
      const subBox = el("div.sub-grp" + (subOpen ? ".open" : ""),
        { "data-key": sub, "data-real": real ? "1" : "0" });

      subBox.append(el("div.sub-head", {},
        el("button.sub-toggle", {
          onclick: () => {
            if (state.closedSubs.has(key)) state.closedSubs.delete(key);
            else state.closedSubs.add(key);
            renderHome();
          },
        },
          el("span.caret", {}, "\u25b6"),
          el("span.sub-name" + (real ? "" : ".sub-none"), {}, sub),
          el("span.grp-n", {}, String(items.length))),
        real ? el("span.grip.sub-grip", { title: "Drag to reorder this subfield" }, "\u22ee\u22ee") : null));

      const rows = el("div.sub-body");
      items.forEach((i, ix) => rows.append(ideaRow(i, ix, items)));
      subBox.append(rows);
      body.append(subBox);

      // Ideas reorder inside their own sub-group.
      if (state.sort === "priority" && !state.q) {
        sortable(rows, {
          itemSel: ".irow",
          handleSel: ".irow",            // hold anywhere on the row
          onCommit: async ordered => {
            await api("POST", "/api/ideas/reorder", { slugs: ordered.map(n => n.dataset.key) });
            await refreshIndex();
            renderHome();
          },
        });
      }
    }

    // Subfields reorder inside their field. The "\u2014" bucket stays put.
    sortable(body, {
      itemSel: ".sub-grp",
      handleSel: ".sub-head",           // hold anywhere on the header
      // Only the header grabs it; a pointer on the rows inside belongs to them.
      reject: t => !!t.closest(".sub-body"),
      canDrag: n => n.dataset.real === "1",
      onCommit: async ordered => {
        const names = ordered.filter(n => n.dataset.real === "1").map(n => n.dataset.key);
        state.taxonomy = await api("POST", "/api/taxonomy/reorder", { field, subfields: names });
        await refreshIndex();
        renderHome();
      },
    });
  }

  box.append(head, body);
  return box;
}

/** Persist the new order of one visible sub-group, then redraw. */
async function saveOrder(items) {
  await api("POST", "/api/ideas/reorder", { slugs: items.map(x => x.slug) });
  await refreshIndex();
  renderHome();
}

let dragSlug = null;

function ideaRow(i, ix, items) {
  // A search shows a partial group, so manual order would be meaningless there.
  const canMove = state.sort === "priority" && !state.q;
  const row = el("a.irow" + (canMove ? ".movable" : ""),
    { href: `#/idea/${i.slug}`, "data-key": i.slug },
    el(`span.irow-rail.bg-${i.status}`, { title: SLABEL[i.status] }),
    el("div.irow-main", {}, el("div.irow-title", {}, i.title)),
    el("div.irow-score", {}, ratingBadge(i)),
    el("div", {}, meter(i.plan_done, i.plan_total)),
    canMove ? el("span.grip", { title: "Drag to reorder" }, "\u22ee\u22ee") : el("span"));
  // Links are draggable by default. If the browser starts its own link-drag it
  // swallows the pointer stream and our reorder never sees another pointermove.
  row.draggable = false;
  return row;
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
  if (!value.trim()) view.replaceChildren(ph()); else typeset(view);

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
  const toolbar = editorToolbar(ta);
  const foot = el("div.edit-foot", {}, toolbar, figures ? figBtn : null);

  const autosize = () => autoGrow(ta, tall ? 300 : 90);

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
    if (!value.trim()) view.replaceChildren(ph()); else typeset(view);
    box.replaceChildren(view);
  }

  box.addEventListener("click", e => {
    // Let links and images inside rendered markdown behave normally.
    if (e.target.closest("a")) return;
    enter();
  });
  ta.addEventListener("blur", exit);
  ta.addEventListener("input", () => { autosize(); doSave(); });
  ta.addEventListener("keydown", e => {
    if (e.key === "Escape") { ta.blur(); return; }
    if (listContinuation(ta, e)) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); wrapSelection(ta, "**"); }
      else if (k === "i") { e.preventDefault(); wrapSelection(ta, "*"); }
      else if (k === "u") { e.preventDefault(); wrapSelection(ta, "<u>", "</u>"); }
    }
  });
  // Text pastes get cleaned; image pastes become figures.
  ta.addEventListener("paste", e => {
    const raw = e.clipboardData?.getData("text/plain");
    if (!raw) return;
    const clean = sanitizePaste(raw);
    if (clean === raw) return;                 // nothing to fix, let the browser do it
    e.preventDefault();
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.value = ta.value.slice(0, a) + clean + ta.value.slice(b);
    ta.setSelectionRange(a + clean.length, a + clean.length);
    ta.dispatchEvent(new Event("input"));
    toast("pasted text cleaned");
  });

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

  // --- plan: each high-level point is a small document you type into.
  //     One point per block; lines beginning "- " become its sub-points; a line
  //     without "- " starts a new point of its own.
  const planBox = el("div.plan");
  const planMeter = el("div.meter");

  const isTop = it => (it.level || 0) === 0;

  /** Group the flat plan into blocks: one high-level point plus its sub-points. */
  function planBlocks() {
    const blocks = [];
    meta.plan.forEach((it, ix) => {
      if (isTop(it) || !blocks.length) blocks.push({ start: ix, end: ix + 1, items: [it] });
      else { const b = blocks[blocks.length - 1]; b.items.push(it); b.end = ix + 1; }
    });
    return blocks;
  }

  /** Block -> the text you edit. First line is the point, "- " lines are sub-points. */
  const blockToText = b =>
    b.items.map((it, i) => (i === 0 || isTop(it) ? it.text : "- " + it.text)).join("\n");

  /** The text you typed -> plan items, preserving tick state for unchanged lines. */
  function textToItems(text, previous) {
    const items = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const bullet = line.match(/^[-*\u2022]\s+(.*)$/);
      if (bullet && items.length) items.push({ text: bullet[1].trim(), checked: false, level: 1 });
      else items.push({ text: line.replace(/^[-*\u2022]\s+/, ""), checked: false, level: 0 });
    }
    if (items.length) items[0].level = 0;
    // Carry over ticks (and ids) for lines whose wording did not change.
    const pool = [...previous];
    for (const it of items) {
      const j = pool.findIndex(o => o.text === it.text && (o.level || 0) === it.level);
      if (j >= 0) { it.checked = pool[j].checked; it.id = pool[j].id; pool.splice(j, 1); }
    }
    return items.filter(it => it.text);
  }

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

  let editBlock = null;   // index of the block currently open for editing
  let dragBlock = null;

  function renderPlan() {
    const blocks = planBlocks();
    planBox.replaceChildren();

    blocks.forEach((b, bi) => {
      if (bi === editBlock) { planBox.append(blockEditor(b, bi)); return; }

      const main = b.items[0];
      const num = el("span.step-n", { title: "Drag to reorder" },
        String(bi + 1).padStart(2, "0"));

      const cbMain = el("input.cb-main", { type: "checkbox" });
      cbMain.checked = main.checked;
      cbMain.addEventListener("change", async () => {
        meta.plan[b.start].checked = cbMain.checked;
        await savePlan(); renderPlan();
      });

      const text = el("span.step-t", { title: "Click to edit this point" }, main.text);
      text.addEventListener("click", () => { editBlock = bi; renderPlan(); });

      const row = el("div.step.top" + (main.checked ? ".checked" : ""), {},
        num, cbMain, text,
        el("button.del", { title: "Delete this point and its sub-points",
          onclick: async () => {
            meta.plan.splice(b.start, b.end - b.start);
            await savePlan(); renderPlan();
          } }, "\u00d7"));

      // Drag moves the whole block, handle-only so clicks still reach the checkbox.
      row.draggable = false;
      num.addEventListener("mousedown", () => { row.draggable = true; });
      num.addEventListener("mouseup", () => { row.draggable = false; });
      row.addEventListener("dragstart", () => { dragBlock = bi; row.classList.add("dragging"); });
      row.addEventListener("dragend", () => {
        dragBlock = null; row.classList.remove("dragging"); row.draggable = false;
      });
      row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("over"); });
      row.addEventListener("dragleave", () => row.classList.remove("over"));
      row.addEventListener("drop", async e => {
        e.preventDefault(); row.classList.remove("over");
        if (dragBlock === null || dragBlock === bi) return;
        const src = blocks[dragBlock];
        const moved = meta.plan.slice(src.start, src.end);
        const rest = [...meta.plan.slice(0, src.start), ...meta.plan.slice(src.end)];
        const target = blocks[bi];
        const at = target.start > src.start ? target.start - moved.length : target.start;
        rest.splice(at, 0, ...moved);
        meta.plan = rest;
        await savePlan(); renderPlan();
      });

      planBox.append(row);

      b.items.slice(1).forEach((sub, si) => {
        const cbSub = el("input.cb-sub", { type: "checkbox" });
        cbSub.checked = sub.checked;
        cbSub.addEventListener("change", async () => {
          meta.plan[b.start + 1 + si].checked = cbSub.checked;
          await savePlan(); renderPlan();
        });
        const st = el("span.step-t", { title: "Click to edit this point" }, sub.text);
        st.addEventListener("click", () => { editBlock = bi; renderPlan(); });
        planBox.append(el("div.step.sub" + (sub.checked ? ".checked" : ""), {},
          el("span.step-n"), cbSub, st));
      });
    });

    planBox.append(el("div.add-row", {
      onclick: () => {
        meta.plan.push({ text: "", checked: false, level: 0 });
        editBlock = planBlocks().length - 1;
        renderPlan();
      },
    }, el("span.plus", {}, "+"), el("span.add-hint", {}, "add point")));
  }

  /** The textarea that stands in for one block while you edit it. */
  function blockEditor(b, bi) {
    const ta = el("textarea.block-in", { spellcheck: "false" });
    ta.value = blockToText(b);

    const fit = () => autoGrow(ta, 52);

    let done = false;
    async function commit() {
      if (done) return;
      done = true;
      const items = textToItems(ta.value, b.items);
      meta.plan.splice(b.start, b.end - b.start, ...items);
      editBlock = null;
      await savePlan();
      renderPlan();
    }

    ta.addEventListener("input", fit);
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); ta.blur(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); ta.blur(); return; }
      if (listContinuation(ta, e)) { fit(); return; }
    });

    const wrap = el("div.block-edit", {}, el("span.step-n", {}, String(bi + 1).padStart(2, "0")), ta);
    setTimeout(() => {
      fit();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
    return wrap;
  }

  renderPlan(); refreshMeter();

  const planSec = el("div.sec", {},
    el("div.sec-head", {}, hr(), planMeter),
    planBox);

  // --- rater: ten horizontal 1-10 sliders, full names, bottom-right of the page
  const raterBox = el("div.rater");
  const raterAvg = el("span.rater-avg");

  function renderRater() {
    raterBox.replaceChildren(...RATINGS.map(([key, lbl, , hint]) => {
      const rated = typeof meta.ratings[key] === "number";
      const val = rated ? meta.ratings[key] : 5;

      const num = el("span.rate-val" + (rated ? "" : ".unrated"), {}, rated ? String(val) : "\u2013");
      const slider = el("input.rate-slider" + (rated ? "" : ".unrated"), {
        type: "range", min: "1", max: "10", step: "1", title: hint, "aria-label": lbl,
      });
      slider.value = String(val);
      const paint = v => slider.style.setProperty("--fill", ((v - 1) / 9 * 100) + "%");
      paint(val);

      const commit = debounce(async () => {
        await patch({ ratings: meta.ratings });
        const ix = state.ideas.findIndex(x => x.slug === slug);
        if (ix >= 0) state.ideas[ix].ratings = { ...meta.ratings };
      }, 350);

      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        meta.ratings[key] = v;
        num.textContent = String(v);
        num.classList.remove("unrated");
        slider.classList.remove("unrated");
        paint(v);
        updateAvg();
        commit();
      });

      const clear = el("button.rate-clear", {
        title: "Clear this rating",
        onclick: async () => {
          if (typeof meta.ratings[key] !== "number") return;
          delete meta.ratings[key];
          await patch({ ratings: meta.ratings });
          renderRater();
        },
      }, rated ? "\u00d7" : "");

      return el("div.rate-row", {},
        el("span.rate-label", { title: hint }, lbl),
        slider, num, clear);
    }));
    updateAvg();
  }

  function updateAvg() {
    const avg = ratingAvg(meta);
    raterAvg.textContent = avg === null ? "unrated" : avg.toFixed(1);
    raterAvg.classList.toggle("unrated", avg === null);
  }
  renderRater();

  const raterSec = el("div.rater-wrap", {},
    el("div.rater-card", {},
      el("div.rater-head", {}, label("Rating"), grow(), raterAvg),
      raterBox));

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
    descBox, detailBox, planSec, linkList, figSec, raterSec);
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
  const titleIn = el("input.txt", { placeholder: "Short, specific title", spellcheck: "false" });
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
  const listBox = el("div.tax");
  const countFor = (f, sub) =>
    state.ideas.filter(i => i.field === f && (!sub || i.subfield === sub)).length;

  async function reload() {
    state.taxonomy = await api("GET", "/api/taxonomy");
    draw();
    if (!isDetail()) renderHome();
  }

  async function remove(field, sub) {
    const what = sub ? `${field} / ${sub}` : field;
    if (!confirm(`Remove “${what}”?`)) return;
    try {
      await api("DELETE",
        `/api/taxonomy?field=${encodeURIComponent(field)}&subfield=${encodeURIComponent(sub || "")}`);
      await reload();
      toast("removed");
    } catch (err) { alert(err.message); }
  }

  async function add(field, sub) {
    try {
      await api("POST", "/api/taxonomy", { field, subfield: sub || "" });
      await reload();
      toast(sub ? "subfield added" : "field added");
      return true;
    } catch (err) { alert(err.message); return false; }
  }

  function draw() {
    listBox.replaceChildren();

    for (const [field, subs] of Object.entries(state.taxonomy)) {
      const block = el("div.tax-field");

      block.append(el("div.tax-field-head", {},
        el("span.tax-name", {}, field),
        el("span.tax-count", {}, `${countFor(field)} idea${countFor(field) === 1 ? "" : "s"}`),
        el("button.del", { title: `Remove ${field}`, onclick: () => remove(field, "") }, "\u00d7")));

      for (const sub of subs) {
        block.append(el("div.tax-sub", {},
          el("span.tax-sub-name", {}, sub),
          el("span.tax-count", {}, String(countFor(field, sub))),
          el("button.del", { title: `Remove ${sub}`, onclick: () => remove(field, sub) }, "\u00d7")));
      }

      // Each field carries its own "add a subfield here" line — no picker needed.
      const subIn = el("input.txt.tax-in", { placeholder: `add a subfield to ${field}` });
      subIn.addEventListener("keydown", async e => {
        if (e.key !== "Enter") return;
        const v = subIn.value.trim();
        if (!v) return;
        subIn.value = "";
        await add(field, v);
      });
      block.append(el("div.tax-add", {}, el("span.plus", {}, "+"), subIn));
      listBox.append(block);
    }

    // One clearly separate control for a brand-new field.
    const fieldIn = el("input.txt.tax-in", { placeholder: "add a new field" });
    fieldIn.addEventListener("keydown", async e => {
      if (e.key !== "Enter") return;
      const v = fieldIn.value.trim();
      if (!v) return;
      fieldIn.value = "";
      await add(v, "");
    });
    listBox.append(el("div.tax-newfield", {}, el("span.plus", {}, "+"), fieldIn));
  }
  draw();

  modal({
    heading: "Fields & Subfields",
    body: [
      el("div.tax-note", {},
        "Fields group your ideas; subfields group them again inside a field. ",
        "A field or subfield still in use cannot be removed."),
      listBox,
    ],
    actions: c => [el("button.btn.btn-solid", { onclick: c }, "Done")],
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
