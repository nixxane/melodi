"""Web app (PWA) icons from the Tauri app icon, into public/icons/.

    python scripts/gen_pwa_icons.py

- icon-192 / icon-512: the icon as-is (rounded tile, transparent corners)
- maskable-512: on a full-bleed background with padding, for Android's
  adaptive icon shapes (content inside the 80% safe zone)
- apple-touch-icon (180): opaque, since iOS paints transparency black
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src-tauri" / "icons" / "icon.png"
OUT = ROOT / "public" / "icons"
BG = (11, 10, 8, 255)  # --bg


def on_bg(icon: Image.Image, size: int, scale: float) -> Image.Image:
    tile = Image.new("RGBA", (size, size), BG)
    inner = round(size * scale)
    tile.alpha_composite(icon.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return tile


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon = Image.open(SRC).convert("RGBA")
    for s in (192, 512):
        icon.resize((s, s), Image.LANCZOS).save(OUT / f"icon-{s}.png", optimize=True)
    on_bg(icon, 512, 0.74).save(OUT / "maskable-512.png", optimize=True)
    on_bg(icon, 180, 0.9).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    icon.resize((64, 64), Image.LANCZOS).save(OUT / "favicon-64.png", optimize=True)


if __name__ == "__main__":
    main()
