import { writeDifficulty } from '../src/editor/map-io';
const v2 = JSON.stringify({ _version: '2.2.0', _notes: [], _obstacles: [], _events: [] });
const v3 = JSON.stringify({ version: '3.3.0', colorNotes: [], basicBeatmapEvents: [], colorBoostBeatmapEvents: [] });
const events = [{ beat: 4, type: 8, value: 0, floatValue: 1, customData: { rotation: 0, step: 45, prop: 50, speed: 2, direction: 0 } }, { beat: 5, type: 1, value: 1, floatValue: 1, lightIds: [1, 2], color: [1, 0, 0, 1] as [number, number, number, number] }];
console.log(JSON.stringify(JSON.parse(writeDifficulty(v2, events))._events));
console.log(JSON.stringify(JSON.parse(writeDifficulty(v3, events)).basicBeatmapEvents));
