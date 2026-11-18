import type { EventBox, EventBoxGroup, LightColorEvent } from '../engine/core/beatmap/types';
import { expandGlsEvents, type ExpandedGlsEvent } from '../engine/core/lighting/gls-events';
import { glsColorTween } from '../engine/core/lighting/gls-sampling';
import type { BoxGroupBlock } from './box-groups';
import type { ClipColor, LightClip } from './model';

/**
 * A colour block of the game's own group lighting as the timeline's clips: what each element of the
 * group gets, one clip for each stretch it is lit (`slot`: the element). The same clips an effect's
 * events are, so they are drawn by the one that draws an effect (the timeline's `drawEffectChildren`).
 *
 * The spreading over the elements and the brightness added by the distribution are the engine's own
 * (`expandGlsEvents`, `glsColorTween`) — the same that the 3D view plays. A sketch of it, not the
 * lights' exact look: a fade to the next event is shown as one only where it dims, strobes not at all.
 */

const REFS = ['left', 'right', 'white'] as const;

/** How long an event lasts when nothing comes after it on its element (beats). */
const TAIL = 0.5;

const colorOf = (color: number, brightness: number): ClipColor => ({ ref: REFS[color] ?? 'left', brightness: Math.max(0, brightness) });

/** The block's clips (none when the group's number of elements is not known). */
export function colorBlockClips(block: BoxGroupBlock, count: number): LightClip[] {
  if (block.kind !== 'color' || count <= 0) return [];
  const expanded = expandGlsEvents<LightColorEvent, EventBox<LightColorEvent>>([block.eventGroup as unknown as EventBoxGroup<EventBox<LightColorEvent>>], count);
  const byElement = new Map<number, ExpandedGlsEvent<LightColorEvent, EventBox<LightColorEvent>>[]>();
  for (const event of expanded) {
    const list = byElement.get(event.element);
    if (list === undefined) byElement.set(event.element, [event]);
    else list.push(event);
  }
  const clips: LightClip[] = [];
  for (const [element, events] of byElement) {
    // (times kept in the map's beats: no conversion to the song's)
    const states = glsColorTween(events, (beat) => beat);
    states.forEach((state, index) => {
      // (an "extend" changes nothing: the one before it goes on; no brightness: dark, nothing to draw)
      if (state.usePrevious === 1 || state.brightness <= 0) return;
      let next = index + 1;
      while (next < states.length && states[next]!.usePrevious === 1) next++;
      const after = states[next];
      const end = Math.max(state.time + 1 / 64, after?.time ?? state.time + TAIL);
      const dims = after !== undefined && after.easing !== -1 && after.brightness < state.brightness;
      clips.push({
        id: `${block.id}:${String(element)}:${String(index)}`,
        type: block.group,
        ids: null,
        start: state.time,
        end,
        startMode: 'on',
        fadeIn: 0,
        endMode: dims ? 'fade' : 'off',
        color: colorOf(state.color, state.brightness),
        endColor: null,
        layer: 1,
        slot: element,
      });
    });
  }
  return clips;
}
