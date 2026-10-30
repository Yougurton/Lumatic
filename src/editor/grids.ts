/** The grids beats are put on: halves down to 1/64, then the triplets (and none at all). */
export const GRIDS: [number, string][] = [
  [1, '1'],
  [0.5, '1/2'],
  [0.25, '1/4'],
  [0.125, '1/8'],
  [0.0625, '1/16'],
  [0.03125, '1/32'],
  [0.015625, '1/64'],
  [1 / 3, '1/3'],
  [1 / 6, '1/6'],
  [1 / 12, '1/12'],
  [1 / 24, '1/24'],
  [1 / 48, '1/48'],
  [0, 'без сетки'],
];

/** A list to pick a grid step from (beats): every grid, and — `longer` — steps of several beats too. */
export function gridSelect(value: number, change: (value: number) => void, longer: number[] = []): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'grid-select';
  const options: [number, string][] = [...[...longer].sort((a, b) => b - a).map((beats): [number, string] => [beats, String(beats)]), ...GRIDS.filter(([beats]) => beats > 0)];
  // (a value none of them has — made before — is shown as it is)
  if (!options.some(([beats]) => Math.abs(beats - value) < 1e-6)) options.push([value, String(Math.round(value * 10000) / 10000)]);
  for (const [beats, label] of options) select.append(Object.assign(document.createElement('option'), { value: String(beats), textContent: label }));
  select.value = String(options.find(([beats]) => Math.abs(beats - value) < 1e-6)![0]);
  select.addEventListener('change', () => change(Number(select.value)));
  return select;
}
