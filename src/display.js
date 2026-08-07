/**
 * Display mode arithmetic.
 *
 * Steps 7 and 8 of the study — transparent shell, cutaway, clipping, exploded
 * floors, and loading only the focused level at full detail — are all decisions
 * about *what to show*, not about what the building is. None of them may create,
 * destroy, or fork geometry, and none of them may change a truth state.
 *
 * The arithmetic lives here, apart from the renderer, for one practical reason:
 * a WebGLRenderer needs a GPU and a canvas, so anything folded into RoomViewer
 * can only be checked by driving a browser. These functions are pure, take plain
 * numbers and arrays, and are verified headlessly by `tests/verify-display.js`.
 *
 * Vectors are `[x, y, z]` arrays rather than THREE.Vector3 so this module stays
 * free of the renderer entirely.
 */

const AXES = { x: 0, y: 1, z: 2 };

export const CLIP_AXES = Object.keys(AXES);

/** Display treatments for the building shell. Orthogonal to model/plan/section. */
export const SHELL_MODES = ['solid', 'transparent', 'cutaway', 'hidden'];

/** How much of the shell is left opaque in each treatment. */
export const SHELL_OPACITY = { solid: 1, transparent: 0.16, cutaway: 0.16, hidden: 0 };

const clamp01 = t => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);

function assertVec3(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new TypeError(`${name} must be a finite [x, y, z], received ${JSON.stringify(value)}`);
  }
  return value;
}

/* ------------------------------------------------------------- exploded --- */

/**
 * Vertical offsets for an exploded stack.
 *
 * Floors are pulled apart in their stacking order, not by their address, so a
 * building whose levels start at 02 explodes from its own lowest floor rather
 * than from an imaginary level zero. The lowest floor never moves: the study
 * stays anchored to the ground plane it was framed against.
 *
 * @param {Array<{id: string, level?: number}>} levels
 * @param {number} gap  metres of separation added per level; 0 is unexploded
 * @returns {Map<string, number>} floor id -> y offset
 */
export function explodeOffsets(levels, gap) {
  if (!Array.isArray(levels)) throw new TypeError('explodeOffsets requires an array of levels');
  const amount = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const ordered = [...levels].sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  const offsets = new Map();
  ordered.forEach((entry, index) => offsets.set(entry.id, index * amount));
  return offsets;
}

/* ------------------------------------------------------------- clipping --- */

/**
 * A section plane across the model, expressed the way THREE.Plane reads it:
 * fragments where `normal · p + constant < 0` are cut away.
 *
 * `t` runs 0..1 across the model's own extent on that axis, so the control is
 * meaningful without the caller knowing the building's dimensions. `flip`
 * chooses which half survives.
 *
 * The cut is a camera effect. It removes fragments, never objects: the index,
 * the object count, and every truth state are identical on both sides of it,
 * which is what keeps a clipped view from reading as a different model.
 */
export function clipPlaneSpec(axis, t, bounds, { flip = false } = {}) {
  const index = AXES[axis];
  if (index === undefined) throw new TypeError(`Unknown clip axis "${axis}" — expected one of ${CLIP_AXES.join(', ')}`);
  const min = Number(bounds?.min?.[axis]);
  const max = Number(bounds?.max?.[axis]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new TypeError(`clipPlaneSpec needs finite bounds on "${axis}"`);
  }

  const at = min + (max - min) * clamp01(t);
  const direction = flip ? 1 : -1;
  const normal = [0, 0, 0];
  normal[index] = direction;
  // normal · p + constant > 0 is the surviving half, so the plane passes through
  // `at` exactly when constant = -direction * at.
  return { normal, constant: -direction * at, at, axis };
}

/** True when `point` survives the cut described by a plane spec. */
export function survivesClip(spec, point) {
  assertVec3(point, 'point');
  const { normal, constant } = spec;
  return normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2] + constant >= 0;
}

/* -------------------------------------------------------------- cutaway --- */

/**
 * Is the camera on the outside face of this piece of shell?
 *
 * Cutaway hides the walls between the viewer and the room rather than making
 * them transparent, so interiors read at full contrast from any angle. A wall is
 * in the way exactly when the camera sits on the side its outward normal points
 * to — which is a sign test, and needs no raycasting.
 *
 * Walls edge-on to the view (dot product within `epsilon` of zero) are kept:
 * they occlude almost nothing, and dropping them makes the plan read as though
 * the room had no boundary.
 */
export function facesCamera(outwardNormal, center, cameraPosition, epsilon = 1e-3) {
  assertVec3(outwardNormal, 'outwardNormal');
  assertVec3(center, 'center');
  assertVec3(cameraPosition, 'cameraPosition');
  const dot = outwardNormal[0] * (cameraPosition[0] - center[0])
            + outwardNormal[1] * (cameraPosition[1] - center[1])
            + outwardNormal[2] * (cameraPosition[2] - center[2]);
  return dot > epsilon;
}

/**
 * Outward normal for a box-shaped wall.
 *
 * The wall's own thickness runs along its local Z, so its face normal is local Z
 * turned by the wall's rotation. Which of the two directions is "out" is decided
 * by the room it encloses: the one pointing away from the room centre.
 */
export function outwardNormalFor(rotationDegrees, wallCenter, roomCenter) {
  assertVec3(wallCenter, 'wallCenter');
  assertVec3(roomCenter, 'roomCenter');
  const radians = (rotationDegrees / 360) * Math.PI * 2;
  const normal = [Math.sin(radians), 0, Math.cos(radians)];
  const away = [wallCenter[0] - roomCenter[0], 0, wallCenter[2] - roomCenter[2]];
  const dot = normal[0] * away[0] + normal[2] * away[2];
  // A wall through the room centre has no outside; leave it pointing as authored
  // rather than flipping on floating-point noise.
  return dot < 0 ? [-normal[0], 0, -normal[2]] : normal;
}

/* --------------------------------------------------- progressive detail --- */

/**
 * Which levels get full geometry.
 *
 * The rule the brief states is "only the selected floor receives full detail".
 * Two details make that workable rather than literal:
 *
 *   - A focus on the building as a whole, or on nothing, is not a request to
 *     drop all detail. The level last asked for stays loaded, so navigating up
 *     to the building and back down does not empty the model.
 *   - `all` is an explicit override, kept because the honest way to show what
 *     progressive loading costs and saves is to let a reader turn it off.
 *
 * @returns {Set<string>} floor ids to build at full detail
 */
export function detailFloorSet({ mode = 'focused', focusId = null, floorIds = [], fallback = null } = {}) {
  if (floorIds.length === 0) return new Set();
  if (mode === 'all') return new Set(floorIds);
  if (mode !== 'focused') throw new TypeError(`Unknown detail mode "${mode}" — expected "focused" or "all"`);

  const target = floorIds.find(id => focusId === id || focusId?.startsWith(`${id}.`))
    ?? (floorIds.includes(fallback) ? fallback : null)
    ?? floorIds[0];
  return new Set([target]);
}
