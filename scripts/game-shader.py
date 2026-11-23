"""Read one of the game's shaders as GLSL, for study (nothing of it goes into the repository).

    python3 scripts/game-shader.py <Beat Saber folder> <environment, e.g. coldplay> <material> <vp|fp> <out folder> [pass]

Finds the shader variant the material uses (by its keywords), takes its compiled DirectX 11 program
out of the shader's blob, restores the DXBC checksum Unity zeroes, and turns it into GLSL with
vkd3d-compiler (DXBC -> SPIR-V) and spirv-cross (SPIR-V -> GLSL), both from the system's packages.
The names of the constants are not in the program: cb0 is $Globals (material and global values),
the last buffer the per-instance (material property block) values.
"""
import importlib.util
import math
import os
import struct
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ge', os.path.join(here, 'game-environments.py'))
ge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ge)
from UnityPy.helpers import CompressionHelper  # noqa: E402

# (the DXBC checksum: MD5's rounds with its own padding)
S = [7,12,17,22]*4 + [5,9,14,20]*4 + [4,11,16,23]*4 + [6,10,15,21]*4
K = [int(abs(math.sin(i+1)) * 2**32) & 0xffffffff for i in range(64)]
def rol(x, c): return ((x << c) | (x >> (32-c))) & 0xffffffff
def transform(state, block):
    M = struct.unpack('<16I', block)
    a, b, c, d = state
    for i in range(64):
        if i < 16: f = (b & c) | (~b & d); g = i
        elif i < 32: f = (d & b) | (~d & c); g = (5*i+1) % 16
        elif i < 48: f = b ^ c ^ d; g = (3*i+5) % 16
        else: f = c ^ (b | (~d & 0xffffffff)); g = (7*i) % 16
        f = (f + a + K[i] + M[g]) & 0xffffffff
        a, d, c = d, c, b
        b = (b + rol(f, S[i])) & 0xffffffff
    return [(x+y) & 0xffffffff for x, y in zip(state, [a,b,c,d])]
def checksum(dxbc):
    data = dxbc[20:]; size = len(data)
    state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
    num_bits = (size*8) & 0xffffffff; num_bits2 = ((num_bits >> 2) | 1) & 0xffffffff
    leftover = size % 64; full = size - leftover
    for i in range(0, full, 64): state = transform(state, data[i:i+64])
    rest = data[full:]
    if leftover >= 56:
        blk = rest + b'\x80' + b'\0'*(63-leftover)
        state = transform(state, blk)
        blk = struct.pack('<I', num_bits) + b'\0'*56 + struct.pack('<I', num_bits2)
        state = transform(state, blk)
    else:
        blk = struct.pack('<I', num_bits) + rest + b'\x80'
        blk = blk + b'\0'*(60-len(blk)) + struct.pack('<I', num_bits2)
        state = transform(state, blk)
    return struct.pack('<4I', *state)

if len(sys.argv) < 6:
    raise SystemExit(__doc__)
game, env, matname, stage, out = sys.argv[1:6]
passi = int(sys.argv[6]) if len(sys.argv) > 6 else 0
os.makedirs(out, exist_ok=True)
c = ge.Converter(game, env, os.path.join(here, '..', 'public', 'environments'))
mat = None
for a in c.env.assets:
    for o in a.objects.values():
        if o.type.name == 'Material':
            m = o.read()
            if m.m_Name == matname: mat = m
want = set(getattr(mat, 'm_ValidKeywords', []) or [])
shader = mat.m_Shader.read()
pf = shader.m_ParsedForm; names = pf.m_KeywordNames
print('shader', pf.m_Name, 'material kw', sorted(want))
blob = bytes(shader.compressedBlob)
segs = [CompressionHelper.decompress_lz4(blob[off:off+cl], dl) for off, cl, dl in zip(shader.offsets[0], shader.compressedLengths[0], shader.decompressedLengths[0])]
table = segs[0]
p = pf.m_SubShaders[0].m_Passes[passi]
prog = {'fp': p.progFragment, 'vp': p.progVertex}[stage]
subs = [(t, i, s) for t, tier in enumerate(prog.m_PlayerSubPrograms) for i, s in enumerate(tier)]
best = None
for tier_index, sub_index, sp in subs:
    kws = set(names[k] for k in sp.m_KeywordIndices)
    score = len(kws & want) * 10 - len(kws - want) - len(want - kws) * 5
    if best is None or score > best[0]: best = (score, sp, kws, tier_index, sub_index)
score, sp, kws, tier_index, sub_index = best
print('extra', sorted(kws - want), 'missing', sorted(want - kws))
off, ln, sg = struct.unpack_from('<iii', table, 4 + sp.m_BlobIndex * 12)
data = segs[sg][off:off+ln]
d = bytearray(data[data.find(b'DXBC'):])
size = struct.unpack_from('<I', d, 24)[0]; d = d[:size]
d[4:20] = checksum(bytes(d))
base = os.path.join(out, f'{matname}_{stage}{passi}')
open(base + '.dxbc', 'wb').write(d)
subprocess.run(['vkd3d-compiler', '-x', 'dxbc-tpf', '-b', 'spirv-binary', '-o', base + '.spv', base + '.dxbc'], check=True)
glsl = subprocess.run(['spirv-cross', '--version', '330', '--no-es', base + '.spv'], capture_output=True, text=True).stdout
open(base + '.glsl', 'w').write(glsl)
print('lines', glsl.count('\n'), base + '.glsl')

# (the program's parameter table: each constant's name and its place — byte offset in its buffer,
# divided by 16 the vec4 index in the GLSL above, the remainder /4 the component)
import re
pbi = prog.m_ParameterBlobIndices[tier_index][sub_index]
off, ln, sg = struct.unpack_from('<iii', table, 4 + pbi * 12)
params = segs[sg][off:off + ln]
lines = []
for m in re.finditer(rb'[\x01-\x40]\x00\x00\x00([_$A-Za-z][_A-Za-z0-9]{0,63})', params):
    length = struct.unpack_from('<I', params, m.start())[0]
    name = m.group(1)[:length].decode()
    if len(name) != length:
        continue
    end = (m.start() + 4 + length + 3) & ~3
    values = struct.unpack_from('<6i', params, end) if end + 24 <= len(params) else ()
    if len(values) == 6 and values[0] == 0 and values[1] == 1:
        lines.append(f'  {name}: [{values[5] // 16}].{"xyzw"[(values[5] % 16) // 4]} ({values[2]} wide)')
    else:
        lines.append(f'{name}')
open(base + '.params.txt', 'w').write('\n'.join(lines) + '\n')
print('parameters', base + '.params.txt')
