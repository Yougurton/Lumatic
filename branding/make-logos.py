"""
Lumatic's logo: the spark, in several forms and palettes, as SVG files (branding/logos/) — its icon, the icon
with the name beside it, the icon in one colour (one per form); and the name alone. The name is drawn as outlines of Inter Display (SIL Open Font
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


# ----- the spark: the first round's sparkle and glow, in several forms and palettes -------------------------

# each palette's colours, laid along the spark from its lower left to its upper right
PALETTES = {
    'spectrum': ['#ff4f8b', '#ffb03d', '#ffe14a', '#4dffb8', '#3dc8ff', '#8f6bff'],
    'neon': ['#ff4fd8', '#b06bff', '#3de0ff'],
    'sunset': ['#ffc04a', '#ff5f6d', '#c86bff'],
    'aurora': ['#4dffb8', '#3dc8ff', '#8f6bff'],
    'accent': ['#6aa6ff', '#8f98ff', '#b084ff'],
    'fire': ['#ffe14a', '#ff8a3d', '#ff3d6e'],
}
PALETTE_NAMES = {'spectrum': 'спектр', 'neon': 'неон', 'sunset': 'закат', 'aurora': 'аврора', 'accent': 'акцент', 'fire': 'огонь'}


def tile(fill=BG):
    return f'  <rect width="128" height="128" rx="28" fill="{fill}"/>'


def sparkle(cx, cy, outers, inner, turn=0.0):
    """A sparkle's outline: its points `outers` (radii, from the top clockwise), curved in through the
    middle between them (the first round's shape)."""
    n = len(outers)
    pts = []
    for k in range(n * 2):
        a = math.radians(-90 + turn + k * 180 / n)
        rad = outers[k // 2] if k % 2 == 0 else inner
        pts.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad))
    d = f'M{r(pts[0][0])} {r(pts[0][1])}'
    for k in range(1, n * 2 + 1):
        p = pts[k % (n * 2)]
        d += f' Q{r(cx)} {r(cy)} {r(p[0])} {r(p[1])}' if k % 2 == 1 else f' L{r(p[0])} {r(p[1])}'
    return d + 'Z'


FORMS = {
    # the first round's four-pointed sparkle
    'classic': ('классика', lambda: [sparkle(64, 64, [46] * 4, 13)], None),
    # taller than wide, like a flare in a lens
    'tall': ('вытянутая', lambda: [sparkle(64, 64, [54, 32, 54, 32], 12)], None),
    # four long points and four short ones between them
    'eight': ('восемь лучей', lambda: [sparkle(64, 64, [48, 24, 48, 24, 48, 24, 48, 24], 11)], None),
    # turned a little, as if caught spinning
    'tilted': ('наклонная', lambda: [sparkle(64, 64, [50, 38, 50, 38], 12, turn=-18)], None),
    # in a thin ring — the rings of the stage
    'ring': ('в кольце', lambda: [sparkle(64, 64, [40] * 4, 11)], 'ring'),
    # a streak of light through it
    'flare': ('с бликом', lambda: [sparkle(64, 64, [44] * 4, 12)], 'streak'),
}


def spark(form, palette, mono=None):
    _, shapes, extra = FORMS[form]
    paths = shapes()
    if mono:
        out = [f'  <path d="{d}" fill="{mono}"/>' for d in paths]
        if extra == 'ring':
            out.append(f'  <circle cx="64" cy="64" r="52" fill="none" stroke="{mono}" stroke-width="3"/>')
        if extra == 'streak':
            out.append(f'  <rect x="4" y="62.5" width="120" height="3" rx="1.5" fill="{mono}" opacity="0.7"/>')
        return '', '\n'.join(out)
    colors = PALETTES[palette]
    stops = ''.join(f'<stop offset="{r(k / (len(colors) - 1))}" stop-color="{c}"/>' for k, c in enumerate(colors))
    defs = [
        f'    <linearGradient id="sg" gradientUnits="userSpaceOnUse" x1="38" y1="90" x2="90" y2="38">{stops}</linearGradient>',
        f'    <radialGradient id="sc" cx="64" cy="64" r="22" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{WHITE}"/><stop offset="1" stop-color="{WHITE}" stop-opacity="0"/></radialGradient>',
        glow('sf', 3.2),
    ]
    out = [tile()]
    if extra == 'ring':
        out.append('  <circle cx="64" cy="64" r="52" fill="none" stroke="url(#sg)" stroke-width="2.5" opacity="0.75" filter="url(#sf)"/>')
    if extra == 'streak':
        defs.append(f'    <linearGradient id="ss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{colors[0]}" stop-opacity="0"/><stop offset="0.5" stop-color="{WHITE}"/><stop offset="1" stop-color="{colors[-1]}" stop-opacity="0"/></linearGradient>')
        out.append('  <rect x="4" y="62.6" width="120" height="2.8" rx="1.4" fill="url(#ss)" filter="url(#sf)"/>')
    for d in paths:
        out.append(f'  <path d="{d}" fill="url(#sg)" filter="url(#sf)"/>')
    out.append('  <circle cx="64" cy="64" r="22" fill="url(#sc)"/>')
    return '\n'.join(defs), '\n'.join(out)


CONCEPTS = [
    (f'spark-{form}-{palette}', f'Искра · {FORMS[form][0]} · {PALETTE_NAMES[palette]}', (lambda m=None, f=form, p=palette: spark(f, p, m)),
     f'A sparkle of light ({form}) in the {palette} colours, white at its heart')
    for form in FORMS for palette in PALETTES
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
    form = slug.split('-')[1]
    if slug.endswith('-spectrum'):
        _, mono = make(WHITE)
        write(f'lumatic-spark-{form}-mono.svg', svg(128, 128, mono, 'Lumatic', f'A sparkle of light ({form}) in one colour'))
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
    spectrum = PALETTES['spectrum']
    color = spectrum[min(len(spectrum) - 1, int(t * len(spectrum)))]
    w = (width - (n - 1) * 6) / n
    bars.append(f'  <rect x="{r(24 + k * (w + 6))}" y="92" width="{r(w)}" height="6" rx="3" fill="{color}" opacity="{r(0.55 + 0.45 * math.sin(math.pi * t))}"/>')
write('lumatic-wordmark.svg', svg(width + 48, 120, f'  <rect width="{r(width + 48)}" height="120" rx="20" fill="{PANEL}"/>\n{name}\n' + '\n'.join(bars), 'Lumatic', 'The name Lumatic with a row of lights in many colours under it'))
print('written to', OUT)
