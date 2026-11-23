import {
  AddEquation,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  CustomBlending,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  OneFactor,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type Material,
  type Texture,
} from 'three';

import { materialFogUniforms } from '../materials/shared';
import { FOG_CHUNK } from '../shaders/chunks';
import type { EnvironmentMaterialContext } from './materials/material-context';
import {
  particleEmitterPositionProperty,
  particleEmitterRadiusProperty,
  particleEmitterRotationProperty,
  particleEmitterScaleProperty,
  type EnvironmentParticleSystemData,
} from './types';

const PARTICLE_VERT = /* glsl */ `
attribute vec3 particleVelocity;
attribute float particleStart;
attribute float particleLifetime;
attribute float particleSize;
attribute float particleRotation;
uniform float _SongTime;
uniform float _Cycle;
uniform float _Prewarm;
uniform float _ViewportHeight;
varying float vAge;
varying float vLifetime;
varying float vRotation;
varying vec3 vWorldPos;
void main() {
  float elapsed = _SongTime - particleStart;
  float alive = step(0.0, elapsed);
  if (_Prewarm != 0.0) {
    elapsed += _Cycle;
    alive = 1.0;
  }
  float age = mod(max(elapsed, 0.0), _Cycle);
  alive *= 1.0 - step(particleLifetime, age);
  vec3 localPosition = position + particleVelocity * age;
  vec4 worldPosition = modelMatrix * vec4(localPosition, 1.0);
  vec4 viewPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * viewPosition;
  gl_PointSize = alive * particleSize * projectionMatrix[1][1] * _ViewportHeight * 0.5
    / max(-viewPosition.z, 0.001);
  vAge = age;
  vLifetime = particleLifetime;
  vRotation = particleRotation;
  vWorldPos = worldPosition.xyz;
}
`;

function alphaCurve(keys: readonly [number, number][]) {
  const glslFloat = (value: number) => (Number.isInteger(value) ? `${value}.0` : `${value}`);
  const sorted = [...keys].sort((a, b) => a[0] - b[0]);
  const first = sorted[0];
  if (first === undefined) return 'return 1.0;';
  let [previousTime, previousValue] = first;
  const lines = [`if (t <= ${glslFloat(previousTime)}) return ${glslFloat(previousValue)};`];
  for (const [time, value] of sorted.slice(1)) {
    lines.push(
      `if (t <= ${glslFloat(time)}) return mix(${glslFloat(previousValue)}, ${glslFloat(value)}, clamp((t - ${glslFloat(previousTime)}) / ${glslFloat(Math.max(time - previousTime, 1e-6))}, 0.0, 1.0));`,
    );
    previousTime = time;
    previousValue = value;
  }
  lines.push(`return ${glslFloat(previousValue)};`);
  return lines.join('\n');
}

function particleFragmentShader(system: EnvironmentParticleSystemData) {
  return /* glsl */ `
uniform sampler2D _MainTex;
uniform vec4 _Tint;
uniform float _Brightness;
uniform float _AlphaMultiplier;
uniform float _FogStartOffset;
uniform float _FogScale;
varying float vAge;
varying float vLifetime;
varying float vRotation;
varying vec3 vWorldPos;
${FOG_CHUNK}
float particleAlpha(float t) {
  ${alphaCurve(system.alphaKeys)}
}
void main() {
  float sine = sin(vRotation);
  float cosine = cos(vRotation);
  vec2 uv = gl_PointCoord - 0.5;
  uv = mat2(cosine, -sine, sine, cosine) * uv + 0.5;
  vec4 sampleColor = texture2D(_MainTex, uv);
  float textureAlpha = ${system.alphaChannelRed ? 'sampleColor.r' : 'sampleColor.a'};
  float alpha = textureAlpha * _Tint.a * _AlphaMultiplier
    * particleAlpha(clamp(vAge / max(vLifetime, 0.0001), 0.0, 1.0));
  ${system.squareAlpha ? 'alpha *= alpha;' : ''}
  vec3 color = _Tint.rgb * (1.0 + _Brightness);
  ${system.whiteBoost ? 'color += vec3(alpha);' : ''}
  vec4 outputColor = vec4(color * alpha, alpha);
  ${system.fogEnabled ? 'outputColor = applyTransparentLightFog(outputColor, vWorldPos, _FogStartOffset, _FogScale);' : ''}
  if (outputColor.a <= 0.0001) discard;
  gl_FragColor = outputColor;
}
`;
}

const MESH_PARTICLE_VERT = /* glsl */ `
attribute float particleStart;
attribute float particleLifetime;
attribute float particleSize;
attribute float particleRotation;
uniform float _SongTime;
uniform float _Cycle;
uniform float _Prewarm;
uniform float _RotationSpeed;
varying float vAge;
varying float vLifetime;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec4 vScreenPos;
void main() {
  float elapsed = _SongTime - particleStart;
  float alive = step(0.0, elapsed);
  if (_Prewarm != 0.0) {
    elapsed += _Cycle;
    alive = 1.0;
  }
  float age = mod(max(elapsed, 0.0), _Cycle);
  alive *= 1.0 - step(particleLifetime, age);
  // (the mesh turned about its own z, by its start rotation and its spin since)
  float angle = particleRotation + _RotationSpeed * age;
  float sine = sin(angle);
  float cosine = cos(angle);
  vec3 local = position * particleSize * alive;
  local.xy = mat2(cosine, sine, -sine, cosine) * local.xy;
  vec4 worldPosition = modelMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vScreenPos = vec4((gl_Position.xy + gl_Position.ww) * 0.5, gl_Position.zw);
  vAge = age;
  vLifetime = particleLifetime;
  vUv = uv;
  vWorldPos = worldPosition.xyz;
}
`;

function meshParticleFragmentShader(system: EnvironmentParticleSystemData) {
  const fogColor = system.fogColor ?? system.name === 'BigSmokePS';
  return /* glsl */ `
uniform sampler2D _MainTex;
uniform vec4 _Tint;
uniform float _Brightness;
uniform float _AlphaMultiplier;
uniform float _StartAlpha;
uniform float _FogStartOffset;
uniform float _FogScale;
varying float vAge;
varying float vLifetime;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec4 vScreenPos;
${FOG_CHUNK}
float particleAlpha(float t) {
  ${alphaCurve(system.alphaKeys)}
}
void main() {
  vec4 sampleColor = texture2D(_MainTex, vUv);
  float textureAlpha = ${system.alphaChannelRed ? 'sampleColor.r' : 'sampleColor.a'};
  float alpha = textureAlpha * _Tint.a * _AlphaMultiplier * _StartAlpha
    * particleAlpha(clamp(vAge / max(vLifetime, 0.0001), 0.0, 1.0));
  ${system.squareAlpha ? 'alpha *= alpha;' : ''}
  ${
    fogColor
      ? // (the haze takes the colour of the fog behind it: it brightens the sky in its own pattern)
        'vec3 color = chroFogColor(vScreenPos).rgb * _Tint.rgb * 2.0 * (1.0 + _Brightness) * 4.0;'
      : 'vec3 color = _Tint.rgb * (1.0 + _Brightness);'
  }
  ${system.whiteBoost ? 'color += vec3(alpha);' : ''}
  vec4 outputColor = vec4(color * alpha, alpha);
  ${system.fogEnabled && !fogColor ? 'outputColor = applyTransparentLightFog(outputColor, vWorldPos, _FogStartOffset, _FogScale);' : ''}
  if (outputColor.a <= 0.0001) discard;
  ${
    fogColor
      ? // (the haze is drawn over the sky but writes no glow: its alpha would bloom the whole view white)
        'outputColor.a = 0.0;'
      : ''
  }
  gl_FragColor = outputColor;
}
`;
}

/** Particles drawn as a mesh each — the game's haze around the player (BigSmokePS): a few cubes
 *  of smoke texture, 24 m across, that the player stands inside; each fades in and out over its
 *  life and turns slowly about the track's axis. */
function meshParticleGeometry(system: EnvironmentParticleSystemData) {
  const box = new BoxGeometry(1, 1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = box.index;
  geometry.setAttribute('position', box.getAttribute('position'));
  geometry.setAttribute('uv', box.getAttribute('uv'));
  const starts: number[] = [];
  const lifetimes: number[] = [];
  const sizes: number[] = [];
  const rotations: number[] = [];
  const { count, cycle } = meshParticleSchedule(system);
  for (let index = 0; index < count; index += 1) {
    const perLoop = Math.max(1, Math.floor(system.rate * (system.duration ?? 0) + 1e-6));
    const loop = Math.floor(index / perLoop);
    // (emitted through each loop of the system — the first a whole interval in — and each loop again)
    starts.push(system.duration === undefined ? index / system.rate : ((index % perLoop) + 1) / system.rate + loop * system.duration);
    lifetimes.push(system.lifetime[0] + (system.lifetime[1] - system.lifetime[0]) * random(index, 4));
    sizes.push(system.size[0] + (system.size[1] - system.size[0]) * random(index, 5));
    rotations.push(system.rotationRange[0] + (system.rotationRange[1] - system.rotationRange[0]) * random(index, 6));
  }
  geometry.setAttribute('particleStart', new InstancedBufferAttribute(new Float32Array(starts), 1));
  geometry.setAttribute('particleLifetime', new InstancedBufferAttribute(new Float32Array(lifetimes), 1));
  geometry.setAttribute('particleSize', new InstancedBufferAttribute(new Float32Array(sizes), 1));
  geometry.setAttribute('particleRotation', new InstancedBufferAttribute(new Float32Array(rotations), 1));
  geometry.instanceCount = count;
  box.dispose();
  return { geometry, cycle };
}

/** How many particles are drawn and how long their pattern takes to repeat. The game's emission
 *  starts over with each loop of the system (BigSmokePS: a cube 2 s and 4 s into each 5 s loop, each
 *  living 5 s — two cubes at any time); without the loop's length, one every interval. */
function meshParticleSchedule(system: EnvironmentParticleSystemData) {
  const longest = Math.max(system.lifetime[0], system.lifetime[1]);
  if (system.duration === undefined || system.duration <= 0) {
    return { count: system.maxParticles, cycle: system.maxParticles / system.rate };
  }
  const perLoop = Math.max(1, Math.floor(system.rate * system.duration + 1e-6));
  const loops = Math.max(1, Math.ceil(longest / system.duration));
  return { count: Math.min(perLoop * loops, Math.max(system.maxParticles, 1) * loops), cycle: system.duration * loops };
}

function isMeshParticleSystem(system: EnvironmentParticleSystemData) {
  return system.renderMode === 'mesh' || (system.renderMode === undefined && system.name === 'BigSmokePS');
}

function random(index: number, salt: number) {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function randomUnitVector(index: number, salt: number) {
  const y = random(index, salt) * 2 - 1;
  const angle = random(index, salt + 1) * Math.PI * 2;
  const radius = Math.sqrt(1 - y * y);
  return new Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
}

function particleGeometry(system: EnvironmentParticleSystemData) {
  const positions: number[] = [];
  const velocities: number[] = [];
  const starts: number[] = [];
  const lifetimes: number[] = [];
  const sizes: number[] = [];
  const rotations: number[] = [];
  const {
    [particleEmitterRotationProperty]: emitterEuler,
    [particleEmitterRadiusProperty]: emitterRadius,
    [particleEmitterScaleProperty]: emitterScale,
    [particleEmitterPositionProperty]: emitterPosition,
  } = system;
  const emitterRotation = new Quaternion().setFromEuler(
    new Euler(
      (emitterEuler[0] * Math.PI) / 180,
      (emitterEuler[1] * Math.PI) / 180,
      (emitterEuler[2] * Math.PI) / 180,
      'XYZ',
    ),
  );

  for (let index = 0; index < system.maxParticles; index += 1) {
    const direction = randomUnitVector(index, 0);
    const radius = emitterRadius * Math.cbrt(random(index, 2));
    const position = direction
      .clone()
      .multiplyScalar(radius)
      .multiply(new Vector3(...emitterScale))
      .applyQuaternion(emitterRotation)
      .add(new Vector3(...emitterPosition));
    const emissionDirection =
      system.randomDirection === 0 ? new Vector3(0, 1, 0).applyQuaternion(emitterRotation) : direction;
    const speed = system.speed[0] + (system.speed[1] - system.speed[0]) * random(index, 3);
    positions.push(position.x, position.y, position.z);
    velocities.push(emissionDirection.x * speed, emissionDirection.y * speed, emissionDirection.z * speed);
    starts.push(system.rate > 0 ? index / system.rate : 0);
    lifetimes.push(system.lifetime[0] + (system.lifetime[1] - system.lifetime[0]) * random(index, 4));
    sizes.push(system.size[0] + (system.size[1] - system.size[0]) * random(index, 5));
    rotations.push(system.rotationRange[0] + (system.rotationRange[1] - system.rotationRange[0]) * random(index, 6));
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('particleVelocity', new Float32BufferAttribute(velocities, 3));
  geometry.setAttribute('particleStart', new Float32BufferAttribute(starts, 1));
  geometry.setAttribute('particleLifetime', new Float32BufferAttribute(lifetimes, 1));
  geometry.setAttribute('particleSize', new Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('particleRotation', new Float32BufferAttribute(rotations, 1));
  return geometry;
}

/** Huge smoke sprites emitted right at the player's position (Lattice's BigSmokePS: 24 m
 *  billboards at the origin). In the game they surround the player's head and read as a soft haze;
 *  from a camera standing behind the player, as ours does, they're a flat grey square hanging in
 *  front of the view instead — so they're left out. */
function isPlayerEnvelopingSmoke(system: EnvironmentParticleSystemData) {
  if (system.name === 'BigSmokePS') return true;
  const [x, y, z] = system.position;
  const [sx, sy, sz] = system.shapePosition;
  const distance = Math.hypot(x + sx, y + sy, z + sz);
  return system.size[0] >= 10 && distance < 6;
}

export function buildEnvironmentParticleSystems(
  systems: readonly EnvironmentParticleSystemData[],
  context: EnvironmentMaterialContext,
  root: Group,
  geometries: Map<string, BufferGeometry>,
  materials: Set<Material>,
) {
  const viewport = new Vector2();
  for (const [index, system] of systems.entries()) {
    const texture = context.textures?.get(system.texture);
    if (texture === undefined || system.maxParticles === 0 || system.rate <= 0) continue;
    if (isMeshParticleSystem(system)) {
      buildMeshParticleSystem(system, index, texture, context, root, geometries, materials);
      continue;
    }
    if (isPlayerEnvelopingSmoke(system)) continue;
    const geometry = particleGeometry(system);
    const material = new ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: particleFragmentShader(system),
      uniforms: {
        ...materialFogUniforms(context.fog, {
          enabled: system.fogEnabled,
          heightEnabled: system.heightFogEnabled,
        }),
        _MainTex: { value: texture },
        _Tint: { value: new Vector4(...system.tint) },
        _Brightness: { value: system.brightness },
        _AlphaMultiplier: { value: system.alphaMultiplier },
        _SongTime: context.songTime ?? { value: 0 },
        _Cycle: { value: system.maxParticles / system.rate },
        _Prewarm: { value: system.prewarm ? 1 : 0 },
        _ViewportHeight: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
    });
    material.onBeforeRender = (renderer) => {
      const viewportHeight = material.uniforms._ViewportHeight;
      if (viewportHeight !== undefined) viewportHeight.value = renderer.getDrawingBufferSize(viewport).y;
    };

    const node = new Group();
    node.name = system.name;
    node.position.set(...system.position);
    node.quaternion.set(...system.rotation);
    node.scale.set(...system.scale);
    const points = new Points(geometry, material);
    points.name = `${system.name}:particles`;
    points.frustumCulled = false;
    if (system.followCamera === true) {
      // (the game moves it with the camera: its place and turn are the camera's, then its own)
      const local = new Matrix4().compose(
        new Vector3(...system.position),
        new Quaternion(...system.rotation),
        new Vector3(...system.scale),
      );
      points.matrixAutoUpdate = false;
      points.matrixWorldAutoUpdate = false;
      points.onBeforeRender = (_renderer, _scene, camera) => {
        points.matrixWorld.multiplyMatrices(camera.matrixWorld, local);
      };
    }
    points.renderOrder = system.sortingOrder;
    node.add(points);
    root.add(node);
    geometries.set(`particle-system:${index}:${system.name}`, geometry);
    materials.add(material);
  }
}

function buildMeshParticleSystem(
  system: EnvironmentParticleSystemData,
  index: number,
  texture: Texture,
  context: EnvironmentMaterialContext,
  root: Group,
  geometries: Map<string, BufferGeometry>,
  materials: Set<Material>,
) {
  const { geometry, cycle } = meshParticleGeometry(system);
  const fogColor = system.fogColor ?? system.name === 'BigSmokePS';
  const material = new ShaderMaterial({
    vertexShader: MESH_PARTICLE_VERT,
    fragmentShader: meshParticleFragmentShader(system),
    uniforms: {
      ...materialFogUniforms(context.fog, {
        enabled: system.fogEnabled,
        heightEnabled: system.heightFogEnabled,
      }),
      _MainTex: { value: texture },
      _Tint: { value: new Vector4(...system.tint) },
      _Brightness: { value: system.brightness },
      _AlphaMultiplier: { value: system.alphaMultiplier },
      _StartAlpha: { value: system.startAlpha ?? 1 },
      _SongTime: context.songTime ?? { value: 0 },
      _Cycle: { value: cycle },
      _Prewarm: { value: system.prewarm ? 1 : 0 },
      _RotationSpeed: { value: system.rotationSpeed ?? (system.name === 'BigSmokePS' ? Math.PI / 180 : 0) },
    },
    defines: fogColor ? { FOG_COLOR_HAZE: 1 } : {},
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  });
  const node = new Group();
  node.name = system.name;
  node.position.set(...system.position);
  node.quaternion.set(...system.rotation);
  node.scale.set(...system.scale);
  const mesh = new Mesh(geometry, material);
  mesh.name = `${system.name}:particles`;
  mesh.frustumCulled = false;
  mesh.renderOrder = system.sortingOrder;
  node.add(mesh);
  root.add(node);
  geometries.set(`particle-system:${index}:${system.name}`, geometry);
  materials.add(material);
}
