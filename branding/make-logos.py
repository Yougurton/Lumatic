"""
Lumatic's logo concepts as SVG files (branding/logos/): the lambda of lasers and the spark, each in a few
palettes — its icon, the icon with the name beside it, and the icon in one colour. The name is drawn as outlines of Inter Display (SIL Open Font
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


# ----- the palettes: not the game's red and blue — the lights can be any colour ---------------------------

PALETTES = {
    # a colour for each beam / arm, round the colour wheel
    'spectrum': ['#ff4f8b', '#ff9a3d', '#ffd84a', '#4dffb8', '#3dc8ff', '#8f6bff'],
    # two neon colours that aren't the game's own
    'neon': ['#ff4fd8', '#ff4fd8', '#ff4fd8', '#3de0ff', '#3de0ff', '#3de0ff'],
    # the editor's own accent, blue to violet
    'accent': ['#6aa6ff', '#7f9cff', '#9890ff', '#b084ff', '#9890ff', '#6aa6ff'],
}


def tile(fill=BG):
    return f'  <rect width="128" height="128" rx="28" fill="{fill}"/>'


def fade_gradient(id_, x1, y1, x2, y2, color, start=1.0, end=0.12):
    return (f'    <linearGradient id="{id_}" gradientUnits="userSpaceOnUse" x1="{r(x1)}" y1="{r(y1)}" x2="{r(x2)}" y2="{r(y2)}">'
            f'<stop offset="0" stop-color="{color}" stop-opacity="{start}"/><stop offset="1" stop-color="{color}" stop-opacity="{end}"/></linearGradient>')


def leg_stops(palette, side):
    """A leg's colours from the light at its foot up to where the legs meet."""
    c = PALETTES[palette]
    if palette == 'spectrum':
        return [c[0], c[1], c[2]] if side == 0 else [c[5], c[4], c[3]]
    return [c[side * 3 + 1]] * 3


def lambda_lasers(palette, mono=None):
    """The Greek L (Λ) drawn by lasers: two beams from lights on the floor meet up high and cross a
    little, as beams do; fainter beams fan out to the outside. No crossbar — it's a lambda, not an A."""
    colors = PALETTES.get(palette, [])
    left, right, apex = (30, 106), (98, 106), (64, 22)
    defs = []
    out = [] if mono else [tile()]
    if not mono:
        defs.append(glow('fl', 1.8))
        defs.append(f'    <radialGradient id="al" cx="{apex[0]}" cy="{apex[1]}" r="10" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{WHITE}" stop-opacity="0.95"/><stop offset="1" stop-color="{WHITE}" stop-opacity="0"/></radialGradient>')
    out.append('  <g stroke-linecap="round"' + ('' if mono else ' filter="url(#fl)"') + '>')
    # the fan: beams turned outward from each leg, fading out
    for side, (ox, oy) in ((0, left), (1, right)):
        dx, dy = apex[0] - ox, apex[1] - oy
        for k, spread in enumerate((13, 26)):
            a = math.atan2(dy, dx) + math.radians(spread) * (-1 if side == 0 else 1)
            length = 74 - k * 10
            x2, y2 = ox + math.cos(a) * length, oy + math.sin(a) * length
            if mono:
                out.append(f'    <line x1="{ox}" y1="{oy}" x2="{r(x2)}" y2="{r(y2)}" stroke="{mono}" stroke-width="{r(2.6 - k * 0.6)}" opacity="{r(0.6 - k * 0.15)}"/>')
            else:
                color = leg_stops(palette, side)[1 + k] if palette == 'spectrum' else colors[side * 3 + 1]
                gid = f'fan{side}{k}'
                defs.append(fade_gradient(gid, ox, oy, x2, y2, color, 0.9, 0.0))
                out.append(f'    <line x1="{ox}" y1="{oy}" x2="{r(x2)}" y2="{r(y2)}" stroke="url(#{gid})" stroke-width="{r(3 - k * 0.7)}"/>')
    # the legs: a little past the apex, so they cross there; the right stroke heavier, as the letter is written
    for side, (ox, oy) in ((0, left), (1, right)):
        dx, dy = apex[0] - ox, apex[1] - oy
        x2, y2 = apex[0] + dx * 0.14, apex[1] + dy * 0.14
        width = 8 if side else 5.5
        if mono:
            out.append(f'    <line x1="{ox}" y1="{oy}" x2="{r(x2)}" y2="{r(y2)}" stroke="{mono}" stroke-width="{width}"/>')
            continue
        a, b, c = leg_stops(palette, side)
        gid = f'leg{side}'
        defs.append(f'    <linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{ox}" y1="{oy}" x2="{r(x2)}" y2="{r(y2)}"><stop offset="0" stop-color="{a}"/><stop offset="0.45" stop-color="{b}"/><stop offset="0.8" stop-color="{c}"/><stop offset="0.93" stop-color="{WHITE}"/><stop offset="1" stop-color="{WHITE}" stop-opacity="0.3"/></linearGradient>')
        out.append(f'    <line x1="{ox}" y1="{oy}" x2="{r(x2)}" y2="{r(y2)}" stroke="url(#{gid})" stroke-width="{width}"/>')
    out.append('  </g>')
    if not mono:
        out.append(f'  <circle cx="{apex[0]}" cy="{apex[1]}" r="10" fill="url(#al)"/>')
    # the two lights on the floor
    for side, (ox, oy) in ((0, left), (1, right)):
        out.append(f'  <circle cx="{ox}" cy="{oy}" r="{6 if side else 5}" fill="{mono or leg_stops(palette, side)[0]}"/>')
    return '\n'.join(defs), '\n'.join(out)


def spark(palette, mono=None):
    """A spark of light: a four-pointed sparkle, each arm its own colour, white only at its very heart —
    one star and nothing else."""
    colors = PALETTES.get(palette, [])
    cx, cy, outer, inner = 64, 64, 50, 17
    arms = []
    for k in range(4):
        a = math.radians(-90 + k * 90)
        tip = (cx + math.cos(a) * outer, cy + math.sin(a) * outer)
        side1 = (cx + math.cos(a - math.pi / 4) * inner, cy + math.sin(a - math.pi / 4) * inner)
        side2 = (cx + math.cos(a + math.pi / 4) * inner, cy + math.sin(a + math.pi / 4) * inner)
        bend = (cx + math.cos(a) * inner * 1.15, cy + math.sin(a) * inner * 1.15)
        # (curved in towards the middle: a sparkle, not a plain star)
        d = (f'M{r(cx)} {r(cy)} L{r(side1[0])} {r(side1[1])} Q{r(bend[0])} {r(bend[1])} {r(tip[0])} {r(tip[1])}'
             f' Q{r(bend[0])} {r(bend[1])} {r(side2[0])} {r(side2[1])}Z')
        arms.append((d, tip))
    if mono:
        # (one outline: the arms' own shapes would leave hairlines where they meet)
        d = ''
        for k in range(4):
            a = math.radians(-90 + k * 90)
            tip = (cx + math.cos(a) * outer, cy + math.sin(a) * outer)
            nxt = math.radians(-90 + (k + 1) * 90)
            between = (cx + math.cos(a + math.pi / 4) * inner * 0.55, cy + math.sin(a + math.pi / 4) * inner * 0.55)
            next_tip = (cx + math.cos(nxt) * outer, cy + math.sin(nxt) * outer)
            d += (f'M{r(tip[0])} {r(tip[1])}' if k == 0 else '') + f' Q{r(between[0])} {r(between[1])} {r(next_tip[0])} {r(next_tip[1])}'
        return '', f'  <path d="{d}Z" fill="{mono}"/>'
    # an arm's colour each: top, right, bottom, left
    pick = {'spectrum': [2, 4, 5, 0], 'neon': [0, 3, 3, 0], 'accent': [3, 1, 3, 0]}[palette]
    defs = [glow('fs', 2.4), f'    <radialGradient id="cs" cx="{cx}" cy="{cy}" r="13" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{WHITE}"/><stop offset="0.5" stop-color="{WHITE}" stop-opacity="0.7"/><stop offset="1" stop-color="{WHITE}" stop-opacity="0"/></radialGradient>']
    out = [tile(), '  <g filter="url(#fs)">']
    for k, (d, tip) in enumerate(arms):
        gid = f'arm{k}'
        color = colors[pick[k]]
        defs.append(f'    <linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{cx}" y1="{cy}" x2="{r(tip[0])}" y2="{r(tip[1])}"><stop offset="0" stop-color="{WHITE}"/><stop offset="0.2" stop-color="{color}"/><stop offset="1" stop-color="{color}"/></linearGradient>')
        out.append(f'    <path d="{d}" fill="url(#{gid})"/>')
    out.append('  </g>')
    out.append(f'  <circle cx="{cx}" cy="{cy}" r="13" fill="url(#cs)"/>')
    return '\n'.join(defs), '\n'.join(out)


CONCEPTS = [
    ('lambda-spectrum', 'Λ-лазеры · спектр', lambda m=None: lambda_lasers('spectrum', m), 'The Greek letter lambda drawn by laser beams in many colours meeting over a stage'),
    ('lambda-neon', 'Λ-лазеры · неон', lambda m=None: lambda_lasers('neon', m), 'The Greek letter lambda drawn by magenta and cyan laser beams meeting over a stage'),
    ('lambda-accent', 'Λ-лазеры · акцент', lambda m=None: lambda_lasers('accent', m), 'The Greek letter lambda drawn by blue-violet laser beams meeting over a stage'),
    ('spark-spectrum', 'Искра · спектр', lambda m=None: spark('spectrum', m), 'A four-pointed sparkle, each arm a different colour, white at its heart'),
    ('spark-neon', 'Искра · неон', lambda m=None: spark('neon', m), 'A four-pointed sparkle in magenta and cyan, white at its heart'),
    ('spark-accent', 'Искра · акцент', lambda m=None: spark('accent', m), 'A four-pointed sparkle in blue and violet, white at its heart'),
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
    _, mono = make(WHITE)
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
    spectrum = PALETTES['spectrum']
    color = spectrum[min(len(spectrum) - 1, int(t * len(spectrum)))]
    w = (width - (n - 1) * 6) / n
    bars.append(f'  <rect x="{r(24 + k * (w + 6))}" y="92" width="{r(w)}" height="6" rx="3" fill="{color}" opacity="{r(0.55 + 0.45 * math.sin(math.pi * t))}"/>')
write('lumatic-wordmark.svg', svg(width + 48, 120, f'  <rect width="{r(width + 48)}" height="120" rx="20" fill="{PANEL}"/>\n{name}\n' + '\n'.join(bars), 'Lumatic', 'The name Lumatic with a row of lights in many colours under it'))
print('written to', OUT)
