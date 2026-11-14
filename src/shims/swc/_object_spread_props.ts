/** In place of @swc/helpers' helper of the same name (Apache-2.0): the source's own properties (their
 *  descriptors as they are) put on the target. */
export function _(target: Record<PropertyKey, unknown>, source: Record<PropertyKey, unknown> | null | undefined) {
  if (source === null || source === undefined) return target;
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
  return target;
}
