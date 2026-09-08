"""Research Vault — FastAPI backend.

Everything is served from 127.0.0.1 only; ideas never leave the machine.
"""

import re

import markdown as md
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import storage

app = FastAPI(title="Research Vault")

STATIC_DIR = storage.ROOT / "app" / "static"

_MD_EXTENSIONS = ["extra", "sane_lists"]  # tables, fenced code, footnotes

# --- LaTeX protection -------------------------------------------------------
# Markdown would eat the innards of an equation: "$b_a$" becomes "<em>" and
# "$x^*$" loses its star. So every math span is lifted out before markdown runs
# and put back verbatim afterwards. KaTeX (client side) does the actual
# typesetting and already skips <pre>/<code>, so math inside a code fence stays
# literal. Placeholders use private-use codepoints that markdown never touches.
_PH_OPEN, _PH_CLOSE = "\ue000", "\ue001"          # maths placeholders
_CH_OPEN, _CH_CLOSE = "\ue002", "\ue003"          # code placeholders

# Code is lifted out first so a "$" inside a code span or fence is never
# mistaken for maths; it is put back before markdown runs, so it still
# formats as code.
_CODE_PATTERNS = [
    re.compile(r"```.*?```", re.S),                  # fenced block
    re.compile(r"~~~.*?~~~", re.S),
    re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)", re.S),    # inline span
]

_MATH_PATTERNS = [
    re.compile(r"\$\$.+?\$\$", re.S),            # $$ display $$
    re.compile(r"\\\[.+?\\\]", re.S),          # \[ display \]
    re.compile(r"\\\(.+?\\\)", re.S),          # \( inline \)
    # $ inline $ — must hug its content, and a trailing digit means it was
    # money ("$5 and $10"), not maths.
    re.compile(r"(?<![\\$])\$(?!\s)([^$\n]*?)(?<!\s)\$(?!\d)"),
]


def _protect_math(text: str) -> tuple[str, list[str]]:
    code: list[str] = []

    def stash_code(m: re.Match) -> str:
        code.append(m.group(0))
        return f"{_CH_OPEN}{len(code) - 1}{_CH_CLOSE}"

    for pattern in _CODE_PATTERNS:
        text = pattern.sub(stash_code, text)

    spans: list[str] = []

    def stash_math(m: re.Match) -> str:
        spans.append(m.group(0))
        return f"{_PH_OPEN}{len(spans) - 1}{_PH_CLOSE}"

    for pattern in _MATH_PATTERNS:
        text = pattern.sub(stash_math, text)

    # Put code back before markdown so it renders as code as usual.
    for i, raw in enumerate(code):
        text = text.replace(f"{_CH_OPEN}{i}{_CH_CLOSE}", raw)
    return text, spans


def _strip_delims(raw: str) -> tuple[bool, str]:
    """(is_display, tex_without_delimiters)."""
    if raw.startswith("$$") and raw.endswith("$$"):
        return True, raw[2:-2]
    if raw.startswith("\\[") and raw.endswith("\\]"):
        return True, raw[2:-2]
    if raw.startswith("\\(") and raw.endswith("\\)"):
        return False, raw[2:-2]
    return False, raw[1:-1]


def _restore_math(html: str, spans: list[str]) -> str:
    """Emit each formula as a tagged span. The server is the only thing that
    decides what counts as maths, so the client never has to guess — that is what
    keeps "$5 and $10" from being typeset as an equation."""
    for i, raw in enumerate(spans):
        display, tex = _strip_delims(raw)
        esc = (tex.replace("&", "&amp;").replace("<", "&lt;")
                  .replace(">", "&gt;").replace('"', "&quot;"))
        span = (f'<span class="tex" data-display="{1 if display else 0}" '
                f'data-tex="{esc}">{esc}</span>')
        html = html.replace(f"{_PH_OPEN}{i}{_PH_CLOSE}", span)
    return html


def render_markdown(text: str, slug: str | None = None) -> str:
    text, math_spans = _protect_math(text)
    html = md.markdown(text, extensions=_MD_EXTENSIONS)
    html = _restore_math(html, math_spans)
    if slug:
        # Relative figure refs in the .md stay portable ("figures/x.png");
        # rewrite them to the serving route only at render time.
        html = re.sub(r'src="figures/', f'src="/figures/{slug}/', html)
        html = re.sub(r'href="figures/', f'href="/figures/{slug}/', html)
    return html


class CreateIdea(BaseModel):
    title: str
    field: str = ""
    subfield: str = ""
    status: str = "seed"
    tags: list[str] = []


class TextPayload(BaseModel):
    description: str | None = None
    detail: str | None = None
    notes: str | None = None


class RenderPayload(BaseModel):
    text: str
    slug: str | None = None


class RelatedPayload(BaseModel):
    other: str


_RE_FENCE = re.compile(r"```.*?```", re.S)          # drop code blocks entirely
_RE_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")     # drop images
_RE_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")     # [text](url) -> text
# Line-leading markers only, so hyphens inside words ("sparse-view") survive.
_RE_LEAD = re.compile(r"^[ \t]*(?:[#>]+|[-*+]|\d+\.)[ \t]*", re.M)
_RE_EMPH = re.compile(r"[*`]+")                     # inline emphasis / code ticks


def _excerpt(slug: str, limit: int = 150) -> str:
    """Plain-text preview of description.md with markdown syntax stripped."""
    text = storage.read_text(slug, "description")
    if not text.strip():
        return ""
    flat = _RE_FENCE.sub(" ", text)
    flat = _RE_IMAGE.sub("", flat)
    flat = _RE_LINK.sub(r"\1", flat)
    flat = _RE_LEAD.sub("", flat)
    flat = _RE_EMPH.sub("", flat)
    flat = " ".join(flat.split())
    return flat[:limit] + ("…" if len(flat) > limit else "")


def _progress(meta: dict) -> dict:
    # Only high-level (level 0) steps count; sub-steps are detail, not milestones.
    tops = [it for it in meta["plan"] if it.get("level", 0) == 0]
    total = len(tops)
    done = sum(1 for it in tops if it["checked"])
    return {**meta, "plan_total": total, "plan_done": done,
            "excerpt": _excerpt(meta["slug"])}


@app.get("/api/ideas")
def api_list_ideas():
    return [_progress(m) for m in storage.list_ideas()]


@app.post("/api/ideas")
def api_create_idea(body: CreateIdea):
    if not body.title.strip():
        raise HTTPException(400, "title required")
    return _progress(storage.create_idea(
        body.title, body.field, body.subfield, body.status, body.tags))


@app.get("/api/ideas/{slug}")
def api_get_idea(slug: str):
    try:
        meta = storage.load_meta(slug)
    except FileNotFoundError:
        raise HTTPException(404, f"no idea: {slug}")
    figures_dir = storage.idea_dir(slug) / "figures"
    figures = sorted(p.name for p in figures_dir.iterdir()) if figures_dir.is_dir() else []
    return {
        "meta": _progress(meta),
        "figures": figures,
        **{f: storage.read_text(slug, f) for f in storage.TEXT_FIELDS},
        **{f + "_html": render_markdown(storage.read_text(slug, f), slug)
           for f in storage.TEXT_FIELDS},
    }


@app.patch("/api/ideas/{slug}")
def api_patch_idea(slug: str, patch: dict):
    try:
        return _progress(storage.update_meta(slug, patch))
    except FileNotFoundError:
        raise HTTPException(404, f"no idea: {slug}")


@app.put("/api/ideas/{slug}/text")
def api_put_text(slug: str, body: TextPayload):
    try:
        for f in storage.TEXT_FIELDS:
            value = getattr(body, f)
            if value is not None:
                storage.write_text(slug, f, value)
    except FileNotFoundError:
        raise HTTPException(404, f"no idea: {slug}")
    return {"ok": True}


@app.delete("/api/ideas/{slug}")
def api_delete_idea(slug: str):
    try:
        storage.delete_idea(slug)
    except FileNotFoundError:
        raise HTTPException(404, f"no idea: {slug}")
    return {"ok": True}


class MovePayload(BaseModel):
    direction: str


@app.post("/api/ideas/{slug}/move")
def api_move_idea(slug: str, body: MovePayload):
    try:
        return _progress(storage.move_idea(slug, body.direction))
    except FileNotFoundError:
        raise HTTPException(404, f"no idea: {slug}")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/ideas/{slug}/related")
def api_link_related(slug: str, body: RelatedPayload):
    try:
        storage.link_related(slug, body.other)
        return _progress(storage.load_meta(slug))
    except FileNotFoundError:
        raise HTTPException(404, "idea not found")


@app.delete("/api/ideas/{slug}/related/{other}")
def api_unlink_related(slug: str, other: str):
    try:
        storage.unlink_related(slug, other)
        return _progress(storage.load_meta(slug))
    except FileNotFoundError:
        raise HTTPException(404, "idea not found")


@app.post("/api/ideas/{slug}/figures")
async def api_upload_figure(slug: str, file: UploadFile = File(...)):
    data = await file.read()
    try:
        name = storage.save_figure(slug, file.filename or "figure.png", data)
    except FileNotFoundError:
        raise HTTPException(404, f"no idea: {slug}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"filename": name, "markdown": f"![{name}](figures/{name})"}


@app.get("/figures/{slug}/{filename}")
def api_get_figure(slug: str, filename: str):
    if "/" in filename or ".." in filename:
        raise HTTPException(400, "bad filename")
    path = storage.idea_dir(slug) / "figures" / filename
    if not path.exists():
        raise HTTPException(404, "figure not found")
    return FileResponse(path)


@app.post("/api/render")
def api_render(body: RenderPayload):
    return {"html": render_markdown(body.text, body.slug)}


class TaxonomyPayload(BaseModel):
    field: str
    subfield: str = ""


@app.get("/api/taxonomy")
def api_get_taxonomy():
    return storage.load_taxonomy()


@app.post("/api/taxonomy")
def api_add_taxonomy(body: TaxonomyPayload):
    try:
        return storage.add_taxonomy(body.field, body.subfield)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/taxonomy")
def api_remove_taxonomy(field: str, subfield: str = ""):
    try:
        return storage.remove_taxonomy(field, subfield)
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.get("/api/search")
def api_search(q: str = ""):
    return {"slugs": storage.search(q)}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
