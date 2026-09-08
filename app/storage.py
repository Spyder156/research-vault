"""File-based storage layer for Research Vault.

Layout (one folder per idea, IDEAS_DIR lives beside app/ and is gitignored):
    ideas/<slug>/
        meta.json        # structured state: title, field, status, plan, links, related
        description.md   # short prose, may reference images as figures/<name>
        detail.md        # long-form elaboration
        notes.md         # freeform notepad
        figures/         # uploaded images
Deleted ideas are moved to ideas/.trash/<slug>-<timestamp>, never removed.
"""

import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

# FastAPI runs sync endpoints in a threadpool, so two requests genuinely overlap.
# Every read-modify-write of a meta.json goes through this lock: without it an
# autosaving prose block (which re-saves meta just to bump "updated") can clobber
# a plan or status change made a moment earlier — a silent lost update.
_LOCK = threading.RLock()


def _locked(fn):
    def wrapper(*args, **kwargs):
        with _LOCK:
            return fn(*args, **kwargs)
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


# ROOT: research-vault/ (parent of app/). Ideas live beside the code, not inside it.
ROOT = Path(__file__).resolve().parent.parent
IDEAS_DIR = ROOT / "ideas"
TRASH_DIR = IDEAS_DIR / ".trash"
TAXONOMY_PATH = IDEAS_DIR / "taxonomy.json"

STATUSES = ["seed", "active", "parked"]

# Per-idea markdown files. "detail" is the long-form box under the description.
TEXT_FIELDS = ("description", "detail", "notes")
# Retired statuses map forward so older meta.json files keep their meaning.
STATUS_MIGRATE = {"exploring": "active", "done": "parked"}

# Seeded on first run; the user edits it from the UI (or by hand — it is plain JSON).
DEFAULT_TAXONOMY = {
    "CV": ["SLAM", "Gaussian Splatting", "3D Reconstruction", "Detection",
           "Segmentation", "Optical Flow", "Place Recognition"],
    "Robotics": ["VLMs", "3D Perception", "Manipulation", "Navigation",
                 "Control", "Sim2Real"],
    "ML": ["Representation Learning", "Self-Supervised", "Optimization", "Architectures"],
    "Other": [],
}

# expects/returns: all timestamps are local-time ISO-8601 strings "YYYY-MM-DDTHH:MM:SS"
def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def slugify(title: str) -> str:
    s = title.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "idea"


def unique_slug(title: str) -> str:
    base = slugify(title)
    slug, n = base, 2
    while (IDEAS_DIR / slug).exists():
        slug = f"{base}-{n}"
        n += 1
    return slug


def idea_dir(slug: str) -> Path:
    # Reject path tricks: slug must be a single sanitized path segment.
    if slug != slugify(slug) and not re.fullmatch(r"[a-z0-9-]+", slug):
        raise ValueError(f"bad slug: {slug!r}")
    return IDEAS_DIR / slug


def _atomic_write(path: Path, data: str) -> None:
    # Write to a temp file in the same dir, then rename: a crash never leaves a
    # half-written file. The temp name carries a unique suffix so two concurrent
    # writers can never share (and steal) one another's temp file.
    tmp = path.with_suffix(f"{path.suffix}.{os.getpid()}-{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _default_meta(slug: str, title: str) -> dict:
    ts = now_iso()
    return {
        "slug": slug,
        "title": title,
        "field": "",          # e.g. "CV", "Robotics" — free-form, user-defined
        "subfield": "",       # e.g. "SLAM", "GS", "VLMs"
        "tags": [],
        "status": "seed",
        "order": 0,           # manual priority rank; lower sorts first within its field
        "created": ts,
        "updated": ts,
        # Flat list, display order. "level" 0 = high-level step, 1 = sub-step of the
        # nearest level-0 item above it. Only level 0 counts toward progress.
        "plan": [],           # [{"id": str, "text": str, "checked": bool, "level": 0|1}]
        "links": [],          # [{"title": str, "url": str}]
        "related": [],        # [slug] — kept symmetric by link/unlink helpers
    }


def _normalize_meta(slug: str, meta: dict) -> dict:
    """Fill any missing keys so old files keep working after schema additions."""
    base = _default_meta(slug, meta.get("title", slug))
    base.update(meta)
    base["slug"] = slug
    base["status"] = STATUS_MIGRATE.get(base["status"], base["status"])
    if base["status"] not in STATUSES:
        base["status"] = "seed"
    try:
        base["order"] = int(base["order"])
    except (TypeError, ValueError):
        base["order"] = 0
    for item in base["plan"]:
        item.setdefault("id", uuid.uuid4().hex[:8])
        item.setdefault("text", "")
        item.setdefault("checked", False)
        try:
            item["level"] = 1 if int(item.get("level", 0)) == 1 else 0
        except (TypeError, ValueError):
            item["level"] = 0
    # A sub-step needs something to sit under, so the first item is always top level.
    if base["plan"]:
        base["plan"][0]["level"] = 0
    return base


def load_meta(slug: str) -> dict:
    path = idea_dir(slug) / "meta.json"
    if not path.exists():
        raise FileNotFoundError(slug)
    return _normalize_meta(slug, json.loads(path.read_text(encoding="utf-8")))


def save_meta(slug: str, meta: dict) -> None:
    _atomic_write(idea_dir(slug) / "meta.json", json.dumps(meta, indent=2, ensure_ascii=False))


def list_ideas() -> list[dict]:
    IDEAS_DIR.mkdir(exist_ok=True)
    out = []
    for d in sorted(IDEAS_DIR.iterdir()):
        if d.is_dir() and not d.name.startswith(".") and (d / "meta.json").exists():
            try:
                out.append(load_meta(d.name))
            except (json.JSONDecodeError, ValueError):
                # A hand-edited broken meta.json should not take the whole app down.
                continue
    return out


@_locked
def create_idea(title: str, field: str = "", subfield: str = "", status: str = "seed",
                tags: list[str] | None = None) -> dict:
    IDEAS_DIR.mkdir(exist_ok=True)
    existing = list_ideas()
    slug = unique_slug(title)
    d = idea_dir(slug)
    (d / "figures").mkdir(parents=True)
    meta = _default_meta(slug, title.strip())
    # New ideas land at the bottom of the manual priority order.
    meta["order"] = max((m["order"] for m in existing), default=0) + 1
    meta["field"] = field.strip()
    meta["subfield"] = subfield.strip()
    meta["status"] = status if status in STATUSES else "seed"
    meta["tags"] = tags or []
    save_meta(slug, meta)
    for f in TEXT_FIELDS:
        _atomic_write(d / f"{f}.md", "")
    return meta


# Fields the client may PATCH directly. 'related' is excluded: it is kept
# symmetric across ideas and must go through link_related/unlink_related.
_PATCHABLE = {"title", "field", "subfield", "tags", "status", "plan", "links", "order"}


@_locked
def update_meta(slug: str, patch: dict) -> dict:
    meta = load_meta(slug)
    for key, value in patch.items():
        if key not in _PATCHABLE:
            continue
        if key == "status" and value not in STATUSES:
            continue
        if key == "plan":
            value = [
                {"id": it.get("id") or uuid.uuid4().hex[:8],
                 "text": str(it.get("text", "")),
                 "checked": bool(it.get("checked", False)),
                 "level": 1 if it.get("level") == 1 else 0}
                for it in value
            ]
            if value:
                value[0]["level"] = 0
        meta[key] = value
    meta["updated"] = now_iso()
    save_meta(slug, meta)
    return meta


@_locked
def move_idea(slug: str, direction: str) -> dict:
    """Swap this idea's priority rank with its neighbour *inside its own field group*.

    Grouping is by field, so 'up' means 'above the idea directly above it in the
    same field', not globally. Returns the updated meta.
    """
    if direction not in ("up", "down"):
        raise ValueError("direction must be 'up' or 'down'")
    meta = load_meta(slug)
    siblings = sorted(
        (m for m in list_ideas() if m["field"] == meta["field"]),
        key=lambda m: (m["order"], m["created"]),
    )
    ix = next(i for i, m in enumerate(siblings) if m["slug"] == slug)
    swap_ix = ix - 1 if direction == "up" else ix + 1
    if not (0 <= swap_ix < len(siblings)):
        return meta                      # already at the end; a no-op, not an error
    other = siblings[swap_ix]

    # Ranks can collide (both 0) on ideas created before ordering existed, so a
    # plain value swap would be a no-op. Renumber the group densely first.
    for rank, m in enumerate(siblings):
        if m["order"] != rank:
            m["order"] = rank
            save_meta(m["slug"], m)
    meta = load_meta(slug)
    other = load_meta(other["slug"])
    meta["order"], other["order"] = other["order"], meta["order"]
    save_meta(slug, meta)
    save_meta(other["slug"], other)
    return meta


def read_text(slug: str, which: str) -> str:
    assert which in TEXT_FIELDS
    path = idea_dir(slug) / f"{which}.md"
    return path.read_text(encoding="utf-8") if path.exists() else ""


@_locked
def write_text(slug: str, which: str, text: str) -> None:
    assert which in TEXT_FIELDS
    d = idea_dir(slug)
    if not d.exists():
        raise FileNotFoundError(slug)
    _atomic_write(d / f"{which}.md", text)
    meta = load_meta(slug)
    meta["updated"] = now_iso()
    save_meta(slug, meta)


@_locked
def link_related(slug_a: str, slug_b: str) -> None:
    """Symmetric: a shows b and b shows a."""
    if slug_a == slug_b:
        return
    for a, b in ((slug_a, slug_b), (slug_b, slug_a)):
        meta = load_meta(a)
        if b not in meta["related"]:
            meta["related"].append(b)
            save_meta(a, meta)


@_locked
def unlink_related(slug_a: str, slug_b: str) -> None:
    for a, b in ((slug_a, slug_b), (slug_b, slug_a)):
        meta = load_meta(a)
        if b in meta["related"]:
            meta["related"].remove(b)
            save_meta(a, meta)


@_locked
def delete_idea(slug: str) -> None:
    """Soft delete: move the folder into ideas/.trash/ with a timestamp suffix."""
    d = idea_dir(slug)
    if not d.exists():
        raise FileNotFoundError(slug)
    # Remove now-dangling symmetric links from other ideas.
    for other in load_meta(slug)["related"]:
        try:
            unlink_related(slug, other)
        except FileNotFoundError:
            pass
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    shutil.move(str(d), str(TRASH_DIR / f"{slug}-{time.strftime('%Y%m%d-%H%M%S')}"))


_FIGURE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"}


@_locked
def save_figure(slug: str, filename: str, data: bytes) -> str:
    """Returns the stored filename. Sanitizes the name and dodges collisions."""
    d = idea_dir(slug)
    if not d.exists():
        raise FileNotFoundError(slug)
    stem = slugify(Path(filename).stem)[:60] or "figure"
    ext = Path(filename).suffix.lower()
    if ext not in _FIGURE_EXTS:
        raise ValueError(f"unsupported figure type: {ext}")
    figures = d / "figures"
    figures.mkdir(exist_ok=True)
    name, n = f"{stem}{ext}", 2
    while (figures / name).exists():
        name = f"{stem}-{n}{ext}"
        n += 1
    (figures / name).write_bytes(data)
    meta = load_meta(slug)
    meta["updated"] = now_iso()
    save_meta(slug, meta)
    return name


@_locked
def load_taxonomy() -> dict[str, list[str]]:
    """Field -> [subfields]. Seeded on first run, then union-ed with whatever the
    ideas on disk actually use, so hand-edited meta.json never yields a dead dropdown."""
    IDEAS_DIR.mkdir(exist_ok=True)
    if TAXONOMY_PATH.exists():
        try:
            tax = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            tax = dict(DEFAULT_TAXONOMY)
    else:
        tax = {k: list(v) for k, v in DEFAULT_TAXONOMY.items()}
        _atomic_write(TAXONOMY_PATH, json.dumps(tax, indent=2, ensure_ascii=False))

    changed = False
    for meta in list_ideas():
        f, s = meta.get("field", ""), meta.get("subfield", "")
        if f and f not in tax:
            tax[f] = []
            changed = True
        if f and s and s not in tax[f]:
            tax[f].append(s)
            changed = True
    if changed:
        save_taxonomy(tax)
    return {k: sorted(v) for k, v in sorted(tax.items())}


def save_taxonomy(tax: dict) -> None:
    IDEAS_DIR.mkdir(exist_ok=True)
    _atomic_write(TAXONOMY_PATH, json.dumps(tax, indent=2, ensure_ascii=False))


@_locked
def add_taxonomy(field: str, subfield: str = "") -> dict:
    field, subfield = field.strip(), subfield.strip()
    if not field:
        raise ValueError("field required")
    tax = load_taxonomy()
    tax.setdefault(field, [])
    if subfield and subfield not in tax[field]:
        tax[field].append(subfield)
    save_taxonomy(tax)
    return {k: sorted(v) for k, v in sorted(tax.items())}


@_locked
def remove_taxonomy(field: str, subfield: str = "") -> dict:
    """Removes a subfield, or a whole field when subfield is empty.
    Refuses if any idea still uses it — no silent orphaning."""
    tax = load_taxonomy()
    in_use = [m["title"] for m in list_ideas()
              if m["field"] == field and (not subfield or m["subfield"] == subfield)]
    if in_use:
        raise ValueError(f"in use by {len(in_use)} idea(s): {', '.join(in_use[:3])}")
    if subfield:
        if field in tax and subfield in tax[field]:
            tax[field].remove(subfield)
    else:
        tax.pop(field, None)
    save_taxonomy(tax)
    return {k: sorted(v) for k, v in sorted(tax.items())}


def search(query: str) -> list[str]:
    """Case-insensitive substring search over title, tags, description and notes.
    Returns matching slugs. Linear scan — fine for thousands of ideas."""
    q = query.lower().strip()
    if not q:
        return []
    hits = []
    for meta in list_ideas():
        hay = " ".join([
            meta["title"], meta["field"], meta["subfield"], " ".join(meta["tags"]),
            " ".join(it["text"] for it in meta["plan"]),
            " ".join(l.get("title", "") + " " + l.get("url", "") for l in meta["links"]),
            *(read_text(meta["slug"], f) for f in TEXT_FIELDS),
        ]).lower()
        if q in hay:
            hits.append(meta["slug"])
    return hits
