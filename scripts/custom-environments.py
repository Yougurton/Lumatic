"""
Builds the editor's ready-made Chroma environments from their authors' repositories (cloned beside):

    python3 scripts/custom-environments.py <ChaseEnvs> <BSCEL> <Chroma-Environments>

- MadChase — https://github.com/MadChase/ChaseEnvs (MIT)
- Phøenix — https://github.com/Phoenix-BS/BSCEL (MIT; credit the environments' makers)
- Lonely (and Fatalution's edit) — https://github.com/LonelyCen/Chroma-Environments (free to use with
  credit, as its README says)

Writes public/custom-envs/<id>.json (the environment as a v3 difficulty's custom data, and the game's
environment it's built on), <id>.jpg (the author's picture, small), licenses/<collection>.txt, and
src/editor/custom-environments.json (what the editor lists: names, authors, notes).
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'custom-envs'
CATALOG = ROOT / 'src' / 'editor' / 'custom-environments.json'

COLLECTIONS = [
    {'id': 'madchase', 'name': 'ChaseEnvs', 'author': 'MadChase', 'source': 'https://github.com/MadChase/ChaseEnvs', 'license': 'MIT License, © 2025 MadChase'},
    {'id': 'bscel', 'name': 'BSCEL', 'author': 'Phøenix', 'source': 'https://github.com/Phoenix-BS/BSCEL', 'license': 'MIT License, © 2023 Phoenix. Автор просит указывать создателей окружений.'},
    {'id': 'lonely', 'name': "Lonely's Chroma Environments", 'author': 'Lonely', 'source': 'https://github.com/LonelyCen/Chroma-Environments', 'license': 'Свободно для использования с указанием автора (README репозитория).'},
]

MADCHASE = {
    'cage': ('Cage', 'Куб в клетке, дорожка из летящих блоков.', 'Rotating lasers — маленькие лазеры сверху. Ring neons: куб в центре — ID 101, подсветка под дорожкой — 150–153, лазеры вокруг — 2001–2010.'),
    'cage alt': ('Cage Alt', 'Вариант Cage: куб в клетке, дорожка из летящих блоков.', 'Rotating lasers — ID 11–17 (не вращаются событиями). Back lasers — подсветка снизу, ID 150–153. Ring neons: куб — 101, лазеры вокруг — 2001–2010.'),
    'collider': ('Collider', 'Огромная труба с лазерами по кругу и летающими кубами.', 'Back lasers — все лазеры, ID 101–154. Left rotating lasers — кубы, ID 101–115. Left center lights — заполняющий свет, ID 1000–1129.'),
    'movin': ('Movin', 'Большой движущийся треугольник без конца.', 'Big rings — все движущиеся огни, ID 101–364 (внизу: 346, 142–179 и 101–125, остальные — две верхние стороны).'),
    'cave': ('Cave', 'Пещера из кубов, вода как облака внизу. Очень тяжёлая (тысячи кубов).', 'Center lights — 5 лазеров на вас, ID 101, 102, 103, 110, 115 слева направо. Left/Right lasers — из воды, ID 1, 7, 13, 19, 25. Back lasers — заливка сзади.'),
    'believer': ('Believer', 'По песне Believer: много светящейся геометрии.', 'Back lasers — заливка без ID. Ring lights: 101–103 большие лазеры (101 центр, 102 лево, 103 право), 104–106 стороны пирамиды, 107–109 шары, 110 — пол (очень яркий). Left/Right lasers — ID 1, 7, 13, 19, 22, 25 от ближних к дальним. Треки шаров: Ballleft, Ballmid, Ballright.'),
    'galaxy': ('Galaxy', 'Летящая галактика в небе.', 'Left rotating laser — сияния, ID 101–125; треки Aurora1…Aurora26.'),
    'moses': ('Moses', 'Расступающееся море, много отражений и лазеров.', 'Sunbeams и солнце — как в игре (солнце больше, с треком). Left/Right lasers — ID 1–9 от ближних к дальним. Water 1–4 — линии на полу, ID 1–2; Water 3 ID 101 — брызги вдали; Water 4 ID 5–6 — большие лазеры у водопадов.'),
    '360 env': ('360', 'Для 360-карт: 72 лазера вокруг игрока.', 'Всё на Left/Right rotating lasers: ID 1–36 на каждой стороне.'),
}

LONELY = [
    ('BTS Plat/BTS.dat', 'BTS Plat/BTS Example.png', 'lonely-bts', 'BTS Enhanced', 'Lonely', 'Окружение из карты «The 15 Sublimit»: кольцо кубов вокруг центра.'),
    ('BTS Plat/Witch.dat', 'BTS Plat/Witch Example.jpg', 'lonely-bts-witch', 'BTS Witch Edit', 'Fatalution (по окружению Lonely)', 'Правка BTS Enhanced: дорожка возвращена, кольцо кубов ровно вокруг центра.'),
    ('Billie Plat/Billie.dat', 'Billie Plat/Billie Example.png', 'lonely-billie', 'Billie Enhanced', 'Lonely', 'Хэллоуинская переделка Billie, самое сложное окружение автора.'),
    ('Panic Plat/Panic.dat', 'Panic Plat/Panic Example.png', 'lonely-panic', 'Panic Enhanced', 'Lonely', 'Первое окружение автора, подходит к самым разным песням.'),
]

# (BSCEL variants and the picture each has)
BSCEL_PICTURES = {
    'Accelerate NSL': 'Accelerate (No Start Line)',
    'Overflow (P)': 'Overflow (Pulse)',
    'Arches CN': 'Arches (CloudNone)',
    'Tunnel LA': 'Tunnel (Light Tunnel)',
    'Signal (C)': 'Signal (Clearing)',
    'Lilly (Dawn)': 'Lilly',
    'Lilly (Dusk)': 'Lilly',
    'Lilly (Midnight)': 'Lilly',
    'Lilly (Rainbow)': 'Lilly',
}

V2_KEYS = {'_id': 'id', '_lookupMethod': 'lookupMethod', '_active': 'active', '_scale': 'scale', '_position': 'position', '_localPosition': 'localPosition', '_rotation': 'rotation', '_localRotation': 'localRotation', '_track': 'track', '_duplicate': 'duplicate'}
V2_TO_V3 = {'id', 'lookupMethod', 'active', 'scale', 'position', 'localPosition', 'rotation', 'localRotation', 'track', 'duplicate'}


def lenient_json(text: str):
    """JSON as the authors wrote it (a trailing comma here and there)."""
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', text))


def v3_entry(entry: dict) -> dict:
    """A v2 environment entry in v3 keys (v2 positions are in lanes of 0.6 m)."""
    out = {}
    for key, value in entry.items():
        if key == '_lightID':
            out['components'] = {'ILightWithId': {'lightID': value}}
        elif key in V2_KEYS:
            name = V2_KEYS[key]
            out[name] = [round(v * 0.6, 6) for v in value] if name in ('position', 'localPosition') else value
    return out


def fits_v2(data: dict) -> bool:
    """Plain environment entries only (what a v2 difficulty can take)."""
    if data['customEvents'] or data['materials'] or data['pointDefinitions']:
        return False
    for entry in data['environment']:
        for key, value in entry.items():
            if key == 'components':
                if set(value.keys()) != {'ILightWithId'} or set(value['ILightWithId'].keys()) - {'lightID'}:
                    return False
            elif key not in V2_TO_V3:
                return False
    return True


def needs_noodle(data: dict) -> bool:
    return any(event.get('t') in ('AssignTrackParent', 'AssignPlayerToTrack') for event in data['customEvents'])


def thumbnail(source: Path, target: Path):
    image = Image.open(source).convert('RGB')
    image.thumbnail((480, 480))
    image.save(target, quality=82)


def note(text: str, limit=900) -> str:
    """A README's text, plain."""
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'[#*`]+', '', text)
    text = re.sub(r'\n\s*\n+', '\n', text).strip()
    return text if len(text) <= limit else text[: limit - 1].rsplit(' ', 1)[0] + '…'


def write(id_: str, environment_name: str, data: dict):
    (OUT / f'{id_}.json').write_text(json.dumps({'environmentName': environment_name, **data}, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')


def main():
    chase, bscel, lonely = (Path(arg) for arg in sys.argv[1:4])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'licenses').mkdir(exist_ok=True)
    (OUT / 'licenses' / 'madchase.txt').write_text((chase / 'LICENSE').read_text(encoding='utf-8'), encoding='utf-8')
    (OUT / 'licenses' / 'bscel.txt').write_text((bscel / 'LICENSE').read_text(encoding='utf-8'), encoding='utf-8')
    (OUT / 'licenses' / 'lonely.txt').write_text(note((lonely / 'README.md').read_text(encoding='utf-8'), 2000), encoding='utf-8')
    entries = []

    for folder in sorted((chase / 'Main Envs').iterdir()):
        name, summary, lights = MADCHASE[folder.name.lower()]
        raw = json.loads((folder / 'env.dat').read_text(encoding='utf-8'))
        data = {key: raw.get(key, [] if key in ('environment', 'customEvents') else {}) for key in ('environment', 'materials', 'customEvents', 'pointDefinitions')}
        id_ = 'madchase-' + re.sub(r'[^a-z0-9]+', '-', folder.name.lower()).strip('-')
        write(id_, raw['environmentName'], data)
        thumbnail(folder / 'PIC.png', OUT / f'{id_}.jpg')
        entries.append({'id': id_, 'collection': 'madchase', 'name': name, 'author': 'MadChase', 'environment': raw['environmentName'], 'summary': summary, 'lights': lights, 'noodle': needs_noodle(data) or name.startswith('Cage'), 'v2': fits_v2(data)})

    # (its "User Environments" are for players' own environment setting, not for maps)
    for path in sorted((bscel / 'Main Environments').glob('*/*/*.dat')):
        if path.parts[-3] == 'User Environments':
            continue
        raw = lenient_json(path.read_text(encoding='utf-8-sig'))
        data = {'environment': raw.get('environment', []), 'materials': raw.get('materials', {}), 'customEvents': [], 'pointDefinitions': {}}
        stem = path.stem
        picture = path.parent / f'{BSCEL_PICTURES.get(stem, stem)}.png'
        id_ = 'bscel-' + re.sub(r'[^a-z0-9]+', '-', stem.lower()).strip('-')
        write(id_, raw['environmentName'], data)
        if picture.exists():
            thumbnail(picture, OUT / f'{id_}.jpg')
        readme = path.parent / 'README.md'
        entries.append({
            'id': id_,
            'collection': 'bscel',
            'name': raw.get('name', stem),
            'author': raw.get('author', 'Phøenix'),
            'environment': raw['environmentName'],
            # (its description says only what it's called, but for the edits)
            'summary': raw.get('description', '') if 'Edit' in raw.get('description', '') else '',
            'lights': note(readme.read_text(encoding='utf-8')) if readme.exists() else '',
            'noodle': needs_noodle(data),
            'v2': fits_v2(data),
            'picture': picture.exists(),
        })

    for dat, picture, id_, name, author, summary in LONELY:
        folder = lonely / 'Environments'
        raw = json.loads('{' + (folder / dat).read_text(encoding='utf-8-sig') + '}')
        data = {'environment': [v3_entry(entry) for entry in raw['_environment']], 'materials': {}, 'customEvents': [], 'pointDefinitions': {}}
        environment = {'BTS': 'BTSEnvironment', 'Witch': 'BTSEnvironment', 'Billie': 'BillieEnvironment', 'Panic': 'PanicEnvironment'}[Path(dat).stem]
        write(id_, environment, data)
        thumbnail(folder / picture, OUT / f'{id_}.jpg')
        readme = note((folder / Path(dat).parent / 'README.md').read_text(encoding='utf-8'))
        entries.append({'id': id_, 'collection': 'lonely', 'name': name, 'author': author, 'environment': environment, 'summary': summary, 'lights': readme, 'noodle': False, 'v2': fits_v2(data)})

    for entry in entries:
        entry.setdefault('picture', True)
    CATALOG.write_text(json.dumps({'collections': COLLECTIONS, 'environments': entries}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(len(entries), 'environments')


if __name__ == '__main__':
    main()
