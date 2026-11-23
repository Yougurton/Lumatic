"""
ChroEditor's own stand-ins for sprites the environment data has no image for (see
src/engine/renderer/environment/environment-supplements.ts): drawn here from plain shapes, no game
pixels or third-party artwork. White, the shape in the alpha (the light's colour tints it).

    python3 scripts/stand-in-textures.py
"""

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'public' / 'environments' / 'textures'
SS = 4  # drawn this many times larger, then scaled down (smooth edges)


def finish(mask: Image.Image, size: tuple[int, int], halo: float, halo_radius: float) -> Image.Image:
    """The shape (an L mask drawn SS× larger) with a soft halo around it, as white with that alpha."""
    small = mask.resize(size, Image.LANCZOS)
    glow = small.filter(ImageFilter.GaussianBlur(halo_radius)).point(lambda v: int(v * halo))
    alpha = ImageChops.lighter(small, glow)
    image = Image.new('RGBA', size, (255, 255, 255, 0))
    image.putalpha(alpha)
    return image


def pointed_arch(draw: ImageDraw.ImageDraw, left: float, right: float, spring: float, bottom: float, sharpness: float, fill: int):
    """A lancet: straight sides from `bottom` up to `spring`, then two arcs (radius `sharpness` × the
    half width) meeting in a point."""
    half = (right - left) / 2
    radius = sharpness * half
    apex = spring - math.sqrt(radius * radius - (radius - half) ** 2)
    points = [(left, bottom), (left, spring)]
    # the left arc (centred right of the middle) up to the apex, then the right one down
    cx_left = left + radius
    top_angle = math.acos((radius - half) / radius)
    steps = 48
    for i in range(1, steps + 1):
        a = math.pi - top_angle * i / steps
        points.append((cx_left + radius * math.cos(a), spring - radius * math.sin(a)))
    cx_right = right - radius
    for i in range(steps - 1, -1, -1):
        a = top_angle * i / steps
        points.append((cx_right + radius * math.cos(a), spring - radius * math.sin(a)))
    points += [(right, spring), (right, bottom)]
    draw.polygon(points, fill=fill)
    return apex


def quatrefoil(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, lead: float):
    """A four-lobed tracery opening: its lead outline, the glass inside it left lit."""
    lobe = r * 0.5
    for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
        x, y = cx + dx * lobe, cy + dy * lobe
        draw.ellipse((x - lobe - lead / 2, y - lobe - lead / 2, x + lobe + lead / 2, y + lobe + lead / 2), fill=0)
    for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
        x, y = cx + dx * lobe, cy + dy * lobe
        draw.ellipse((x - lobe + lead / 2, y - lobe + lead / 2, x + lobe - lead / 2, y + lobe - lead / 2), fill=255)
    draw.rectangle((cx - lobe, cy - lobe, cx + lobe, cy + lobe), fill=255)


def window():
    """A tall gothic window: a pointed arch with a lit rim, three lights with pointed heads (the
    middle one taller), two transoms low down, quatrefoils in the head — leaded glass, lit from
    behind."""
    w, h = 256, 576
    W, H = w * SS, h * SS
    mask = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(mask)
    margin_x, top, bottom = 40 * SS, 40 * SS, (h - 40) * SS
    left, right = margin_x, W - margin_x
    width = right - left
    spring = top + width * 0.72
    pointed_arch(draw, left, right, spring, bottom, 1.6, 255)
    lead = width * 0.035
    rim = width * 0.07
    # the rim's inner edge: a lead line just inside the outline
    inner_l, inner_r, inner_b = left + rim, right - rim, bottom - rim
    inner_spring = spring + rim * 0.2
    outline = Image.new('L', (W, H), 0)
    outline_draw = ImageDraw.Draw(outline)
    pointed_arch(outline_draw, inner_l, inner_r, inner_spring, inner_b, 1.6, 255)
    shrunk = Image.new('L', (W, H), 0)
    pointed_arch(ImageDraw.Draw(shrunk), inner_l + lead, inner_r - lead, inner_spring + lead * 0.3, inner_b - lead, 1.6, 255)
    mask = ImageChops.subtract(mask, ImageChops.subtract(outline, shrunk))
    draw = ImageDraw.Draw(mask)
    glass_l, glass_r = inner_l + lead, inner_r - lead
    glass_w = glass_r - glass_l
    # the three lights: mullions from the bottom up to their heads
    third = glass_w / 3
    m1, m2 = glass_l + third, glass_l + 2 * third
    head_side = top + (bottom - top) * 0.42
    head_mid = top + (bottom - top) * 0.36
    for x in (m1, m2):
        draw.rectangle((x - lead / 2, head_side, x + lead / 2, inner_b), fill=0)
    # the lights' pointed heads (lead arches)
    for (l, r, s) in ((glass_l, m1, head_side + third * 0.55), (m1, m2, head_mid + third * 0.55), (m2, glass_r, head_side + third * 0.55)):
        arch = Image.new('L', (W, H), 0)
        pointed_arch(ImageDraw.Draw(arch), l - lead / 2, r + lead / 2, s, s + 1, 1.25, 255)
        hole = Image.new('L', (W, H), 0)
        pointed_arch(ImageDraw.Draw(hole), l + lead / 2, r - lead / 2, s + lead * 0.4, s + 1 + lead, 1.25, 255)
        ring = ImageChops.subtract(arch, hole)
        mask = ImageChops.subtract(mask, ring)
    draw = ImageDraw.Draw(mask)
    # transoms
    for f in (0.66, 0.83):
        y = top + (bottom - top) * f
        draw.rectangle((glass_l, y - lead / 2, glass_r, y + lead / 2), fill=0)
    # small diamonds in the side lights at the first transom's height
    for cx in (glass_l + third / 2, m2 + third / 2):
        cy = top + (bottom - top) * 0.58
        d = third * 0.22
        draw.polygon([(cx, cy - d - lead), (cx + d + lead, cy), (cx, cy + d + lead), (cx - d - lead, cy)], fill=0)
        draw.polygon([(cx, cy - d), (cx + d, cy), (cx, cy + d), (cx - d, cy)], fill=255)
    # the head's tracery: a quatrefoil at the top, two side by side under it
    r = glass_w * 0.26
    quatrefoil(draw, (glass_l + glass_r) / 2, top + width * 0.42, r, lead)
    for cx in (glass_l + glass_w * 0.27, glass_l + glass_w * 0.73):
        quatrefoil(draw, cx, top + width * 0.42 + r * 1.05, r * 0.9, lead)
    finish(mask, (w, h), halo=0.45, halo_radius=10).save(OUT / 'chroeditor-window-gothic.png')


def twin_frames():
    """Two upright rectangular frames side by side, a narrow gap between them."""
    w, h = 320, 448
    W, H = w * SS, h * SS
    mask = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(mask)
    margin_x, margin_y = 36 * SS, 34 * SS
    gap = 12 * SS
    line = 14 * SS
    frame_w = (W - 2 * margin_x - gap) / 2
    for i in range(2):
        l = margin_x + i * (frame_w + gap)
        draw.rectangle((l, margin_y, l + frame_w, H - margin_y), fill=255)
        draw.rectangle((l + line, margin_y + line, l + frame_w - line, H - margin_y - line), fill=0)
    finish(mask, (w, h), halo=0.5, halo_radius=9).save(OUT / 'chroeditor-twin-frames.png')


def slanted_stripes():
    """Three long stripes one above another, both ends cut by the same slant (a parallelogram split
    in three)."""
    w, h = 512, 128
    W, H = w * SS, h * SS
    mask = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(mask)
    margin_x, margin_y = 22 * SS, 14 * SS
    stripe, gap = 24 * SS, 14 * SS
    shift = 64 * SS  # how far the slant moves over the whole height
    span = H - 2 * margin_y
    for i in range(3):
        y0 = margin_y + i * (stripe + gap)
        y1 = y0 + stripe
        # the slant: x at a height y
        at = lambda x, y: x + shift * (1 - (y - margin_y) / span)
        draw.polygon([(at(margin_x, y0), y0), (at(W - margin_x - shift, y0), y0), (at(W - margin_x - shift, y1), y1), (at(margin_x, y1), y1)], fill=255)
    finish(mask, (w, h), halo=0.5, halo_radius=7).save(OUT / 'chroeditor-slanted-stripes.png')


def radial_glow():
    """A soft round glow."""
    size = 128
    image = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    alpha = Image.new('L', (size, size), 0)
    pixels = alpha.load()
    for y in range(size):
        for x in range(size):
            d = math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1)
            pixels[x, y] = int(255 * max(0.0, 1 - d) ** 2.2)
    image.putalpha(alpha)
    image.save(OUT / 'chroeditor-glow-radial.png')


if __name__ == '__main__':
    window()
    twin_frames()
    slanted_stripes()
    radial_glow()
