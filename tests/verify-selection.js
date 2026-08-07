/**
 * Selection coherence.
 *
 * The defect these exist to prevent: the viewport tooltip naming Level 07 while
 * the inspector names Level 06. That happened because each consumer worked the
 * level out for itself from whichever variable was nearest.
 *
 * `resolveScope` is now the only place that derives a level, a room, a title or
 * a camera target from an address, so these check the derivation directly, and
 * `assertCoherent` is checked against strings that deliberately disagree.
 *
 *   deno run -A --import-map=tests/import_map.json tests/verify-selection.js
 */
import { loadModel, makeChecker } from './model.js';
import { resolveScope, assertCoherent, createSelectionStore, SCOPE } from '../src/selection.js';

const { check, done } = makeChecker();
const { building } = await loadModel();

const rooms = new Map(building.rooms.map(r => [r.definition.id, r.definition]));
const model = {
  buildingId: building.id,
  floors: building.floors,
  rooms,
  displayNames: building.displayNames,
  entryOf: id => ({ displayName: `entry:${id}`, truth: 'designer-default' })
};

const L = n => `building-a.floor-${String(n).padStart(2, '0')}`;

/* ------------------------------------------------------------- kinds --- */

check('the building resolves as the building',
      resolveScope(null, model).kind === SCOPE.BUILDING
      && resolveScope('building-a', model).kind === SCOPE.BUILDING);

check('a level resolves as a level', resolveScope(L(4), model).kind === SCOPE.LEVEL);
check('a unit resolves as a room',
      resolveScope(`${L(4)}.unit-0401`, model).kind === SCOPE.ROOM);
check('a commons scope resolves as a room-level scope',
      resolveScope(building.floors[3].commonsId, model).kind === SCOPE.ROOM);
check('a component resolves as a component',
      [SCOPE.COMPONENT, SCOPE.ASSEMBLY]
        .includes(resolveScope(`${L(4)}.unit-0401.wall-01`, model).kind));

check('a commons scope is labelled as one, not as a unit',
      resolveScope(building.floors[3].commonsId, model).kindLabel.includes('PLATE'));
check('a core scope is labelled as one',
      resolveScope(building.floors[3].coreId, model).kindLabel.includes('CORE'));

/* -------------------------------------------------- one level, always --- */

// Every kind of address on a level must derive the same level name. This is the
// exact property whose absence produced the contradiction.
for (const n of [1, 2, 3, 4, 5, 6, 7]) {
  const addresses = [
    L(n),
    `${L(n)}.unit-${String(n).padStart(2, '0')}01`,
    `${L(n)}.unit-${String(n).padStart(2, '0')}01.wall-01`,
    building.floors[n - 1].commonsId,
    `${building.floors[n - 1].commonsId}.plate`,
    building.floors[n - 1].coreId
  ];
  const names = new Set(addresses.map(id => resolveScope(id, model).levelLabel));
  check(`every address on level 0${n} derives one level name`,
        names.size === 1 && names.has(`Level ${String(n).padStart(2, '0')}`),
        [...names].join(' / '));
}

check('the building itself is on no level',
      resolveScope('building-a', model).levelLabel === null);

/* --------------------------------------------------------- derivation --- */

const unit = resolveScope(`${L(7)}.unit-0701`, model);
check('a unit knows its level', unit.levelId === L(7));
check('a unit knows its room', unit.roomId === `${L(7)}.unit-0701`);
check('a unit has no component id', unit.componentId === null);

const part = resolveScope(`${L(7)}.unit-0701.wall-01`, model);
check('a component knows its room and its level',
      part.roomId === `${L(7)}.unit-0701` && part.levelId === L(7));
check('a component frames its room, not itself', part.focusId === part.roomId);
check('a level frames itself', resolveScope(L(5), model).focusId === L(5));
check('the building frames everything', resolveScope('building-a', model).focusId === null);

check('the short label names the level for anything inside one',
      unit.shortLabel.includes('Level 07'), unit.shortLabel);
check('the short label does not name a level for the building',
      !resolveScope('building-a', model).shortLabel.includes('Level'));

check('the breadcrumb runs building to component',
      part.breadcrumb.length === 4 && part.breadcrumb[0] === building.displayNames['building-a'],
      part.breadcrumb.join(' › '));

/* -------------------------------------------------- the assertion itself --- */

const scope = resolveScope(L(6), model);

let reported = null;
assertCoherent(scope, { inspector: 'Level 06', status: 'Level 06 · 9 units' }, p => { reported = p; });
check('agreeing labels raise nothing', reported === null);

assertCoherent(scope, { inspector: 'Level 06', tooltip: 'Level 07' }, p => { reported = p; });
check('a disagreeing label is caught', reported !== null && reported[0].includes('Level 07'),
      reported?.[0]);

reported = null;
assertCoherent(resolveScope('building-a', model), { panel: 'Level 04' }, p => { reported = p; });
check('a level named while nothing is on a level is caught', reported !== null, reported?.[0]);

reported = null;
assertCoherent(scope, { panel: null, other: undefined }, p => { reported = p; });
check('absent labels are not a contradiction', reported === null);

/* ------------------------------------------------------------- store --- */

const seen = [];
const store = createSelectionStore(model, { onChange: s => seen.push(s.id) });
store.set(L(3));
store.set(`${L(3)}.unit-0301`);
check('the store publishes every change', seen.length === 2 && seen[1].endsWith('unit-0301'));
check('the store holds one address', store.id === `${L(3)}.unit-0301`);
check('refresh re-derives without changing the address',
      store.refresh().id === `${L(3)}.unit-0301` && seen.length === 3);
check('the resolved scope is available without setting it',
      store.resolve(L(1)).levelLabel === 'Level 01' && store.id === `${L(3)}.unit-0301`);

const threw = fn => { try { fn(); return false; } catch { return true; } };
check('a malformed address is rejected rather than half-resolved',
      threw(() => resolveScope('Not An Address', model)));

done();
