"""
The editor's Russian text that has no English yet: every Russian string in src/ and index.html (text
in HTML templates piece by piece, ${…} as {0}, {1}…) that src/editor/i18n-en.ts doesn't have.

  python3 scripts/i18n-check.py        (from the repository's folder; exits with 1 when some are missing)
"""
import re, sys, json, os, glob
CYR = re.compile('[А-Яа-яЁё]')
def tokens(src):
    """Yield (kind, text) string literals of a TS source: kind 'q' for quoted, 't' for template (with ${} replaced)."""
    i, n = 0, len(src)
    prev_sig = ''
    while i < n:
        c = src[i]
        if src.startswith('//', i):
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2); i = n if j < 0 else j + 2; continue
        if c in '\'"':
            j = i + 1; buf = []
            while j < n and src[j] != c:
                if src[j] == '\\': buf.append(src[j:j+2]); j += 2; continue
                buf.append(src[j]); j += 1
            yield ('q', ''.join(buf)); i = j + 1; prev_sig = 'x'; continue
        if c == '`':
            j, txt = template(src, i + 1)
            yield ('t', txt); i = j; prev_sig = 'x'; continue
        if c == '/' and prev_sig in ('', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return', '\n'):
            # regex literal
            j = i + 1; inclass = False
            while j < n and src[j] != '\n':
                if src[j] == '\\': j += 2; continue
                if src[j] == '[': inclass = True
                elif src[j] == ']': inclass = False
                elif src[j] == '/' and not inclass: break
                j += 1
            i = j + 1; prev_sig = 'x'; continue
        if not c.isspace():
            if c.isalnum() or c in '_$':
                m = re.match(r'[\w$]+', src[i:]); w = m.group(0)
                prev_sig = 'return' if w in ('return', 'typeof', 'case') else 'x'; i += len(w); continue
            prev_sig = c if c in '(,=:[!&|?{};' else 'x'
        i += 1
template_counter = [0]
def template(src, i):
    out = []; k = 0
    n = len(src)
    while i < n and src[i] != '`':
        if src[i] == '\\': out.append(src[i:i+2]); i += 2; continue
        if src.startswith('${', i):
            depth = 1; j = i + 2
            while j < n and depth:
                ch = src[j]
                if ch == '`':
                    j2, _ = template(src, j + 1); j = j2; continue
                if ch in '\'"':
                    q = ch; j += 1
                    while j < n and src[j] != q:
                        if src[j] == '\\': j += 1
                        j += 1
                    j += 1; continue
                if ch == '{': depth += 1
                elif ch == '}': depth -= 1
                j += 1
            inner = src[i+2:j-1]
            out.append('{%d}' % k); k += 1
            # nested literals inside ${} get scanned separately by caller via inner re-tokenizing
            nested.extend(tokens(inner))
            i = j; continue
        out.append(src[i]); i += 1
    return i + 1, ''.join(out)
nested = []
def unescape(s):
    return s.replace("\\'", "'").replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\').replace('\\`', '`')
def pieces(kind, text):
    text = unescape(text)
    if '<' in text and re.search(r'<[a-z/]', text):
        res = []
        for m in re.finditer(r'(?:title|placeholder|aria-label)="([^"]*)"', text):
            res.append(m.group(1))
        stripped = re.sub(r'<[^>]*>', '\x00', text)
        res += [p for p in stripped.split('\x00')]
        return [p.strip() for p in res if CYR.search(p)]
    return [text.strip()] if CYR.search(text) else []
def renumber(s):
    # placeholders renumbered in order of appearance
    idx = {}
    def r(m):
        key = m.group(0)
        idx.setdefault(len(idx), None)
        return '{%d}' % (len(idx) - 1)
    return re.sub(r'\{\d+\}', r, s)

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
known = set()
for line in open(os.path.join(root, 'src/editor/i18n-en.ts'), encoding='utf8'):
    m = re.match(r'\s*("(?:[^"\\]|\\.)*"):', line)
    if m: known.add(json.loads(m.group(1)))
files = sorted(glob.glob(root + '/src/**/*.ts', recursive=True)) + [root + '/index.html']
missing = {}
for f in files:
    if f.endswith('i18n-en.ts'): continue
    src = open(f, encoding='utf8').read()
    if f.endswith('.html'):
        found = [m.group(1) for m in re.finditer(r'(?:title|placeholder|aria-label)="([^"]*)"', src)]
        body = re.sub(r'<(style|script)\b.*?</\1>', '', src, flags=re.S)
        found += re.sub(r'<[^>]*>', '\x00', body).split('\x00')
        lits = [x.strip() for x in found if CYR.search(x)]
    else:
        nested.clear()
        lits = []
        for kind, txt in tokens(src):
            lits += pieces(kind, txt)
        for kind, txt in list(nested):
            lits += pieces(kind, txt)
    for l in lits:
        l = re.sub(r'\s+', ' ', renumber(l)).strip()
        if l and l not in known: missing.setdefault(l, os.path.relpath(f, root))
for text, f in missing.items():
    print(f'{f}\t{text}')
print(f'{len(missing)} without English', file=sys.stderr)
sys.exit(1 if missing else 0)
