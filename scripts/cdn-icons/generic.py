"""
generic.py — Placeholder logos for assets collect.py could not fill.

Every key in missing.json that has no real logo in manifest.json gets a neutral
128x128 PNG: a grey disc with the symbol's initial, matching the letter-bubble
fallback in AssetIcon.tsx. With these on the CDN the 403s are gone and the app
renders the same thing it renders today, from a real image.

Output (kept apart from icons/ so collect.py never treats them as resolved):
  scripts/cdn-icons/generic/<base64>.png
  scripts/cdn-icons/manifest-generic.json   (caip, key, source="generic", sha256)

Run after collect.py (re-run it whenever collect.py resolves more):
  uv run --no-project --with pillow python scripts/cdn-icons/generic.py

A generic uploaded now blocks a real logo later (upload.ts never overwrites):
to replace one, delete the object from the bucket and upload the real file.
"""
import hashlib
import io
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DIR = Path(__file__).resolve().parent
OUT = DIR / "generic"
SIZE = 128
SCALE = 4  # draw at 4x, downsample for smooth edges
BG = (58, 63, 71, 255)  # neutral grey, readable on light and dark themes
FG = (205, 210, 218, 255)
FONT = ImageFont.load_default(int(SIZE * 0.46 * SCALE))  # bundled with Pillow: same output on every machine


def initial(symbol: str) -> str:
    for ch in (symbol or "").strip():
        if ch.isalnum():
            return ch.upper()
    return "?"


def render(letter: str) -> bytes:
    big = SIZE * SCALE
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((0, 0, big - 1, big - 1), fill=BG)
    d.text((big / 2, big / 2), letter, font=FONT, fill=FG, anchor="mm")
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main():
    missing = json.loads((DIR / "missing.json").read_text())
    have = {e["key"] for e in json.loads((DIR / "manifest.json").read_text())}

    shutil.rmtree(OUT, ignore_errors=True)  # derived output: rebuild from scratch
    OUT.mkdir()
    cache: dict[str, bytes] = {}
    manifest = []
    for a in sorted(missing, key=lambda a: a["caip"]):
        if a["key"] in have:
            continue
        letter = initial(a.get("symbol") or a.get("name") or "")
        png = cache.setdefault(letter, render(letter))
        (OUT / Path(a["key"]).name).write_bytes(png)
        manifest.append({"caip": a["caip"], "symbol": a.get("symbol"), "key": a["key"], "source": "generic",
                         "sha256": hashlib.sha256(png).hexdigest(), "bytes": len(png)})

    (DIR / "manifest-generic.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"missing={len(missing)} real={len(have)} generic={len(manifest)} distinct_images={len(cache)}")


if __name__ == "__main__":
    main()
