"""
Builds an environment for the editor from the user's own installed copy of Beat Saber.

    python3 scripts/game-environments.py <Beat Saber folder> <environment> <output folder> [<reference>]
    python3 scripts/game-environments.py --dump-reference

    <environment>   the name the game's files use for it: panic2, rockmixtape, weave …
    <output folder> gets <Id>.json (the same format as public/environments/*.json), textures/ and
                    <Id>.report.json (what the converter did not understand)

Nothing it writes may be committed or shipped: it is the game's data and stays on the user's
computer. Needs UnityPy (MIT) and Pillow.

The game's scene is turned into the vocabulary the engine already speaks (ChroViewer's): the game's
TubeBloomPrePassLight becomes a ParametricBloomFogLightController, its light-with-id components
become the light controllers with Kind/Type/ID, its light groups become the group effects, and so on.
"""

import collections
import glob
import hashlib
import json
import math
import os
import sys

import UnityPy

SHARED = ['sharedassets_', 'maincore_assets', 'textmeshprofonts', 'core_assets', 'default_assets', 'unitybuiltin']

# (game shader → the engine's shader name and material family)
SHADERS = {
    'Custom/SimpleLit': ('ChroMapper/Lit', 'lit'),
    'Custom/TransparentNeonLight': ('ChroMapper/Parametric Box Transparent', 'lightTubeTransparent'),
    'Custom/OpaqueNeonLight': ('ChroMapper/Parametric Box Opaque', 'lightTubeOpaque'),
    'Custom/Parametric3SliceSprite': ('ChroMapper/Parametric Slice Billboard', 'fakeGlow'),
    'Custom/ParametricBoxFakeGlow': ('ChroMapper/Parametric Box Fake Glow', 'fakeGlow'),
    'Custom/CustomParticles': ('Custom/CustomParticles', 'customParticles'),
    'Custom/SetDepthOnly': ('Custom/SetDepthOnly', 'depthOnly'),
    'Custom/Mirror': ('ChroMapper/Mirror', 'mirror'),
    'Custom/SimpleStencil': ('Custom/SimpleStencil', 'stencil'),
}

# (objects that are the game's own machinery, not the environment)
DROP_COMPONENTS = {
    'SceneDecoratorContext', 'EnvironmentSceneSetup', 'EnvironmentBrandingManager', 'CoreGameHUDController',
    'LightSwitchEventEffect', 'LightWithIdManager', 'SaberBurnMarkSparkles', 'Canvas', 'StaticBatchedMeshContainer',
    'LightColorGroupEffectManager', 'LightRotationGroupEffectManager', 'LightTranslationGroupEffectManager', 'FloatFxGroupEffectManager',
}
# (materials the engine has nothing to draw with)
SKIP_MATERIALS = {'SaberBurnMarks', 'SaberBurnMarkSparkle'}
# (renderers the game keeps switched off in the scene file and turns on, or draws batched, itself)
RUNTIME_RENDERERS = {'StaticBatchableMesh', 'Parametric3SliceSpriteController', 'ParametricBoxController', 'RectangleFakeGlow'}
MANAGERS = ['LightColorGroupEffectManager', 'LightRotationGroupEffectManager', 'LightTranslationGroupEffectManager', 'FloatFxGroupEffectManager']


def vec(v, keys='xyz'):
    return [round(float(getattr(v, k)), 7) for k in keys]


# The engine's data is right-handed: Unity's with z negated.
def position(v):
    return [round(float(v.x), 7), round(float(v.y), 7), round(-float(v.z), 7) + 0.0]


def rotation(q):
    return [round(-float(q.x), 7) + 0.0, round(-float(q.y), 7) + 0.0, round(float(q.z), 7), round(float(q.w), 7)]


def color(c):
    return [round(float(c[k]), 7) for k in 'rgba']


def num(v):
    return round(float(v), 7) if isinstance(v, float) else int(v)


def curve(c):
    return {'keys': [{'time': num(k['time']), 'value': num(k['value']), 'inSlope': num(k['inSlope']), 'outSlope': num(k['outSlope'])} for k in c['m_Curve']]}


def reference_materials(reference):
    """The engine's own materials, which the converted ones take the engine-only properties from: a
    folder of the engine's environments, or the list made of them (--dump-reference)."""
    if os.path.isfile(reference):
        with open(reference, encoding='utf-8') as f:
            return json.load(f)
    materials, seen = [], set()
    for path in sorted(glob.glob(os.path.join(reference, '*.json'))):
        with open(path, encoding='utf-8') as f:
            for mat in json.load(f).get('materials', {}).values():
                key = (mat['shader'], mat['name'], tuple(mat['keywords']))
                if key not in seen:
                    seen.add(key)
                    materials.append({k: mat[k] for k in ('name', 'shader', 'keywords', 'floats', 'colors')})
    return materials


class Converter:
    def __init__(self, game, name, reference):
        self.reference = reference_materials(reference)
        try:
            with open(os.path.join(game, 'BeatSaberVersion.txt'), encoding='utf-8') as f:
                self.game_version = f.read().strip()
        except OSError:
            self.game_version = ''
        folder = os.path.join(game, 'Beat Saber_Data', 'StreamingAssets', 'aa', 'StandaloneWindows64')
        wanted = [name + 'environment_scenes', name + 'environment_assets'] + SHARED
        files = [f for f in glob.glob(os.path.join(folder, '*.bundle')) if any(os.path.basename(f).startswith(w) or w in os.path.basename(f) for w in wanted)]
        if not any(name + 'environment_scenes' in f for f in files):
            raise SystemExit(f'No {name}environment_scenes_*.bundle in {folder}')
        builtin = os.path.join(game, 'Beat Saber_Data', 'Resources', 'unity default resources')
        self.env = UnityPy.load(*files, *([builtin] if os.path.exists(builtin) else []))
        self.scene = next(a for a in self.env.assets if any(o.type.name == 'RenderSettings' for o in a.objects.values()))
        self.unknown = collections.Counter()
        self.notes = []
        self.class_cache = {}
        self.objects = []          # output objects
        self.index = {}            # GameObject path id → output index
        self.comp_ref = {}         # game component path id → ObjectReference of what it became
        self.meshes = {}
        self.mesh_keys = {}
        self.materials = {}
        self.material_keys = {}
        self.textures = {}         # asset path → PIL image
        self.texture_keys = {}

    # ---- reading ----

    def cls(self, obj):
        key = (obj.assets_file.name, obj.path_id)
        if key not in self.class_cache:
            if obj.type.name != 'MonoBehaviour':
                self.class_cache[key] = obj.type.name
            else:
                try:
                    self.class_cache[key] = obj.read().m_Script.read().m_ClassName
                except Exception:
                    self.class_cache[key] = '?'
        return self.class_cache[key]

    def info(self):
        """The environment's EnvironmentInfoSO and its light groups' ScriptableObjects (by group id)."""
        info, groups = None, {}
        for asset in self.env.assets:
            for obj in asset.objects.values():
                if obj.type.name != 'MonoBehaviour':
                    continue
                c = self.cls(obj)
                if c == 'EnvironmentInfoSO':
                    info = obj
        return info

    # ---- scene tree ----

    def build_tree(self):
        self.transforms = {}
        self.go_components = {}   # GameObject path id → [(class, obj)]
        for obj in self.scene.objects.values():
            if obj.type.name in ('Transform', 'RectTransform'):
                self.transforms[obj.path_id] = obj.read()
        self.go_transform = {t.m_GameObject.path_id: t for t in self.transforms.values()}
        for obj in self.scene.objects.values():
            if obj.type.name == 'GameObject':
                go = obj.read()
                comps = []
                for c in go.m_Component:
                    co = c.component.deref()
                    comps.append((self.cls(co), co))
                self.go_components[obj.path_id] = comps
        roots = [t for t in self.transforms.values() if t.m_Father.path_id == 0]
        env_roots = [t for t in roots if t.m_GameObject.read().m_Name == 'Environment'] or roots
        for i, root in enumerate(env_roots):
            self.walk(root, -1, self.id, i, True)

    def dropped(self, t, go):
        classes = {c for c, _ in self.go_components[t.m_GameObject.path_id]}
        if classes & DROP_COMPONENTS:
            return True
        if go.m_Name.startswith('======'):
            return True
        if go.m_Name == 'BloomPass':  # (a copy drawn only into the game's bloom pre-pass)
            return True
        if go.m_Layer == 5:  # UI
            return True
        return False

    def walk(self, t, parent, path, sibling, root=False):
        go = t.m_GameObject.read()
        if not root and self.dropped(t, go):
            return
        chroma = f'{path}.[{sibling}]{go.m_Name}'
        index = len(self.objects)
        self.index[t.m_GameObject.path_id] = index
        out = {
            'name': go.m_Name,
            'parent': parent,
            # (the game keeps the environment's root switched off until the scene is set up)
            'active': True if root else bool(go.m_IsActive),
            'layer': int(go.m_Layer),
            'position': position(t.m_LocalPosition),
            'rotation': rotation(t.m_LocalRotation),
            'scale': vec(t.m_LocalScale),
            'components': {'ChromaIDMarker': [{'ChromaID': chroma, 'enabled': True}]},
        }
        self.objects.append(out)
        for i, child in enumerate(t.m_Children):
            self.walk(child.read(), index, chroma, i)

    # ---- references ----

    def obj_ref(self, pptr):
        """A reference to the output object a game Transform / GameObject / component is on."""
        if pptr is None or pptr.path_id == 0 or pptr.file_id != 0:
            return None
        obj = self.scene.objects.get(pptr.path_id)
        if obj is None:
            return None
        if obj.type.name == 'GameObject':
            go_id = obj.path_id
        else:
            go_id = obj.read().m_GameObject.path_id
        index = self.index.get(go_id)
        return None if index is None else {'obj': index}

    def renderer_ref(self, pptr):
        ref = self.obj_ref(pptr)
        return None if ref is None else {**ref, 'component': 'MeshRenderer', 'componentIndex': 0}

    def add(self, go_id, name, data, source=None):
        index = self.index.get(go_id)
        if index is None:
            return None
        comps = self.objects[index]['components'].setdefault(name, [])
        comps.append(data)
        ref = {'obj': index, 'component': name, 'componentIndex': len(comps) - 1}
        if source is not None:
            self.comp_ref[source] = ref
        return ref

    # ---- meshes, materials, textures ----

    def mesh_key(self, pptr):
        if pptr is None or pptr.path_id == 0:
            return None
        ident = (pptr.assetsfile.name if pptr.file_id == 0 else pptr.assetsfile.externals[pptr.file_id - 1].path, pptr.path_id)
        if ident in self.mesh_keys:
            return self.mesh_keys[ident]
        try:
            mesh = pptr.read()
            from UnityPy.helpers.MeshHelper import MeshHandler
            handler = MeshHandler(mesh)
            handler.process()
            flip = lambda v: (v[0], v[1], -v[2])
            data = {'positions': [round(float(x), 6) + 0.0 for v in handler.m_Vertices for x in flip(v)]}
            groups, indices = [], []
            triangles = handler.get_triangles()
            for material_index, sub in enumerate(triangles):
                start = len(indices)
                for tri in sub:
                    indices.extend((int(tri[0]), int(tri[2]), int(tri[1])))
                groups.append({'start': start, 'count': len(indices) - start, 'materialIndex': material_index})
            data['indices'] = indices
            if handler.m_Normals is not None and len(handler.m_Normals):
                data['normals'] = [round(float(x), 5) + 0.0 for v in handler.m_Normals for x in flip(v)]
            if handler.m_UV0 is not None and len(handler.m_UV0):
                data['uvs'] = [round(float(x), 6) for v in handler.m_UV0 for x in v[:2]]
            if handler.m_UV1 is not None and len(handler.m_UV1):
                data['secondaryUvs'] = [round(float(x), 6) for v in handler.m_UV1 for x in v[:2]]
            if handler.m_Colors is not None and len(handler.m_Colors):
                colors = [float(x) for v in handler.m_Colors for x in v[:4]]
                # (kept as bytes in some meshes: the engine has them from 0 to 1)
                scale = 255.0 if max(colors) > 1.0 else 1.0
                data['colors'] = [round(x / scale, 5) for x in colors]
            if len(groups) > 1:
                data['groups'] = groups
            digest = hashlib.sha1(json.dumps(data['positions']).encode()).hexdigest()[:8]
            key = f'{mesh.m_Name}@{digest}'
            self.meshes[key] = data
        except Exception as error:  # a mesh UnityPy can't read is reported, not fatal
            self.notes.append(f'mesh {ident}: {type(error).__name__}: {error}')
            key = None
        self.mesh_keys[ident] = key
        return key

    def texture(self, pptr):
        if pptr.path_id == 0:
            return None
        try:
            tex = pptr.read()
            if tex.object_reader.type.name != 'Texture2D':
                self.unknown[f'texture type {tex.object_reader.type.name}'] += 1
                return None
            ident = (tex.object_reader.assets_file.name, pptr.path_id)
            if ident not in self.texture_keys:
                image = tex.image
                digest = hashlib.sha1(image.tobytes()).hexdigest()[:16]
                asset = f'textures/game-{digest}.png'
                self.textures[asset] = image
                self.texture_keys[ident] = asset
            return self.texture_keys[ident]
        except Exception as error:
            self.notes.append(f'texture: {type(error).__name__}: {error}')
            return None

    def material_key(self, pptr):
        if pptr is None or pptr.path_id == 0:
            return None
        try:
            mat = pptr.read()
        except Exception as error:
            self.notes.append(f'material: {type(error).__name__}: {error}')
            return None
        ident = (mat.object_reader.assets_file.name, pptr.path_id)
        if ident in self.material_keys:
            return self.material_keys[ident]
        try:
            shader = mat.m_Shader.read().m_ParsedForm.m_Name
        except Exception:
            shader = '?'
        mapped = SHADERS.get(shader)
        if mapped is None:
            self.unknown[f'shader {shader}'] += 1
            mapped = (shader, 'unknown')
        props = mat.m_SavedProperties
        textures = {}
        for name, env in props.m_TexEnvs:
            asset = self.texture(env.m_Texture)
            if asset is not None:
                textures[name] = {'asset': asset, 'scale': vec(env.m_Scale, 'xy'), 'offset': vec(env.m_Offset, 'xy')}
        data = {
            'name': mat.m_Name,
            'shader': mapped[0],
            'family': mapped[1],
            'gameShader': shader,
            'colors': {name: [num(float(getattr(c, k))) for k in 'rgba'] for name, c in props.m_Colors},
            'floats': {name: num(float(v)) for name, v in props.m_Floats},
            'keywords': list(getattr(mat, 'm_ValidKeywords', None) or []),
        }
        if textures:
            data['textures'] = textures
        if mat.m_Name in SKIP_MATERIALS:
            data['family'] = 'skip'
        native = dict(data['floats'])
        self.fill_from_reference(data)
        self.engine_properties(data, native)
        key = mat.m_Name
        n = 1
        while key in self.materials and self.materials[key] != data:
            n += 1
            key = f'{mat.m_Name}#{n}'
        self.materials[key] = data
        self.material_keys[ident] = key
        return key

    def fill_from_reference(self, data):
        """The engine's shaders have properties the game's keep inside the shader (blend modes, bloom
        type, culling …): they are taken from the engine's own material that is most alike — the same
        shader, then the same name, then the most keywords in common."""
        best, score = None, None
        keywords = set(data['keywords'])
        for ref in self.reference:
            if ref['shader'] != data['shader']:
                continue
            other = set(ref['keywords'])
            s = (ref['name'] == data['name'], len(keywords & other) / max(1, len(keywords | other)))
            if score is None or s > score:
                best, score = ref, s
        if best is None:
            if data['family'] != 'unknown':
                self.notes.append(f"material {data['name']}: no material of the engine's with shader {data['shader']} to take defaults from")
            return
        for kind in ('floats', 'colors'):
            for name, value in best[kind].items():
                data[kind].setdefault(name, value)
        if score[1] < 1 and not score[0]:
            self.unknown[f"material {data['name']}: defaults from the engine's {best['name']} (keywords differ)"] += 1

    def engine_properties(self, data, native):
        """The engine-only properties that the game's material does say, under other names or as
        keywords (found by comparing the environments both have): they win over what the alike
        material had."""
        floats, keywords = data['floats'], set(data['keywords'])
        for engine, game in (('_BlendModeSrc', '_BlendSrcFactor'), ('_BlendModeDst', '_BlendDstFactor'), ('_BlendModeSrcA', '_BlendSrcFactorA'),
                             ('_BlendModeDstA', '_BlendDstFactorA'), ('_CullMode', '_Cull'), ('_Vertex', '_VertexMode')):
            if game in native:
                floats[engine] = native[game]
        if data['family'] != 'lit':
            boost = 2 if '_WHITEBOOSTTYPE_ALWAYS' in keywords else 1 if '_WHITEBOOSTTYPE_MAINEFFECT' in keywords else 0
            floats['_BloomType'] = boost
            floats['_BloomWhite'] = boost
        floats['_SquareAlpha'] = int('SQUARE_ALPHA' in keywords)
        floats['_UseFogForLights'] = int('USE_FOG_FOR_LIGHTS' in keywords)
        floats['_EnableYAxisBillboard'] = int('ENABLE_Y_AXIS_BILLBOARD' in keywords)
        floats['_EnableFog'] = int('FOG' in keywords or 'ENABLE_FOG' in keywords)

    def renderers(self):
        for go_id, comps in self.go_components.items():
            index = self.index.get(go_id)
            if index is None:
                continue
            out = self.objects[index]
            for c, obj in comps:
                if c == 'MeshFilter':
                    out['mesh'] = self.mesh_key(obj.read().m_Mesh)
                elif c == 'MeshRenderer':
                    r = obj.read()
                    out['rendererEnabled'] = bool(r.m_Enabled) or bool({c for c, _ in comps} & RUNTIME_RENDERERS)
                    out['materials'] = [self.material_key(m) for m in r.m_Materials]
            if 'materials' in out and out.get('mesh') is None:
                out.pop('mesh', None)

    # ---- lights ----

    def light_groups(self):
        """Light ids of the groups: id → (group id, element), and each group's ScriptableObject."""
        self.group_so = {}
        self.group_of_go = {}
        self.light_address = {}
        for go_id, comps in self.go_components.items():
            for c, obj in comps:
                if c == 'LightGroup':
                    so = obj.read()._lightGroupSO.read_typetree()
                    self.group_so[so['_groupId']] = so
                    self.group_of_go[go_id] = so['_groupId']
                    self.comp_ref[obj.path_id] = so['_groupId']
                    if not so['_sameIdElements']:
                        self.notes.append(f"light group {so['_groupName']}: its elements' lights have ids of their own (not handled)")
                    for element in range(so['_numberOfElements']):
                        self.light_address[so['_startLightId'] + element] = (so['_groupId'], element)
        for pptr in self.info_obj.read()._lightGroups._lightGroupSOList:
            so = pptr.read_typetree()
            if so['_groupId'] not in self.group_so:
                self.group_so[so['_groupId']] = so
                for element in range(so['_numberOfElements']):
                    self.light_address.setdefault(so['_startLightId'] + element, (so['_groupId'], element))
        self.basic = {}  # lights id → event type
        self.basic_effects = []
        for go_id, comps in self.go_components.items():
            for c, obj in comps:
                if c == 'LightSwitchEventEffect':
                    t = obj.read_typetree()
                    self.basic[t['_lightsID']] = t['_event']
                    self.basic_effects.append(t)
        self.basic_lights = collections.defaultdict(list)  # event type → refs, in the scene's order

    def address(self, light_id):
        if light_id in self.light_address:
            group, element = self.light_address[light_id]
            return {'Kind': 1, 'Type': group, 'ID': element}
        if light_id in self.basic:
            return {'Kind': 0, 'Type': self.basic[light_id], 'ID': -1}
        return {'Kind': 0, 'Type': -1, 'ID': light_id}

    def register(self, ref, address):
        if ref is None:
            return
        if address['Kind'] == 1:
            self.group_lights[address['Type']].append((address['ID'], ref))
        elif address['Type'] >= 0:
            lights = self.basic_lights[address['Type']]
            address['ID'] = len(lights)
            lights.append(ref)

    def components(self):
        self.group_lights = collections.defaultdict(list)
        self.fx_groups = []
        handled = {
            'Transform', 'RectTransform', 'MeshFilter', 'MeshRenderer', 'LightGroup', 'LightColorGroupParent', 'ZenjectBinding',
            'LightGroupElementsSpawner', 'LightGroupLinearLayouter', 'TubeBloomPrePassLight', 'RectangleFakeGlow',
            'ReflectionProbeBakingOverride', 'DisableOnPlatform', 'StaticBatchableMesh', 'StaticBatchedMeshContainer',
            'BloomFogEnvironment', 'LightGroupRotationXTransform', 'LightGroupRotationYTransform', 'LightGroupRotationZTransform',
            'LightGroupTranslationXTransform', 'LightGroupTranslationYTransform', 'LightGroupTranslationZTransform',
            'LightColorGroup', 'LightRotationGroup', 'LightTranslationGroup', 'IgnoreForReflectionProbeBaking', 'BakeIdMapper',
            'ColorArrayLightWithIdsGroupEntry', 'MaterialController',
        } | set(MANAGERS)
        # in the scene's order, so that the lights of the old event types get their ids in it
        order = sorted(self.go_components, key=lambda go_id: self.index.get(go_id, 1 << 30))
        # first pass: what other components point at
        for go_id in order:
            for c, obj in self.go_components[go_id]:
                if go_id not in self.index:
                    continue
                if c == 'MaterialPropertyBlockController':
                    t = obj.read()
                    self.add(go_id, c, {'Renderers': [r for r in (self.renderer_ref(p) for p in t._renderers) if r], 'enabled': bool(t.m_Enabled)}, obj.path_id)
                elif c == 'ParametricBoxController':
                    t = obj.read_typetree()
                    self.add(go_id, 'ParametricBoxLight', {
                        'Renderer': self.renderer_ref(obj.read()._meshRenderer), 'AlphaStart': num(t['alphaStart']), 'AlphaEnd': num(t['alphaEnd']),
                        'AlphaMultiplier': num(t['alphaMultiplier']), 'Width': num(t['width']), 'WidthStart': num(t['widthStart']),
                        'WidthEnd': num(t['widthEnd']), 'Center': num(t['heightCenter']), 'Height': num(t['height']), 'Length': num(t['length']),
                        'MinAlpha': num(t['minAlpha']), 'UseCollision': 0, 'CollisionHeight': 0, 'UpdateTransform': 1, 'enabled': bool(t['m_Enabled']),
                    }, obj.path_id)
                elif c == 'Parametric3SliceSpriteController':
                    t = obj.read_typetree()
                    self.add(go_id, 'ParametricSpriteLight', {
                        'Renderer': {'obj': self.index[go_id], 'component': 'MeshRenderer', 'componentIndex': 0},
                        'WidthMultiplier': num(t['_widthMultiplier']), 'Width': num(t['width']), 'Length': num(t['length']), 'Center': num(t['center']),
                        'AlphaMultiplier': num(t['alphaMultiplier']), 'MinAlpha': num(t['minAlpha']), 'AlphaStart': num(t['alphaStart']),
                        'AlphaEnd': num(t['alphaEnd']), 'WidthStart': num(t['widthStart']), 'WidthEnd': num(t['widthEnd']),
                        'UseCollision': 0, 'CollisionLength': 0, 'enabled': bool(t['m_Enabled']),
                    }, obj.path_id)
                    # (the game builds the sprite's quad itself; the engine has it as mesh "4")
                    self.objects[self.index[go_id]]['mesh'] = '4'
        for go_id in order:
            for c, obj in self.go_components[go_id]:
                if go_id not in self.index:
                    continue
                if c == 'MaterialPropertyBlockColorSetter':
                    t = obj.read_typetree()
                    self.add(go_id, c, {
                        'Controller': self.comp_ref.get(t['_materialPropertyBlockController']['m_PathID']), 'Property': t['_property'],
                        'InverseAlpha': int(t['_inverseAlpha']), 'DisableOnZeroAlpha': int(t['_disableOnZeroAlpha']),
                        'SendAlphaToProperty': int(t['_sendAlphaToProperty']), 'AlphaProperty': t['_alphaProperty'],
                        'MultiplyWithAlpha': int(t['_multiplyWithAlpha']), 'enabled': bool(t['m_Enabled']),
                    }, obj.path_id)
        # second pass: the lights
        for go_id in order:
            if go_id not in self.index:
                continue
            for c, obj in self.go_components[go_id]:
                if c in handled or c in ('MaterialPropertyBlockController', 'MaterialPropertyBlockColorSetter', 'ParametricBoxController', 'Parametric3SliceSpriteController'):
                    continue
                method = getattr(self, 'c_' + c, None)
                if method is None:
                    self.unknown[f'component {c}'] += 1
                    continue
                method(go_id, obj)

    def c_TubeBloomPrePassLightWithId(self, go_id, obj):
        t = obj.read_typetree()
        light_obj = self.scene.objects.get(t['_tubeBloomPrePassLight']['m_PathID'])
        if light_obj is None:
            return
        light = light_obj.read_typetree()
        light_go = light_obj.read().m_GameObject.path_id
        box = sprite = None
        for key, value in light.items():
            if isinstance(value, dict) and value.get('m_FileID') == 0 and value.get('m_PathID') in self.comp_ref:
                ref = self.comp_ref[value['m_PathID']]
                if isinstance(ref, dict) and ref['component'] == 'ParametricBoxLight':
                    box = ref
                elif isinstance(ref, dict) and ref['component'] == 'ParametricSpriteLight':
                    sprite = ref
        address = self.address(t['_ID'])
        fog = self.add(light_go, 'BloomFogObject', {
            'Length': 1, 'Center': 1, 'StartWidth': 1, 'EndWidth': 1, 'StartAlpha': 1, 'EndAlpha': 1, 'MultiplyLengthByAlphaBloomFogMultiplier': 1,
            'MultiplyLengthByAlphaMultiplier': 1, 'LightWidthMultiplier': 1, 'IntensityMultiplier': 1, 'BoostToWhite': 0, 'LimitAlpha': 0,
            'MinAlpha': 0, 'MaxAlpha': 1, 'enabled': True,
        })
        g = lambda key, default=0: num(light.get(key, default))
        data = {
            **address, 'Width': g('_width'), 'OverrideChildrenLength': g('_overrideChildrenLength'), 'Length': g('_length'), 'Center': g('_center'),
            'ColorAlphaMultiplier': g('_colorAlphaMultiplier'), 'BloomFogIntensityMultiplier': g('_bloomFogIntensityMultiplier'),
            'FakeBloomIntensityMultiplier': g('_fakeBloomIntensityMultiplier'), 'BoostToWhite': g('_boostToWhite'),
            'LightWidthMultiplier': g('_lightWidthMultiplier'), 'AddWidthToLength': g('_addWidthToLength'),
            'ThickenWithDistance': g('_thickenWithDistance'), 'ThickenCurve': curve(light['_thickenCurve']),
            'MinDistance': g('_minDistance'), 'MaxDistance': g('_maxDistance'), 'MinWidthMultiplier': g('_minWidthMultiplier'),
            'MaxWidthMultiplier': g('_maxWidthMultiplier'), 'DisableRenderersOnZeroAlpha': g('_disableRenderersOnZeroAlpha'),
            'BakedGlowWidthScale': g('_bakedGlowWidthScale', 1), 'MultiplyLengthByAlpha': g('_multiplyLengthByAlpha'),
            'AlphaToLengthCurve': curve(light['_alphaToLengthCurve']) if '_alphaToLengthCurve' in light else curve(light['_thickenCurve']),
            'AlphaToLengthBloomFogCurve': curve(light['_alphaToLengthBloomFogCurve']) if '_alphaToLengthBloomFogCurve' in light else curve(light['_thickenCurve']),
            'UpdateAlways': g('_updateAlways'), 'LimitAlpha': g('_limitAlpha'), 'MinAlpha': g('_minAlpha'), 'MaxAlpha': g('_maxAlpha', 1),
            'OverrideChildrenAlpha': g('_overrideChildrenAlpha'), 'StartAlpha': g('_startAlpha', 1), 'EndAlpha': g('_endAlpha', 1),
            'OverrideChildrenWidth': g('_overrideChildrenWidth'), 'StartWidth': g('_startWidth', 1), 'EndWidth': g('_endWidth', 1),
            'EnabledRenderers': 1, 'BoxLight': box, 'SpriteLight': sprite, 'BloomFog': fog,
            'MultiplyLengthByAlphaBloomFogMultiplier': 1, 'CollisionLength': 3.4028235e+38,
            'enabled': bool(light['m_Enabled']) and bool(t['m_Enabled']),
        }
        self.register(self.add(light_go, 'ParametricBloomFogLightController', data, obj.path_id), data)

    def c_MaterialLightWithId(self, go_id, obj):
        t = obj.read_typetree()
        data = {
            **self.address(t['_ID']), 'Renderer': self.renderer_ref(obj.read()._meshRenderer), 'SetAlphaOnly': int(t['_setAlphaOnly']),
            'AlphaIntensity': num(t['_alphaIntensity']), 'AlphaIntoColor': int(t['_alphaIntoColor']), 'SetColorOnly': int(t['_setColorOnly']),
            'MultiplyColorWithAlpha': int(t['_multiplyColorWithAlpha']), 'MultiplyColor': int(t['_multiplyColor']),
            'ColorMultiplier': num(t['_colorMultiplier']), 'Alpha': 0, 'Property': t['_colorProperty'], 'enabled': bool(t['m_Enabled']),
        }
        self.register(self.add(go_id, 'MaterialLightController', data, obj.path_id), data)

    def c_InstancedMaterialLightWithId(self, go_id, obj):
        t = obj.read_typetree()
        data = {
            **self.address(t['_ID']), 'MpbColorSetter': self.comp_ref.get(t['_materialPropertyBlockColorSetter']['m_PathID']),
            'Intensity': num(t['_intensity']), 'HDR': int(t['_hdr']), 'MinAlpha': num(t['_minAlpha']), 'SetColorOnly': int(t['_setColorOnly']),
            'MultiplyColorByAlpha': int(t['_multiplyColorByAlpha']), 'SaturateIntensity': int(t['_saturateIntensity']), 'enabled': bool(t['m_Enabled']),
        }
        self.register(self.add(go_id, 'InstancedMaterialLightController', data, obj.path_id), data)

    def c_RectangleFakeGlowLightWithId(self, go_id, obj):
        t = obj.read_typetree()
        glow_obj = self.scene.objects.get(t['_rectangleFakeGlow']['m_PathID'])
        glow = glow_obj.read_typetree()
        data = {
            **self.address(t['_ID']), 'MpbController': self.comp_ref.get(glow['_materialPropertyBlockController']['m_PathID']),
            'MinAlpha': num(t['_minAlpha']), 'AlphaMultiplier': num(t['_alphaMul']), 'Size': [num(glow['_size']['x']), num(glow['_size']['y'])],
            'EdgeSize': num(glow['_edgeSize']), 'enabled': bool(t['m_Enabled']),
        }
        self.register(self.add(go_id, 'RectangleFakeGlowLightController', data, obj.path_id), data)

    def c_SpriteLightWithId(self, go_id, obj):
        # (sprites are not drawn by the engine: the light keeps its place in the ids as a sink)
        t = obj.read_typetree()
        data = {**self.address(t['_ID']), 'enabled': bool(t['m_Enabled'])}
        self.register(self.add(go_id, 'LightSink', data, obj.path_id), data)
        self.unknown['SpriteLightWithId (kept as a light sink)'] += 1

    def c_ColorArrayLightWithIds(self, go_id, obj):
        """A mesh lit in pieces: the game's shader takes each vertex's colour from an array by the index
        in the mesh's second UVs (x * 10 + y), plus the renderer's offset in the array; every entry of the
        array is a light. The engine has no such shader, so the mesh is cut into its pieces — an object
        each, lit as any material light is."""
        t = obj.read_typetree()
        entries = {entry['_index']: entry['_lightId'] for entry in t['_colorArrayLightWithIds']}
        controllers = [self.scene.objects.get(p['m_PathID']) for p in t['_materialPropertyBlockControllers']]
        controllers = [c for c in controllers if c is not None]
        if not controllers:
            return
        # (the renderers share the array in equal parts, in the controllers' order)
        share = len(entries) // len(controllers)
        for k, controller in enumerate(controllers):
            for pptr in controller.read()._renderers:
                ref = self.obj_ref(pptr)
                if ref is None:
                    continue
                whole = self.objects[ref['obj']]
                mesh = self.meshes.get(whole.get('mesh'))
                if mesh is None or 'secondaryUvs' not in mesh:
                    self.notes.append(f"colour array on {whole['name']}: its mesh has no second UVs to cut it by")
                    continue
                uv2 = mesh['secondaryUvs']
                pieces = collections.defaultdict(list)
                indices = mesh['indices']
                for i in range(0, len(indices), 3):
                    v = indices[i]
                    pieces[int(round(uv2[2 * v] * 10 + uv2[2 * v + 1]))].append(indices[i:i + 3])
                chroma = whole['components']['ChromaIDMarker'][0]['ChromaID']
                for n, (piece, triangles) in enumerate(sorted(pieces.items())):
                    used = sorted({v for tri in triangles for v in tri})
                    remap = {v: i for i, v in enumerate(used)}
                    data = {'positions': [x for v in used for x in mesh['positions'][3 * v:3 * v + 3]], 'indices': [remap[v] for tri in triangles for v in tri]}
                    for key, size in (('normals', 3), ('uvs', 2), ('colors', 4)):
                        if key in mesh:
                            data[key] = [x for v in used for x in mesh[key][size * v:size * v + size]]
                    key = f"{whole['mesh']}#{piece}"
                    self.meshes[key] = data
                    index = len(self.objects)
                    light_id = entries.get(piece + k * share)
                    address = self.address(light_id) if light_id is not None else {'Kind': 0, 'Type': -1, 'ID': -1}
                    light = {
                        **address, 'Renderer': {'obj': index, 'component': 'MeshRenderer', 'componentIndex': 0}, 'SetAlphaOnly': 0, 'AlphaIntensity': 1,
                        'AlphaIntoColor': 0, 'SetColorOnly': 0, 'MultiplyColorWithAlpha': 0, 'MultiplyColor': 0, 'ColorMultiplier': 1, 'Alpha': 0,
                        'Property': '_Color', 'enabled': True,
                    }
                    self.objects.append({
                        'name': f"{whole['name']}Piece{piece}", 'parent': ref['obj'], 'active': True, 'layer': whole.get('layer', 0),
                        'position': [0, 0, 0], 'rotation': [0, 0, 0, 1], 'scale': [1, 1, 1], 'mesh': key, 'rendererEnabled': True,
                        'materials': list(whole.get('materials', [])),
                        'components': {'ChromaIDMarker': [{'ChromaID': f'{chroma}.[{n}]Piece{piece}', 'enabled': True}], 'MaterialLightController': [light]},
                    })
                    self.register({'obj': index, 'component': 'MaterialLightController', 'componentIndex': 0}, light)
                # (the whole mesh is not drawn any more: its pieces are)
                whole['rendererEnabled'] = False

    def c_TransformSpectrogram(self, go_id, obj):
        t = obj.read_typetree()
        transforms = [r for r in (self.obj_ref(p) for p in obj.read()._transforms) if r]
        self.add(go_id, 'TransformSpectrogram', {
            'Transforms': transforms, 'Axis': int(t['_axis']), 'MinPosition': num(t['_minPosition']), 'MaxPosition': num(t['_maxPosition']),
            'ScaleSamples': int(t['_scaleSamples']), 'Scale': num(t['_scale']), 'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_Mirror(self, go_id, obj):
        """A real mirror: the scene file has the material the game shows with its mirrors switched
        off; the game puts the mirror's own on when it starts. The engine's planar reflection, as on
        the floor of Big Mirror."""
        mirror = obj.read()
        ref = self.renderer_ref(mirror._renderer)
        if ref is None:
            return
        material = self.material_key(mirror._mirrorMaterial)
        if material is None or self.materials[material]['family'] != 'mirror':
            self.unknown['component Mirror (its material is not a mirror the engine has)'] += 1
            return
        target = self.objects[ref['obj']]
        target['materials'] = [material]
        plane = self.obj_ref(mirror._reflectionPlaneTransform) or {'obj': ref['obj']}
        comps = target['components'].setdefault('PlanarReflection', [])
        comps.append({'MirrorRenderer': {'asset': 'b54751a1fc3ac3983afa3aa9d4141095'}, 'Renderer': ref, 'PlaneTransform': plane, 'enabled': bool(obj.read_typetree()['m_Enabled'])})

    def c_DisableWhenMirrorIsEnabled(self, go_id, obj):
        # (what the game shows in the mirror's place when mirrors are off: the mirror is on here)
        index = self.index.get(go_id)
        if index is not None:
            self.objects[index]['active'] = False

    # ---- float effects (FX groups): what a group's value does to its elements ----

    def path_ref(self, pptr):
        """A reference to the output object of a game object or component given as the file has it."""
        if not pptr or pptr.get('m_FileID') != 0 or not pptr.get('m_PathID'):
            return None
        obj = self.scene.objects.get(pptr['m_PathID'])
        if obj is None:
            return None
        go_id = obj.path_id if obj.type.name == 'GameObject' else obj.read().m_GameObject.path_id
        index = self.index.get(go_id)
        return None if index is None else {'obj': index}

    def c_FloatMaterialPropertyEffectTarget(self, go_id, obj):
        t = obj.read_typetree()
        self.add(go_id, 'MpbFx', {
            'MpbController': self.comp_ref.get(t['_materialPropertyBlockController']['m_PathID']), 'PropertyName': t['_propertyName'],
            'ValueBounds': [num(t['_valueBounds']['x']), num(t['_valueBounds']['y'])], 'GranularityMultiplier': num(t['_granularityMultiplier']),
            'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_FloatArrayMaterialPropertyEffectTarget(self, go_id, obj):
        t = obj.read_typetree()
        self.add(go_id, 'MpbArrayFx', {
            'MpbControllers': [r for r in (self.comp_ref.get(p['m_PathID']) for p in t['_materialPropertyBlockControllers']) if r],
            'PropertyName': t['_propertyName'], 'ValueBounds': [num(t['_valueBounds']['x']), num(t['_valueBounds']['y'])],
            'GranularityMultiplier': num(t['_granularityMultiplier']), 'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_FloatLocalScaleEffect(self, go_id, obj):
        t = obj.read_typetree()
        self.add(go_id, 'LocalScaleFx', {
            'TargetTransforms': [r for r in (self.path_ref(p) for p in t['_transforms']) if r],
            'ValueBounds': [num(t['_valueBounds']['x']), num(t['_valueBounds']['y'])], 'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_Parametric3SliceSpriteWidthEndFloatFxEffectTarget(self, go_id, obj):
        t = obj.read_typetree()
        self.add(go_id, 'ParametricSliceEndWidthFx', {
            'SpriteLight': self.comp_ref.get(t['_parametric3SliceSpriteController']['m_PathID']),
            'ValueBounds': [num(t['_valueBounds']['x']), num(t['_valueBounds']['y'])], 'ValueMultiplier': num(t['_valueMultiplier']),
            'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_SwitchGameObjectArrayEffectTarget(self, go_id, obj):
        t = obj.read_typetree()
        self.add(go_id, 'SwitchGameObjectArrayFx', {
            'GameObjects': [{'Threshold': num(e['threshold']), 'GameObject': r} for e in t['gameObjects'] for r in [self.path_ref(e['gameObject'])] if r],
            'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_SwitchGameObjectEffectTarget(self, go_id, obj):
        t = obj.read_typetree()
        a, b = self.path_ref(t['_gameObject01']), self.path_ref(t['_gameObject02'])
        if a is None or b is None:
            return
        self.add(go_id, 'SwitchGameObjectFx', {'GameObjectA': a, 'GameObjectB': b, 'enabled': bool(t['m_Enabled'])}, obj.path_id)

    def c_VertexDisplacementFloatFxGroupEffectTarget(self, go_id, obj):
        t = obj.read_typetree()
        r = t['_displacementRanges']
        self.add(go_id, 'VertexDisplacementFx', {
            'Ranges': [num(r['x']), num(r['y']), num(r['z'])], 'XCurve': curve(t['_xAnimationCurve']), 'YCurve': curve(t['_yAnimationCurve']),
            'ZCurve': curve(t['_zAnimationCurve']), 'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_FloatFxGroup(self, go_id, obj):
        self.fx_groups.append(obj.read_typetree())

    def c_BoxCollider(self, go_id, obj):
        t = obj.read()
        self.add(go_id, 'BoxCollider', {'Center': vec(t.m_Center), 'Size': vec(t.m_Size), 'enabled': bool(t.m_Enabled)})

    def c_LightManager(self, go_id, obj):
        self.add(go_id, 'LightManager', {'enabled': True})

    def c_TrackLaneRing(self, go_id, obj):
        self.unknown['component TrackLaneRing (no rings manager in the scene: placed by a layouter)'] += 1

    def c_DirectionalLight(self, go_id, obj):
        t = obj.read_typetree()
        self.add(go_id, 'DirectionalLight', {'Color': color(t['color']), 'Intensity': num(t['intensity']), 'Radius': num(t['radius']), 'enabled': bool(t['m_Enabled'])}, obj.path_id)

    def intensity_refs(self, entries, go_id):
        refs = []
        for entry in entries:
            address = self.address(entry['_lightId'])
            data = {**address, 'Intensity': num(entry['_intensity']), 'enabled': True}
            ref = self.add(go_id, 'LightIntensityController', data)
            self.register(ref, data)
            refs.append(ref)
        return refs

    def c_DirectionalLightWithIds(self, go_id, obj):
        t = obj.read_typetree()
        light = next((self.comp_ref.get(o.path_id) for c, o in self.go_components[go_id] if c == 'DirectionalLight'), None)
        self.add(go_id, 'DirectionalLightsController', {
            'LightIntensityData': self.intensity_refs(t['_lightIntensityData'], go_id), 'Intensity': num(t.get('_intensity', 1)),
            'MaxIntensity': num(t.get('_maxIntensity', 1)), 'MultiplyColorByAlpha': int(t.get('_multiplyColorByAlpha', 1)),
            'MixType': int(t.get('_mixType', 0)), 'Light': light, 'SetIntensityOnly': int(t.get('_setIntensityOnly', 0)),
            'DefaultColor': color(t['_defaultColor']) if '_defaultColor' in t else [0, 0, 0, 0], 'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_BloomPrePassBackgroundColorsGradient(self, go_id, obj):
        t = obj.read_typetree()
        # (lit by a light — a controller on the same object: that one draws it, in the light's colour)
        if any(c == 'BloomPrePassBackgroundColorsGradientTintColorWithLightId' for c, _ in self.go_components[go_id]):
            return
        self.add(go_id, 'BackgroundGradient', {
            'ExecutionTime': int(t['_executionTimeType']), 'TintColor': color(t['_tintColor']),
            'Elements': [{'color': color(e['color']), 'startT': num(e['startT']), 'exp': num(e['exp'])} for e in t['_elements']],
            'enabled': bool(t['m_Enabled']),
        }, obj.path_id)

    def c_BloomPrePassBackgroundColorsGradientTintColorWithLightId(self, go_id, obj):
        t = obj.read_typetree()
        gradient = self.scene.objects.get(t['_bloomPrePassBackgroundColorsGradient']['m_PathID'])
        g = gradient.read_typetree() if gradient is not None else {'_tintColor': {'r': 1, 'g': 1, 'b': 1, 'a': 1}, '_elements': []}
        lights = t['_lightIntensityData']
        if len(lights) != 1:
            self.notes.append(f'background gradient: lit by {len(lights)} lights, the first is taken')
        first = lights[0] if lights else {'_lightId': -1, '_intensity': 1}
        data = {
            **self.address(first['_lightId']), 'LightIntensity': num(first['_intensity']),
            'Intensity': num(t['_intensity']), 'MaxIntensity': num(t['_maxIntensity']), 'MultiplyColorByAlpha': int(t['_multiplyColorByAlpha']),
            'MixType': int(t['_mixType']), 'TintColor': color(g['_tintColor']),
            'Elements': [{'color': color(e['color']), 'startT': num(e['startT']), 'exp': num(e['exp'])} for e in g['_elements']],
            'enabled': bool(t['m_Enabled']),
        }
        self.register(self.add(go_id, 'BackgroundGradientController', data, obj.path_id), data)

    # ---- group effects ----

    def managers(self):
        root = 0
        def manager(name, extra=None):
            index = len(self.objects)
            self.objects.append({'name': name, 'parent': root, 'active': True, 'position': [0, 0, 0], 'rotation': [0, 0, 0, 1], 'scale': [1, 1, 1], 'components': extra or {}})
            return index

        # the old event types
        basic = manager('BasicEventEffectController')
        boost = {'obj': basic, 'component': 'ColorBoostEffect', 'componentIndex': 0}
        entries = [{'Type': 5, 'Manager': boost}]
        effects = []
        for effect in sorted(self.basic_effects, key=lambda e: e['_event']):
            entries.append({'Type': effect['_event'], 'Manager': {'obj': basic, 'component': 'BasicLightEffect', 'componentIndex': len(effects)}})
            effects.append({
                'Atsc': None, 'ID': effect['_event'], 'ColorBoostEffect': boost, 'OffIntensity': num(effect['_offColorIntensity']),
                'LightOnStart': int(effect['_lightOnStart']), 'InvertColorScheme': 0, 'LightIdRemapEntries': [],
                'lightEntries': self.basic_lights.get(effect['_event'], []), 'enabled': True,
            })
        self.objects[basic]['components'] = {
            'BasicEventEffectManager': [{'effectEntries': entries, 'enabled': True}],
            'ColorBoostEffect': [{'Atsc': None, 'ID': 5, 'ColorScheme': None, 'Boost': 0, 'enabled': True}],
            'BasicLightEffect': effects,
        }

        refs = {'BasicEventEffectManager': {'obj': basic, 'component': 'BasicEventEffectManager', 'componentIndex': 0}}
        color_groups, rotation_groups, translation_groups = [], [], []
        for go_id, comps in self.go_components.items():
            for c, obj in comps:
                if c in ('LightColorGroup', 'LightRotationGroup', 'LightTranslationGroup'):
                    t = obj.read_typetree()
                    group = self.comp_ref.get(t['_lightGroup']['m_PathID'])
                    if not isinstance(group, int):
                        self.notes.append(f'{c}: its light group is not in the scene')
                        continue
                    {'LightColorGroup': color_groups, 'LightRotationGroup': rotation_groups, 'LightTranslationGroup': translation_groups}[c].append((group, t))

        def transform_entries(t):
            entries = []
            for axis, key in enumerate(('x', 'y', 'z')):
                for element, pptr in enumerate(t[f'_{key}Transforms']):
                    obj = self.scene.objects.get(pptr['m_PathID'])
                    index = None if obj is None else self.index.get(obj.read().m_GameObject.path_id)
                    if index is not None:
                        entries.append({'ID': element, 'Transforms': [{'obj': index}], 'Axis': axis, 'Mirrored': int(t[f'_mirror{key.upper()}'])})
            return entries

        index = manager('LightColorGroupEffectManager')
        effects, entries = [], []
        for group in sorted(self.group_so):
            so = self.group_so[group]
            lights = [ref for _, ref in sorted(self.group_lights.get(group, []), key=lambda l: l[0])]
            entries.append({'Group': group, 'Effect': {'obj': index, 'component': 'LightColorGroupEffect', 'componentIndex': len(effects)}})
            effects.append({'Atsc': None, 'ID': group, 'Count': so['_numberOfElements'], 'ColorBoostEffect': boost, 'lightEntries': lights, 'enabled': True})
        self.objects[index]['components'] = {'LightColorGroupEffectManager': [{'effectEntries': entries, 'enabled': True}], 'LightColorGroupEffect': effects}
        refs['LightColorGroupEffectManager'] = {'obj': index, 'component': 'LightColorGroupEffectManager', 'componentIndex': 0}

        index = manager('LightRotationGroupEffectManager')
        effects, entries = [], []
        for group, t in sorted(rotation_groups, key=lambda g: g[0]):
            entries.append({'Group': group, 'Effect': {'obj': index, 'component': 'LightRotationGroupEffect', 'componentIndex': len(effects)}})
            effects.append({'Atsc': None, 'ID': -1, 'Count': self.group_so[group]['_numberOfElements'], 'transformEntries': transform_entries(t), 'enabled': True})
        self.objects[index]['components'] = {'LightRotationGroupEffectManager': [{'effectEntries': entries, 'enabled': True}], 'LightRotationGroupEffect': effects}
        refs['LightRotationGroupEffectManager'] = {'obj': index, 'component': 'LightRotationGroupEffectManager', 'componentIndex': 0}

        index = manager('LightTranslationGroupEffectManager')
        effects, entries = [], []
        for group, t in sorted(translation_groups, key=lambda g: g[0]):
            limits = [[num(t[f'_{k}TranslationLimits']['x']), num(t[f'_{k}TranslationLimits']['y'])] for k in 'xyz']
            distribution = [[num(t[f'_{k}DistributionLimits']['x']), num(t[f'_{k}DistributionLimits']['y'])] for k in 'xyz']
            entries.append({'Group': group, 'Effect': {'obj': index, 'component': 'LightTranslationGroupEffect', 'componentIndex': len(effects)}})
            effects.append({
                'Atsc': None, 'ID': -1, 'Count': self.group_so[group]['_numberOfElements'], 'transformEntries': transform_entries(t),
                'TranslationLimits': limits, 'DistributionLimits': distribution, 'enabled': True,
            })
        self.objects[index]['components'] = {'LightTranslationGroupEffectManager': [{'effectEntries': entries, 'enabled': True}], 'LightTranslationGroupEffect': effects}
        refs['LightTranslationGroupEffectManager'] = {'obj': index, 'component': 'LightTranslationGroupEffectManager', 'componentIndex': 0}

        index = manager('FloatFxGroupEffectManager')
        effects, entries = [], []
        for t in self.fx_groups:
            group = self.comp_ref.get(t['_lightGroup']['m_PathID'])
            if not isinstance(group, int):
                self.notes.append('FloatFxGroup: its light group is not in the scene')
                continue
            fx = []
            for element, pptr in enumerate(t['_targets']):
                ref = self.comp_ref.get(pptr['m_PathID'])
                if isinstance(ref, dict):
                    fx.append({'ID': element, 'Targets': [ref]})
                else:
                    target = self.scene.objects.get(pptr['m_PathID'])
                    self.unknown[f"FX target {self.cls(target) if target is not None else '?'} (not understood)"] += 1
            entries.append({'Group': group, 'Effect': {'obj': index, 'component': 'FloatFxGroupEffect', 'componentIndex': len(effects)}})
            effects.append({'Atsc': None, 'ID': group, 'Count': self.group_so[group]['_numberOfElements'], 'Trigger': int(t['_isTriggerOnly']), 'fxEntries': fx, 'enabled': True})
        self.objects[index]['components'] = {'FloatFxGroupEffectManager': [{'effectEntries': entries, 'enabled': True}], 'FloatFxGroupEffect': effects}
        refs['FloatFxGroupEffectManager'] = {'obj': index, 'component': 'FloatFxGroupEffectManager', 'componentIndex': 0}
        return refs

    # ---- the whole thing ----

    def convert(self):
        info_obj = self.info()
        if info_obj is None:
            raise SystemExit('No EnvironmentInfoSO found')
        info = info_obj.read_typetree()
        self.info_obj = info_obj
        self.id = info['_serializedName']
        self.build_tree()
        self.renderers()
        self.light_groups()
        self.components()
        refs = self.managers()

        scheme_obj = info_obj.read()._colorScheme.read()
        scheme_tree = scheme_obj._colorScheme if hasattr(scheme_obj, '_colorScheme') else None
        st = info_obj.read()._colorScheme.read_typetree()['_colorScheme']
        rgb = lambda key: [num(st[key][k]) for k in 'rgb']
        scheme = {
            'colorLeft': rgb('_saberAColor'), 'colorRight': rgb('_saberBColor'), 'envColorLeft': rgb('_environmentColor0'),
            'envColorRight': rgb('_environmentColor1'), 'envColorWhite': rgb('_environmentColorW'), 'obstacleColor': rgb('_obstaclesColor'),
            'envColorLeftBoost': rgb('_environmentColor0Boost'), 'envColorRightBoost': rgb('_environmentColor1Boost'),
            'envColorWhiteBoost': rgb('_environmentColorWBoost'), 'supportsEnvironmentColorBoost': bool(st.get('_supportsEnvironmentColorBoost', True)),
        }
        fog = {'offset': 0, 'height': 10, 'startY': -100, 'attenuation': 0.001, 'autoExposureLimit': 1600}
        for comps in self.go_components.values():
            for c, obj in comps:
                if c == 'BloomFogEnvironment':
                    p = obj.read()._fogParams.read_typetree()
                    fog = {'offset': num(p['offset']), 'height': num(p['heightFogHeight']), 'startY': num(p['heightFogStartY']),
                           'attenuation': num(p['attenuation']), 'autoExposureLimit': num(p['autoExposureLimit'])}
        size = info['_environmentSizeData']
        floors = ['NoFloor', 'CloseTo0', 'Above0']
        ceilings = ['NoCeiling', 'LowCeiling', 'HighCeiling']
        lanes = ['None', 'Normal', 'Wide']
        pick = lambda names, i: names[i] if 0 <= i < len(names) else str(i)
        self.objects[0]['components']['EnvironmentDescriptor'] = [{
            'ID': self.id, **refs, 'RotationController': None,
            'ChromaIDMarkers': [{'obj': i, 'component': 'ChromaIDMarker', 'componentIndex': 0} for i, o in enumerate(self.objects) if 'ChromaIDMarker' in o['components']],
            'SizeData': {'FloorType': size['_floorType'], 'CeilingType': size['_ceilingType'], 'TrackLaneType': size['_trackLaneType']},
            'BloomFogParams': {'Offset': fog['offset'], 'Height': fog['height'], 'StartY': fog['startY'], 'Attenuation': fog['attenuation'], 'AutoExposureLimit': fog['autoExposureLimit']},
            'enabled': True,
        }]
        # (the sprite quad the engine expects under "4")
        if any(o.get('mesh') == '4' for o in self.objects):
            self.meshes['4'] = {
                'positions': [-1, 0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0, -1, 1, 0, 1, 1, 0],
                'uvs': [0, 0, 1, 0, 0, 0.25, 1, 0.25, 0, 0.75, 1, 0.75, 0, 1, 1, 1],
                'indices': [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6, 5, 7, 6],
            }
        groups = sorted(self.group_so.values(), key=lambda so: so['_groupId'])
        data = {
            'version': 1,
            'id': self.id,
            'title': info['_environmentName'],
            'source': 'game',
            'colorScheme': scheme,
            'fogParams': fog,
            'sizeData': {'floorType': pick(floors, size['_floorType']), 'ceilingType': pick(ceilings, size['_ceilingType']), 'trackLaneType': pick(lanes, size['_trackLaneType'])},
            'eventTracks': [{'name': 'Player Place', 'type': 4}, {'name': 'Boost Colors', 'type': 5}],
            'lightGroups': [{'id': so['_groupId'], 'name': so['_groupName'], 'count': so['_numberOfElements']} for so in groups],
            'meshes': self.meshes,
            'materials': self.materials,
            'objects': self.objects,
            'warnings': [],
        }
        report = {
            'id': self.id, 'title': info['_environmentName'], 'groups': len(groups), 'gameVersion': self.game_version,
            'unityVersion': str(self.scene.unity_version), 'objects': len(self.objects), 'meshes': len(self.meshes),
            'materials': len(self.materials), 'textures': len(self.textures),
            'notUnderstood': dict(sorted(self.unknown.items(), key=lambda kv: -kv[1])), 'notes': self.notes,
        }
        return data, report


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    dumped = os.path.join(here, 'game-environment-materials.json')
    if sys.argv[1:] == ['--dump-reference']:
        # (what the packaged app has beside this script instead of the environments' folder)
        with open(dumped, 'w', encoding='utf-8') as f:
            json.dump(reference_materials(os.path.join(here, '..', 'public', 'environments')), f, separators=(',', ':'))
        return
    if len(sys.argv) not in (4, 5):
        raise SystemExit(__doc__)
    game, name, out = sys.argv[1:4]
    folder = os.path.join(here, '..', 'public', 'environments')
    reference = sys.argv[4] if len(sys.argv) == 5 else folder if os.path.isdir(folder) else dumped
    converter = Converter(game, name.lower(), reference)
    data, report = converter.convert()
    os.makedirs(os.path.join(out, 'textures'), exist_ok=True)
    with open(os.path.join(out, f"{data['id']}.json"), 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    for asset, image in converter.textures.items():
        image.save(os.path.join(out, asset))
    with open(os.path.join(out, f"{data['id']}.report.json"), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    sys.stdout.buffer.write(json.dumps(report, ensure_ascii=True).encode('ascii') + b'\n')


if __name__ == '__main__':
    main()
