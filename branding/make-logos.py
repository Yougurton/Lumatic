"""
Lumatic's logo concepts as SVG files (branding/logos/): each concept's icon, the icon with the name
beside it, and the icon in one colour. The name is drawn as outlines of Inter Display (SIL Open Font
License), so it looks the same without the font installed.

  python3 branding/make-logos.py        (needs fontTools: pip install fonttools)
"""
import math, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'logos')
FONT = '/usr/share/fonts/opentype/inter/InterDisplay-SemiBold.otf'

RED = '#ff3d5e'
BLUE = '#2ea8ff'
ACCENT = '#6aa6ff'
WHITE = '#f4f6fb'
BG = '#0e0f13'
PANEL = '#16171c'

_font = TTFont(FONT)
_glyphs = _font.getGlyphSet()
_cmap = _font.getBestCmap()
_upm = _font['head'].unitsPerEm
_kern = {}


def text_path(text, size, x, y, tracking=0.0):
    """The text's outlines as one path's d (baseline at y), and its width."""
    scale = size / _upm
    pen = SVGPathPen(_glyphs)
    cursor = 0.0
    for ch in text:
        name = _cmap[ord(ch)]
        glyph = _glyphs[name]
        glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, x + cursor, y)))
        cursor += glyph.width * scale + tracking * size
    width = cursor - tracking * size
    return pen.getCommands(), width


def r(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.')


def svg(view_w, view_h, body, title, desc, defs=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {r(view_w)} {r(view_h)}" width="{r(view_w)}" height="{r(view_h)}" role="img" aria-labelledby="t d">\n'
            f'  <title id="t">{title}</title>\n  <desc id="d">{desc}</desc>\n'
            + (f'  <defs>\n{defs}\n  </defs>\n' if defs else '') + body + '\n</svg>\n')


def glow(id_, std=3.0):
    return (f'    <filter id="{id_}" x="-50%" y="-50%" width="200%" height="200%">\n'
            f'      <feGaussianBlur stdDeviation="{std}" result="b"/>\n'
            f'      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>\n    </filter>')


def lr_gradient(id_, x1=0, x2=128, a=RED, b=BLUE):
    return (f'    <linearGradient id="{id_}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="0" x2="{x2}" y2="0">'
            f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>')


# ----- the concepts' icons: (defs, body) in a 128×128 box; mono: one colour, no glow --------------------------

def tile(fill=BG):
    return f'  <rect width="128" height="128" rx="28" fill="{fill}"/>'


def rings(mono=None):
    """1. The ring tunnel: squares turned a little more each, as the rings stand in a spiral."""
    defs = '' if mono else lr_gradient('g1', 20, 108) + '\n' + glow('f1', 2.2)
    out = [] if mono else [tile()]
    out.append(f'  <g fill="none" stroke="{mono or "url(#g1)"}" stroke-linejoin="round"' + ('' if mono else ' filter="url(#f1)"') + '>')
    for k in range(5):
        size = 76 - k * 15
        angle = 45 - k * 11
        width = 6.5 - k * 1.0
        opacity = 1 - k * 0.12
        out.append(f'    <rect x="{r(64 - size / 2)}" y="{r(64 - size / 2)}" width="{r(size)}" height="{r(size)}" rx="{r(size * 0.12)}" stroke-width="{r(width)}" opacity="{r(opacity)}" transform="rotate({angle} 64 64)"/>')
    out.append('  </g>')
    out.append(f'  <circle cx="64" cy="64" r="5" fill="{mono or WHITE}"' + ('' if mono else ' filter="url(#f1)"') + '/>')
    return defs, '\n'.join(out)


def lasers(mono=None):
    """2. Lasers: red beams from the left of the stage, blue from the right, crossing over it."""
    defs = '' if mono else '\n'.join([
        f'    <linearGradient id="gr" gradientUnits="userSpaceOnUse" x1="22" y1="104" x2="106" y2="20"><stop offset="0" stop-color="{RED}"/><stop offset="1" stop-color="{RED}" stop-opacity="0.15"/></linearGradient>',
        f'    <linearGradient id="gb" gradientUnits="userSpaceOnUse" x1="106" y1="104" x2="22" y2="20"><stop offset="0" stop-color="{BLUE}"/><stop offset="1" stop-color="{BLUE}" stop-opacity="0.15"/></linearGradient>',
        glow('f2', 2.4)])
    out = [] if mono else [tile()]
    origin_l, origin_r = (30, 102), (98, 102)
    out.append('  <g stroke-linecap="round"' + ('' if mono else ' filter="url(#f2)"') + '>')
    for k, angle in enumerate((62, 50, 38)):
        a = math.radians(angle)
        length = 92 - k * 8
        for (ox, oy), sign, grad in ((origin_l, 1, 'url(#gr)'), (origin_r, -1, 'url(#gb)')):
            x2 = ox + sign * math.cos(a) * length
            y2 = oy - math.sin(a) * length
            out.append(f'    <line x1="{ox}" y1="{oy}" x2="{r(x2)}" y2="{r(y2)}" stroke="{mono or grad}" stroke-width="{r(5 - k * 1.1)}"/>')
    out.append('  </g>')
    # the stage and the two lights on it
    out.append(f'  <rect x="20" y="100" width="88" height="7" rx="3.5" fill="{mono or PANEL}"' + ('' if mono else f' stroke="{ACCENT}" stroke-opacity="0.35"') + '/>')
    out.append(f'  <circle cx="{origin_l[0]}" cy="{origin_l[1]}" r="5" fill="{mono or RED}"/>')
    out.append(f'  <circle cx="{origin_r[0]}" cy="{origin_r[1]}" r="5" fill="{mono or BLUE}"/>')
    return defs, '\n'.join(out)


def timeline(mono=None):
    """3. An L of timeline clips: three short clips on three rows make its stem, a long one on the fourth
    its foot; the song cursor runs through it."""
    defs = '' if mono else lr_gradient('g3', 26, 104) + '\n' + glow('f3', 1.6)
    out = [] if mono else [tile()]
    rows = [(26, RED), (46, BLUE), (66, RED)]
    for y, color in rows:
        out.append(f'  <rect x="26" y="{y}" width="26" height="14" rx="4" fill="{mono or color}"/>')
        if not mono:
            out.append(f'  <rect x="47" y="{y}" width="5" height="14" rx="2" fill="{WHITE}" opacity="0.55"/>')
    out.append(f'  <rect x="26" y="86" width="78" height="14" rx="4" fill="{mono or "url(#g3)"}"/>')
    # the song cursor
    out.append(f'  <g fill="{mono or WHITE}"' + ('' if mono else ' filter="url(#f3)"') + '>')
    out.append('    <rect x="76" y="24" width="3" height="80" rx="1.5"/>')
    out.append('    <path d="M70.5 18h14l-7 8z"/>')
    out.append('  </g>')
    return defs, '\n'.join(out)


def spark(mono=None):
    """4. A spark of light: a four-pointed star, its left half red and right half blue, white at its
    heart — Chroma's colours meeting."""
    def star(cx, cy, outer, inner):
        pts = []
        for k in range(8):
            a = math.radians(-90 + k * 45)
            rad = outer if k % 2 == 0 else inner
            pts.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad))
        d = f'M{r(pts[0][0])} {r(pts[0][1])}'
        for k in range(1, 9):
            p = pts[k % 8]
            # (curved in between the points: a sparkle, not a plain star)
            d += f' Q{r(cx)} {r(cy)} {r(p[0])} {r(p[1])}' if k % 2 == 1 else f' L{r(p[0])} {r(p[1])}'
        return d + 'Z'
    d = star(64, 64, 46, 13)
    if mono:
        return '', f'  <path d="{d}" fill="{mono}"/>\n  <path d="{star(96, 32, 10, 3)}" fill="{mono}"/>'
    defs = '\n'.join([
        f'    <linearGradient id="g4" gradientUnits="userSpaceOnUse" x1="18" y1="0" x2="110" y2="0"><stop offset="0" stop-color="{RED}"/><stop offset="0.5" stop-color="{RED}"/><stop offset="0.5" stop-color="{BLUE}"/><stop offset="1" stop-color="{BLUE}"/></linearGradient>',
        f'    <radialGradient id="c4" cx="64" cy="64" r="22" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{WHITE}"/><stop offset="1" stop-color="{WHITE}" stop-opacity="0"/></radialGradient>',
        glow('f4', 3.2)])
    out = [tile(), f'  <path d="{d}" fill="url(#g4)" filter="url(#f4)"/>', '  <circle cx="64" cy="64" r="22" fill="url(#c4)"/>',
           f'  <path d="{star(96, 32, 10, 3)}" fill="{WHITE}" opacity="0.85"/>']
    return defs, '\n'.join(out)


def lens(mono=None):
    """5. A lettermark: the i of Lumatic as a beam of light with a light shining for its dot, under it the
    row of lights it plays on."""
    defs = '' if mono else '\n'.join([
        f'    <linearGradient id="g5" gradientUnits="userSpaceOnUse" x1="0" y1="94" x2="0" y2="34"><stop offset="0" stop-color="{ACCENT}"/><stop offset="1" stop-color="{WHITE}"/></linearGradient>',
        f'    <radialGradient id="h5" cx="64" cy="28" r="20" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{WHITE}"/><stop offset="0.35" stop-color="{ACCENT}" stop-opacity="0.9"/><stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/></radialGradient>',
        glow('f5', 2.0)])
    out = [] if mono else [tile()]
    out.append(f'  <rect x="57" y="40" width="14" height="52" rx="7" fill="{mono or "url(#g5)"}"/>')
    if mono:
        out.append(f'  <circle cx="64" cy="27" r="9" fill="{mono}"/>')
    else:
        out.append('  <circle cx="64" cy="28" r="20" fill="url(#h5)"/>')
        out.append(f'  <circle cx="64" cy="28" r="7" fill="{WHITE}" filter="url(#f5)"/>')
    colors = [RED, RED, ACCENT, BLUE, BLUE]
    for k, color in enumerate(colors):
        x = 30 + k * 14.5
        out.append(f'  <rect x="{r(x)}" y="100" width="10" height="6" rx="3" fill="{mono or color}"' + ('' if mono or k == 2 else ' opacity="0.9"') + '/>')
    return defs, '\n'.join(out)


CONCEPTS = [
    ('1-rings', 'Тоннель колец', rings, 'Squares turned one after another into a spiral, red to blue, like the rings of the Beat Saber stage'),
    ('2-lasers', 'Лазеры сцены', lasers, 'Red lasers from the left of a stage and blue from the right crossing over it'),
    ('3-timeline', 'L из таймлайна', timeline, 'The letter L made of timeline clips in red and blue, with the song cursor running through it'),
    ('4-spark', 'Искра Chroma', spark, 'A four-pointed sparkle, half red and half blue, white at its heart'),
    ('5-light-i', 'i со светом', lens, 'The letter i as a beam with a light shining for its dot and a row of lights under it'),
]


def write(name, content):
    with open(os.path.join(OUT, name), 'w', encoding='utf8') as f:
        f.write(content)


def wordmark(x, baseline, size, color=WHITE):
    d, width = text_path('Lumatic', size, x, baseline, tracking=-0.01)
    return f'  <path d="{d}" fill="{color}"/>', width


os.makedirs(OUT, exist_ok=True)
for slug, _, make, desc in CONCEPTS:
    defs, body = make()
    write(f'lumatic-{slug}-icon.svg', svg(128, 128, body, 'Lumatic', desc, defs))
    _, mono = make(mono=WHITE)
    write(f'lumatic-{slug}-icon-mono.svg', svg(128, 128, mono, 'Lumatic', desc + ' (one colour)'))
    # the icon with the name beside it, on the editor's panel colour
    name, width = wordmark(150, 84, 56)
    total = 150 + width + 34
    body_h = f'  <rect width="{r(total)}" height="128" rx="20" fill="{PANEL}"/>\n  <g transform="translate(8 8) scale(0.875)">\n{body}\n  </g>\n{name}'
    write(f'lumatic-{slug}-horizontal.svg', svg(total, 128, body_h, 'Lumatic', desc + ', with the name Lumatic beside it', defs))

# the name alone: light bars under it in the game's colours
name, width = wordmark(24, 74, 64)
bars = []
n = 14
for k in range(n):
    t = k / (n - 1)
    color = RED if t < 0.45 else (ACCENT if t < 0.55 else BLUE)
    w = (width - (n - 1) * 6) / n
    bars.append(f'  <rect x="{r(24 + k * (w + 6))}" y="92" width="{r(w)}" height="6" rx="3" fill="{color}" opacity="{r(0.55 + 0.45 * math.sin(math.pi * t))}"/>')
write('lumatic-wordmark.svg', svg(width + 48, 120, f'  <rect width="{r(width + 48)}" height="120" rx="20" fill="{PANEL}"/>\n{name}\n' + '\n'.join(bars), 'Lumatic', 'The name Lumatic with a row of red, light blue and blue lights under it'))
print('written to', OUT)
