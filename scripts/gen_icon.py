import numpy as np
from PIL import Image, ImageDraw

S = 1024

# Diagonal gradient: violet -> indigo -> cyan
x = np.linspace(0, 1, S)
y = np.linspace(0, 1, S)
xx, yy = np.meshgrid(x, y)
t = (xx + yy) / 2.0

c1 = np.array([247, 207, 107], dtype=np.float64)  # f7cf6b gold
c2 = np.array([243, 154, 71], dtype=np.float64)   # f39a47 amber
c3 = np.array([228, 87, 94], dtype=np.float64)    # e4575e rose


def lerp(a, b, t):
    return a[None, None, :] * (1 - t[..., None]) + b[None, None, :] * t[..., None]


rgb = np.where(
    t[..., None] < 0.5, lerp(c1, c2, t * 2), lerp(c2, c3, (t - 0.5) * 2)
)
rgb = np.clip(rgb, 0, 255).astype(np.uint8)

# Rounded-square alpha mask
mask = Image.new("L", (S, S), 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=220, fill=255)

img = Image.fromarray(np.dstack([rgb, np.array(mask)]).astype(np.uint8), "RGBA")

# Equalizer waveform (5 rounded bars), white
overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
bar_w = 78
gap = 46
heights = [0.46, 0.72, 0.98, 0.62, 0.40]
max_h = 430
total = 5 * bar_w + 4 * gap
start_x = (S - total) // 2
cx = S // 2
for i, h in enumerate(heights):
    bh = int(max_h * h)
    bx = start_x + i * (bar_w + gap)
    by = cx - bh // 2
    od.rounded_rectangle(
        [bx, by, bx + bar_w, by + bh], radius=bar_w // 2, fill=(255, 255, 255, 255)
    )

img = Image.alpha_composite(img, overlay)
img.save("logo-source.png")
print("wrote logo-source.png", img.size)
