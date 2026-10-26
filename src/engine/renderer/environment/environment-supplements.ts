import type { EnvironmentData } from './types';

/**
 * Stand-ins for what the environment data has no picture of: sprite lights whose sprite isn't in the
 * data (the game's art isn't redistributable) get a quad of their own with one of ChroEditor's
 * procedural textures (scripts/stand-in-textures.py), so they light up — tinted and dimmed by their
 * light events as the game's are — instead of being nothing. Band logos aren't copied (trademarks):
 * where one stands, a plain shape of about its size does.
 *
 * Sizes are the sprite's own (Unity units at a scale of 1); the object's scale applies on top.
 */

interface SpriteStandIn {
  /** The object's name starts with this. */
  name: string;
  texture: string;
  width: number;
  height: number;
  /** White at the heart when bright (neon), or keeping its colour throughout (glass). */
  white: boolean;
}

const WINDOW = 'textures/chroeditor-window-gothic.png';
const FRAMES = 'textures/chroeditor-twin-frames.png';
const STRIPES = 'textures/chroeditor-slanted-stripes.png';
const GLOW = 'textures/chroeditor-glow-radial.png';

// (sizes measured against the game: the shape in each texture fills less than all of it — the rest is
// its glow)
const STAND_INS: Record<string, SpriteStandIn[]> = {
  // two tall gothic windows high at the back, each lit by its own light (scaled ×10: 2.65 m × 7.5 m
  // each, 5 m apart)
  PanicEnvironment: [{ name: 'Window', texture: WINDOW, width: 0.386, height: 0.867, white: false }],
  // the band's sign far up ahead: two upright frames (about 10 m × 15 m together)
  BTSEnvironment: [{ name: 'MagicDoorSprite', texture: FRAMES, width: 12.5, height: 17.5, white: true }],
  // the band's sign on the floor either side: three slanted stripes along the track (scaled ×4: about
  // 9.4 m long)
  SkrillexEnvironment: [{ name: 'Logo', texture: STRIPES, width: 2.57, height: 0.45, white: true }],
  // the small dots on the rings' lasers
  Dragons2Environment: [{ name: 'Dot', texture: GLOW, width: 1, height: 1, white: true }],
};

const MARK = '__chroeditor_stand_ins';

export function supplementEnvironment(data: EnvironmentData) {
  const standIns = STAND_INS[data.id];
  if (standIns === undefined || (data.materials as Record<string, unknown>)[MARK] !== undefined) return;
  // (once per data: the loaded data may be kept and loaded again)
  Object.defineProperty(data.materials, MARK, { value: true, enumerable: false });
  data.objects.forEach((object, index) => {
    const standIn = standIns.find((item) => object.name.startsWith(item.name));
    const controller = object.components?.SpriteLightController?.[0];
    // (its sprite renderer — none, or the object's own, which the data has no picture for)
    const ownRenderer = controller?.Renderer === null || controller?.Renderer?.obj === index;
    if (standIn === undefined || controller === undefined || !ownRenderer || object.mesh !== undefined) return;
    const meshName = `__chroeditor_quad_${String(standIn.width)}x${String(standIn.height)}`;
    data.meshes[meshName] ??= quad(standIn.width, standIn.height);
    const materialName = `__chroeditor_sprite_${standIn.texture}${standIn.white ? '_white' : ''}`;
    data.materials[materialName] ??= {
      name: materialName,
      shader: 'ChroEditor/Sprite Light',
      family: 'fakeGlow',
      colors: { _Color: [1, 1, 1, 1] },
      // (as the game's own sprite lights: hardly any fog)
      floats: { _BloomType: standIn.white ? 2 : 0, _ZWrite: 0, _CullMode: 0, _UseFogForLights: 1, _FogScale: 0.02, _FogStartOffset: 0 },
      textures: { _MainTex: { asset: standIn.texture, scale: [1, 1], offset: [0, 0] } },
      keywords: [],
    };
    object.mesh = meshName;
    object.materials = [materialName];
    object.rendererEnabled = true;
  });
}

/** A quad in the XY plane, centred, facing +Z (a sprite as Unity draws it). */
function quad(width: number, height: number) {
  const x = width / 2;
  const y = height / 2;
  return {
    positions: [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

/** The stand-in textures (drawn whole, not tiled). */
export const STAND_IN_TEXTURES = new Set([WINDOW, FRAMES, STRIPES, GLOW]);
