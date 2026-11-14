"""
Lumatic's app icon: a rounded square with "Lu" and a dashed row of lights under it (the wordmark's row,
public/lumatic-wordmark.svg), in several variants (branding/icons/). The letters are outlines of Inter
Display (SIL Open Font License), so they look the same without the font installed.

  python3 branding/make-icons.py        (needs fontTools: pip install fonttools)
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'icons')
FONTS = '/usr/share/fonts/opentype/inter/InterDisplay-{}.otf'

PANEL = '#16171c'
WHITE = '#f4f6fb'
INK = '#16171c'
# the wordmark's row of lights: pink, orange, yellow, mint, sky, violet
RAINBOW = ['#ff4f8b', '#ff9a3d', '#ffd84a', '#4dffb8', '#3dc8ff', '#8f6bff']

SIZE = 512
RADIUS = 112


def letters(text, weight, tracking=0.0):
    """The text's outlines (font units, y up) as a path's commands, and their bounds."""
    font = TTFont(FONTS.format(weight))
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    pen = SVGPathPen(glyphs)
    bounds = BoundsPen(glyphs)
    cursor = 0.0
    upm = font['head'].unitsPerEm
    for ch in text:
        glyph = glyphs[cmap[ord(ch)]]
        glyph.draw(TransformPen(pen, (1, 0, 0, 1, cursor, 0)))
        glyph.draw(TransformPen(bounds, (1, 0, 0, 1, cursor, 0)))
        cursor += glyph.width + tracking * upm
    return pen.getCommands(), bounds.bounds


def lu(weight, width, center_x, top, tracking=-0.02):
    """'Lu' as a path `width` wide, its top at `top`: the <path> and its bottom."""
    commands, (x0, y0, x1, y1) = letters('Lu', weight, tracking)
    scale = width / (x1 - x0)
    height = (y1 - y0) * scale
    # (font units have y up: flipped, moved so the outline's box lands where asked)
    tx = center_x - width / 2 - x0 * scale
    ty = top + y1 * scale
    transform = f'matrix({scale:.5f} 0 0 {-scale:.5f} {tx:.3f} {ty:.3f})'
    return commands, transform, top + height


def dashes(left, right, y, height, count, colors, gap_ratio=0.55, opacity_bell=False, round_dots=False):
    """A row of `count` lights from `left` to `right` (each its colour from the rainbow, in order)."""
    out = []
    unit = (right - left) / (count + (count - 1) * gap_ratio)
    w = height if round_dots else unit
    gap = (right - left - count * w) / max(1, count - 1)
    for k in range(count):
        x = left + k * (w + gap)
        color = colors[min(len(colors) - 1, int(k * len(colors) / count))]
        mid = abs(k - (count - 1) / 2) / ((count - 1) / 2)
        opacity = f' opacity="{1 - 0.45 * mid ** 2:.2f}"' if opacity_bell else ''
        out.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{height:.2f}" rx="{height / 2:.2f}" fill="{color}"{opacity}/>')
    return '\n  '.join(out)


def svg(name, body, defs=''):
    text = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}" role="img" aria-labelledby="t">
  <title id="t">Lumatic</title>
  {f"<defs>{defs}</defs>" if defs else ""}
  {body}
</svg>
'''
    with open(os.path.join(OUT, f'lumatic-icon-{name}.svg'), 'w') as f:
        f.write(text)
    return name


def variants():
    made = []
    c = SIZE / 2

    # 1. classic: the wordmark made small — white letters, eight lights fading at the ends
    d, tr, bottom = lu('SemiBold', 292, c, 118)
    made.append(svg('1-classic', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{PANEL}"/>
  <path d="{d}" transform="{tr}" fill="{WHITE}"/>
  {dashes(96, 416, 374, 16, 8, ['#ff4f8b', '#ff4f8b', '#ff9a3d', '#ffd84a', '#4dffb8', '#3dc8ff', '#8f6bff', '#8f6bff'], gap_ratio=0.45, opacity_bell=True)}'''))

    # 1, small: the same for 16–32 px — the letters bigger, four thick lights (thin ones blur away)
    d, tr, bottom = lu('Bold', 360, c, 92)
    made.append(svg('1-classic-small', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{PANEL}"/>
  <path d="{d}" transform="{tr}" fill="{WHITE}"/>
  {dashes(76, 436, 384, 44, 4, ['#ff4f8b', '#ffd84a', '#4dffb8', '#8f6bff'], gap_ratio=0.3)}'''))

    # 2. bold: heavier, bigger letters; six lights, one a colour
    d, tr, bottom = lu('Bold', 326, c, 100)
    made.append(svg('2-bold', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{PANEL}"/>
  <path d="{d}" transform="{tr}" fill="{WHITE}"/>
  {dashes(84, 428, 380, 24, 6, RAINBOW, gap_ratio=0.3)}'''))

    # 3. glow: lit from above, the lights glowing as lamps do
    d, tr, bottom = lu('SemiBold', 300, c, 112)
    made.append(svg('3-glow', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="url(#bg)"/>
  <path d="{d}" transform="{tr}" fill="{WHITE}"/>
  <g filter="url(#glow)">
  {dashes(92, 420, 374, 18, 6, RAINBOW, gap_ratio=0.35)}
  </g>''', defs=f'''<radialGradient id="bg" cx="50%" cy="85%" r="75%"><stop offset="0" stop-color="#262838"/><stop offset="1" stop-color="#101117"/></radialGradient>
    <filter id="glow" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'''))

    # 4. underline: the lights only as wide as the letters, closer under them
    d, tr, bottom = lu('SemiBold', 300, c, 128)
    made.append(svg('4-underline', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{PANEL}"/>
  <path d="{d}" transform="{tr}" fill="{WHITE}"/>
  {dashes(c - 150, c + 150, bottom + 34, 16, 5, ['#ff4f8b', '#ff9a3d', '#ffd84a', '#3dc8ff', '#8f6bff'], gap_ratio=0.3)}'''))

    # 5. tile: the square in the lights' colours, white letters and lights
    d, tr, bottom = lu('Bold', 300, c, 112)
    made.append(svg('5-tile', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="url(#tile)"/>
  <path d="{d}" transform="{tr}" fill="#ffffff"/>
  {dashes(96, 416, 378, 18, 6, ['#ffffff'], gap_ratio=0.35)}''', defs='<linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4f8b"/><stop offset="0.5" stop-color="#8f6bff"/><stop offset="1" stop-color="#3dc8ff"/></linearGradient>'))

    # 6. light: a light square, dark letters, the coloured lights
    d, tr, bottom = lu('SemiBold', 292, c, 118)
    made.append(svg('6-light', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{WHITE}"/>
  <path d="{d}" transform="{tr}" fill="{INK}"/>
  {dashes(96, 416, 374, 18, 6, RAINBOW, gap_ratio=0.35)}'''))

    # 7. dots: a row of round lamps, as LEDs on a strip
    d, tr, bottom = lu('SemiBold', 292, c, 112)
    colors = ['#ff4f8b', '#ff4f8b', '#ff9a3d', '#ff9a3d', '#ffd84a', '#ffd84a', '#4dffb8', '#4dffb8', '#3dc8ff', '#3dc8ff', '#8f6bff', '#8f6bff']
    made.append(svg('7-dots', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{PANEL}"/>
  <path d="{d}" transform="{tr}" fill="{WHITE}"/>
  {dashes(96, 416, 374, 22, 12, colors, round_dots=True)}'''))

    # 8. gradient letters: the letters lit in the lights' colours, the lights under them white
    d, tr, bottom = lu('Bold', 310, c, 108)
    made.append(svg('8-gradient', f'''<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{PANEL}"/>
  <path d="{d}" transform="{tr}" fill="url(#ink)"/>
  {dashes(96, 416, 378, 18, 6, ['#ffffff'], gap_ratio=0.35)}''', defs='<linearGradient id="ink" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff4f8b"/><stop offset="0.5" stop-color="#ffd84a"/><stop offset="1" stop-color="#3dc8ff"/></linearGradient>'))
    return made


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name in variants():
        print('made', f'lumatic-icon-{name}.svg')
