import { CubeCamera, HalfFloatType, LinearFilter, Mesh, Vector3, WebGLCubeRenderTarget, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three';

/**
 * Live reflections: a material that reflects what's round it as it is now — a chrome shape (the game's
 * InterscopeCar) shows the scene bent by its own form, the player's platform behind the camera too. Its
 * surroundings are taken into a small cube map from where the shapes made of it stand, every frame
 * (as the mirror floors are), the shapes themselves hidden meanwhile.
 *
 * One cube map a material: shapes sharing one reflect from the middle of them.
 */
interface LiveReflection {
  target: WebGLCubeRenderTarget;
  camera: CubeCamera;
  material: Material;
  meshes: Object3D[];
}

const reflections = new Set<LiveReflection>();
const SIZE = 128;

/** A cube map for a material to reflect (let go when the material is). */
export function liveReflectionTarget(material: Material) {
  const target = new WebGLCubeRenderTarget(SIZE, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
  const camera = new CubeCamera(0.05, 2000, target);
  const reflection: LiveReflection = { target, camera, material, meshes: [] };
  reflections.add(reflection);
  material.addEventListener('dispose', () => {
    reflections.delete(reflection);
    target.dispose();
  });
  return target;
}

/** Which meshes are made of each live material (after the scene is built anew). */
export function findLiveReflectionMeshes(scene: Scene) {
  if (reflections.size === 0) return;
  for (const reflection of reflections) reflection.meshes = [];
  const byMaterial = new Map([...reflections].map((reflection) => [reflection.material, reflection]));
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) byMaterial.get(material as Material)?.meshes.push(object);
  });
}

const centre = new Vector3();
const point = new Vector3();

/** Before a frame: each live material's surroundings taken anew. */
export function renderLiveReflections(renderer: WebGLRenderer, scene: Scene) {
  for (const reflection of reflections) {
    const shown = reflection.meshes.filter((mesh) => mesh.visible && mesh.parent !== null);
    if (shown.length === 0) continue;
    centre.set(0, 0, 0);
    for (const mesh of shown) centre.add(mesh.getWorldPosition(point));
    centre.divideScalar(shown.length);
    for (const mesh of shown) mesh.visible = false;
    reflection.camera.position.copy(centre);
    reflection.camera.updateMatrixWorld();
    const before = renderer.getRenderTarget();
    reflection.camera.update(renderer, scene);
    renderer.setRenderTarget(before);
    for (const mesh of shown) mesh.visible = true;
  }
}

export const hasLiveReflections = () => reflections.size > 0;
