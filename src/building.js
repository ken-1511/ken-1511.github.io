/**
 * Compose a building from levels, each assigned a floor-plan variant.
 *
 * This replaces the earlier stacking, which took one unit type and repeated it
 * on a uniform grid at every level. That produced a vertical array of identical
 * rooms — a thing that reads as a spreadsheet, not a building — and, worse, it
 * asserted a uniformity that nothing in the available material supports.
 *
 * A level now owns a *variant*: a plate outline, a corridor, a core, shared and
 * service rooms, and a list of placed units. Levels that genuinely differ get
 * different variants. Levels with no evidence either way share one and say so.
 *
 * What is composed here, and what each thing claims:
 *
 *   levels           the count and the 1-2 / 3-7 split are stated in the set
 *   elevations       derived — stacked from ceiling heights that are stated
 *   plate outlines   unresolved — no plate is drawn anywhere in the set
 *   unit positions   unresolved — nothing locates a unit on a plate
 *   unit types       measured off the unit sheets; the sheets are withheld, so
 *                    the types publish with no source link
 *
 * Addresses are positional-independent by construction. A unit's address is its
 * level and its index within that level's variant, so moving a unit in the
 * variant changes where it is drawn and not what it is called.
 */

import { joinId, floorIdOf, isValidId } from './ids.js';
import { TRUTH, assertTruthState } from './truth.js';
import { instantiateType } from './types.js';

const pad = n => String(n).padStart(2, '0');

/** Axis-aligned bounds of a polygon, as { minX, maxX, minZ, maxZ }. */
export function polygonBounds(polygon) {
  const xs = polygon.map(p => p[0]);
  const zs = polygon.map(p => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minZ: Math.min(...zs), maxZ: Math.max(...zs)
  };
}

export function polygonArea(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, z1] = polygon[i];
    const [x2, z2] = polygon[(i + 1) % polygon.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}

/**
 * A single frame shared by every level.
 *
 * Levels are authored in their own plate coordinates, starting at the plate's
 * own corner. Stacking them as authored would leave each level sitting wherever
 * its outline happened to start, so repeated walls, the corridor and the core
 * would drift level to level. One offset, computed from every plate at once and
 * applied to all of them, keeps what repeats aligned and lets what does not
 * repeat step or stop where the variant says it does.
 */
export function buildingFrame(variants) {
  const all = [...variants].flatMap(v => v.plate.polygon);
  const bounds = polygonBounds(all);
  return {
    offsetX: -(bounds.minX + bounds.maxX) / 2,
    offsetZ: -(bounds.minZ + bounds.maxZ) / 2,
    width: bounds.maxX - bounds.minX,
    depth: bounds.maxZ - bounds.minZ
  };
}

function translatePolygon(polygon, dx, dz) {
  return polygon.map(([x, z]) => [round(x + dx), round(z + dz)]);
}

const round = n => Math.round(n * 10000) / 10000;

/**
 * Rebase a scope's part ids onto its own address.
 *
 * Unit types go through `instantiateType`, which does this. The commons and core
 * scopes are built here rather than instantiated, so they have to do it too —
 * otherwise every level registers a part called `plate`, they collide the moment
 * a second level is built, and until then they sit in the index at a bare
 * address that belongs to no room.
 */
function rebaseParts(scopeId, parts) {
  return parts.map(part => {
    const id = joinId(scopeId, part.id);
    if (!isValidId(id)) throw new TypeError(`Part "${part.id}" of ${scopeId} does not form a valid address`);
    return { ...part, id };
  });
}

/**
 * The level's shared spaces, as one room-level scope.
 *
 * Plate, corridor, shared rooms and service rooms all belong to the level rather
 * than to any unit, so they are collected into a `commons-NN` scope that sits at
 * the same depth in the address as a unit does. Everything downstream — the
 * index, layers, picking, roll-up, the model tree — then treats it like any
 * other room-level scope with no special case at all.
 */
function commonsDefinition(floorId, level, variant, frame) {
  const id = joinId(floorId, `commons-${pad(level.level)}`);
  const parts = [];

  parts.push({
    type: 'plate',
    id: 'plate',
    name: `${level.name} floor plate`,
    truth: variant.plate.truth,
    layer: 'structure',
    geometry: {
      polygon: translatePolygon(variant.plate.polygon, frame.offsetX, frame.offsetZ),
      thickness: variant.plate.thickness,
      y: 0
    },
    note: variant.plate.note
  });

  const c = variant.corridor;
  parts.push({
    type: 'zone',
    id: 'corridor',
    name: 'Corridor',
    roomType: 'corridor',
    truth: c.truth,
    layer: 'circulation',
    geometry: {
      x: round((c.x0 + c.x1) / 2 + frame.offsetX),
      z: round((c.z0 + c.z1) / 2 + frame.offsetZ),
      width: round(c.x1 - c.x0),
      depth: round(c.z1 - c.z0),
      y: 0.012
    },
    note: c.note
  });

  for (const [layer, rooms] of [['common', variant.common], ['service', variant.service]]) {
    for (const room of rooms ?? []) {
      parts.push({
        type: 'zone',
        id: room.id,
        name: room.name,
        roomType: room.roomType,
        truth: room.truth,
        layer,
        geometry: {
          x: round(room.x + frame.offsetX),
          z: round(room.z + frame.offsetZ),
          width: room.width,
          depth: room.depth,
          y: 0.012
        },
        note: room.note
      });
    }
  }

  return {
    schema: 'parametric-study.room-definition.v1',
    id,
    name: `${level.name} — plate, circulation and shared rooms`,
    shortName: 'Plate & commons',
    kind: 'commons',
    truth: variant.plate.truth,
    container: 'parametric study',
    summary: variant.evidence?.basis ?? null,
    source: null,
    dimensions: null,
    massing: null,
    params: null,
    displayNames: { [id]: 'Plate & commons' },
    parts: rebaseParts(id, parts),
    missing: ['A drawn floor plate', 'Corridor location and configuration',
              'Any schedule of shared or service rooms']
  };
}

/** Stairs, lift and shafts, as one room-level scope per level. */
function coreDefinition(floorId, level, variant, frame) {
  const id = joinId(floorId, `core-${pad(level.level)}`);
  const height = level.floorToFloor.value;
  const parts = (variant.vertical ?? []).map(element => ({
    type: 'volume',
    id: element.id,
    name: element.name,
    truth: element.truth,
    layer: 'vertical',
    geometry: {
      x: round(element.x + frame.offsetX),
      z: round(element.z + frame.offsetZ),
      width: element.width,
      depth: element.depth,
      height: round(height)
    },
    note: element.note
  }));

  return {
    schema: 'parametric-study.room-definition.v1',
    id,
    name: `${level.name} — vertical elements`,
    shortName: 'Vertical core',
    kind: 'core',
    truth: TRUTH.UNRESOLVED,
    container: 'parametric study',
    summary: 'The set names shafts, stairs and a lift. It locates none of them.',
    source: null,
    dimensions: null,
    massing: null,
    params: null,
    displayNames: { [id]: 'Vertical core' },
    parts: rebaseParts(id, parts),
    missing: ['Stair location and count', 'Lift location and count', 'Shaft locations']
  };
}

/**
 * Expand the building spec into levels and placed rooms.
 *
 * @param {object} spec building.json
 * @param {Map<string,object>} variants variantId -> parsed variant
 * @param {Map<string,object>} types typeId -> parsed unit type
 */
export function composeBuilding(spec, variants, types) {
  if (!Array.isArray(spec.levels) || spec.levels.length === 0) {
    throw new Error('building spec must declare at least one level');
  }

  const used = spec.levels.map(level => {
    const variant = variants.get(level.variant);
    if (!variant) throw new Error(`Level ${level.id} references unknown variant "${level.variant}"`);
    return variant;
  });
  const frame = buildingFrame(new Set(used));

  const rooms = [];
  const floors = [];
  const displayNames = { [spec.id]: spec.name ?? spec.id };

  spec.levels.forEach((level, index) => {
    const variant = used[index];
    const floorId = joinId(spec.id, level.id);
    const y = level.elevation.value;
    displayNames[floorId] = level.name;

    const unitRecords = [];
    variant.units.forEach((placement, unitIndex) => {
      const type = types.get(placement.type);
      if (!type) throw new Error(`Variant ${variant.id} references unknown unit type "${placement.type}"`);

      // Address is level plus index within the variant, so it survives the unit
      // being moved, re-laid-out, or the plate being re-cut.
      const tag = `${pad(level.level)}${pad(unitIndex + 1)}`;
      const unitId = joinId(floorId, `unit-${tag}`);
      const label = `${type.shortName ?? type.name} ${tag}`;
      const definition = instantiateType(type, { id: unitId, name: label, shortName: label });
      definition.kind = 'unit';
      definition.roomTypes = (type.parts ?? [])
        .filter(part => part.type === 'zone')
        .map(part => part.roomType);
      definition.bedrooms = type.bedrooms ?? 0;
      definition.accessibility = type.accessibility ?? null;

      const world = {
        x: round(placement.transform.x + frame.offsetX),
        y,
        z: round(placement.transform.z + frame.offsetZ),
        rotation: placement.transform.rotation ?? 0,
        truth: TRUTH.UNRESOLVED,
        note: 'Nothing in the available set places a unit on a plate. This position '
            + 'is part of a study arrangement and carries no claim.'
      };
      rooms.push({ definition, placement: world });
      unitRecords.push({ id: unitId, type: placement.type, tag, placement: world });
      displayNames[unitId] = label;
    });

    const commons = commonsDefinition(floorId, level, variant, frame);
    const core = coreDefinition(floorId, level, variant, frame);
    for (const definition of [commons, core]) {
      rooms.push({ definition, placement: { x: 0, y, z: 0, rotation: 0, truth: TRUTH.UNRESOLVED } });
      Object.assign(displayNames, definition.displayNames);
    }

    const platePolygon = translatePolygon(variant.plate.polygon, frame.offsetX, frame.offsetZ);
    const inventory = {};
    for (const record of unitRecords) {
      const key = types.get(record.type).shortName ?? record.type;
      inventory[key] = (inventory[key] ?? 0) + 1;
    }

    floors.push({
      id: floorId,
      level: level.level,
      name: level.name,
      role: level.role,
      variantId: variant.id,
      variantName: variant.name,
      elevation: level.elevation,
      floorToFloor: level.floorToFloor,
      ceilingHeight: variant.ceilingHeight,
      plate: {
        polygon: platePolygon,
        bounds: polygonBounds(platePolygon),
        area: round(polygonArea(platePolygon)),
        truth: variant.plate.truth,
        note: variant.plate.note
      },
      units: unitRecords,
      unitCount: unitRecords.length,
      inventory,
      roomTypes: [...new Set(rooms
        .filter(r => floorIdOf(r.definition.id) === floorId)
        .flatMap(r => r.definition.roomTypes ?? []))].sort(),
      commonsId: commons.id,
      coreId: core.id,
      evidence: variant.evidence,
      notes: variant.notes ?? [],
      truth: TRUTH.UNRESOLVED
    });

    assertTruthState(level.elevation.truth, `${floorId} elevation`);
  });

  // Which variants are used more than once, and are therefore an assumed repeat.
  const usage = new Map();
  for (const floor of floors) {
    if (!usage.has(floor.variantId)) usage.set(floor.variantId, []);
    usage.get(floor.variantId).push(floor.id);
  }
  for (const floor of floors) {
    const shared = usage.get(floor.variantId);
    floor.repeated = shared.length > 1;
    floor.sharesVariantWith = shared.filter(id => id !== floor.id);
  }

  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    truth: spec.truth ?? TRUTH.UNRESOLVED,
    levelStructure: spec.levelStructure ?? null,
    frame,
    floors,
    rooms,
    displayNames,
    variants: [...new Set(used)].map(v => ({
      id: v.id, name: v.name, role: v.role, evidence: v.evidence, notes: v.notes
    })),
    stats: {
      levels: floors.length,
      units: floors.reduce((n, f) => n + f.unitCount, 0),
      variants: new Set(used).size,
      partSpecs: rooms.reduce((n, r) => n + r.definition.parts.length, 0)
    }
  };
}
