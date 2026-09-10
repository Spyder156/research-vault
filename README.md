# Research Vault

A local-first app for collecting and developing research ideas. The app code lives in this
repo; **your ideas live in an `ideas/` folder beside it that is gitignored and never leaves
your machine.**

## How it works

**Landing.** The app opens on a quiet page: the wordmark centred, New Idea beneath it, and
your ideas listed as **collapsed field groups** — nothing opened, nothing demanding
attention. Expand a field (or search) and the wordmark parks itself top-left as a header
bar while the working view takes over. Clicking the wordmark returns you to the landing
state; so does `Esc`.

**Grouping.** Ideas are grouped by field, never by subfield. Within a group you choose the
order: **Priority** (manual — hover a row for ▲▼ arrows), Subfield, Updated, Title, or
Progress. Priority ranks are per-field, so reordering inside CV never disturbs Robotics.

**Idea page.** Title, a three-state status control, then four unlabelled blocks in order:
a short description, a large long-form box, the Plan, and a notes scratchpad — followed by
Links & Reading and a figures gallery. The sections carry no headings; their shape tells
you what they are.

**The Plan is written, not assembled.** Click a point (or the `+` line) and it opens as a
small text box. The first line is the point itself; lines starting with `- ` become its
sub-points, and pressing `Enter` after one continues the list automatically. A line
*without* `- ` starts a new point of its own, so you can type a whole roadmap in one go and
it splits itself up when you leave the box (`Esc` or `Ctrl+Enter` also close it).

Out of the box it becomes a checklist: a **big square checkbox** for each point, a **small
round one** for each sub-point. **Only the points count toward the progress bar** —
sub-points are working detail. Ticks survive re-editing: any line whose wording you did not
change keeps its state. Each point is edited on its own, and dragging one by its number
carries its sub-points along.

**Links & Reading** is a two-column table: the name you give a paper on the left, and a
short `Link` on the right that carries the full URL.

## LaTeX

Maths is written in LaTeX and typeset by KaTeX, which is vendored under
`app/static/vendor/katex` — so it works with no network and no CDN.

- `$...$` inline, `$$...$$` for a display block; `\(...\)` and `\[...\]` also work.
- Formulas are identified **on the server**, before markdown runs, so `$b_a$` keeps its
  subscript instead of turning into italics, and prices like `$5 and $10` stay as text.
- Anything inside backticks or a fenced block is left literal — `` `$x_i$` `` renders as code.
- A wide equation scrolls inside its own strip rather than stretching the box.
- A formula KaTeX cannot parse stays visible as its source instead of vanishing.

**Paste the source, not the rendered page.** Copying equations out of a rendered page (a
chat answer, a docs site) yields Unicode maths glyphs and invisible spacers rather than
LaTeX — every formula arrives duplicated and unusable. Use the source/copy button instead.
Pasting into a prose box strips the invisible characters and folds those glyphs back to
ASCII, which makes such a paste readable, but it cannot reconstruct the LaTeX.

**Everything is click-to-edit.** Click any text — the title, a plan point, or a prose block —
and it becomes editable in place. There are no Edit buttons and no side-by-side preview:
one box, which autosaves as you type and renders back to markdown on blur or `Esc`. Prose
boxes carry a formatting strip while open (heading size, **bold**, *italic*, underline,
lists, quote, code, link, formula) with `Ctrl+B` / `Ctrl+I` / `Ctrl+U` shortcuts. Paste
or drag an image into the long box or the notes and it is stored in that idea's `figures/`.
The short description takes text only — no figures.

Field and subfield are set when you create an idea, and can be changed from the two
dropdowns at the very bottom of the idea page.

Nothing on any page uses the hand cursor, and hover states are instant — the only animation
in the app is the wordmark moving between the landing and working layouts.

## Status

Three states, and nothing else — an idea is either waiting, being worked on, or shelved.

| Status | Light | Dark | Meaning |
| --- | --- | --- | --- |
| Seed | `#8f8b82` | `#8a857c` | captured, not started |
| Active | `#27703c` | `#4fa96a` | being worked on |
| Parked | `#de6a60` | `#a4514a` | deliberately shelved |

Green and red are the classic colourblind collision, so they are separated by **lightness
as well as hue**, and each theme gets its own steps (the prominent one is dark on the light
theme and light on the dark theme, so Active always reads as the loud one). Both sets pass
all-pairs CVD separation — worst pair ΔE 8.4 light / 12.0 dark against a ≥ 8 target, with
normal-vision ΔE 28.6 / 24.7.

Everything else in the interface is monochrome warm-neutral. Colour means status; nothing
else earns it.

## Storage format

No database. One folder per idea — human-readable forever:

```
ideas/
├── taxonomy.json          # the field → subfield lists behind the dropdowns
└── <slug>/
    ├── meta.json          # title, field, status, order, plan, links
    ├── description.md     # the short version
    ├── detail.md          # the long-form box
    ├── notes.md           # scratchpad (kept on disk; not shown in the current UI)
    └── figures/
```

Writes are atomic (temp file + rename). Deleting an idea moves it to `ideas/.trash/`; it is
never destroyed. A field still used by an idea cannot be removed from the taxonomy. Older
files using the retired `exploring` / `done` statuses migrate forward automatically
(`exploring → active`, `done → parked`).

## Run

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python run.py            # serve here, open the browser
```

Other forms:

```bash
./.venv/bin/python run.py --background   # detach; logs to logs/server.log
./.venv/bin/python run.py --stop         # stop the running server
./.venv/bin/python run.py --port 7788    # a different port
```

Bound to `127.0.0.1` only — nothing is exposed to the network.

**Everything the app writes stays in this folder**: `ideas/` for your notes, `logs/` for
server output. Both are gitignored, so nothing personal is ever committed and nothing is
scattered outside the repo.

## Keyboard

| Key | Action |
| --- | --- |
| `N` | New idea |
| `/` | Focus search |
| `Esc` | Collapse everything, back to the landing state |
| `Ctrl+S` | Flush saves (everything autosaves anyway) |
