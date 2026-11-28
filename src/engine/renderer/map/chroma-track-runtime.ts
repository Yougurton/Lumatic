import { Matrix4, Quaternion, Vector3, type Object3D, type ShaderMaterial } from 'three';

import { eventProgress, eventProviderBeat } from '../../core/animation/event-timing';
import {
  multiplyQuaternions,
  quaternionFromEuler,
  sampleNumber,
  sampleRotation,
  sampleVector,
  sampleVector4,
  type NumberPoint,
  type PointSampleContext,
  type QuaternionTuple,
  type RotationPoint,
  type Vector3Tuple,
  type Vector4Point,
  type Vector4Tuple,
  type VectorPoint,
} from '../../core/animation/point-definition';
import type {
  ChromaComponentAnimation,
  ChromaNumberPoint,
  ChromaTrackAnimation,
  ChromaVectorPoint,
} from '../../core/chroma-environment';
import type { NoodleBeatmapData, NoodleParentEvent } from '../../core/noodle-data';
import { activeNoodleParent, hasNoodleParent, sampleNoodleParent, type NoodleParentSample } from '../../core/noodle-runtime';
import type {
  EnvironmentChromaTubeTarget,
  EnvironmentLightSegment,
  EnvironmentMaterialLight,
  LoadedEnvironment,
} from '../environment/environment-runtime';
import type { FogParams } from '../fog-math';
import { shaderColorUniform, shaderNumberUniform } from '../materials/shared';

// Depth-fighting stabilization constants: animation z deltas at or below STACK_MAX_DELTA are
// treated as coplanar stacks and re-spaced to STACK_GAP (a sub-pixel world distance) each update.
const STACK_MAX_DELTA = 0.02;
const STACK_GAP = 0.05;

interface TimedEvent {
  beat: number;
  duration: number;
  repeat: number;
  easing?: string;
}

interface PointEvent<T> extends TimedEvent {
  order: number;
  points: T[];
}

type VectorEvent = PointEvent<VectorPoint>;
type RotationEvent = PointEvent<RotationPoint>;
type ColorEvent = PointEvent<Vector4Point>;
type NumberEvent = PointEvent<NumberPoint>;

interface TrackRuntime {
  position: VectorEvent[];
  localPosition: VectorEvent[];
  rotation: RotationEvent[];
  localRotation: RotationEvent[];
  scale: VectorEvent[];
  color: ColorEvent[];
  fogHeight: NumberEvent[];
  fogStartY: NumberEvent[];
  fogAttenuation: NumberEvent[];
  fogOffset: NumberEvent[];
}

interface ComponentTrackRuntime {
  fogHeight: NumberEvent[];
  fogStartY: NumberEvent[];
  fogAttenuation: NumberEvent[];
  fogOffset: NumberEvent[];
  colorAlphaMultiplier: NumberEvent[];
  bloomFogIntensityMultiplier: NumberEvent[];
}

interface TransformTarget {
  target: Object3D;
  tracks: string[];
  position: Vector3;
  rotation: Quaternion;
  scale: Vector3;
  events?: readonly (readonly [VectorEvent | undefined, VectorEvent | undefined, RotationEvent | undefined, RotationEvent | undefined, VectorEvent | undefined])[];
  parent?: boolean;
  beat?: number;
  nextChange?: number;
  static?: boolean;
}

interface MaterialTarget {
  material: ShaderMaterial;
  tracks: string[];
  color?: ReturnType<typeof shaderColorUniform>;
  alpha?: number;
  multiplier?: number;
}

interface TubeTarget {
  target: EnvironmentChromaTubeTarget;
  tracks: string[];
  segments: { target: EnvironmentLightSegment; intensityMultiplier: number }[];
  materialLights: {
    target: EnvironmentMaterialLight;
    intensityMultiplier: number;
  }[];
}

const laneSize = 0.6;
const fogProperties: readonly [
  keyof Pick<FogParams, 'height' | 'startY' | 'attenuation' | 'offset'>,
  keyof ComponentTrackRuntime,
][] = [
  ['height', 'fogHeight'],
  ['startY', 'fogStartY'],
  ['attenuation', 'fogAttenuation'],
  ['offset', 'fogOffset'],
];

function emptyTrack(): TrackRuntime {
  return {
    position: [],
    localPosition: [],
    rotation: [],
    localRotation: [],
    scale: [],
    color: [],
    fogHeight: [],
    fogStartY: [],
    fogAttenuation: [],
    fogOffset: [],
  };
}

function emptyComponentTrack(): ComponentTrackRuntime {
  return {
    fogHeight: [],
    fogStartY: [],
    fogAttenuation: [],
    fogOffset: [],
    colorAlphaMultiplier: [],
    bloomFogIntensityMultiplier: [],
  };
}

function latestEvent<T extends { beat: number }>(events: readonly T[], beat: number) {
  if (events.length === 0 || (events[0]?.beat ?? Number.POSITIVE_INFINITY) > beat) return undefined;
  if (events.length === 1 || (events[events.length - 1]?.beat ?? Number.POSITIVE_INFINITY) <= beat) return events[events.length - 1];
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((events[middle]?.beat ?? Number.POSITIVE_INFINITY) <= beat) low = middle + 1;
    else high = middle;
  }
  return events[low - 1];
}

function followingEvent<T extends { beat: number }>(events: readonly T[], beat: number) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((events[middle]?.beat ?? Number.POSITIVE_INFINITY) <= beat) low = middle + 1;
    else high = middle;
  }
  return events[low];
}

function sampleEvent<T extends { expression?: unknown; value: R }, R>(
  event: PointEvent<T> | undefined,
  beat: number,
  sample: (points: readonly T[], time: number, context?: PointSampleContext, songBpmTime?: number) => R,
  context?: PointSampleContext,
) {
  if (event === undefined) return undefined;
  if (event.points.length === 1 && event.points[0]?.expression === undefined) return event.points[0].value as R;
  return sample(
    event.points,
    eventProgress(beat, event.beat, event.duration, event.repeat, event.easing),
    context,
    eventProviderBeat(beat, event.beat, event.duration, event.repeat),
  );
}

function pointEvent<T>(
  animation: ChromaTrackAnimation,
  points: T[] | undefined,
  order: number,
): PointEvent<T> | undefined {
  return points === undefined
    ? undefined
    : {
        beat: animation.songBpmTime,
        duration: animation.durationSongBpmTime,
        repeat: animation.repeat,
        easing: animation.easing,
        order,
        points,
      };
}

function componentEvent(
  animation: ChromaComponentAnimation,
  points: ChromaNumberPoint[] | undefined,
  order: number,
): NumberEvent | undefined {
  return points === undefined
    ? undefined
    : {
        beat: animation.songBpmTime,
        duration: animation.durationSongBpmTime,
        repeat: 0,
        easing: animation.easing,
        order,
        points,
      };
}

function rotationPoints(points: ChromaVectorPoint[] | undefined) {
  return points?.map((point): RotationPoint => {
    const rotation = quaternionFromEuler(point.value);
    return {
      value: rotation,
      time: point.time,
      easing: point.easing,
      expression: point.expression,
    };
  });
}

function push<T>(items: T[], item: T | undefined) {
  if (item !== undefined) items.push(item);
}

function eventOrder(left: TimedEvent & { order: number }, right: TimedEvent & { order: number }) {
  return left.beat - right.beat || left.order - right.order;
}

function addTargetTrack<T>(targets: Map<T, string[]>, track: string, target: T) {
  const tracks = targets.get(target);
  if (tracks === undefined) targets.set(target, [track]);
  else if (!tracks.includes(track)) tracks.push(track);
}

function targetDepth(target: Object3D) {
  let depth = 0;
  for (let parent = target.parent; parent !== null; parent = parent.parent) depth++;
  return depth;
}

function multiplyVector(left: Vector3Tuple | undefined, right: Vector3Tuple | undefined): Vector3Tuple | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return [left[0] * right[0], left[1] * right[1], left[2] * right[2]];
}

function addVector(left: Vector3Tuple | undefined, right: Vector3Tuple | undefined): Vector3Tuple | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function multiplyColor(left: Vector4Tuple | undefined, right: Vector4Tuple | undefined): Vector4Tuple | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return [left[0] * right[0], left[1] * right[1], left[2] * right[2], left[3] * right[3]];
}

function mapPosition(value: Vector3Tuple, v2: boolean): Vector3Tuple {
  const scale = v2 ? laneSize : 1;
  return [value[0] * scale, value[1] * scale, -value[2] * scale];
}

function newer(left: NumberEvent | undefined, right: NumberEvent | undefined) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return right.beat > left.beat || (right.beat === left.beat && right.order > left.order) ? right : left;
}

export class ChromaTrackRuntime {
  private readonly tracks = new Map<string, TrackRuntime>();
  private readonly componentTracks = new Map<string, ComponentTrackRuntime>();
  private readonly worldPosition = new Vector3();
  private readonly parentPosition = new Vector3();
  private readonly parentScale = new Vector3();
  private readonly parentRotation = new Quaternion();
  private readonly targetRotation = new Quaternion();
  private readonly parentMatrix = new Matrix4();
  private readonly parentMatrixInverse = new Matrix4();
  private readonly noodleBasis = new Matrix4().makeScale(1, 1, -1);
  private transformTargets: TransformTarget[] = [];
  private readonly stackPairs: Array<{ a: TransformTarget; b: TransformTarget; rx: number; ry: number }> = [];
  private readonly baseTransforms = new WeakMap<Object3D, { position: Vector3; rotation: Quaternion; scale: Vector3 }>();
  private materialTargets: MaterialTarget[] = [];
  private tubeTargets: TubeTarget[] = [];
  private fogTracks: string[] = [];
  private fogTrackEvents: { beat: number; track: string }[] = [];
  private baseFog: FogParams | null = null;
  private fog: FogParams | null = null;
  private v2 = false;

  rebuild(environment: LoadedEnvironment) {
    this.clear();
    this.baseFog = { ...environment.data.fogParams };
    this.fog = { ...this.baseFog };
    const source = environment.chromaEnvironment;
    if (source === undefined) return;
    this.v2 = source.version === 2;

    for (const [order, animation] of source.animations.entries()) {
      const rotation = rotationPoints(animation.rotation);
      const localRotation = rotationPoints(animation.localRotation);
      for (const trackName of animation.track) {
        let track = this.tracks.get(trackName);
        if (track === undefined) {
          track = emptyTrack();
          this.tracks.set(trackName, track);
        }
        push(track.position, pointEvent(animation, animation.position, order));
        push(track.localPosition, pointEvent(animation, animation.localPosition, order));
        push(track.rotation, pointEvent(animation, rotation, order));
        push(track.localRotation, pointEvent(animation, localRotation, order));
        push(track.scale, pointEvent(animation, animation.scale, order));
        push(track.color, pointEvent(animation, animation.color, order));
        push(track.fogHeight, pointEvent(animation, animation.fogHeight, order));
        push(track.fogStartY, pointEvent(animation, animation.fogStartY, order));
        push(track.fogAttenuation, pointEvent(animation, animation.fogAttenuation, order));
        push(track.fogOffset, pointEvent(animation, animation.fogOffset, order));
      }
    }

    for (const [order, animation] of source.componentAnimations.entries()) {
      for (const trackName of animation.track) {
        let track = this.componentTracks.get(trackName);
        if (track === undefined) {
          track = emptyComponentTrack();
          this.componentTracks.set(trackName, track);
        }
        const fog = animation.components.BloomFogEnvironment;
        push(track.fogHeight, componentEvent(animation, fog?.height, order));
        push(track.fogStartY, componentEvent(animation, fog?.startY, order));
        push(track.fogAttenuation, componentEvent(animation, fog?.attenuation, order));
        push(track.fogOffset, componentEvent(animation, fog?.offset, order));
        const tube = animation.components.TubeBloomPrePassLight;
        push(track.colorAlphaMultiplier, componentEvent(animation, tube?.colorAlphaMultiplier, order));
        push(track.bloomFogIntensityMultiplier, componentEvent(animation, tube?.bloomFogIntensityMultiplier, order));
      }
    }

    for (const track of this.tracks.values()) {
      track.position.sort(eventOrder);
      track.localPosition.sort(eventOrder);
      track.rotation.sort(eventOrder);
      track.localRotation.sort(eventOrder);
      track.scale.sort(eventOrder);
      track.color.sort(eventOrder);
      track.fogHeight.sort(eventOrder);
      track.fogStartY.sort(eventOrder);
      track.fogAttenuation.sort(eventOrder);
      track.fogOffset.sort(eventOrder);
    }
    for (const track of this.componentTracks.values()) {
      track.fogHeight.sort(eventOrder);
      track.fogStartY.sort(eventOrder);
      track.fogAttenuation.sort(eventOrder);
      track.fogOffset.sort(eventOrder);
      track.colorAlphaMultiplier.sort(eventOrder);
      track.bloomFogIntensityMultiplier.sort(eventOrder);
    }

    const transformTracks = new Map<Object3D, string[]>();
    for (const [track, targets] of environment.chromaTracks ?? []) {
      for (const target of targets) addTargetTrack(transformTracks, track, target);
    }
    this.transformTargets = [...transformTracks].map(([target, tracks]) => {
      // (rebuilt with the animations changed — the editor — a target may stand where they had it:
      // its own transform is the one it had when first seen)
      let base = this.baseTransforms.get(target);
      if (base === undefined) {
        base = { position: target.position.clone(), rotation: target.quaternion.clone(), scale: target.scale.clone() };
        this.baseTransforms.set(target, base);
      }
      return { target, tracks, position: base.position.clone(), rotation: base.rotation.clone(), scale: base.scale.clone() };
    });
    this.transformTargets.sort((left, right) => targetDepth(left.target) - targetDepth(right.target));
    // Depth-fighting stabilization: some maps stack geometry in nearly coplanar layers (gaps of
    // a few thousandths of a unit, e.g. Pictured as Perfect's card stacks). Such gaps are below
    // depth-buffer precision at play distances, so the surfaces flicker and shimmer. Detect
    // track pairs that overlap in x/y while separated by at most STACK_MAX_DELTA in z, using the
    // tracks' own animation values; update() then enforces a small depth-exact gap between the
    // live targets, preserving their front-to-back order.
    this.stackPairs.length = 0;
    const parked = (value: Vector3Tuple) =>
      Math.abs(value[0]) > 60000 || Math.abs(value[1]) > 60000 || Math.abs(value[2]) > 60000;
    interface StackSample {
      x: number;
      y: number;
      z: number;
      hx: number;
      hy: number;
      target: number;
    }
    const halfExtents = new Map<string, { hx: number; hy: number }>();
    for (const [name, track] of this.tracks) {
      const value = track.scale[0]?.points[0]?.value;
      halfExtents.set(
        name,
        value === undefined
          ? { hx: 0.5, hy: 0.5 }
          : {
              hx: Math.max((Math.abs(value[0]) + Math.abs(value[2])) / 2, 0.25),
              hy: Math.max((Math.abs(value[1]) + Math.abs(value[2])) / 2, 0.25),
            },
      );
    }
    const samplesByCell = new Map<number, StackSample[]>();
    for (const [index, transform] of this.transformTargets.entries()) {
      const extents =
        transform.tracks.map((name) => halfExtents.get(name)).find((value) => value !== undefined) ?? { hx: 0.5, hy: 0.5 };
      for (const name of transform.tracks) {
        const track = this.tracks.get(name);
        if (track === undefined) continue;
        for (const event of track.position) {
          for (const point of event.points) {
            const value = point.value;
            if (value === undefined || parked(value)) continue;
            const cellKey = Math.floor(value[0] / 32) * 100003 + Math.floor(value[1] / 32);
            let bucket = samplesByCell.get(cellKey);
            if (bucket === undefined) {
              bucket = [];
              samplesByCell.set(cellKey, bucket);
            }
            bucket.push({ x: value[0], y: value[1], z: value[2], hx: extents.hx, hy: extents.hy, target: index });
          }
        }
      }
    }
    const reaches = new Map<number, { rx: number; ry: number }>();
    const targetCount = Math.max(this.transformTargets.length, 1);
    for (const bucket of samplesByCell.values()) {
      for (let i = 0; i < bucket.length; i++) {
        const a = bucket[i]!;
        for (let j = i + 1; j < bucket.length; j++) {
          const b = bucket[j]!;
          if (a.target === b.target) continue;
          const rx = a.hx + b.hx + 0.05;
          const ry = a.hy + b.hy + 0.05;
          if (Math.abs(a.x - b.x) > rx || Math.abs(a.y - b.y) > ry) continue;
          const delta = Math.abs(a.z - b.z);
          if (delta <= 0 || delta > STACK_MAX_DELTA) continue;
          const key = Math.min(a.target, b.target) * targetCount + Math.max(a.target, b.target);
          const reach = reaches.get(key);
          if (reach === undefined) reaches.set(key, { rx, ry });
          else {
            reach.rx = Math.max(reach.rx, rx);
            reach.ry = Math.max(reach.ry, ry);
          }
        }
      }
    }
    for (const [key, reach] of reaches) {
      const a = this.transformTargets[Math.floor(key / targetCount)];
      const b = this.transformTargets[key % targetCount];
      if (a === undefined || b === undefined) continue;
      this.stackPairs.push({ a, b, rx: reach.rx, ry: reach.ry });
    }

    const materialTracks = new Map<ShaderMaterial, string[]>();
    for (const [track, targets] of environment.chromaMaterialTracks ?? []) {
      for (const target of targets) addTargetTrack(materialTracks, track, target);
    }
    this.materialTargets = [...materialTracks].map(([material, tracks]) => ({
      material,
      tracks,
      color: shaderColorUniform(material, '_Color')?.clone(),
      alpha: shaderNumberUniform(material, '_ColorAlpha'),
      multiplier: shaderNumberUniform(material, '_ColorMultiplier'),
    }));

    this.fogTracks = [...(environment.chromaFogTracks ?? [])];
    this.fogTrackEvents = source.fogTrackEvents.map((event) => ({
      beat: event.songBpmTime,
      track: event.track,
    }));

    const tubeTracks = new Map<EnvironmentChromaTubeTarget, string[]>();
    for (const [track, targets] of environment.chromaTubeTracks ?? []) {
      for (const target of targets) addTargetTrack(tubeTracks, track, target);
    }
    this.tubeTargets = [...tubeTracks].map(([target, tracks]) => ({
      target,
      tracks,
      segments: target.segments.map((segment) => ({
        target: segment,
        intensityMultiplier: segment.intensityMultiplier ?? 1,
      })),
      materialLights: target.materialLights.map((light) => ({
        target: light,
        intensityMultiplier: light.intensityMultiplier,
      })),
    }));
  }

  clear() {
    this.tracks.clear();
    this.componentTracks.clear();
    this.transformTargets = [];
    this.materialTargets = [];
    this.tubeTargets = [];
    this.fogTracks = [];
    this.fogTrackEvents = [];
    this.baseFog = null;
    this.fog = null;
  }

  update(beat: number, noodle?: NoodleBeatmapData, context?: PointSampleContext) {
    this.updateTransforms(beat, noodle, context);
    this.updateMaterials(beat, context);
    this.updateTubeComponents(beat, context);
    // Depth-fighting stabilization: keep detected near-coplanar stacks separated by a small
    // depth-exact gap, preserving their current front-to-back order. Parked targets stay put.
    for (const pair of this.stackPairs) {
      const pa = pair.a.target.position;
      const pb = pair.b.target.position;
      if (Math.abs(pa.x) > 60000 || Math.abs(pa.y) > 60000 || Math.abs(pa.z) > 60000) continue;
      if (Math.abs(pb.x) > 60000 || Math.abs(pb.y) > 60000 || Math.abs(pb.z) > 60000) continue;
      if (Math.abs(pa.x - pb.x) > pair.rx || Math.abs(pa.y - pb.y) > pair.ry) continue;
      const closer = pa.z >= pb.z ? pair.a : pair.b;
      const farther = closer === pair.a ? pair.b : pair.a;
      if (closer.target.position.z - farther.target.position.z >= STACK_GAP) continue;
      farther.target.position.z = closer.target.position.z - STACK_GAP;
      farther.target.updateMatrix();
      farther.target.updateWorldMatrix(false, false);
    }
    return this.updateFog(beat, context);
  }

  private track(name: string) {
    return this.tracks.get(name);
  }

  private sampleVector(events: VectorEvent[], beat: number, context?: PointSampleContext) {
    return sampleEvent(latestEvent(events, beat), beat, sampleVector, context);
  }

  private sampleRotation(
    events: RotationEvent[],
    beat: number,
    context?: PointSampleContext,
  ): QuaternionTuple | undefined {
    const rotation = sampleEvent(latestEvent(events, beat), beat, sampleRotation, context);
    return rotation === undefined ? undefined : [-rotation[0], -rotation[1], rotation[2], rotation[3]];
  }

  private sampleColor(events: ColorEvent[], beat: number, context?: PointSampleContext) {
    return sampleEvent(latestEvent(events, beat), beat, sampleVector4, context);
  }

  private sampleNumber(events: NumberEvent[], beat: number, context?: PointSampleContext) {
    return sampleEvent(latestEvent(events, beat), beat, sampleNumber, context);
  }

  private sampleNumberEvent(event: NumberEvent, beat: number, context?: PointSampleContext) {
    return sampleEvent(event, beat, sampleNumber, context);
  }

  private updateTransforms(beat: number, noodle?: NoodleBeatmapData, context?: PointSampleContext) {
    const dynamicEvent = (event: PointEvent<VectorPoint> | PointEvent<RotationPoint> | undefined, time: number) =>
      event !== undefined && (event.repeat > 0 || time < event.beat + event.duration || event.points.some((point) => point.expression !== undefined));
    const childTracks = new Set(noodle?.parentEvents.flatMap((event) => event.childrenTracks) ?? []);
    const parentCache = new Map<NoodleParentEvent, NoodleParentSample>();
    for (const runtime of this.transformTargets) {
      const hasParent = noodle !== undefined && runtime.tracks.some((track) => childTracks.has(track)) && hasNoodleParent(noodle, runtime.tracks, beat);
      if (
        !hasParent &&
        runtime.static === true &&
        runtime.parent === false &&
        runtime.beat !== undefined &&
        beat >= runtime.beat &&
        (runtime.nextChange === undefined || beat < runtime.nextChange)
      ) {
        continue;
      }
      const events = runtime.tracks.map((name) => {
        const track = this.track(name);
        return track === undefined
          ? ([undefined, undefined, undefined, undefined, undefined] as const)
          : ([latestEvent(track.position, beat), latestEvent(track.localPosition, beat), latestEvent(track.rotation, beat), latestEvent(track.localRotation, beat), latestEvent(track.scale, beat)] as const);
      });
      const parent = hasParent;
      const moving = parent || events.some((list) => list.some((event) => dynamicEvent(event, beat)));
      // A child track's own position event that is NEWER than its noodle parent's latest position
      // event acts in world space (Heck re-asserts transform.position): the parked parent must not
      // displace it. Children whose last position event predates the parent's keep riding it —
      // that is what hides Pictured as Perfect's transition tunnel once its parent parks, while
      // keeping its digit text (re-positioned after the park) visible.
      let worldWins = false;
      if (parent && noodle !== undefined) {
        const parentEvent = activeNoodleParent(noodle, runtime.tracks, beat);
        if (parentEvent !== undefined) {
          let childBeat: number | undefined;
          for (const list of events) {
            const positionEvent = list[0];
            if (positionEvent !== undefined && (childBeat === undefined || positionEvent.beat > childBeat)) childBeat = positionEvent.beat;
          }
          const parentTrack = this.track(parentEvent.parentTrack);
          const parentBeat = parentTrack === undefined ? undefined : latestEvent(parentTrack.position, beat)?.beat;
          worldWins = childBeat !== undefined && (parentBeat === undefined || childBeat > parentBeat);
        }
      }
      if (
        !moving &&
        runtime.static === true &&
        runtime.events !== undefined &&
        runtime.parent === parent &&
        events.every((list, index) => list.every((event, property) => event === runtime.events![index]?.[property]))
      ) {
        continue;
      }
      let position: Vector3Tuple | undefined;
      let localPosition: Vector3Tuple | undefined;
      let rotation: QuaternionTuple | undefined;
      let localRotation: QuaternionTuple | undefined;
      let scale: Vector3Tuple | undefined;
      for (const name of runtime.tracks) {
        const track = this.track(name);
        if (track === undefined) continue;
        position = addVector(position, this.sampleVector(track.position, beat, context));
        localPosition = addVector(localPosition, this.sampleVector(track.localPosition, beat, context));
        rotation = multiplyQuaternions(rotation, this.sampleRotation(track.rotation, beat, context));
        localRotation = multiplyQuaternions(localRotation, this.sampleRotation(track.localRotation, beat, context));
        scale = multiplyVector(scale, this.sampleVector(track.scale, beat, context));
      }

      const target = runtime.target;
      if (scale === undefined) target.scale.copy(runtime.scale);
      else target.scale.fromArray(scale);

      if (localRotation !== undefined) target.quaternion.fromArray(localRotation);
      else if (rotation !== undefined) {
        this.targetRotation.fromArray(rotation);
        if (target.parent !== null) {
          target.parent.updateWorldMatrix(true, false);
          target.parent.matrixWorld.decompose(this.parentPosition, this.parentRotation, this.parentScale);
          this.targetRotation.premultiply(this.parentRotation.invert());
        }
        target.quaternion.copy(this.targetRotation);
      } else target.quaternion.copy(runtime.rotation);

      if (localPosition !== undefined) target.position.fromArray(mapPosition(localPosition, this.v2));
      else if (position !== undefined) {
        this.worldPosition.fromArray(mapPosition(position, this.v2));
        if (target.parent !== null) {
          target.parent.updateWorldMatrix(true, false);
          target.parent.worldToLocal(this.worldPosition);
        }
        // worldToLocal through a scale-0 ancestor divides by zero; keep base so the subtree stays collapsed
        if (Number.isFinite(this.worldPosition.x + this.worldPosition.y + this.worldPosition.z)) {
          target.position.copy(this.worldPosition);
        } else target.position.copy(runtime.position);
      } else target.position.copy(runtime.position);

      target.updateMatrix();
      target.updateWorldMatrix(false, true);
      if (parent && noodle !== undefined && !worldWins) this.applyNoodleParent(runtime, noodle, beat, context, parentCache);
      runtime.events = events;
      runtime.parent = parent;
      runtime.beat = beat;
      runtime.static = !moving;
      runtime.nextChange = moving
        ? undefined
        : runtime.tracks.reduce<number | undefined>((next, name) => {
            const track = this.track(name);
            if (track === undefined) return next;
            for (const property of [track.position, track.localPosition, track.rotation, track.localRotation, track.scale]) {
              const event = followingEvent<{ beat: number }>(property, beat);
              if (event !== undefined && (next === undefined || event.beat < next)) next = event.beat;
            }
            return next;
          }, undefined);
    }
  }

  private applyNoodleParent(
    runtime: TransformTarget,
    noodle: NoodleBeatmapData,
    beat: number,
    context: PointSampleContext | undefined,
    cache: Map<NoodleParentEvent, NoodleParentSample>,
  ) {
    const parent = sampleNoodleParent(noodle, runtime.tracks, beat, context, cache);
    if (parent?.matrix === undefined) return;
    const target = runtime.target;
    this.parentMatrix.fromArray(parent.matrix).premultiply(this.noodleBasis).multiply(this.noodleBasis);
    if (parent.worldPositionStays) {
      target.updateWorldMatrix(true, false);
      target.matrix.copy(target.matrixWorld);
    }
    target.matrix.premultiply(this.parentMatrix);
    if (target.parent !== null) {
      target.parent.updateWorldMatrix(true, false);
      this.parentMatrixInverse.copy(target.parent.matrixWorld).invert();
      target.matrix.premultiply(this.parentMatrixInverse);
    }
    target.matrix.decompose(target.position, target.quaternion, target.scale);
    target.updateMatrix();
    target.updateWorldMatrix(false, true);
  }

  private updateMaterials(beat: number, context?: PointSampleContext) {
    for (const runtime of this.materialTargets) {
      let color: Vector4Tuple | undefined;
      for (const name of runtime.tracks) {
        const track = this.track(name);
        if (track !== undefined) color = multiplyColor(color, this.sampleColor(track.color, beat, context));
      }
      const target = shaderColorUniform(runtime.material, '_Color');
      if (color === undefined) {
        if (target !== undefined && runtime.color !== undefined) target.copy(runtime.color);
        if (runtime.alpha !== undefined && runtime.material.uniforms._ColorAlpha !== undefined) {
          runtime.material.uniforms._ColorAlpha.value = runtime.alpha;
        }
        if (runtime.multiplier !== undefined && runtime.material.uniforms._ColorMultiplier !== undefined) {
          runtime.material.uniforms._ColorMultiplier.value = runtime.multiplier;
        }
        continue;
      }
      target?.setRGB(color[0], color[1], color[2]).convertSRGBToLinear();
      if (runtime.material.uniforms._ColorAlpha !== undefined) runtime.material.uniforms._ColorAlpha.value = color[3];
      if (runtime.material.uniforms._ColorMultiplier !== undefined) {
        runtime.material.uniforms._ColorMultiplier.value = color[3];
      }
    }
  }

  private componentEvent(tracks: readonly string[], property: keyof ComponentTrackRuntime, beat: number) {
    let selected: NumberEvent | undefined;
    for (const name of tracks) {
      const events = this.componentTracks.get(name)?.[property];
      if (events !== undefined) selected = newer(selected, latestEvent(events, beat));
    }
    return selected;
  }

  private updateTubeComponents(beat: number, context?: PointSampleContext) {
    for (const runtime of this.tubeTargets) {
      const colorEvent = this.componentEvent(runtime.tracks, 'colorAlphaMultiplier', beat);
      const bloomEvent = this.componentEvent(runtime.tracks, 'bloomFogIntensityMultiplier', beat);
      const color = colorEvent === undefined ? undefined : this.sampleNumberEvent(colorEvent, beat, context);
      const bloom = bloomEvent === undefined ? undefined : this.sampleNumberEvent(bloomEvent, beat, context);
      for (const light of runtime.materialLights) {
        light.target.intensityMultiplier = color ?? light.intensityMultiplier;
      }
      for (const segment of runtime.segments) {
        segment.target.intensityMultiplier = bloom ?? segment.intensityMultiplier;
      }
    }
  }

  private fogTrackValue(
    trackName: string,
    property: keyof Pick<TrackRuntime, 'fogHeight' | 'fogStartY' | 'fogAttenuation' | 'fogOffset'>,
    beat: number,
    context?: PointSampleContext,
  ) {
    const events = this.track(trackName)?.[property];
    return events === undefined ? undefined : this.sampleNumber(events, beat, context);
  }

  private updateFog(beat: number, context?: PointSampleContext) {
    if (this.baseFog === null || this.fog === null) return undefined;
    const next = { ...this.baseFog };
    if (this.v2) {
      for (const [index, assignment] of this.fogTrackEvents.entries()) {
        if (assignment.beat > beat) break;
        const following = this.fogTrackEvents[index + 1];
        const end = following !== undefined && following.beat <= beat ? following.beat : beat;
        next.height = this.fogTrackValue(assignment.track, 'fogHeight', end, context) ?? next.height;
        next.startY = this.fogTrackValue(assignment.track, 'fogStartY', end, context) ?? next.startY;
        next.attenuation = this.fogTrackValue(assignment.track, 'fogAttenuation', end, context) ?? next.attenuation;
        next.offset = this.fogTrackValue(assignment.track, 'fogOffset', end, context) ?? next.offset;
      }
    } else {
      for (const [fogProperty, eventProperty] of fogProperties) {
        const event = this.componentEvent(this.fogTracks, eventProperty, beat);
        if (event !== undefined) {
          next[fogProperty] = this.sampleNumberEvent(event, beat, context) ?? next[fogProperty];
        }
      }
    }

    if (
      next.height === this.fog.height &&
      next.startY === this.fog.startY &&
      next.attenuation === this.fog.attenuation &&
      next.offset === this.fog.offset
    ) {
      return undefined;
    }
    this.fog = next;
    return next;
  }
}
