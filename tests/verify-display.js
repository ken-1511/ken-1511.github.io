/**
 * Headless checks for the display arithmetic behind steps 7 and 8.
 *
 * These need no GPU and no browser: the point of src/display.js being separate
 * from the renderer is that the rules can be checked directly rather than
 * inferred from a screenshot.
 *
 *   deno run -A tests/verify-display.js
 */
import {
  explodeOffsets, clipPlaneSpec, survivesClip, facesCamera, outwardNormalFor,
  detailFloorSet, SHELL_MODES, SHELL_OPACITY, CLIP_AXES
} from '../src/display.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures += 1; console.log(`  FAIL  ${name}  ${detail}`); }
  else console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`);
};
const threw = fn => { try { fn(); return false; } catch { return true; } };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

/* ----------------------------------------------------------- exploded --- */

const levels = [
  { id: 'building-a.floor-04', level: 4 },
  { id: 'building-a.floor-02', level: 2 },
  { id: 'building-a.floor-03', level: 3 }
];

const off = explodeOffsets(levels, 2);
check('explode orders by level, not by argument order',
      off.get('building-a.floor-02') === 0
      && off.get('building-a.floor-03') === 2
      && off.get('building-a.floor-04') === 4,
      `${[...off.values()].join(', ')}`);

check('lowest floor never moves', explodeOffsets(levels, 9).get('building-a.floor-02') === 0);

check('gap 0 collapses the stack',
      [...explodeOffsets(levels, 0).values()].every(v => v === 0));

check('negative gap is treated as unexploded',
      [...explodeOffsets(levels, -5).values()].every(v => v === 0));

check('non-array levels rejected', threw(() => explodeOffsets(null, 1)));

/* ----------------------------------------------------------- clipping --- */

const bounds = { min: { x: -10, y: 0, z: -5 }, max: { x: 10, y: 18, z: 5 } };

const half = clipPlaneSpec('y', 0.5, bounds);
check('clip t=0.5 lands mid-extent', near(half.at, 9), `at ${half.at}`);
check('clip keeps the min side by default',
      survivesClip(half, [0, 1, 0]) && !survivesClip(half, [0, 17, 0]));

const flipped = clipPlaneSpec('y', 0.5, bounds, { flip: true });
check('flip keeps the max side',
      !survivesClip(flipped, [0, 1, 0]) && survivesClip(flipped, [0, 17, 0]));

check('a point on the plane survives both orientations',
      survivesClip(half, [0, 9, 0]) && survivesClip(flipped, [0, 9, 0]));

check('t=0 and t=1 reach the real extremes',
      near(clipPlaneSpec('x', 0, bounds).at, -10) && near(clipPlaneSpec('x', 1, bounds).at, 10));

check('t clamps outside 0..1',
      near(clipPlaneSpec('x', -3, bounds).at, -10) && near(clipPlaneSpec('x', 4, bounds).at, 10));

check('every advertised axis resolves',
      CLIP_AXES.every(axis => Number.isFinite(clipPlaneSpec(axis, 0.5, bounds).at)));

check('unknown axis rejected', threw(() => clipPlaneSpec('w', 0.5, bounds)));
check('non-finite bounds rejected', threw(() => clipPlaneSpec('y', 0.5, { min: {}, max: {} })));

/* ------------------------------------------------------------ cutaway --- */

// A room centred at the origin, 3.35 m deep: north wall at -1.68, south at +1.68.
const roomCentre = [0, 1.37, 0];
const northWall = [0, 1.37, -1.6764];
const southWall = [0, 1.37, 1.6764];

const northNormal = outwardNormalFor(0, northWall, roomCentre);
const southNormal = outwardNormalFor(0, southWall, roomCentre);
check('opposite walls get opposite outward normals',
      near(northNormal[2], -1) && near(southNormal[2], 1),
      `north z ${northNormal[2].toFixed(3)}, south z ${southNormal[2].toFixed(3)}`);

const eastNormal = outwardNormalFor(90, [2.74, 1.37, 0], roomCentre);
check('a rotated wall normal turns with it', near(eastNormal[0], 1), `x ${eastNormal[0].toFixed(3)}`);

// Camera to the south, looking north: the south wall is in the way, the north is not.
const cameraSouth = [0, 6, 14];
check('cutaway hides only the near wall',
      facesCamera(southNormal, southWall, cameraSouth)
      && !facesCamera(northNormal, northWall, cameraSouth));

const cameraNorth = [0, 6, -14];
check('orbiting swaps which wall is hidden',
      facesCamera(northNormal, northWall, cameraNorth)
      && !facesCamera(southNormal, southWall, cameraNorth));

check('an edge-on wall is kept',
      !facesCamera(eastNormal, [2.74, 1.37, 0], [2.74, 6, 14]),
      'camera directly above the wall plane');

check('overhead camera keeps vertical shell',
      !facesCamera(northNormal, northWall, [0, 60, -1.6764]));

check('malformed vectors rejected', threw(() => facesCamera([0, 0], [0, 0, 0], [0, 0, 0])));

/* -------------------------------------------------- progressive detail --- */

const floorIds = ['building-a.floor-02', 'building-a.floor-03', 'building-a.floor-04'];

check('a unit address resolves to its own level',
      [...detailFloorSet({ focusId: 'building-a.floor-03.unit-0302', floorIds })].join() === 'building-a.floor-03');

check('a component address resolves to its level',
      [...detailFloorSet({ focusId: 'building-a.floor-04.unit-0401.kitchen.base-03', floorIds })].join()
        === 'building-a.floor-04');

check('focusing the building keeps the last level loaded',
      [...detailFloorSet({ focusId: 'building-a', floorIds, fallback: 'building-a.floor-04' })].join()
        === 'building-a.floor-04');

check('no focus and no fallback loads the first level',
      [...detailFloorSet({ focusId: null, floorIds })].join() === 'building-a.floor-02');

check('a stale fallback does not survive',
      [...detailFloorSet({ focusId: null, floorIds, fallback: 'building-a.floor-99' })].join()
        === 'building-a.floor-02');

check('all mode loads every level', detailFloorSet({ mode: 'all', floorIds }).size === 3);

check('exactly one level is detailed in focused mode',
      floorIds.every(id => detailFloorSet({ focusId: id, floorIds }).size === 1));

check('an empty building asks for nothing', detailFloorSet({ floorIds: [] }).size === 0);

check('unknown detail mode rejected', threw(() => detailFloorSet({ mode: 'some', floorIds })));

/* ------------------------------------------------------------- shell --- */

check('every shell mode has an opacity',
      SHELL_MODES.every(mode => typeof SHELL_OPACITY[mode] === 'number'));
check('hidden is fully transparent and solid is opaque',
      SHELL_OPACITY.hidden === 0 && SHELL_OPACITY.solid === 1);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
if (failures > 0) Deno.exit(1);
