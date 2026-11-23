import { ACES_CHUNK, BASE_COLOR_CHUNK, DXT5_NORMAL_CHUNK, FOG_CHUNK } from './chunks';

// (a volume texture of the game — its 3D noise — as the converter lays it out: its slices side by
// side in an atlas, the first at the bottom left. Read texel by texel and blended in all three
// directions, wrapping as the game's texture does: the same values the game's sampler gives)
const VOLUME_ATLAS_CHUNK = /* glsl */ `
float volumeAtlasTexel(sampler2D atlas, vec4 volume, ivec3 texel) {
  ivec3 size = ivec3(volume.xyz);
  int columns = int(volume.w);
  ivec3 wrapped = ((texel % size) + size) % size;
  ivec2 tile = ivec2(wrapped.z % columns, wrapped.z / columns);
  return texelFetch(atlas, tile * size.xy + wrapped.xy, 0).r;
}
float volumeAtlas(sampler2D atlas, vec4 volume, vec3 p) {
  vec3 place = fract(p) * volume.xyz - 0.5;
  vec3 base = floor(place);
  vec3 f = place - base;
  ivec3 i = ivec3(base);
  float c000 = volumeAtlasTexel(atlas, volume, i);
  float c100 = volumeAtlasTexel(atlas, volume, i + ivec3(1, 0, 0));
  float c010 = volumeAtlasTexel(atlas, volume, i + ivec3(0, 1, 0));
  float c110 = volumeAtlasTexel(atlas, volume, i + ivec3(1, 1, 0));
  float c001 = volumeAtlasTexel(atlas, volume, i + ivec3(0, 0, 1));
  float c101 = volumeAtlasTexel(atlas, volume, i + ivec3(1, 0, 1));
  float c011 = volumeAtlasTexel(atlas, volume, i + ivec3(0, 1, 1));
  float c111 = volumeAtlasTexel(atlas, volume, i + ivec3(1, 1, 1));
  return mix(
    mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y),
    mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y),
    f.z
  );
}
`;

export const ENVIRONMENT_LIT_VERT = /* glsl */ `
${VOLUME_ATLAS_CHUNK}
#ifdef VERTEX_DISPLACEMENT_3D
uniform sampler2D _VertexDisplacement3DTex;
uniform vec4 _VertexDisplacement3DVolume;
uniform float _VertexDisplacement3DTexScale;
uniform vec3 _VertexDisplacement3DTexOffset;
uniform vec3 _VertexDisplacement3DTexPanning;
uniform float _VertexDisplacementMaskMultiplier;
uniform float _VertexDisplacementMaskOffset;
uniform float _TimeSeconds;
uniform float _SongTime;
uniform float _TimeOffset;
#endif
uniform vec3 _DisplacementAxisMultiplier;
uniform float _DisplacementStrength;
uniform float _MeshPackingId;
#ifdef EMISSION_SOURCE_SDF
varying vec3 vSdfLocal;
#endif
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;
varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec2 vUv;
#ifdef USE_SECONDARY_UV
varying vec2 vSecondaryUv;
#endif
varying vec4 vScreenPos;
#ifdef USE_VERTEX_COLOR
attribute vec4 color;
varying vec4 vVertexColor;
#endif
#if defined(MESH_PACKING) || defined(USE_SECONDARY_UV)
attribute vec2 uv1;
#endif

void main() {
  vec3 localPosition = position;
  vec3 localNormal = normal;
  mat3 instanceBasis = mat3(1.0);
  #ifdef MESH_PACKING
  if (abs(uv1.y - _MeshPackingId) > 0.1) localPosition = vec3(0.0);
  #endif
  #ifdef VERTEX_DISPLACEMENT_3D
  // (as the game's own vertex shader does it, read from its compiled code: the 3D noise, read where
  // the vertex stands in the game's world, pushes it along its normal — each axis by its own share —
  // as far as the strength the map gives)
  float displacementTime = _TimeSeconds;
    #ifdef CUSTOM_TIME_SONG
  displacementTime = _SongTime;
    #elif defined(CUSTOM_TIME_FREEZE)
  displacementTime = _TimeOffset;
    #endif
  vec4 displacementWorld = vec4(position, 1.0);
    #ifdef USE_INSTANCING
  displacementWorld = instanceMatrix * displacementWorld;
    #endif
  displacementWorld = modelMatrix * displacementWorld;
  vec3 displacementPlace = vec3(displacementWorld.x, displacementWorld.y, -displacementWorld.z)
    * _VertexDisplacement3DTexScale + _VertexDisplacement3DTexOffset
    + _VertexDisplacement3DTexPanning * 0.1 * displacementTime;
  float displacementNoise = volumeAtlas(_VertexDisplacement3DTex, _VertexDisplacement3DVolume, displacementPlace)
    * _VertexDisplacementMaskMultiplier + _VertexDisplacementMaskOffset;
  localPosition += localNormal * displacementNoise * _DisplacementStrength * _DisplacementAxisMultiplier;
  #elif defined(VERTEX_DISPLACEMENT)
  vec3 displacement = color.rgb;
  #ifdef DISPLACEMENT_BIDIRECTIONAL
  displacement = displacement * 2.0 - 1.0;
  #endif
  #ifdef DISPLACEMENT_SPATIAL
  localPosition += displacement * _DisplacementAxisMultiplier * _DisplacementStrength;
  #else
  localPosition += localNormal * displacement.r * _DisplacementAxisMultiplier * _DisplacementStrength;
  #endif
  #endif
  #ifdef USE_VERTEX_COLOR
  vVertexColor = color;
  #endif
  vec4 localPos = vec4(localPosition, 1.0);
  #ifdef USE_INSTANCING
  localPos = instanceMatrix * localPos;
  instanceBasis = mat3(instanceMatrix);
  #endif
  vec4 worldPos = modelMatrix * localPos;
  vec4 viewPos = viewMatrix * worldPos;
  vWorldPos = worldPos.xyz;
  #ifdef EMISSION_SOURCE_SDF
  // (the game's world coordinates — the engine's with z turned back: the noise lies over the world,
  // so each flower takes its own colour from where it stands)
  vSdfLocal = vec3(worldPos.x, worldPos.y, -worldPos.z);
  #endif
  vWorldNormal = normalize(mat3(modelMatrix) * instanceBasis * localNormal);
  #ifdef USE_TANGENT
  vWorldTangent = normalize(mat3(modelMatrix) * instanceBasis * tangent.xyz);
  vWorldBitangent = normalize(cross(vWorldNormal, vWorldTangent) * tangent.w);
  #endif
  vViewPos = viewPos.xyz;
  #ifdef USE_INSTANCING
  vViewNormal = normalize(mat3(viewMatrix) * vWorldNormal);
  #else
  vViewNormal = normalize(normalMatrix * localNormal);
  #endif
  vUv = uv;
  #ifdef USE_SECONDARY_UV
  vSecondaryUv = uv1;
  #endif
  gl_Position = projectionMatrix * viewPos;
  vScreenPos = vec4((gl_Position.xy + gl_Position.ww) * 0.5, gl_Position.zw);
}
`;

export const ENVIRONMENT_UNLIT_FRAG = /* glsl */ `
uniform vec3 _Color;
uniform float _ColorAlpha;
uniform float _FogStartOffset;
uniform float _FogScale;
varying vec3 vWorldPos;
varying vec4 vScreenPos;
${ACES_CHUNK}
${FOG_CHUNK}
void main() {
  vec4 albedo = vec4(chroToneMap(_Color), _ColorAlpha);
  albedo = applyChroFog(albedo, vScreenPos, vWorldPos, _FogStartOffset, _FogScale);
  gl_FragColor = clamp(albedo, 0.0, 1.0);
  #include <colorspace_fragment>
}
`;

const REFLECTION_PROBE_CHUNK = /* glsl */ `
uniform samplerCube _ReflectionProbe;
uniform samplerCube _ReflectionProbe2;
uniform vec3 _ReflectionProbePosition;
uniform vec3 _ReflectionProbeBoxMin;
uniform vec3 _ReflectionProbeBoxMax;
uniform vec4 _LightProbeLightBakeId[6];

vec3 chroDecodeProbeChannel(float encoded, vec4 lightColor) {
  float lowRange = min(encoded, 0.5);
  float highRange = max(encoded - 0.5, 0.0) * lightColor.a;
  return lowRange * lightColor.rgb + vec3(highRange * highRange);
}

vec3 chroProjectProbeDirection(vec3 direction, vec3 worldPosition) {
  vec3 inverseDirection = 1.0 / direction;
  vec3 projectedBounds = mix(
    (_ReflectionProbeBoxMin - worldPosition) * inverseDirection,
    (_ReflectionProbeBoxMax - worldPosition) * inverseDirection,
    step(vec3(0.0), direction)
  );
  float projectedDistance = min(min(projectedBounds.x, projectedBounds.y), projectedBounds.z);
  return worldPosition - _ReflectionProbePosition + direction * projectedDistance;
}

vec3 chroSampleProbe(vec3 reflectedView, vec3 worldPosition, float mip) {
  #ifdef LIVE_PROBE
  // (taken by a cube camera here: in this space already — not the game's, z the other way)
  return textureCube(_ReflectionProbe, reflectedView, mip).rgb;
  #endif
  vec3 probeDirection = vec3(reflectedView.xy, -reflectedView.z);
  #ifdef BAKED_REFLECTION_PROBE
  vec3 unityWorldPosition = vec3(worldPosition.xy, -worldPosition.z);
  probeDirection = chroProjectProbeDirection(probeDirection, unityWorldPosition);
  vec3 firstProbe = textureCube(_ReflectionProbe, probeDirection, mip).rgb;
  vec3 secondProbe = textureCube(_ReflectionProbe2, probeDirection, mip).rgb;
  vec3 decoded = chroDecodeProbeChannel(firstProbe.r, _LightProbeLightBakeId[0]);
  decoded += chroDecodeProbeChannel(firstProbe.g, _LightProbeLightBakeId[1]);
  decoded += chroDecodeProbeChannel(firstProbe.b, _LightProbeLightBakeId[2]);
  decoded += chroDecodeProbeChannel(secondProbe.r, _LightProbeLightBakeId[3]);
  decoded += chroDecodeProbeChannel(secondProbe.g, _LightProbeLightBakeId[4]);
  decoded += chroDecodeProbeChannel(secondProbe.b, _LightProbeLightBakeId[5]);
  return clamp(decoded * 2.0, 0.0, 1.0);
  #else
  return textureCube(_ReflectionProbe, probeDirection, mip).rgb;
  #endif
}
`;

export const WATER_LIT_FRAG = /* glsl */ `
uniform sampler2D _NormalTexture;
uniform vec2 _NormalTextureScale;
uniform vec2 _NormalTextureOffset;
uniform vec2 _NormalTexScrolling;
uniform float _NormalScale;
uniform float _NormalScaleVertical;
uniform float _Metallic;
uniform float _ReflectionIntensity;
uniform float _Smoothness;
uniform vec3 _Color;
uniform float _ColorAlpha;
uniform float _TimeSeconds;
uniform float _FogStartOffset;
uniform float _FogScale;
uniform float _FallingFogStartOffset;
uniform float _ZFadePosition;
uniform float _ZFadeScale;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vWorldTangent;
varying vec3 vWorldBitangent;
varying vec2 vUv;
varying vec4 vScreenPos;
${ACES_CHUNK}
${FOG_CHUNK}
${DXT5_NORMAL_CHUNK}
${REFLECTION_PROBE_CHUNK}
void main() {
  float unityTime = _TimeSeconds * 0.05;
  vec2 normalUv = (vUv + _NormalTexScrolling * unityTime) * _NormalTextureScale + _NormalTextureOffset;
  vec4 packedNormal = texture2D(_NormalTexture, normalUv);
  vec2 mappedXy = chroDxt5NormalXY(packedNormal);
  vec3 surfaceNormal = normalize(vWorldNormal);
  float mappedZ = sqrt(max(1.0 - min(dot(mappedXy, mappedXy), 1.0), 0.0));
  float verticalGain = 1.0 + _NormalScaleVertical * (1.0 - surfaceNormal.y);
  mappedXy *= verticalGain;
  vec3 mappedNormal = normalize(mat3(vWorldTangent, vWorldBitangent, surfaceNormal) * vec3(mappedXy, mappedZ));
  vec3 normal = normalize(mix(surfaceNormal, mappedNormal, _NormalScale));
  vec3 viewDirection = normalize(cameraPosition - vWorldPos);
  vec3 reflectedView = reflect(-viewDirection, normal);
  float roughness = 1.0 - _Smoothness;
  float roughnessMipWeight = 1.7 - 0.7 * roughness;
  float probeMip = roughness * roughnessMipWeight * 6.0;
  vec3 reflection = chroSampleProbe(reflectedView, vWorldPos, probeMip);
  #ifndef BAKED_REFLECTION_PROBE
  reflection = min(reflection * 2.0, vec3(1.0));
  #endif
  float reflectionWeight = _Smoothness * mix(0.4, 2.0, _Metallic);
  vec3 reflectionColor = mix(vec3(1.0), _Color, _Metallic);
  vec4 albedo = vec4(
    chroToneMap(reflection * reflectionColor * _ReflectionIntensity * reflectionWeight),
    _ColorAlpha
  );
  float fogStartOffset = _FogStartOffset + _FallingFogStartOffset * (1.0 - clamp(normal.y, 0.0, 1.0));
  albedo = applyChroFog(albedo, vScreenPos, vWorldPos, fogStartOffset, _FogScale);
  #ifdef Z_FADE
  float alpha = clamp((_ZFadePosition + vWorldPos.z) * _ZFadeScale, 0.0, 1.0) * _ColorAlpha;
  gl_FragColor = vec4(albedo.rgb, alpha);
  #else
  gl_FragColor = vec4(albedo.rgb, 0.0);
  #endif
  #include <colorspace_fragment>
}
`;

export const ENVIRONMENT_LIT_FRAG = /* glsl */ `
${VOLUME_ATLAS_CHUNK}
uniform vec3 _DirectionalLightDirections[5];
uniform vec3 _DirectionalLightColors[5];
uniform vec3 _DirectionalLightPositions[5];
uniform float _DirectionalLightRadii[5];
uniform float _AmbientMinimalValue;
uniform vec3 _NominalDiffuseLevel;
uniform float _AmbientMultiplier;
uniform float _DiffuseEnabled;
uniform float _BothSidesDiffuseMultiplier;
uniform float _Metallic;
uniform float _SpecularEnabled;
uniform float _Smoothness;
uniform float _SpecularIntensity;
uniform float _LightFalloffEnabled;
uniform float _PrivatePointLightEnabled;
uniform vec3 _PrivatePointLightColor;
uniform vec3 _PrivatePointLightPosition;
uniform float _PrivatePointLightLocal;
uniform float _PrivatePointLightIntensity;
uniform float _GroundFadeEnabled;
uniform float _GroundFadeScale;
uniform float _GroundFadeOffset;
uniform float _DistanceDarkeningEnabled;
uniform float _DarkeningScale;
uniform float _DarkeningIntensity;
uniform vec3 _DarkeningCenter;
uniform vec3 _DarkeningDirection;
uniform vec3 _EmissionColor;
uniform float _EmissionColorAlpha;
uniform float _VertexEmissionThreshold;
uniform float _VertexEmissionStrength;
uniform float _VertexEmissionBloomIntensity;
uniform sampler2D _DiffuseTex;
uniform vec2 _DiffuseTexScale;
uniform vec2 _DiffuseTexOffset;
uniform float _AlbedoMultiplier;
uniform sampler2D _MetalSmoothnessTex;
uniform vec2 _MetalSmoothnessTexScale;
uniform vec2 _MetalSmoothnessTexOffset;
uniform float _OcclusionIntensity;
#ifdef OCCLUSION_DIRT
uniform sampler2D _DirtTex;
uniform vec2 _DirtTexScale;
uniform vec2 _DirtTexOffset;
#endif
uniform sampler2D _DirtDetailTex;
uniform vec2 _DirtDetailTexScale;
uniform vec2 _DirtDetailTexOffset;
uniform vec2 _OcclusionDetailOffset;
uniform float _OcclusionDetailIntensity;
uniform sampler2D _NormalTexture;
uniform vec2 _NormalTextureScale;
uniform vec2 _NormalTextureOffset;
uniform float _NormalScale;
uniform sampler2D _EmissionTex;
uniform vec2 _EmissionTexScale;
uniform vec2 _EmissionTexOffset;
#ifdef DISTORTION_EMISSION
uniform sampler2D _DistortionTex;
uniform vec2 _DistortionTexScale;
uniform vec2 _DistortionTexOffset;
uniform float _DistortionStrength;
uniform vec2 _DistortionAxes;
uniform vec2 _DistortionPanning;
#endif
#ifdef PARALLAX_MAP
uniform sampler2D _ParallaxMap;
uniform vec2 _ParallaxMapScale;
uniform vec2 _ParallaxMapOffset;
uniform float _ParallaxIntensity;
uniform float _ParallaxStep;
uniform vec2 _ParallaxTexSpeed;
#endif
uniform sampler2D _EmissionMask;
uniform vec2 _EmissionMaskScale;
uniform vec2 _EmissionMaskOffset;
uniform sampler2D _SecondaryEmissionMask;
uniform vec2 _SecondaryEmissionMaskScale;
uniform vec2 _SecondaryEmissionMaskOffset;
uniform vec2 _EmissionMaskSpeed;
uniform vec2 _SecondaryEmissionMaskSpeed;
uniform float _PrimaryEmissionGain;
uniform float _SecondaryEmissionGain;
uniform float _ReflectionIntensity;
uniform vec3 _EmissionTexColor;
uniform float _EmissionTexColorAlpha;
#ifdef EMISSION_COLOR_GRADIENT
uniform sampler2D _EmissionGradientTex;
uniform float _EmissionGradientPosition;
uniform float _EmissionGradientPanningSpeed;
uniform float _EmissionGradientIntensity;
uniform vec2 _EmissionTexSpeed;
#endif
#ifdef EMISSION_SOURCE_SDF
uniform vec4 _SDFPointArray[4];
uniform float _SDFPointIntensity;
uniform float _SDFNegativeIntensity;
uniform float _SDFNoiseIntensity;
uniform float _SDFNoiseScale;
uniform vec3 _SDFNoisePanning;
float sdfHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
#ifdef SDF_NOISE_TEXTURE
uniform sampler2D _SDFNoiseTex;
uniform vec4 _SDFNoiseVolume;
float sdfNoise(vec3 p) {
  return volumeAtlas(_SDFNoiseTex, _SDFNoiseVolume, p);
}
#else
// (a smooth noise over the world, in place of the game's 3D texture, when it is not taken)
float sdfNoise(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(sdfHash(cell), sdfHash(cell + vec3(1.0, 0.0, 0.0)), f.x),
        mix(sdfHash(cell + vec3(0.0, 1.0, 0.0)), sdfHash(cell + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(sdfHash(cell + vec3(0.0, 0.0, 1.0)), sdfHash(cell + vec3(1.0, 0.0, 1.0)), f.x),
        mix(sdfHash(cell + vec3(0.0, 1.0, 1.0)), sdfHash(cell + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z
  );
}
#endif
#endif
uniform float _EmissionBrightness;
uniform float _EmissionFogSuppression;
uniform float _EmissionTexBloomIntensity;
uniform float _EmissionTexWhiteBoostMultiplier;
uniform float _TimeSeconds;
uniform float _SongTime;
uniform float _TimeOffset;
uniform float _FogStartOffset;
uniform float _FogScale;
#ifdef EMISSION_SOURCE_SDF
varying vec3 vSdfLocal;
#endif
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vViewPos;
varying vec3 vViewNormal;
varying vec2 vUv;
#ifdef USE_SECONDARY_UV
varying vec2 vSecondaryUv;
#endif
varying vec4 vScreenPos;
#ifdef USE_VERTEX_COLOR
varying vec4 vVertexColor;
#endif
${BASE_COLOR_CHUNK}
${ACES_CHUNK}
${FOG_CHUNK}
${REFLECTION_PROBE_CHUNK}
float chroDiffuseTerm(vec3 normal, vec3 lightDirection) {
  return max(dot(normal, lightDirection), 0.0)
    + max(dot(normal, -lightDirection), 0.0) * _BothSidesDiffuseMultiplier;
}

float chroLightFalloff(vec3 lightOffset, float radius) {
  return clamp(1.0 - length(lightOffset) / max(radius, 0.00000001), 0.0, 1.0);
}

const float CHRO_PI = 3.14159265;

float chroGgxDistribution(float normalDotHalf, float roughnessSquared) {
  float roughnessFourth = roughnessSquared * roughnessSquared;
  float denominator = normalDotHalf * normalDotHalf * (roughnessFourth - 1.0) + 1.0;
  return roughnessFourth / (CHRO_PI * denominator * denominator);
}

float chroSmithMasking(float normalDotDirection, float geometryK) {
  return normalDotDirection / (normalDotDirection * (1.0 - geometryK) + geometryK);
}

vec3 chroSchlickFresnel(vec3 baseReflectance, float viewDotHalf) {
  return baseReflectance + (1.0 - baseReflectance) * pow(1.0 - viewDotHalf, 5.0);
}

vec3 chroSpecularTerm(
  vec3 lightDirection,
  vec3 viewDirection,
  vec3 normal,
  vec3 albedo,
  float metallic,
  float smoothness
) {
  vec3 halfDirection = normalize(lightDirection + viewDirection);
  float normalDotHalf = clamp(dot(normal, halfDirection), 0.0, 1.0);
  float normalDotView = clamp(dot(normal, viewDirection), 0.0, 1.0);
  float normalDotLight = clamp(dot(normal, lightDirection), 0.0, 1.0);
  float viewDotHalf = clamp(dot(viewDirection, halfDirection), 0.0, 1.0);
  float roughness = 1.0 - smoothness;
  float roughnessSquared = roughness * roughness;
  float distribution = chroGgxDistribution(normalDotHalf, roughnessSquared);
  vec3 baseReflectance = mix(vec3(0.04), albedo, metallic);
  vec3 fresnel = chroSchlickFresnel(baseReflectance, viewDotHalf);
  float geometryK = (roughnessSquared + 1.0) * (roughnessSquared + 1.0) / 8.0;
  float geometryView = chroSmithMasking(normalDotView, geometryK);
  float geometryLight = chroSmithMasking(normalDotLight, geometryK);
  return distribution * fresnel * geometryView * geometryLight
    / (4.0 * normalDotView * normalDotLight + 0.001) * normalDotLight;
}
void main() {
  float materialTime = _TimeSeconds;
  #ifdef CUSTOM_TIME_SONG
  materialTime = _SongTime;
  #elif defined(CUSTOM_TIME_FREEZE)
  materialTime = _TimeOffset;
  #endif
  vec3 albedo = baseColor();
  #ifdef DIFFUSE_TEXTURE
  albedo *= texture2D(_DiffuseTex, vUv * _DiffuseTexScale + _DiffuseTexOffset).rgb * _AlbedoMultiplier;
  #endif
  #ifdef USE_VERTEX_COLOR
  #ifndef VERTEX_EMISSION
  albedo *= vVertexColor.rgb;
  #endif
  #endif
  vec3 normal = normalize(vWorldNormal);
  #ifdef NORMAL_TEXTURE
  vec3 mappedNormal = texture2D(
    _NormalTexture,
    vUv * _NormalTextureScale + _NormalTextureOffset
  ).xyz * 2.0 - 1.0;
  mappedNormal.xy *= _NormalScale;
  vec3 positionDx = dFdx(vWorldPos);
  vec3 positionDy = dFdy(vWorldPos);
  vec2 uvDx = dFdx(vUv);
  vec2 uvDy = dFdy(vUv);
  vec3 tangent = normalize(positionDx * uvDy.y - positionDy * uvDx.y);
  vec3 bitangent = normalize(-positionDx * uvDy.x + positionDy * uvDx.x);
  normal = normalize(mat3(tangent, bitangent, normal) * mappedNormal);
  #endif
  vec3 viewDirection = normalize(cameraPosition - vWorldPos);
  float metallic = _Metallic;
  float smoothness = _Smoothness;
  vec4 packedSurface = vec4(1.0);
  #ifdef METAL_SMOOTHNESS_TEXTURE
  packedSurface = texture2D(
    _MetalSmoothnessTex,
    vUv * _MetalSmoothnessTexScale + _MetalSmoothnessTexOffset
  );
    #ifdef METALLIC_TEXTURE
  metallic *= packedSurface.r;
    #endif
    #ifdef SMOOTHNESS_TEXTURE
    #ifdef METAL_SMOOTHNESS_ALPHA
    smoothness *= packedSurface.a;
    #elif defined(METAL_SMOOTHNESS_GREEN_ROUGHNESS)
    smoothness *= 1.0 - packedSurface.g;
    #else
    smoothness *= packedSurface.g;
    #endif
    #endif
  #endif
  vec3 diffuseLight = vec3(0.0);
  vec3 specularLight = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    vec3 lightColor = _DirectionalLightColors[i];
    if (lightColor.r == 0.0 && lightColor.g == 0.0 && lightColor.b == 0.0) continue;
    vec3 lightDir = normalize(_DirectionalLightDirections[i]);
    float attenuation = 1.0;
    if (_LightFalloffEnabled != 0.0) {
      vec3 lightOffset = vWorldPos - _DirectionalLightPositions[i];
      attenuation = chroLightFalloff(lightOffset, _DirectionalLightRadii[i]);
    }
    diffuseLight += chroDiffuseTerm(normal, lightDir) * attenuation * lightColor * _DiffuseEnabled;
    if (_SpecularEnabled != 0.0) {
      specularLight += chroSpecularTerm(lightDir, viewDirection, normal, albedo, metallic, smoothness)
        * attenuation * lightColor;
    }
  }
  if (_PrivatePointLightEnabled != 0.0) {
    vec3 pointOffset = _PrivatePointLightLocal != 0.0
      ? _PrivatePointLightPosition
      : _PrivatePointLightPosition - vWorldPos;
    vec3 lightDir = normalize(pointOffset);
    vec3 pointColor = _PrivatePointLightColor * _PrivatePointLightIntensity;
    diffuseLight += chroDiffuseTerm(normal, lightDir) * pointColor * _DiffuseEnabled;
    if (_SpecularEnabled != 0.0) {
      specularLight += chroSpecularTerm(lightDir, viewDirection, normal, albedo, metallic, smoothness) * pointColor;
    }
  }
  vec3 calculated = diffuseLight * albedo * (1.0 - metallic);
  if (_SpecularEnabled != 0.0) {
    calculated += specularLight * _SpecularIntensity;
  }
  calculated += max(_NominalDiffuseLevel * albedo, vec3(_AmbientMinimalValue)) * _AmbientMultiplier;
  #ifdef REFLECTION_PROBE
  vec3 reflectedView = reflect(-viewDirection, normal);
  float roughness = 1.0 - smoothness;
  float roughnessMipWeight = 1.7 - 0.7 * roughness;
  float probeMip = roughness * roughnessMipWeight * 6.0;
  vec3 reflection = chroSampleProbe(reflectedView, vWorldPos, probeMip);
    #ifdef MULTIPLY_REFLECTIONS
    reflection *= mix(vec3(1.0), albedo, metallic);
    #endif
  float reflectionWeight = smoothness * mix(0.4, 2.0, metallic);
  calculated += reflection * reflectionWeight * _ReflectionIntensity;
  #endif
  #ifdef OCCLUSION
    #ifdef OCCLUSION_DIRT
  // (the surface's own picture — stone, dirt — darkening what the lights give it)
  float occlusion = mix(1.0, texture2D(_DirtTex, vUv * _DirtTexScale + _DirtTexOffset).b, _OcclusionIntensity);
    #else
  float occlusion = mix(1.0, packedSurface.b, _OcclusionIntensity);
    #endif
    #ifdef OCCLUSION_DETAIL
    float detailOcclusion = texture2D(
      _DirtDetailTex,
      (vUv + _OcclusionDetailOffset) * _DirtDetailTexScale + _DirtDetailTexOffset
    ).b;
    occlusion *= mix(1.0, detailOcclusion, _OcclusionDetailIntensity);
    #endif
    #ifdef OCCLUSION_BEFORE_EMISSION
    calculated *= occlusion;
    #endif
  #endif
  #ifdef TONE_MAP_BEFORE_EMISSION
  calculated = chroToneMap(calculated);
  #endif
  float bloomEmission = 0.0;
  float fogSuppression = 1.0;
  #ifdef EMISSION_SOURCE_SDF
  vec3 sdfEmission = vec3(0.0);
  #endif
  #ifdef VERTEX_EMISSION
  float vertexEmissionT = clamp(
    (vVertexColor.g - _VertexEmissionThreshold) / (1.0 - _VertexEmissionThreshold),
    0.0,
    1.0
  );
  float vertexEmissionMask = vertexEmissionT * vertexEmissionT * (3.0 - 2.0 * vertexEmissionT)
    * _VertexEmissionStrength;
    #ifdef PARALLAX_MAP
  // (the game's "flexible parallax" shader is not readable. Taken so: a picture as if inside the
  // surface, which slides with the angle of view, and the glow of the vertices shows through it)
  vec3 parallaxReflected = reflect(-viewDirection, normal);
  float parallaxDepth = texture2D(
    _ParallaxMap,
    (vUv + _ParallaxTexSpeed * materialTime) * _ParallaxMapScale + _ParallaxMapOffset
      + parallaxReflected.xy * 0.12 * _ParallaxStep
  ).r;
  vertexEmissionMask *= mix(0.25, 1.0 + _ParallaxIntensity, parallaxDepth);
    #endif
  calculated += _EmissionColor * _EmissionColorAlpha * vertexEmissionMask;
  fogSuppression = 1.0 - _EmissionFogSuppression * vertexEmissionMask
    * _EmissionColorAlpha * _EmissionColorAlpha;
  #endif
  #ifdef EMISSION_TEXTURE
  vec2 emissionUv = vUv;
    #ifdef DISTORTION_EMISSION
  // (the game's shader is not readable. Taken so: the distortion texture's red and green shift where
  // the emission texture is read, along the material's axes; the material's time offset — a map may
  // step it — moves the pattern)
  vec2 distortionShift = texture2D(
    _DistortionTex,
    (vUv + _DistortionPanning * materialTime + vec2(0.1234, 0.0723) * _TimeOffset) * _DistortionTexScale
      + _DistortionTexOffset
  ).rg - 0.5;
  emissionUv += distortionShift * _DistortionAxes * _DistortionStrength * 2.0;
    #endif
    #if defined(EMISSION_COLOR_GRADIENT) && !defined(EMISSION_SOURCE_SDF)
  vec4 emission = texture2D(
    _EmissionTex,
    (emissionUv + _EmissionTexSpeed * materialTime) * _EmissionTexScale + _EmissionTexOffset
  );
    #else
  vec4 emission = texture2D(_EmissionTex, emissionUv * _EmissionTexScale + _EmissionTexOffset);
    #endif
    #ifdef EMISSION_SOURCE_SDF
    // (as the game's own shader does it, read from its compiled code and its parameter table: each
    // point adds its reach — its radius less the square root of the distance — times the point
    // strength, a negative point multiplies by one less its reach times the negative strength; the 3D
    // noise times its intensity is added to that; the sum times the emission brightness is the field)
    float sdfReach = 0.0;
    float sdfDim = 1.0;
    for (int sdfIndex = 0; sdfIndex < 3; sdfIndex++) {
      vec4 sdfPoint = _SDFPointArray[sdfIndex];
      float reach = max(abs(sdfPoint.w) - sqrt(distance(vWorldPos, sdfPoint.xyz)), 0.0);
      if (sdfPoint.w > 0.0) sdfReach += reach * _SDFPointIntensity;
      else if (sdfPoint.w < 0.0) sdfDim *= clamp(1.0 - reach * _SDFNegativeIntensity, 0.0, 1.0);
    }
    vec3 sdfNoiseShift = _SDFNoisePanning * materialTime;
    float sdfNoiseValue = sdfNoise(vSdfLocal * _SDFNoiseScale + sdfNoiseShift);
    float sdfPlace = (sdfReach * sdfDim + sdfNoiseValue * _SDFNoiseIntensity) * _EmissionBrightness;
      #ifdef EMISSION_COLOR_GRADIENT
      // (the field is the place across the gradient texture (which repeats) and also how bright its
      // colour is, up to full at 1; the map's position is the place up it. The light does not tint it:
      // its strength comes in as the gradient intensity — the game's light sends it there — and scales
      // the colour and the glow)
      vec4 sdfGradient = texture2D(
        _EmissionGradientTex,
        vec2(sdfPlace, fract(_EmissionGradientPosition + _EmissionGradientPanningSpeed * 0.05 * materialTime))
      );
      vec3 sdfColor = clamp(sdfGradient.rgb * sdfPlace, 0.0, 1.0);
      emission = vec4(
        sdfColor * _EmissionGradientIntensity * _EmissionTexColor * _EmissionTexColorAlpha,
        _EmissionTexBloomIntensity * _EmissionGradientIntensity
      );
      #else
      // (without a gradient the field is how bright the light's colour is — not clamped — times the
      // light's strength, and the glow is its square times 3.5, the strength and the bloom intensity)
      emission = vec4(
        sdfPlace * _EmissionTexColor * _EmissionTexColorAlpha,
        sdfPlace * sdfPlace * 3.5 * _EmissionTexColorAlpha * _EmissionTexBloomIntensity
      );
      #endif
    #endif
    #ifdef EMISSION_MASK
    vec2 primaryMaskUv = vUv;
      #ifdef EMISSION_MASK_SECONDARY_UV
      primaryMaskUv = vSecondaryUv;
      #endif
    vec4 primaryMask = texture2D(
      _EmissionMask,
      primaryMaskUv * _EmissionMaskScale + _EmissionMaskOffset + _EmissionMaskSpeed * materialTime
    );
    emission *= mix(vec4(1.0), primaryMask, _PrimaryEmissionGain);
    #endif
    #ifdef SECONDARY_EMISSION_MASK
    vec2 secondaryMaskUv = vUv;
      #ifdef SECONDARY_EMISSION_MASK_SECONDARY_UV
      secondaryMaskUv = vSecondaryUv;
      #endif
    vec4 secondaryMask = texture2D(
      _SecondaryEmissionMask,
      secondaryMaskUv * _SecondaryEmissionMaskScale + _SecondaryEmissionMaskOffset
        + _SecondaryEmissionMaskSpeed * materialTime
    );
    emission *= mix(vec4(1.0), secondaryMask, _SecondaryEmissionGain);
    #endif
    #if defined(EMISSION_TEXTURE_SIMPLE) && !defined(EMISSION_SOURCE_SDF)
      #ifdef EMISSION_COLOR_GRADIENT
    // (the game's shader is not readable. Taken so, by its frames: the texture picks the place across
    // the gradient, the map's position the place along it, and the surface glows evenly)
    float visibleEmission = _EmissionBrightness * mix(0.7, 1.0, emission.g);
    bloomEmission = 0.5 * emission.g * _EmissionBrightness;
    vec3 visibleEmissionColor = texture2D(
      _EmissionGradientTex,
      vec2(emission.r, fract(_EmissionGradientPosition))
    ).rgb * _EmissionGradientIntensity * min(visibleEmission, 1.0);
      #else
    float visibleEmission = emission.r * _EmissionBrightness;
    bloomEmission = emission.g * _EmissionBrightness;
    vec3 visibleEmissionColor = _EmissionTexColor * visibleEmission * _EmissionTexColorAlpha;
      #endif
      #ifdef EMISSION_WHITE_BOOST
      float whiteBoostSignal = bloomEmission * bloomEmission * _EmissionTexColorAlpha
        * _EmissionTexWhiteBoostMultiplier;
      float whiteEnergy = whiteBoostSignal * whiteBoostSignal * 0.997;
      visibleEmissionColor = clamp(visibleEmissionColor + vec3(whiteEnergy), 0.0, 1.0);
      #endif
    calculated += visibleEmissionColor;
    fogSuppression = 1.0 - visibleEmission * _EmissionFogSuppression * _EmissionTexColorAlpha;
    #elif defined(EMISSION_SOURCE_SDF)
    // (the game's shader adds no white boost and no distance fog here: the glow is its own)
    sdfEmission = emission.rgb;
    bloomEmission = emission.a;
    #else
    vec4 finalEmission = emission * vec4(_EmissionTexColor, _EmissionTexColorAlpha)
      * _EmissionBrightness;
    bloomEmission = finalEmission.a;
    calculated += finalEmission.rgb;
    fogSuppression = 1.0 - bloomEmission * _EmissionFogSuppression;
      #ifdef EMISSION_WHITE_BOOST
      float whiteBoostSignal = bloomEmission * bloomEmission * _EmissionTexWhiteBoostMultiplier;
      float whiteEnergy = whiteBoostSignal * whiteBoostSignal * 0.997;
      calculated += vec3(whiteEnergy);
      #endif
    #endif
  #endif
  #if defined(OCCLUSION) && !defined(OCCLUSION_BEFORE_EMISSION)
  calculated *= occlusion;
  #endif
  vec4 color = vec4(calculated, 0.0);
  #ifdef EMISSION_MAIN_EFFECT
  float mainEffectSignal = bloomEmission;
  color.a = mainEffectSignal * mainEffectSignal * 3.5
    * _EmissionTexColorAlpha * _EmissionTexBloomIntensity;
  #endif
  #ifdef VERTEX_EMISSION_MAIN_EFFECT
  color.a += vVertexColor.a * vVertexColor.a * _EmissionColorAlpha * _VertexEmissionBloomIntensity;
  #endif
  if (_GroundFadeEnabled != 0.0) {
    color *= clamp((vWorldPos.y + _GroundFadeOffset) * _GroundFadeScale, 0.0, 1.0);
  }
  #ifndef TONE_MAP_BEFORE_EMISSION
  color.rgb = chroToneMap(color.rgb);
  #endif
  #ifdef EMISSION_SOURCE_SDF
  // (as the game's shader does it: no distance fog; the colour and the glow are the emission over
  // the surface's own. Its code also takes them to a dim grey low down by the height fog, but its
  // frames do not show it — the hill of spheres under the player keeps its colour — so it is left out)
  // (and the surface's own is only its colour times the larger of the nominal diffuse level times the
  // ambient multiplier and the ambient minimum: no lighting and no reflections.
  // The game's code also writes a glow (its alpha) — the bloom intensity times the light's strength
  // for the gradient, the field's square for the flat one — but its frames show no glow and no
  // whitening on these spheres even where the light is at 2, so it is left at none.)
  color = vec4(
    baseColor() * max(_NominalDiffuseLevel * _AmbientMultiplier, vec3(_AmbientMinimalValue)) + sdfEmission,
    0.0
  );
  #else
  color = applyChroFog(color, vScreenPos, vWorldPos, _FogStartOffset, _FogScale * fogSuppression);
  #endif
  if (_DistanceDarkeningEnabled != 0.0) {
    vec3 offset = vWorldPos - _DarkeningCenter;
    float distanceAlongAxis = max(0.0, dot(offset, normalize(_DarkeningDirection)));
    float factor = clamp(distanceAlongAxis * _DarkeningScale, 0.0, 1.0) * _DarkeningIntensity;
    color.rgb = mix(color.rgb, vec3(0.0), factor);
  }
  // game writes to a unorm target: blend sources clamp to [0,1] per draw
  gl_FragColor = clamp(color, 0.0, 1.0);
  #include <colorspace_fragment>
}
`;
