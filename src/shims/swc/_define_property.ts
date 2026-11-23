/** In place of @swc/helpers' helper of the same name (Apache-2.0, which can't go into a GPL-2.0-only
 *  program): what wasm-media-encoders' compiled code asks of it. */
export function _(target: Record<PropertyKey, unknown>, key: PropertyKey, value: unknown) {
  if (key in target) Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  else target[key] = value;
  return target;
}
