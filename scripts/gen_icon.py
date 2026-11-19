"""Draws the app icon (the pixel bunny) to logo-source.png at 1024x1024.

Same design as branding/logo-concepts/12-pixel-bunny.svg, in the default
amber theme: dark tile, panel-style border, amber pixels with a soft
phosphor glow and scanlines.

Then regenerate the Tauri icon set with:  pnpm tauri icon logo-source.png
"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024
U = S / 128  # the SVG design uses a 128-unit grid

BG = (11, 10, 8)            # --bg
LINE = (59, 51, 37)         # --line
ACCENT = (245, 168, 60)     # --accent
ACCENT_DIM = (138, 98, 38)  # --accent-dim
INK = (18, 13, 5)           # --accent-ink

# X accent, O dim (inner ear), C dim (cheek), E eye (background), K nose (ink)
BUNNY = [
    "..X......X..",
    ".XOX....XOX.",
    ".XOX....XOX.",
    ".XOX....XOX.",
    ".XOX....XOX.",
    ".XXXXXXXXXX.",
    "XXXXXXXXXXXX",
    "XXEXXXXXXEXX",
    "XXXXXKKXXXXX",
    "XCXXXXXXXXCX",
    ".XXXXXXXXXX.",
    "..XXXXXXXX..",
]
COLORS = {"X": ACCENT, "O": ACCENT_DIM, "C": ACCENT_DIM, "E": BG, "K": INK}


def r(v):
    return round(v * U)


# Tile mask (rounded square)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=r(24), fill=255)

img = Image.new("RGBA", (S, S), BG + (255,))

# Bunny pixels on their own layer, so the glow can be made from them
px = 7
cols, rows = len(BUNNY[0]), len(BUNNY)
ox, oy = (128 - cols * px) / 2, (128 - rows * px) / 2
art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ad = ImageDraw.Draw(art)
for y, row in enumerate(BUNNY):
    for x, ch in enumerate(row):
        if ch in COLORS:
            x0, y0 = r(ox + x * px), r(oy + y * px)
            ad.rectangle([x0, y0, r(ox + (x + 1) * px) - 1, r(oy + (y + 1) * px) - 1], fill=COLORS[ch] + (255,))

# Phosphor glow: blurred copy of the art at 60% strength, under the art
glow = art.filter(ImageFilter.GaussianBlur(r(2.2)))
glow.putalpha(glow.getchannel("A").point(lambda a: int(a * 0.6)))
img = Image.alpha_composite(img, glow)
img = Image.alpha_composite(img, art)

# Panel-style border
ImageDraw.Draw(img).rounded_rectangle(
    [r(7.5), r(7.5), S - 1 - r(7.5), S - 1 - r(7.5)], radius=r(17), outline=LINE + (255,), width=r(1.5)
)

# Scanlines: a dark band in every 4 units
scan = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(scan)
for y in range(0, 128, 4):
    sd.rectangle([0, r(y), S, r(y + 1.4) - 1], fill=(0, 0, 0, 46))
img = Image.alpha_composite(img, scan)

img.putalpha(ImageChops.multiply(img.getchannel("A"), mask))
img.save("logo-source.png")
print("wrote logo-source.png", img.size)


def small(size):
    """Pixel-exact icon for tray/taskbar sizes: each bunny pixel is a whole
    number of screen pixels, so it stays sharp instead of blurring."""
    p = {16: 1, 24: 2, 32: 2, 48: 3}[size]
    off = (size - cols * p) // 2
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=max(2, size * 3 // 16), fill=BG + (255,))
    for y, row in enumerate(BUNNY):
        for x, ch in enumerate(row):
            if ch in COLORS and ch != "E":
                d.rectangle([off + x * p, off + y * p, off + (x + 1) * p - 1, off + (y + 1) * p - 1], fill=COLORS[ch] + (255,))
    return im


# Run with --small AFTER `pnpm tauri icon logo-source.png`: replaces the
# blurry downscaled small sizes in the Tauri icon set with pixel-exact ones.
if "--small" in __import__("sys").argv:
    icons = "src-tauri/icons/"
    small(32).save(icons + "32x32.png")
    big = {s: img.resize((s, s), Image.LANCZOS) for s in (64, 256)}
    sizes = [16, 24, 32, 48, 64, 256]
    frames = [small(s) for s in (16, 24, 32, 48)] + [big[64], big[256]]
    frames[-1].save(icons + "icon.ico", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    print("wrote pixel-exact 32x32.png and icon.ico")
