/** In place of @swc/helpers' helper of the same name (Apache-2.0): the own properties (and symbols) of
 *  each source copied onto the target, in order. */
export function _(target: Record<PropertyKey, unknown>, ...sources: (Record<PropertyKey, unknown> | null | undefined)[]) {
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    for (const key of [...Object.keys(source), ...Object.getOwnPropertySymbols(source).filter((symbol) => Object.getOwnPropertyDescriptor(source, symbol)?.enumerable === true)]) {
      Object.defineProperty(target, key, { value: source[key], enumerable: true, configurable: true, writable: true });
    }
  }
  return target;
}
