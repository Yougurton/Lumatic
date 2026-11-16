import { CubeTexture, SRGBColorSpace, type ShaderMaterial } from 'three';
import { liveReflectionTarget } from '../live-reflections';
import type { Rgb } from '../../../core/colors';
import { createEnvironmentLitMaterial, createWaterLitMaterial } from '../../materials/environment-surface-materials';
import type { EnvironmentMaterialData } from '../types';
import {
  materialFog,
  materialTexture,
  materialTimeMode,
  vectorColor,
  type EnvironmentMaterialContext,
} from './material-context';

function unityVectorColor(value: [number, number, number, number] | undefined, fallback: Rgb): Rgb {
  const vector = vectorColor(value, fallback);
  return [vector[0], vector[1], -vector[2]];
}

/**
 * A neutral reflection probe for the environments that have none of their own: a sky light above, dim
 * below, a few soft lights round the horizon. Only for a map's own shapes (marked by
 * `_LumaticFallbackProbe`): their glossy materials have nothing to reflect otherwise and look matte.
 */
let fallbackProbe: CubeTexture | undefined;
function neutralProbe(): CubeTexture {
  if (fallbackProbe !== undefined) return fallbackProbe;
  const size = 64;
  // (three's cube faces: +x, -x, +y, -y, +z, -z — each pixel's direction)
  const faces: ((u: number, v: number) => [number, number, number])[] = [
    (u, v) => [1, -v, -u],
    (u, v) => [-1, -v, u],
    (u, v) => [u, 1, v],
    (u, v) => [u, -1, -v],
    (u, v) => [u, -v, 1],
    (u, v) => [-u, -v, -1],
  ];
  const lights: [number, number, number][] = [
    [0.55, 0.45, 0.7],
    [-0.7, 0.35, 0.6],
    [0.1, 0.8, -0.6],
  ];
  const images = faces.map((direction) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const [dx, dy, dz] = direction(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1);
        const length = Math.hypot(dx, dy, dz);
        const [nx, ny, nz] = [dx / length, dy / length, dz / length];
        let value = ny >= 0 ? 0.42 + 0.45 * Math.pow(ny, 0.7) : 0.42 - 0.3 * Math.pow(-ny, 0.5);
        for (const [lx, ly, lz] of lights) {
          const l = Math.hypot(lx, ly, lz);
          const facing = Math.max(0, (nx * lx + ny * ly + nz * lz) / l);
          value += 0.55 * Math.pow(facing, 24);
        }
        const byte = Math.round(Math.min(1, value) * 255);
        const at = (y * size + x) * 4;
        image.data[at] = byte;
        image.data[at + 1] = byte;
        image.data[at + 2] = byte;
        image.data[at + 3] = 255;
      }
    ctx.putImageData(image, 0, 0);
    return canvas;
  });
  fallbackProbe = new CubeTexture(images);
  fallbackProbe.colorSpace = SRGBColorSpace;
  fallbackProbe.needsUpdate = true;
  return fallbackProbe;
}

/** Any cube map — for a material whose own one is set after it is made. */
const placeholderProbe = () => neutralProbe();

export function createLitEnvironmentMaterial(
  data: EnvironmentMaterialData,
  givenContext: EnvironmentMaterialContext,
  color: Rgb,
): ShaderMaterial {
  // (a live reflection: its own cube map, taken every frame — see live-reflections)
  if (data.floats._LumaticLiveReflection === 1) {
    const holder: { target?: ReturnType<typeof liveReflectionTarget> } = {};
    const material: ShaderMaterial = createLitEnvironmentMaterial({ ...data, floats: { ...data.floats, _LumaticLiveReflection: 0 } }, { ...givenContext, bakedReflectionProbe: undefined, reflectionProbe: placeholderProbe() }, color);
    holder.target = liveReflectionTarget(material);
    material.uniforms._ReflectionProbe = { value: holder.target.texture };
    material.defines = { ...material.defines, LIVE_PROBE: 1 };
    material.needsUpdate = true;
    return material;
  }
  // (a map's own shape in an environment without a probe: the neutral one)
  const context =
    data.floats._LumaticFallbackProbe === 1 && givenContext.reflectionProbe === undefined && givenContext.bakedReflectionProbe === undefined
      ? { ...givenContext, reflectionProbe: neutralProbe() }
      : givenContext;
  if (data.shader === 'ChroMapper/Water Lit') {
    const normal = materialTexture(data, context, '_NormalTexture');
    if (normal !== undefined && (context.reflectionProbe !== undefined || context.bakedReflectionProbe !== undefined)) {
      const scrolling = data.colors._NormalTexScrolling ?? [0, 0, 0, 0];
      return createWaterLitMaterial(context.fog, color, data.colors._Color?.[3] ?? 1, normal, {
        normalScale: data.floats._NormalScale ?? 1,
        normalScaleVertical: data.floats._NormalScaleVertical ?? 0,
        normalScrolling: [scrolling[0], scrolling[1]],
        metallic: data.floats._Metallic ?? 0,
        reflectionIntensity: data.floats._ReflectionProbeIntensity ?? 1,
        smoothness: data.floats._Smoothness ?? 0.5,
        fallingFogStartOffset: data.floats._FallingFogStartOffset ?? 0,
        reflectionProbe: context.reflectionProbe,
        bakedReflectionProbe: context.bakedReflectionProbe,
        zFade: data.keywords.includes('Z_FADE')
          ? {
              position: data.floats._ZFadePosition ?? 0,
              scale: data.floats._ZFadeScale ?? 1,
            }
          : undefined,
        fog: materialFog(data),
      });
    }
  }
  const diffuse = materialTexture(data, context, '_DiffuseTex') ?? materialTexture(data, context, '_DiffuseTexture');
  const metalSmoothness = data.keywords.includes('METAL_SMOOTHNESS_TEXTURE')
    ? materialTexture(data, context, '_MetalSmoothnessTex')
    : undefined;
  const dirtDetail = materialTexture(data, context, '_DirtDetailTex') ?? metalSmoothness;
  let smoothnessTextureSource: 'none' | 'green' | 'greenRoughness' | 'alpha' = 'none';
  if (data.keywords.includes('_SMOOTHNESS_TEXTURE_MPM_G_ROUGHNESS')) smoothnessTextureSource = 'greenRoughness';
  else if (data.keywords.includes('_SMOOTHNESS_TEXTURE_MPM_A')) smoothnessTextureSource = 'alpha';
  else if (data.keywords.includes('_SMOOTHNESS_TEXTURE_MPM_G')) smoothnessTextureSource = 'green';
  return createEnvironmentLitMaterial(context.fog, color, context.directionalLights, {
    ambientMinimalValue: data.floats._AmbientMinimalValue ?? 0,
    nominalDiffuseLevel: vectorColor(data.colors._NominalDiffuseLevel, [0, 0, 0]),
    ambientMultiplier: data.floats._AmbientMultiplier ?? 1,
    diffuseEnabled: (data.floats._EnableDiffuse ?? 1) !== 0,
    bothSidesDiffuseMultiplier:
      (data.floats._EnableBothSidesDiffuse ?? 0) === 0 ? 0 : (data.floats._BothSidesDiffuseMultiplier ?? 1),
    metallic: data.floats._Metallic ?? 0,
    specularEnabled: (data.floats._EnableSpecular ?? 1) !== 0,
    smoothness: data.floats._Smoothness ?? data.floats._Glossiness ?? 0.5,
    specularIntensity: data.floats._SpecularIntensity ?? 1,
    lightFalloffEnabled: (data.floats._EnableLightFalloff ?? 0) !== 0,
    privatePointLightEnabled: (data.floats._EnablePrivatePointLight ?? 0) !== 0,
    privatePointLightColor: vectorColor(data.colors._PrivatePointLightColor, [0, 0.5, 1]),
    privatePointLightPosition: unityVectorColor(data.colors._PrivatePointLightPosition, [0, 0, 0]),
    privatePointLightLocal: (data.floats._PointLightPositionLocal ?? 0) !== 0,
    privatePointLightIntensity: data.floats._PrivatePointLightIntensity ?? 1,
    groundFadeEnabled: (data.floats._EnableGroundFade ?? 0) !== 0,
    groundFadeScale: data.floats._GroundFadeScale ?? 0.5,
    groundFadeOffset: data.floats._GroundFadeOffset ?? 1,
    distanceDarkeningEnabled: (data.floats._EnableDistanceDarkening ?? 0) !== 0,
    darkeningScale: data.floats._DarkeningScale ?? 0.35,
    darkeningIntensity: data.floats._DarkeningIntensity ?? 1,
    darkeningCenter: unityVectorColor(data.colors._DarkeningCenter, [0, 0, 0]),
    darkeningDirection: unityVectorColor(data.colors._DarkeningDirection, [1, 1, 1]),
    vertexColorEnabled: data.floats._Vertex === 1 || data.floats._Vertex === 5,
    vertexEmissionEnabled: data.floats._Vertex === 2 || data.keywords.includes('_VERTEXMODE_EMISSION'),
    vertexEmissionColor: vectorColor(data.colors._EmissionColor, [1, 1, 1]),
    vertexEmissionColorAlpha: data.colors._EmissionColor?.[3] ?? 1,
    vertexEmissionThreshold: data.floats._EmissionThreshold ?? 0,
    vertexEmissionStrength: data.floats._EmissionStrength ?? 1,
    vertexEmissionBloomIntensity: data.floats._EmissionBloomIntensity ?? 1,
    vertexEmissionMainEffect: data.keywords.includes('_VERTEX_WHITEBOOSTTYPE_MAINEFFECT'),
    displacementEnabled: data.floats._Vertex === 5 || data.keywords.includes('_VERTEXMODE_DISPLACEMENT'),
    displacementSpatial:
      (data.floats._DisplacementSpatial ?? 0) !== 0 || data.keywords.includes('DISPLACEMENT_SPATIAL'),
    displacementBidirectional:
      (data.floats._DisplacementBidirectional ?? 0) !== 0 || data.keywords.includes('DISPLACEMENT_BIDIRECTIONAL'),
    displacementStrength: data.floats._DisplacementStrength ?? 0.1,
    displacementAxisMultiplier: unityVectorColor(data.colors._DisplacementAxisMultiplier, [1, 1, 1]),
    displacement3d: displacement3d(data, context),
    meshPackingEnabled: data.keywords.includes('MESH_PACKING'),
    meshPackingId: data.floats._MeshPackingId ?? 0,
    diffuse: (data.floats._EnableDiffuseTexture ?? 0) !== 0 ? diffuse : undefined,
    albedoMultiplier: data.floats._AlbedoMultiplier ?? 1,
    metalSmoothness,
    metallicTextureEnabled: data.keywords.includes('_METALLIC_TEXTURE_MPM_R'),
    smoothnessTextureSource,
    occlusionEnabled: data.keywords.includes('OCCLUSION') && data.keywords.includes('_OCCLUSION_SOURCE_MPM_B'),
    emissionDistortion:
      data.keywords.includes('DISTORTION_SIMPLE') && data.keywords.includes('_DISTORTION_TARGET_EMISSIONTEX')
        ? materialTexture(data, context, '_DistortionTex')
        : undefined,
    distortionStrength: data.floats._DistortionStrength ?? 0,
    distortionAxes: [data.colors._DistortionAxes?.[0] ?? 1, data.colors._DistortionAxes?.[1] ?? 1],
    distortionPanning: [data.colors._DistortionPanning?.[0] ?? 0, data.colors._DistortionPanning?.[1] ?? 0],
    occlusionDirt:
      data.keywords.includes('OCCLUSION') && !data.keywords.some((keyword) => keyword.startsWith('_OCCLUSION_SOURCE_'))
        ? materialTexture(data, context, '_DirtTex')
        : undefined,
    occlusionBeforeEmission: data.keywords.includes('OCCLUSION_BEFORE_EMISSION'),
    occlusionIntensity: data.floats._OcclusionIntensity ?? 1,
    occlusionDetail: dirtDetail,
    occlusionDetailEnabled: data.keywords.includes('OCCLUSION_DETAIL') && dirtDetail !== undefined,
    occlusionDetailOffset: [data.colors._AdditiveUVOffset?.[0] ?? 0, data.colors._AdditiveUVOffset?.[1] ?? 0],
    occlusionDetailIntensity: data.floats._OcclusionDetailIntensity ?? 0,
    normal: (data.floats._EnableNormalMap ?? 0) !== 0 ? materialTexture(data, context, '_NormalTexture') : undefined,
    normalScale: data.floats._NormalScale ?? data.floats._BumpScale ?? 1,
    emission: (data.floats._EmissionTexture ?? 0) !== 0 ? materialTexture(data, context, '_EmissionTex') : undefined,
    parallaxMap: data.keywords.some((keyword) => keyword.startsWith('_PARALLAX_FLEXIBLE'))
      ? materialTexture(data, context, '_ParallaxMap')
      : undefined,
    parallaxIntensity: data.floats._ParallaxIntensity ?? 1,
    parallaxStep: data.floats._ParallaxIntensity_Step ?? 1,
    parallaxSpeed: [data.colors._ParallaxTexSpeed?.[0] ?? 0, data.colors._ParallaxTexSpeed?.[1] ?? 0],
    emissionMask:
      (data.floats._EnableEmissionMask ?? 0) !== 0 ? materialTexture(data, context, '_EmissionMask') : undefined,
    secondaryEmissionMask:
      (data.floats._EnableSecondaryEmissionMask ?? 0) !== 0
        ? materialTexture(data, context, '_SecondaryEmissionMask')
        : undefined,
    emissionMaskSecondaryUvs: (data.floats._Secondary_UVs ?? 0) !== 0 && (data.floats._SecondaryUVsMask ?? 0) !== 0,
    secondaryEmissionMaskSecondaryUvs:
      (data.floats._Secondary_UVs ?? 0) !== 0 && (data.floats._SecondaryUVsMask2 ?? 0) !== 0,
    emissionMaskSpeed: vectorColor(data.colors._EmissionMaskSpeed, [0, 0, 0]),
    secondaryEmissionMaskSpeed: vectorColor(data.colors._SecondaryEmissionMaskSpeed, [0, 0, 0]),
    primaryEmissionGain: data.floats._EmissionMaskIntensity ?? 1,
    secondaryEmissionGain: data.floats._SecondaryEmissionMaskIntensity ?? 1,
    reflectionProbe:
      (data.floats._EnableReflectionProbe ?? 0) !== 0 || data.keywords.includes('REFLECTION_PROBE')
        ? context.reflectionProbe
        : undefined,
    bakedReflectionProbe:
      (data.floats._EnableReflectionProbe ?? 0) !== 0 || data.keywords.includes('REFLECTION_PROBE')
        ? context.bakedReflectionProbe
        : undefined,
    reflectionIntensity: data.floats._ReflectionProbeIntensity ?? 1,
    multiplyReflections: data.keywords.includes('MULTIPLY_REFLECTIONS'),
    emissionColor: vectorColor(data.colors._EmissionTexColor, [1, 1, 1]),
    emissionColorAlpha: data.colors._EmissionTexColor?.[3] ?? 1,
    emissionBrightness: data.floats._EmissionBrightness ?? 1,
    emissionFogSuppression: data.floats._EmissionFogSuppression ?? 0,
    emissionAlphaSource: (data.floats._Emission_Alpha_Source ?? 0) === 0 ? 'green' : 'textureAlpha',
    emissionSdf: data.keywords.includes('_EMISSION_TEXTURE_SOURCE_SDF'),
    emissionGradient: data.keywords.includes('_EMISSIONCOLORTYPE_GRADIENT') ? materialTexture(data, context, '_EmissionGradientTex') : undefined,
    emissionGradientPosition: data.floats._EmissionGradientPosition ?? 0,
    emissionGradientIntensity: data.floats._EmissionGradientIntensity ?? 1,
    emissionGradientPanningSpeed: data.floats._EmissionGradientPanningSpeed ?? 0,
    emissionTexSpeed: [data.colors._EmissionTexSpeed?.[0] ?? 0, data.colors._EmissionTexSpeed?.[1] ?? 0],
    sdfNegativeIntensity: data.floats._SDFNegativeIntensity ?? 0.5,
    sdfNoiseIntensity: data.floats._SDFNoiseIntensity ?? 0,
    sdfNoiseScale: data.floats._SDFNoiseScale ?? 0,
    sdfNoisePanning: [data.colors._SDFNoisePanning?.[0] ?? 0, data.colors._SDFNoisePanning?.[1] ?? 0, data.colors._SDFNoisePanning?.[2] ?? 0],
    sdfPointIntensity: data.floats._SDFPointIntensity ?? 1,
    sdfNoiseTexture: sdfNoiseTexture(data, context),
    emissionWhiteBoost:
      data.floats._EmissionBloomType === 1 ||
      data.keywords.includes('_EMISSIONCOLORTYPE_WHITEBOOST') ||
      data.keywords.includes('_EMISSIONBLOOMTYPE_PP'),
    emissionWhiteBoostMultiplier: data.floats._EmissionTexWhiteboostMultiplier ?? 1,
    // (a simple emission texture with no colour type set takes the first of the shader's options, the
    // main effect: the game's compiled shader for such a material — Coldplay's background sphere —
    // writes its glow)
    emissionMainEffect:
      data.keywords.includes('_EMISSIONCOLORTYPE_MAINEFFECT') ||
      data.keywords.includes('_EMISSIONCOLORTYPE_WHITEBOOST') ||
      (data.keywords.includes('_EMISSIONTEXTURE_SIMPLE') &&
        !data.keywords.some((keyword) => keyword.startsWith('_EMISSIONCOLORTYPE_'))),
    emissionBloomIntensity: data.floats._EmissionTexBloomIntensity ?? 1,
    toneMapBeforeEmission: data.keywords.includes('_ACES_APPROACH_BEFORE_EMISSIVE'),
    customTime: materialTimeMode(data.keywords),
    songTime: context.songTime,
    timeOffset: data.floats._TimeOffset ?? 0,
    fog: materialFog(data),
  });
}

function sdfNoiseTexture(data: EnvironmentMaterialData, context: EnvironmentMaterialContext) {
  const volume = data.textures?._SDFNoiseTex?.volume;
  const texture = materialTexture(data, context, '_SDFNoiseTex');
  return volume === undefined || texture === undefined ? undefined : { texture: texture.texture, volume };
}

function displacement3d(data: EnvironmentMaterialData, context: EnvironmentMaterialContext) {
  if (!data.keywords.includes('VERTEXDISPLACEMENT_MASK')) return undefined;
  if (!data.keywords.includes('_VERTEXDISPLACEMENT_MASK_SOURCE_3D_TEXTURE')) return undefined;
  const volume = data.textures?._VertexDisplacement3DTexture?.volume;
  const texture = materialTexture(data, context, '_VertexDisplacement3DTexture');
  if (volume === undefined || texture === undefined) return undefined;
  const vector = (name: string): [number, number, number] => [
    data.colors[name]?.[0] ?? 0,
    data.colors[name]?.[1] ?? 0,
    data.colors[name]?.[2] ?? 0,
  ];
  return {
    texture: texture.texture,
    volume,
    scale: data.floats._VertexDisplacement3DTexScale ?? 1,
    offset: vector('_VertexDisplacement3DTexOffset'),
    panning: vector('_VertexDisplacement3DTexPanning'),
    maskMultiplier: data.floats._VertexDisplacementMaskMultiplier ?? 1,
    maskOffset: data.floats._VertexDisplacementMaskOffset ?? 0,
  };
}
