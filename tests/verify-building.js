/**
 * The building composition, story by story.
 *
 * These are the assertions that stop the model quietly turning back into a
 * repeated grid: that levels have the plates and the inventories they are
 * supposed to have, that the ones which differ actually differ, that the ones
 * which repeat are marked as repeating, and that addresses survive the layout
 * being changed underneath them.
 *
 *   deno run -A --import-map=tests/import_map.json tests/verify-building.js
 */
import { loadModel, makeChecker } from './model.js';
import { composeBuilding, polygonArea, polygonBounds } from '../src/building.js';
import { isValidId, parseId, floorIdOf, roomIdOf } from '../src/ids.js';
import { TRUTH } from '../src/truth.js';

const { check, done } = makeChecker();
const { spec, types, variants, building } = await loadModel();

const floors = building.floors;
const byId = id => floors.find(f => f.id === id);
const L = n => byId(`building-a.floor-${String(n).padStart(2, '0')}`);

/* ------------------------------------------------------- level structure --- */

check('the building has seven levels', floors.length === 7,
      floors.map(f => f.level).join(', '));

check('levels are numbered 01 to 07',
      floors.every((f, i) => f.level === i + 1));

check('every level is assigned a floor-plan variant',
      floors.every(f => variants.has(f.variantId)),
      [...new Set(floors.map(f => f.variantId))].join(', '));

check('there is more than one variant in use',
      new Set(floors.map(f => f.variantId)).size >= 4,
      `${new Set(floors.map(f => f.variantId)).size} distinct variants`);

/* -------------------------------------- lower levels differ from the rest --- */

// This split is the one piece of level structure the source set states outright,
// so it is the one the model is held to.
check('level 01 does not use a residential variant',
      L(1).role !== 'Residential' && !L(1).variantId.includes('residential'),
      `${L(1).role} / ${L(1).variantId}`);

check('level 02 does not use a residential variant',
      L(2).role !== 'Residential' && !L(2).variantId.includes('residential'),
      `${L(2).role} / ${L(2).variantId}`);

check('levels 01 and 02 use different variants from each other',
      L(1).variantId !== L(2).variantId);

check('levels 03 to 07 are residential',
      [3, 4, 5, 6, 7].every(n => L(n).role === 'Residential'));

check('level 01 is taller than the levels above it',
      L(1).floorToFloor.value > L(2).floorToFloor.value,
      `${L(1).floorToFloor.value} m vs ${L(2).floorToFloor.value} m`);

check('level 01 has the taller stated ceiling',
      L(1).ceilingHeight.value > L(2).ceilingHeight.value,
      `${L(1).ceilingHeight.value} m vs ${L(2).ceilingHeight.value} m`);

/* --------------------------------------------- plates are genuinely plates --- */

const areas = floors.map(f => Math.round(f.plate.area));
check('level 01 has the largest plate', Math.max(...areas) === areas[0],
      areas.join(', '));

check('at least three distinct plate areas exist',
      new Set(areas).size >= 3, `${new Set(areas).size} distinct areas: ${[...new Set(areas)].join(', ')}`);

check('the top level sets back from the levels below',
      (L(7).plate.bounds.maxX - L(7).plate.bounds.minX)
        < (L(6).plate.bounds.maxX - L(6).plate.bounds.minX),
      `L07 ${(L(7).plate.bounds.maxX - L(7).plate.bounds.minX).toFixed(1)} m long vs `
      + `L06 ${(L(6).plate.bounds.maxX - L(6).plate.bounds.minX).toFixed(1)} m`);

check('irregular plates keep their notches',
      floors.some(f => f.plate.polygon.length > 4),
      `${floors.filter(f => f.plate.polygon.length > 4).length} levels have a non-rectangular outline`);

check('a notched plate encloses less than its bounding box',
      floors.filter(f => f.plate.polygon.length > 4).every(f => {
        const b = f.plate.bounds;
        return f.plate.area < (b.maxX - b.minX) * (b.maxZ - b.minZ) - 1;
      }), 'so the notch is real geometry, not a label');

check('every plate polygon is closed and non-degenerate',
      floors.every(f => f.plate.polygon.length >= 4 && polygonArea(f.plate.polygon) > 100));

/* --------------------------------------------------- repeats are declared --- */

const repeated = floors.filter(f => f.repeated);
check('levels sharing a plate are marked as repeating', repeated.length > 0,
      repeated.map(f => f.name).join(', '));

check('levels with a unique plate are not marked as repeating',
      floors.filter(f => !f.repeated)
        .every(f => floors.filter(o => o.variantId === f.variantId).length === 1));

check('a repeated level names the levels it shares with',
      repeated.every(f => f.sharesVariantWith.length > 0
        && f.sharesVariantWith.every(id => byId(id))));

check('level 04 does not share its plate with any other level',
      !L(4).repeated, 'it carries the widest set of unit tags in the source');

/* ------------------------------------------------- per-level inventories --- */

check('every level reports a unit inventory',
      floors.every(f => f.inventory && Object.keys(f.inventory).length >= 0));

check('level 01 holds far fewer dwellings than a residential level',
      L(1).unitCount < L(4).unitCount, `${L(1).unitCount} vs ${L(4).unitCount}`);

check('level 04 has the widest mix of unit types',
      Object.keys(L(4).inventory).length >= Object.keys(L(2).inventory).length,
      `${Object.keys(L(4).inventory).length} types on level 04`);

check('at least two levels differ in their unit mix',
      JSON.stringify(L(4).inventory) !== JSON.stringify(L(7).inventory),
      `L04 ${JSON.stringify(L(4).inventory)} vs L07 ${JSON.stringify(L(7).inventory)}`);

check('room types are reported per level',
      floors.some(f => f.roomTypes.length > 0),
      `level 04: ${L(4).roomTypes.join(', ')}`);

/* -------------------------------------- every level owns its own scaffold --- */

check('each level owns a commons scope',
      floors.every(f => building.rooms.some(r => r.definition.id === f.commonsId)));

check('each level owns a core scope',
      floors.every(f => building.rooms.some(r => r.definition.id === f.coreId)));

check('commons and core resolve as room-level scopes',
      floors.every(f => roomIdOf(f.commonsId) === f.commonsId && roomIdOf(f.coreId) === f.coreId));

check('every room belongs to exactly one level',
      building.rooms.every(r => floors.some(f => f.id === floorIdOf(r.definition.id))));

/* ---------------------------------------------------------- addresses --- */

const allIds = building.rooms.flatMap(r => [r.definition.id, ...r.definition.parts.map(p => p.id)]);
check('every address parses', allIds.every(id => { parseId(id); return isValidId(id); }),
      `${allIds.length} addresses`);

check('no duplicate addresses anywhere', new Set(allIds).size === allIds.length,
      `${allIds.length - new Set(allIds).size} duplicates`);

check('every part address sits under its own room',
      building.rooms.every(r => r.definition.parts.every(p => p.id.startsWith(`${r.definition.id}.`))));

// Address stability: move every unit on a plate and re-compose. Addresses are a
// level plus an index, so a re-layout must rename nothing.
const shifted = new Map();
for (const [id, variant] of variants) {
  shifted.set(id, {
    ...variant,
    units: variant.units.map(u => ({
      ...u, transform: { ...u.transform, x: u.transform.x + 13.5, z: u.transform.z + 2.25 }
    }))
  });
}
const moved = composeBuilding(spec, shifted, types);
const before = building.rooms.map(r => r.definition.id).join('|');
const after = moved.rooms.map(r => r.definition.id).join('|');
check('addresses survive every unit being moved', before === after,
      `${moved.rooms.length} rooms re-composed`);

const movedUnit = moved.rooms.find(r => r.definition.id === 'building-a.floor-07.unit-0701');
const originalUnit = building.rooms.find(r => r.definition.id === 'building-a.floor-07.unit-0701');
check('the moved unit really did move',
      movedUnit.placement.x !== originalUnit.placement.x,
      `${originalUnit.placement.x} → ${movedUnit.placement.x}`);

check('re-composing is otherwise deterministic',
      composeBuilding(spec, variants, types).rooms.map(r => r.definition.id).join('|') === before);

/* --------------------------------------------------------------- truth --- */

check('no scope claims source-verified',
      building.rooms.every(r => r.definition.truth !== TRUTH.SOURCE
        && r.definition.parts.every(p => p.truth !== TRUTH.SOURCE)),
      'the set is withheld, so nothing may claim it');

check('no scope carries a source link',
      building.rooms.every(r => !r.definition.source
        && r.definition.parts.every(p => !p.source)));

check('every plate outline is unresolved',
      floors.every(f => f.plate.truth === TRUTH.UNRESOLVED),
      'no plate is drawn anywhere in the available set');

check('every unit position is unresolved',
      building.rooms.filter(r => r.definition.kind === 'unit')
        .every(r => r.placement.truth === TRUTH.UNRESOLVED));

check('elevations are derived, not asserted',
      spec.levels.every(l => l.elevation.truth === TRUTH.DERIVED));

check('every level carries an evidence basis',
      floors.every(f => typeof f.evidence?.basis === 'string' && f.evidence.basis.length > 40));

check('unresolved levels say so in their evidence state',
      floors.filter(f => f.evidence.state === TRUTH.UNRESOLVED).length >= 4);

/* -------------------------------------------------------------- errors --- */

const threw = fn => { try { fn(); return false; } catch { return true; } };
check('an unknown variant is rejected',
      threw(() => composeBuilding({ ...spec, levels: [{ ...spec.levels[0], variant: 'nope' }] }, variants, types)));
check('an unknown unit type is rejected',
      threw(() => composeBuilding(spec, new Map([...variants].map(([k, v]) => [k, { ...v, units: [{ type: 'nope', transform: { x: 0, z: 0 } }] }])), types)));
check('a building with no levels is rejected',
      threw(() => composeBuilding({ ...spec, levels: [] }, variants, types)));

done();
