/**
 * Load the composed building the way the page does, for tests.
 *
 * Reads the real spec, the real variants and the real unit types off disk and
 * runs the real composer. Nothing is mocked, so a test that passes here is a
 * statement about the model that ships.
 */
import { composeBuilding } from '../src/building.js';

const read = async path => JSON.parse(await Deno.readTextFile(path));

export async function loadModel() {
  const spec = await read('building.json');

  const types = new Map();
  for (const [id, path] of Object.entries(spec.types ?? {})) types.set(id, await read(path));

  const variants = new Map();
  for (const [id, path] of Object.entries(spec.variants ?? {})) variants.set(id, await read(path));

  return { spec, types, variants, building: composeBuilding(spec, variants, types) };
}

/** Composition payload in the shape RoomViewer.setComposition expects. */
export function compositionOf(building) {
  return {
    id: building.id,
    name: building.name,
    displayNames: building.displayNames,
    floors: building.floors.map(f => ({
      id: f.id, level: f.level, plate: f.plate, floorToFloor: f.floorToFloor
    })),
    rooms: building.rooms
  };
}

export function makeChecker() {
  const state = { failures: 0 };
  const check = (name, ok, detail = '') => {
    if (!ok) { state.failures += 1; console.log(`  FAIL  ${name}  ${detail}`); }
    else console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`);
  };
  const done = () => {
    console.log(`\n${state.failures === 0 ? 'PASS' : 'FAIL'} — ${state.failures} failure(s)`);
    if (state.failures > 0) Deno.exit(1);
  };
  return { check, done, state };
}
