/**
 * Unit types and building stacking.
 *
 * The gap this closes: generators are parametric at the component level (a wall
 * derives from length/height/thickness, a casework run from module targets), but
 * everything above a part was hand-authored. A room was a literal list of parts,
 * a floor a literal list of rooms, and a building did not exist. Adding a level
 * meant writing another file.
 *
 * A *type* is authored once and instantiated many times. Instantiation is a pure
 * function of the building spec, so the ids it produces are stable across
 * rebuilds — which is the requirement ids.js actually states. Nothing here runs
 * at render time; expansion happens once at load, and the viewer still receives
 * the same `{ definition, placement }` composition it always has.
 *
 * Truth handling: a type instance inherits the type's part-level truth states
 * untouched. What instantiation *adds* — where a unit sits, how high a floor is —
 * is never better than `designer-default`, and is marked so at the point it is
 * introduced rather than inferred later.
 */

import { joinId } from './ids.js';
import { TRUTH, assertTruthState } from './truth.js';

/** Deep clone that leaves no shared references between instances of a type. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

/**
 * Rewrite a part spec's relative id into the instance's address space.
 *
 * Type parts carry *relative* ids (`wall-north`, `kitchen`). Generators that
 * build sub-components derive their children from `spec.id`, so rewriting the
 * top of each spec is enough to move a whole assembly.
 */
function rebase(spec, instanceId) {
  const out = clone(spec);
  if (typeof out.id !== 'string' || out.id.length === 0) {
    throw new Error(`Type part is missing a relative id: ${JSON.stringify(spec).slice(0, 120)}`);
  }
  if (out.id.includes('..')) throw new Error(`Malformed relative id "${out.id}"`);
  out.id = joinId(instanceId, out.id);
  return out;
}

/**
 * Build a room definition from a type.
 *
 * @param {object} type       parsed types/<name>.json
 * @param {object} o
 * @param {string} o.id       full dotted address for this instance
 * @param {string} [o.name]   display name; falls back to the type's
 * @param {object} [o.overrides] shallow per-instance parameter overrides
 */
export function instantiateType(type, { id, name, shortName, overrides = {} } = {}) {
  if (!type || typeof type !== 'object') throw new TypeError('instantiateType requires a type definition');
  if (typeof id !== 'string') throw new TypeError('instantiateType requires an instance id');

  const definition = {
    schema: 'parametric-study.room-definition.v1',
    id,
    name: name ?? type.name,
    shortName: shortName ?? type.shortName ?? type.name,
    unit: type.unit ?? type.name,
    typeId: type.id,
    // An instance is never more certain than the type it came from.
    truth: type.truth ?? TRUTH.DEFAULT,
    container: type.container ?? 'parametric study',
    summary: type.summary ?? null,
    source: type.source ?? null,
    dimensions: type.dimensions ?? null,
    // The coarse envelope drawn when this instance's level is not loaded at full
    // detail. Authored on the type, so a level can be drawn without being built.
    massing: type.massing ?? null,
    params: type.params ?? null,
    displayNames: { [id]: shortName ?? type.shortName ?? type.name },
    parts: (type.parts ?? []).map(spec => rebase(spec, id)),
    missing: type.missing ?? [],
    instanceOf: {
      type: type.id,
      truth: TRUTH.DEFAULT,
      note: 'This room is an instance of an authored unit type. The type carries the '
          + 'observed detail; repeating it across the building is a study assumption, '
          + 'not an observation.'
    }
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in definition)) continue;
    definition[key] = value;
  }
  assertTruthState(definition.truth, `type instance ${id}`);
  return definition;
}

/**
 * Expand a building spec into floors and placed unit instances.
 *
 * @param {object} spec   parsed building.json
 * @param {Map<string,object>} types  typeId -> parsed type definition
 * @returns {{ id, name, floors: Array, rooms: Array<{definition, placement}>, displayNames: object }}
 */
export function stackBuilding(spec, types) {
  const levels = spec.levels ?? {};
  const count = Number(levels.count ?? 1);
  const start = Number(levels.startLevel ?? 1);
  const f2f = Number(levels.floorToFloor?.value ?? 0);

  if (!Number.isInteger(count) || count < 1) throw new Error(`levels.count must be a positive integer, got ${levels.count}`);
  if (!Number.isInteger(start)) throw new Error(`levels.startLevel must be an integer, got ${levels.startLevel}`);
  if (!(f2f > 0)) throw new Error('levels.floorToFloor.value must be a positive number — a building cannot stack without one');

  const bayX = Number(spec.bay?.x ?? 0);
  if (!(bayX > 0)) throw new Error('bay.x must be a positive number');

  const pad = n => String(n).padStart(2, '0');
  const rooms = [];
  const floors = [];
  const displayNames = { [spec.id]: spec.name ?? spec.id };

  for (let i = 0; i < count; i += 1) {
    const level = start + i;
    const floorId = joinId(spec.id, `floor-${pad(level)}`);
    const y = i * f2f;
    const floorRooms = [];

    let bay = 0;
    for (const entry of spec.unitMix ?? []) {
      const type = types.get(entry.type);
      if (!type) throw new Error(`Building references unknown unit type "${entry.type}"`);
      const n = Number(entry.count ?? 0);
      if (!Number.isInteger(n) || n < 0) throw new Error(`unitMix count must be a non-negative integer for "${entry.type}"`);

      for (let u = 0; u < n; u += 1) {
        bay += 1;
        // Deterministic, spec-derived, stable across rebuilds: level + bay index.
        const unitId = joinId(floorId, `unit-${pad(level)}${pad(bay)}`);
        const label = `${type.shortName ?? type.name} ${pad(level)}${pad(bay)}`;
        const definition = instantiateType(type, {
          id: unitId,
          name: label,
          shortName: label
        });
        const placement = {
          x: (bay - 1) * bayX,
          y,
          z: 0,
          rotation: 0,
          truth: TRUTH.DEFAULT,
          note: 'Bay position is a uniform study assumption. No verified plan fixes '
              + 'where this unit sits.'
        };
        rooms.push({ definition, placement });
        floorRooms.push({ id: unitId, type: entry.type, placement });
        displayNames[unitId] = label;
      }
    }

    floors.push({
      id: floorId,
      level,
      name: `Level ${pad(level)}`,
      elevation: {
        value: y,
        unit: 'm',
        truth: TRUTH.DEFAULT,
        note: 'Derived from a uniform floor-to-floor assumption, not a verified elevation.'
      },
      rooms: floorRooms
    });
    displayNames[floorId] = `Level ${pad(level)}`;
  }

  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    truth: TRUTH.DEFAULT,
    floors,
    rooms,
    displayNames,
    stats: {
      levels: count,
      unitsPerFloor: rooms.length / count,
      units: rooms.length,
      partSpecs: rooms.reduce((n, r) => n + r.definition.parts.length, 0)
    }
  };
}
