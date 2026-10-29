"""Draws the Paper Reader icon (same family as the Bench apps: flat marks on a dark rounded square).
Writes AppIcon.png (1024) and AppIcon.icns next to this file.  Run: python3 make_icon.py"""
import math, shutil, subprocess
from pathlib import Path
from PIL import Image, ImageDraw

S = 4                      # supersample
W = 1024 * S
HERE = Path(__file__).parent / "Paper Reader.app/Contents/Resources"
BG = (13, 27, 34, 255)
PAPER = (242, 238, 228, 255)
LINE = (104, 118, 128, 255)
YELLOW = (255, 204, 38, 255)
TEAL = (0, 212, 192, 255)
BLUE = (79, 157, 255, 255)
PINK = (255, 92, 128, 255)
ORANGE = (255, 171, 31, 255)

def s(v): return int(v * S)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([s(110), s(110), s(914), s(914)], radius=s(190), fill=BG)
bg_img = img
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))   # artwork layer, scaled into the tile at the end
d = ImageDraw.Draw(img)

# --- the paper, slightly tilted ---
page = Image.new("RGBA", (s(470), s(600)), (0, 0, 0, 0))
p = ImageDraw.Draw(page)
p.rounded_rectangle([0, 0, s(470), s(600)], radius=s(34), fill=PAPER)
p.polygon([(s(470) - s(110), 0), (s(470), s(110)), (s(470), 0)], fill=(0, 0, 0, 0))            # folded corner cut
p.polygon([(s(470) - s(110), 0), (s(470) - s(110), s(110)), (s(470), s(110))], fill=(214, 207, 190, 255))
# title line
p.rounded_rectangle([s(52), s(62), s(300), s(92)], radius=s(15), fill=(35, 48, 63, 255))
# text lines, one highlighted
ys = [150, 205, 260, 315, 370, 425]
ws = [360, 330, 366, 250, 340, 290]
for i, (y, w) in enumerate(zip(ys, ws)):
    if i == 2:
        p.rounded_rectangle([s(40), s(y - 20), s(40 + w + 24), s(y + 20)], radius=s(10), fill=YELLOW)
    p.rounded_rectangle([s(52), s(y - 9), s(52 + w), s(y + 9)], radius=s(9), fill=LINE)
# small figure thumbnail: bars
for j, (h, c) in enumerate([(60, BLUE), (100, TEAL), (45, PINK), (80, ORANGE)]):
    x = 60 + j * 44
    p.rounded_rectangle([s(x), s(560 - h), s(x + 28), s(560)], radius=s(8), fill=c)
page = page.rotate(-6, resample=Image.BICUBIC, expand=True)
img.alpha_composite(page, (s(200), s(185)))

# --- handwritten teal squiggle (a loop + underline), as if just written ---
pts = []
for t in [i / 200 for i in range(201)]:
    x = 480 + 330 * t
    y = 760 - 26 * math.sin(t * math.pi * 3.2) - 18 * t
    pts.append((s(x), s(y)))
d.line(pts, fill=TEAL, width=s(26), joint="curve")
for q in (pts[0], pts[-1]):
    r = s(13); d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=TEAL)

# --- the pen, resting diagonally at the end of the stroke ---
pen = Image.new("RGBA", (s(120), s(470)), (0, 0, 0, 0))
q = ImageDraw.Draw(pen)
q.rounded_rectangle([s(20), s(0), s(100), s(330)], radius=s(40), fill=BLUE)          # barrel
q.rectangle([s(20), s(300), s(100), s(345)], fill=(200, 212, 222, 255))                # grip ring
q.polygon([(s(20), s(345)), (s(100), s(345)), (s(60), s(450))], fill=(233, 227, 214, 255))  # nib cone
q.polygon([(s(46), s(415)), (s(74), s(415)), (s(60), s(452))], fill=TEAL)              # ink tip
q.rounded_rectangle([s(52), s(40), s(68), s(200)], radius=s(8), fill=(255, 255, 255, 70))  # sheen
pen = pen.rotate(-38, resample=Image.BICUBIC, expand=True)
img.alpha_composite(pen, (s(655), s(355)))

k = 0.74                                            # leave the same breathing room as the Bench icons
art = img.resize((int(W * k), int(W * k)), Image.LANCZOS)
off = (W - art.width) // 2
bg_img.alpha_composite(art, (off - s(10), off + s(4)))
out = bg_img.resize((1024, 1024), Image.LANCZOS)
out.save(HERE / "AppIcon.png")

iconset = HERE / "AppIcon.iconset"
shutil.rmtree(iconset, ignore_errors=True); iconset.mkdir()
for base in (16, 32, 128, 256, 512):
    out.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
    out.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(HERE / "AppIcon.icns")], check=True)
shutil.rmtree(iconset)
print("wrote", HERE / "AppIcon.png", "and AppIcon.icns")
