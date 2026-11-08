import { allObjects, objectSpan, placeOf, wallFootprint, type MapObjects, type MapWall, type ObjectKind } from './notes';

/**
 * "Select by…" on the notes side: the objects of these kinds, colours, directions, columns and rows
 * within a stretch of beats.
 */
export interface NoteCriteria {
  from: number;
  to: number;
  kinds: ObjectKind[];
  /** 0 red, 1 blue (notes, arcs, chains; the others have none and pass). */
  colors: number[];
  /** Cut directions 0–8 (notes; arcs' and chains' heads). */
  directions: number[];
  /** Columns 0–3 (a wall: any column it covers; a free place: its nearest column). */
  columns: number[];
  /** Rows 0–2 (walls pass). */
  rows: number[];
}

/** The ids of the objects that fit. */
export function matchObjects(objects: MapObjects, criteria: NoteCriteria): string[] {
  const from = Math.min(criteria.from, criteria.to) - 1e-6;
  const to = Math.max(criteria.from, criteria.to) + 1e-6;
  const nearest = (value: number, most: number) => Math.max(0, Math.min(most, Math.round(value)));
  return allObjects(objects)
    .filter(({ kind, item }) => {
      if (!criteria.kinds.includes(kind)) return false;
      const [a, b] = objectSpan(kind, item);
      if (b - a < 1e-6 ? a < from || a > to : b <= from + 2e-6 || a >= to - 2e-6) return false;
      if ('c' in item && !criteria.colors.includes(item.c)) return false;
      if (kind === 'notes' || kind === 'arcs' || kind === 'chains') {
        if (!criteria.directions.includes((item as { d: number }).d)) return false;
      }
      if (kind === 'walls') {
        const shape = wallFootprint(item as MapWall);
        const left = Math.floor(shape.x + 1e-6);
        const right = Math.ceil(shape.x + shape.w - 1e-6) - 1;
        for (let col = left; col <= right; col++) if (criteria.columns.includes(nearest(col, 3))) return true;
        return false;
      }
      const place = placeOf(item);
      return criteria.columns.includes(nearest(place.x, 3)) && criteria.rows.includes(nearest(place.y, 2));
    })
    .map(({ item }) => item.id);
}
