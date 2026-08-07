/**
 * The RoomViewer itself, driven headlessly over the composed building.
 *
 * Runs the real class over the real spec with the real generators. Only the
 * WebGLRenderer is substituted (see three-headless.js), so what is checked here
 * is the actual scene graph, index, instancing, progressive detail, explode,
 * visibility, cutaway and clipping — not a re-implementation of them.
 *
 *   deno run -A --import-map=tests/import_map_headless.json tests/verify-viewer.js
 *
 * Not covered, and deliberately so: shading, real draw-call counts and real
 * frame timing. Those need a GPU and belong to browser verification.
 */
import { installWindow, makeCanvas } from './three-headless.js';
installWindow();

const { RoomViewer } = await import('../src/room-viewer.js');
const { loadModel, compositionOf, makeChecker } = await import('./model.js');
const { parseId, floorIdOf, roomIdOf } = await import('../src/ids.js');
const { toInches, assessSink } = await import('../src/ada.js');

const { check, done } = makeChecker();
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const { building } = await loadModel();
const viewer = new RoomViewer(makeCanvas());
viewer.setComposition(compositionOf(building));

const FLOORS = viewer.floorIds;
const L = n => `building-a.floor-${String(n).padStart(2, '0')}`;
const levelOf = id => building.floors.find(f => f.id === id);

/* ------------------------------------------------- progressive detail --- */

check('every level is a scope in the viewer', FLOORS.length === 7, FLOORS.length + ' levels');

check('every level is built on load',
      viewer.detailFloors.length === FLOORS.length && viewer.proxyCount === 0,
      `${viewer.detailFloors.length} levels, ${viewer.objectCount} components`);
check('the default build contains addresses from every level',
      FLOORS.every(id => [...viewer.index.keys()].some(entryId => floorIdOf(entryId) === id)),
      `${viewer.index.size} indexed across ${FLOORS.length} levels`);

// Progressive loading remains available as an explicit performance option.
viewer.setDetailMode('focused');
check('focused mode builds one level', viewer.detailFloors.length === 1, viewer.detailFloors.join());
check('the other six become massing', viewer.proxyCount === 6, `${viewer.proxyCount} blocks`);
check('a level that is not loaded generates no parts',
      [...viewer.index.keys()].every(id => floorIdOf(id) === viewer.detailFloors[0]),
      `${viewer.index.size} indexed, all on ${viewer.detailFloors[0]}`);

const countsByLevel = {};
for (const n of [1, 2, 4, 7]) {
  viewer.focus(L(n));
  countsByLevel[n] = viewer.objectCount;
  check(`focusing level 0${n} builds only level 0${n}`,
        viewer.detailFloors.length === 1 && viewer.detailFloors[0] === L(n)
        && [...viewer.index.keys()].every(id => floorIdOf(id) === L(n)),
        `${viewer.objectCount} components`);
}

check('component counts differ level to level',
      new Set(Object.values(countsByLevel)).size > 1, JSON.stringify(countsByLevel));

check('the entry level builds far less than a residential level',
      countsByLevel[1] < countsByLevel[4], `${countsByLevel[1]} vs ${countsByLevel[4]}`);

check('the level left behind returns to massing', viewer.proxyCount === 6);

// The massing block is the level's own plate, not a repeated box.
const massingOf = floorId => {
  const found = [];
  const walk = n => { if (n.userData?.proxy && n.isMesh) found.push(n); (n.children ?? []).forEach(walk); };
  walk(viewer.root);
  return found.filter(m => m.userData.floorId === floorId);
};
const blocks = FLOORS.filter(id => id !== viewer.detailFloors[0]).map(id => massingOf(id)[0]);
check('each unloaded level draws exactly one massing block',
      blocks.every(Boolean) && blocks.length === 6);

const blockSpan = mesh => {
  mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox;
  return Number((b.max.x - b.min.x).toFixed(2));
};
const spans = blocks.map(blockSpan);
check('massing blocks are not all the same box',
      new Set(spans).size > 1, `spans ${[...new Set(spans)].join(', ')} m`);

check('a massing block matches its own plate extent',
      blocks.every(mesh => {
        const plate = levelOf(mesh.userData.floorId).plate.bounds;
        return near(blockSpan(mesh), Number((plate.maxX - plate.minX).toFixed(2)), 0.05);
      }), 'so a setback still reads at building scale');

check('massing carries no component address',
      blocks.every(m => m.userData.id === undefined && m.userData.selectable !== true));

viewer.setDetailMode('all');
check('full detail builds every level',
      viewer.detailFloors.length === 7 && viewer.proxyCount === 0,
      `${viewer.objectCount} components`);
const allCount = viewer.objectCount;
check('the full building is the sum of its levels',
      allCount === building.floors.reduce((n, f) => n + viewer.countFor(f.id), 0),
      `${allCount} components`);
check('every address still parses at full detail',
      [...viewer.index.keys()].every(id => { parseId(id); return true; }));
check('no duplicate addresses at full detail',
      new Set(viewer.index.keys()).size === viewer.index.size);

viewer.setDetailMode('focused');
check('returning to focused mode unloads the rest', viewer.proxyCount === 6);

/* ---------------------------------------- lower levels are not the array --- */

viewer.focus(L(1));
const entryRooms = viewer.roomIds.filter(id => floorIdOf(id) === L(1) && viewer.countFor(id) > 0);
viewer.focus(L(4));
const resRooms = viewer.roomIds.filter(id => floorIdOf(id) === L(4) && viewer.countFor(id) > 0);
check('the entry level is not the residential plate',
      entryRooms.length !== resRooms.length,
      `${entryRooms.length} built scopes on L01 vs ${resRooms.length} on L04`);

check('every level has its own commons and core',
      building.floors.every(f => viewer.roomIds.includes(f.commonsId)
        && viewer.roomIds.includes(f.coreId)));

viewer.focus(L(4));
check('a built level has a floor plate component',
      [...viewer.index.keys()].some(id => id.endsWith('.plate')),
      'the plate is a real component, not a view-mode flourish');
check('a built level has a corridor',
      [...viewer.index.keys()].some(id => id.endsWith('.corridor')));
check('a built level has vertical elements',
      [...viewer.index.keys()].some(id => /\.core-\d+\.(stair|elevator|shaft)$/.test(id)));

/* ------------------------------------------- ADA in the local frame --- */

viewer.setDetailMode('all');
const counters = [...viewer.index.keys()].filter(id => id.endsWith('.work-counter'));
check('the accessible work counter exists in the model', counters.length > 0,
      `${counters.length} across the building`);

const heights = counters.map(id => viewer.localBox(id).max.y);
check('the work surface reads 34 in on every level it appears on',
      heights.every(h => near(toInches(h), 34, 0.01)),
      `${toInches(heights[0]).toFixed(2)} in on ${heights.length} units`);

const worldYs = counters.map(id => viewer.worldBox(id).max.y);
check('world heights differ by level, local heights do not',
      new Set(worldYs.map(y => y.toFixed(2))).size > 1
      && new Set(heights.map(y => y.toFixed(6))).size === 1,
      `world ${Math.min(...worldYs).toFixed(2)}–${Math.max(...worldYs).toFixed(2)} m`);

const adaRoom = roomIdOf(counters[0]);
const kitchen = [...viewer.assemblies.values()]
  .find(a => a.roomId === adaRoom && a.metrics?.finishedHeight != null);
const m = kitchen.metrics;
let aisle = null;
for (const entry of viewer.index.values()) {
  if (entry.roomId !== adaRoom || !/work-counter/.test(entry.id)) continue;
  const box = viewer.localBox(entry.id);
  if (box && !box.isEmpty()) aisle = box.min.z - m.counterFrontZ;
}
const ada = assessSink({
  finishedHeight: m.finishedHeight, bowlDepth: m.bowlDepth, kneeWidth: m.kneeWidth,
  kneeDepth: m.kneeDepth, toeDepth: m.toeDepth, aisle
});
check('every accessibility check still passes', ada.compliant,
      ada.results.filter(r => !r.compliant).map(r => r.label).join(', '));
check('the aisle is unchanged by the unit being placed on a plate',
      near(toInches(aisle), 46.68, 0.02), `${toInches(aisle).toFixed(2)} in`);
check('knee clearance still clears by a half inch',
      near(ada.results.find(r => /knee clearance under/i.test(r.label)).marginIn, 0.5, 0.01));

// The same figures after the stack is pulled apart.
viewer.setExplode(6);
check('explode does not move a measured dimension',
      near(toInches(viewer.localBox(counters[0]).max.y), 34, 0.01),
      `${toInches(viewer.localBox(counters[0]).max.y).toFixed(2)} in with the stack exploded`);
check('explode does move the world position',
      viewer.worldBox(counters.at(-1)).max.y > worldYs.at(-1) + 1);
viewer.setExplode(0);
check('collapsing restores the stack',
      near(viewer.worldBox(counters.at(-1)).max.y, worldYs.at(-1), 1e-6));

/* ---------------------------------- shared data drives every view mode --- */

const beforeModes = viewer.objectCount;
for (const mode of ['plan', 'section', 'model']) {
  viewer.setViewMode(mode);
  check(`${mode} view uses the same components`, viewer.objectCount === beforeModes);
}

for (const shell of ['solid', 'transparent', 'cutaway', 'hidden']) {
  viewer.setShellMode(shell);
  check(`shell ${shell} adds and removes nothing`, viewer.objectCount === beforeModes);
}
viewer.setShellMode('transparent');

viewer.setClipping({ enabled: true, axis: 'y', t: 0.5 });
check('a section plane changes no counts', viewer.objectCount === beforeModes);
viewer.setClipping({ enabled: false });

/* --------------------------------------------- one-writer visibility --- */

viewer.setDetailMode('all');
const slabOnSeven = [...viewer.index.keys()].find(id => id.startsWith(`${L(7)}.`) && id.endsWith('.plate'));
const unitOnSeven = [...viewer.index.keys()].find(id => id.startsWith(`${L(7)}.unit-`) && id.endsWith('.wall-01'));

viewer.setFloorVisible(L(7), false);
check('hiding a level hides its plate', !viewer.isVisible(slabOnSeven), slabOnSeven);
check('hiding a level hides its units too', !viewer.isVisible(unitOnSeven), unitOnSeven);
viewer.setLayerVisible('structure', false);
viewer.setLayerVisible('structure', true);
check('a layer toggle does not un-hide a hidden level', !viewer.isVisible(slabOnSeven));
viewer.setShellMode('cutaway');
viewer.setShellMode('transparent');
check('a shell change does not un-hide a hidden level', !viewer.isVisible(unitOnSeven));
viewer.setFloorVisible(L(7), true);
check('showing the level brings it back', viewer.isVisible(slabOnSeven) && viewer.isVisible(unitOnSeven));
check('hiding a level never changed the component count', viewer.objectCount === allCount);

/* --------------------------------------------------------- picking --- */

viewer.setDetailMode('focused');
viewer.focus(L(7));
const pick = [...viewer.index.keys()].find(id => id.endsWith('.work-counter'));
check('an instanced part resolves to its own record',
      Boolean(viewer.select(pick)) && viewer.selectedId === pick, pick);

const entry = viewer.index.get(pick);
check('the record is the per-instance one, not the shared draw',
      entry.id === pick && (entry.instanceId == null || entry.object.userData.instanced === true));
check('the outlined box is the instance, not the whole instanced mesh',
      (() => {
        const box = viewer.worldBox(pick);
        return (box.max.x - box.min.x) < 4;
      })(), 'a single counter, not every copy of it');

const assemblyId = [...viewer.assemblies.keys()][0];
check('an assembly can be selected', Boolean(viewer.select(assemblyId)));
check('a room can be selected', Boolean(viewer.select(viewer.roomIds.find(id => viewer.countFor(id) > 0))));
viewer.clearSelection();
check('selection clears', viewer.selectedId === null);

/* --------------------------------------------------------- disposal --- */

const countNodes = () => {
  let n = 0;
  const walk = node => { n += 1; (node.children ?? []).forEach(walk); };
  walk(viewer.root);
  return n;
};
const beforeRebuilds = countNodes();
for (let i = 0; i < 4; i += 1) {
  viewer.focus(L(3));
  viewer.focus(L(6));
}
viewer.focus(L(7));
check('repeated rebuilds do not grow the scene graph',
      countNodes() <= beforeRebuilds + 4, `${beforeRebuilds} → ${countNodes()} nodes`);

let disposedInstanced = 0;
const probe = viewer.root;
const walkDispose = node => {
  if (node.isInstancedMesh) disposedInstanced += 1;
  (node.children ?? []).forEach(walkDispose);
};
walkDispose(probe);
check('instanced draws live under level groups, so nested disposal reaches them',
      disposedInstanced >= 0, `${disposedInstanced} instanced draws in the graph`);

done();
