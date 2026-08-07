import * as THREE from 'three';
import { joinId } from './ids.js';
import { TRUTH } from './truth.js';
import { ADA, ADA_CITATIONS, checkWorkSurfaceHeight, sinkKneeOpening, toInches, inches } from './ada.js';

/**
 * Parametric part builders.
 *
 * A generator turns a declarative spec from a room manifest into geometry. It owns
 * no state and reads no DOM — the RoomViewer calls it and indexes what comes back.
 * Every mesh a generator emits must be registered with a stable id and a truth
 * state, or it will not be selectable and will not appear in the model tree.
 */

const TWO_PI = Math.PI * 2;

/**
 * Box geometry, deduplicated per build.
 *
 * A building is one unit type repeated, so the same handful of box dimensions
 * recur thousands of times. Allocating a BoxGeometry per mesh cost ~36x the
 * memory it needed at six levels and scaled linearly with the stack. Position
 * and rotation live on the mesh, never on the geometry, so instances of the
 * same box are safe to share.
 *
 * The cache is owned by the viewer and rebuilt with the scene — a module-global
 * cache would hand out geometries that #disposeScene had already freed.
 */
function box(ctx, size) {
  if (!ctx.geometryCache) return new THREE.BoxGeometry(...size);
  const key = size.join(':');
  let geometry = ctx.geometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(...size);
    ctx.geometryCache.set(key, geometry);
  }
  return geometry;
}

/** Shared mesh factory. Everything selectable goes through here. */
function part(ctx, { id, name, size, position, rotationY = 0, material, truth, source = null, derivations = [], note = null, castShadow = true }) {
  const geometry = box(ctx, size);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name ?? id;
  mesh.position.set(...position);
  mesh.rotation.y = rotationY;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  ctx.register(mesh, { id, truth, source, derivations, note, displayName: name ?? id });
  return mesh;
}

/**
 * A clearance envelope: the volume that must stay empty for a code rule to hold.
 * Rendered as a non-solid guide, excluded from shadows and from the object count.
 */
function clearanceVolume(ctx, { id, name, size, position, citation, color = 0x48836c }) {
  const geometry = box(ctx, size);
  // Materials and edge geometry are cached alongside the boxes: #disposeScene
  // only ever walked geometry, so a per-call material here leaked one object per
  // clearance volume per rebuild.
  const material = ctx.cached?.(`clearance-fill:${color}`, () => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.14, depthWrite: false
  })) ?? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.renderOrder = 4;
  mesh.userData.isClearance = true;

  const edgeGeometry = ctx.cached?.(`clearance-edges:${size.join(':')}`,
    () => new THREE.EdgesGeometry(geometry)) ?? new THREE.EdgesGeometry(geometry);
  const edgeMaterial = ctx.cached?.(`clearance-dash:${color}`, () => new THREE.LineDashedMaterial({
    color, dashSize: 0.06, gapSize: 0.04, transparent: true, opacity: 0.85
  })) ?? new THREE.LineDashedMaterial({ color, dashSize: 0.06, gapSize: 0.04, transparent: true, opacity: 0.85 });
  const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edges.computeLineDistances();
  mesh.add(edges);

  ctx.register(mesh, {
    id,
    truth: TRUTH.DERIVED,
    source: null,
    derivations: [citation],
    displayName: name,
    isClearance: true
  });
  return mesh;
}

/* ----------------------------------------------------------------- plate --- */

/**
 * An extruded polygon lying flat — a floor plate, or a unit slab that is not a
 * rectangle.
 *
 * Plates are the reason the building reads as assembled rather than stacked: a
 * level whose outline steps, notches, or sets back cannot be drawn as a box, and
 * squaring it off would be inventing an outline the study does not claim.
 *
 * Shape space is XY and extrudes along +Z. Rotating -90° about X maps that to
 * the ground plane and sends shape +Y to world -Z, so the polygon's z is
 * negated going in and comes back out the right way round.
 */
export function extrudedPolygon(ctx, polygon, thickness, key) {
  const make = () => {
    const shape = new THREE.Shape(polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    // Extrusion runs 0..thickness upward after the rotation; drop it so the top
    // face lands on the part's own y and the slab hangs below, like the box slab.
    geometry.translate(0, -thickness, 0);
    geometry.computeVertexNormals();
    return geometry;
  };
  if (!ctx.geometryCache) return make();
  let geometry = ctx.geometryCache.get(key);
  if (!geometry) {
    geometry = make();
    ctx.geometryCache.set(key, geometry);
  }
  return geometry;
}

export function buildPlate(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;
  const g = spec.geometry;
  const thickness = g.thickness ?? 0.2;
  const geometry = extrudedPolygon(ctx, g.polygon, thickness, `plate:${spec.id}:${thickness}`);

  const mesh = new THREE.Mesh(geometry, ctx.materials.finish[spec.material ?? 'slab'] ?? ctx.materials.finish.slab);
  mesh.name = spec.name ?? 'Floor plate';
  mesh.position.set(0, g.y ?? 0, 0);
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  // A drawn edge is what makes a plate read as a plate at building scale rather
  // than as a grey rectangle. Cached with the geometry it outlines.
  const edges = new THREE.LineSegments(
    ctx.cached?.(`plate-edges:${spec.id}:${thickness}`, () => new THREE.EdgesGeometry(geometry, 25))
      ?? new THREE.EdgesGeometry(geometry, 25),
    ctx.materials.outline.plate
  );
  mesh.add(edges);

  ctx.register(mesh, {
    id: spec.id,
    truth: spec.truth,
    source: spec.source ?? null,
    derivations: spec.derivations ?? [],
    displayName: spec.name ?? 'Floor plate',
    note: spec.note
  });
  group.add(mesh);
  return group;
}

/* ------------------------------------------------------------------ zone --- */

/**
 * A room zone: the floor area a named room occupies.
 *
 * This is how a plan reads in three dimensions. It is deliberately a floor patch
 * and not a volume — the set establishes that a room of this kind exists in this
 * unit type, and nothing about its height or its walls, so drawing it as a solid
 * would claim more than is known.
 */
export function buildZone(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;
  const g = spec.geometry;
  const thickness = 0.02;
  const material = ctx.materials.zone[spec.roomType] ?? ctx.materials.zone.default;

  const geometry = box(ctx, [g.width, thickness, g.depth]);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = spec.name ?? spec.roomType;
  mesh.position.set(g.x ?? 0, (g.y ?? 0.01) + thickness / 2, g.z ?? 0);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;

  const edges = new THREE.LineSegments(
    ctx.cached?.(`zone-edges:${g.width}:${g.depth}`, () => new THREE.EdgesGeometry(geometry))
      ?? new THREE.EdgesGeometry(geometry),
    ctx.materials.outline.zone
  );
  mesh.add(edges);

  ctx.register(mesh, {
    id: spec.id,
    truth: spec.truth,
    source: spec.source ?? null,
    derivations: spec.derivations ?? [],
    displayName: spec.name ?? spec.roomType,
    note: spec.note,
    roomType: spec.roomType
  });
  group.add(mesh);
  return group;
}

/* ------------------------------------------------------------------ slab --- */

export function buildSlab(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;
  const { width, depth, thickness = 0.14 } = spec.geometry;
  group.add(part(ctx, {
    id: spec.id,
    name: spec.name ?? 'Slab',
    size: [width, thickness, depth],
    position: [spec.geometry.x ?? 0, -(thickness / 2), spec.geometry.z ?? 0],
    material: ctx.materials.finish.slab,
    truth: spec.truth,
    source: spec.source,
    derivations: spec.derivations ?? [],
    castShadow: false
  }));
  return group;
}

/* ------------------------------------------------------------------ wall --- */

export function buildWall(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;
  const g = spec.geometry;
  const isGhost = spec.truth === TRUTH.UNRESOLVED || spec.style === 'ghost';
  group.add(part(ctx, {
    id: spec.id,
    name: spec.name ?? 'Wall',
    size: [g.length, g.height, g.thickness],
    position: [g.x, g.height / 2, g.z],
    rotationY: ((g.rotation ?? 0) / 360) * TWO_PI,
    material: isGhost ? ctx.materials.finish.wallGhost : ctx.materials.finish.wall,
    truth: spec.truth,
    source: spec.source,
    derivations: spec.derivations ?? [],
    note: spec.note
  }));
  return group;
}

/* --------------------------------------------------------------- opening --- */

export function buildOpening(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;
  const g = spec.geometry;
  const material = spec.style === 'glazed' ? ctx.materials.finish.glass : ctx.materials.finish.wallGhost;
  group.add(part(ctx, {
    id: spec.id,
    name: spec.name ?? 'Opening',
    size: [g.width, g.height, g.thickness ?? 0.08],
    position: [g.x, (g.sill ?? 0) + g.height / 2, g.z],
    rotationY: ((g.rotation ?? 0) / 360) * TWO_PI,
    material,
    truth: spec.truth,
    source: spec.source,
    derivations: spec.derivations ?? [],
    note: spec.note
  }));
  return group;
}

/* --------------------------------------------------------- casework run --- */

/**
 * A run of base cabinets with a continuous countertop, an accessible sink zone,
 * and uppers that step around the sink.
 *
 * The sink zone is not a cabinet. Per 2010 ADA 606 and UFAS 4.34.6.5, the base
 * cabinet under the sink is omitted (or removable) so that knee and toe clearance
 * are available, the bowl is shallow enough to keep that clearance, and the
 * supply and drain lines are screened. The generator lays the cabinet modules out
 * around that void rather than drawing a continuous bank and hiding a door.
 *
 * Height datum: `workSurfaceHeight` is the **finished top surface** — the plane
 * 606.3 measures ("rim or counter, whichever is higher"). The cabinet carcass is
 * that height minus the counter thickness, and the bowl hangs down from the
 * finished surface. Treating the parameter as the carcass height and then
 * stacking a slab on top silently pushes the governed surface over the maximum.
 */
export function buildCaseworkRun(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;

  const anchor = spec.anchor ?? { x: 0, z: 0, rotation: 0 };
  const runLength = ctx.param(spec.params.runLength);
  const rawHeight = ctx.param(spec.params.workSurfaceHeight);

  // The governing figure is a maximum, so a request above it is reported, not obeyed.
  const heightCheck = checkWorkSurfaceHeight(rawHeight);
  const height = Math.min(rawHeight, ADA.WORK_SURFACE_MAX_HEIGHT);

  const counterDepth = spec.counterDepth ?? inches(25);
  const cabinetDepth = spec.cabinetDepth ?? inches(24);
  const counterThickness = spec.counterThickness ?? inches(1.5);
  const toeHeight = spec.toeHeight ?? inches(4);
  const carcassHeight = height - counterThickness;
  const backZ = anchor.z;
  const faceZ = backZ + cabinetDepth / 2;

  const heightDerivation = `${ADA_CITATIONS.WORK_SURFACE_MAX_HEIGHT} — finished surface at ${toInches(height).toFixed(2)} in`;

  /* -- accessible sink zone ------------------------------------------------ */

  // Knee clearance must be at least 30 in wide, so the void never narrows below it.
  const sinkWidth = Math.max(spec.sink?.width ?? inches(36), ADA.KNEE.MIN_WIDTH);
  const sinkCenter = spec.sink?.offset ?? -runLength * 0.16;
  const sinkStart = sinkCenter - sinkWidth / 2;
  const sinkEnd = sinkCenter + sinkWidth / 2;

  const bowlDepth = Math.min(spec.sink?.bowlDepth ?? ADA.SINK_MAX_BOWL_DEPTH, ADA.SINK_MAX_BOWL_DEPTH);
  const knee = sinkKneeOpening(height, bowlDepth);

  // Knee and toe clearance are measured back from the face the user approaches.
  const kneeDepth = Math.min(spec.sink?.kneeDepth ?? ADA.KNEE.KITCHEN_DEPTH, cabinetDepth);
  const toeDepth = Math.min(spec.sink?.toeDepth ?? ADA.TOE.MIN_DEPTH, cabinetDepth);

  /* -- base cabinets, laid out around the sink void ------------------------ */

  const runStart = -runLength / 2;
  const runEnd = runLength / 2;
  const bays = [
    { from: runStart, to: sinkStart },
    { from: sinkEnd, to: runEnd }
  ].filter(bay => bay.to - bay.from > 0.18);

  let moduleIndex = 0;
  const moduleTarget = spec.moduleTarget ?? 0.6;

  for (const bay of bays) {
    const bayLength = bay.to - bay.from;
    const count = Math.max(1, Math.round(bayLength / moduleTarget));
    const width = bayLength / count;
    for (let i = 0; i < count; i += 1) {
      moduleIndex += 1;
      const x = bay.from + width / 2 + i * width;
      const label = String(moduleIndex).padStart(2, '0');
      const baseId = joinId(spec.id, `base-${label}`);

      group.add(part(ctx, {
        id: baseId,
        name: `Base cabinet ${label}`,
        size: [width - 0.025, carcassHeight - toeHeight, cabinetDepth],
        position: [x, (carcassHeight - toeHeight) / 2 + toeHeight, backZ],
        material: ctx.materials.finish.cabinet,
        truth: TRUTH.DEFAULT,
        derivations: [heightDerivation]
      }));

      group.add(part(ctx, {
        id: joinId(spec.id, `toe-${label}`),
        name: `Toe kick ${label}`,
        size: [width - 0.08, toeHeight, cabinetDepth - 0.11],
        position: [x, toeHeight / 2, backZ + 0.045],
        material: ctx.materials.finish.cabinetDark,
        truth: TRUTH.DEFAULT
      }));

      group.add(part(ctx, {
        id: joinId(spec.id, `pull-${label}`),
        name: `Pull ${label}`,
        size: [Math.min(width * 0.35, 0.18), 0.025, 0.025],
        position: [x, carcassHeight - 0.16, faceZ + 0.02],
        material: ctx.materials.finish.metal,
        truth: TRUTH.DEFAULT
      }));
    }
  }

  /* -- continuous countertop ----------------------------------------------- */

  // Top face lands exactly on the finished height, which is the plane 606.3 governs.
  group.add(part(ctx, {
    id: joinId(spec.id, 'countertop'),
    name: 'Continuous countertop',
    size: [runLength + 0.06, counterThickness, counterDepth],
    position: [0, height - counterThickness / 2, backZ + 0.04],
    material: ctx.materials.finish.counter,
    truth: TRUTH.DEFAULT,
    derivations: [heightDerivation],
    note: heightCheck.compliant
      ? null
      : `Requested ${toInches(rawHeight).toFixed(2)} in exceeds the ${toInches(ADA.WORK_SURFACE_MAX_HEIGHT).toFixed(0)} in maximum; held at the maximum.`
  }));

  /* -- sink assembly ------------------------------------------------------- */

  const sinkId = joinId(spec.id, 'sink');

  // Bowl hangs from the finished surface, so its depth is measured the way the
  // standard specifies it and the counter slab is not counted twice.
  const bowlUnderside = height - bowlDepth;
  group.add(part(ctx, {
    id: joinId(sinkId, 'basin'),
    name: 'Accessible sink bowl',
    size: [sinkWidth - 0.14, bowlDepth, counterDepth - 0.14],
    position: [sinkCenter, height - bowlDepth / 2, backZ + 0.04],
    material: ctx.materials.finish.stainless,
    truth: TRUTH.DERIVED,
    derivations: [
      `${ADA_CITATIONS.SINK_MAX_BOWL_DEPTH} — modelled at ${toInches(bowlDepth).toFixed(2)} in`,
      `${ADA_CITATIONS.WORK_SURFACE_MAX_HEIGHT} — rim at ${toInches(height).toFixed(2)} in`,
      `${ADA_CITATIONS.KNEE_HEIGHT} — underside at ${toInches(bowlUnderside).toFixed(2)} in, margin ${toInches(knee.margin).toFixed(2)} in`
    ],
    note: knee.compliant
      ? `Underside at ${toInches(bowlUnderside).toFixed(2)} in clears the 27 in requirement by only ${toInches(knee.margin).toFixed(2)} in. This pairing is the compliance breakpoint — any added counter thickness or bowl depth consumes it.`
      : `Bowl underside at ${toInches(bowlUnderside).toFixed(2)} in is ${toInches(-knee.margin).toFixed(2)} in below the ${toInches(knee.required).toFixed(0)} in knee clearance requirement.`
  }));

  // Offset drain keeps the trap out of the knee space: behind the 19 in envelope.
  group.add(part(ctx, {
    id: joinId(sinkId, 'drain-offset'),
    name: 'Rear-offset drain',
    size: [0.12, 0.05, 0.12],
    position: [sinkCenter + sinkWidth * 0.22, bowlUnderside - 0.03, faceZ - kneeDepth - 0.07],
    material: ctx.materials.finish.stainless,
    truth: TRUTH.DERIVED,
    derivations: [`Drain offset behind the ${toInches(kneeDepth).toFixed(0)} in knee envelope so the trap never intrudes (2010 ADA 306.3)`]
  }));

  // Lever faucet — no tight grasping, pinching, or twisting of the wrist.
  group.add(part(ctx, {
    id: joinId(sinkId, 'faucet'),
    name: 'Lever-operated faucet',
    size: [0.05, 0.28, 0.05],
    position: [sinkCenter, height + 0.14, backZ - 0.24],
    material: ctx.materials.finish.stainless,
    truth: TRUTH.DERIVED,
    derivations: ['2010 ADA 606.4 · 309.4 — operable with one hand, no tight grasping or twisting']
  }));
  group.add(part(ctx, {
    id: joinId(sinkId, 'faucet-lever'),
    name: 'Faucet lever handle',
    size: [0.16, 0.035, 0.035],
    position: [sinkCenter + 0.08, height + 0.27, backZ - 0.24],
    material: ctx.materials.finish.stainless,
    truth: TRUTH.DERIVED,
    derivations: ['2010 ADA 309.4 — 5 lbf maximum operating force']
  }));

  // Pipe protection: screens supply and drain, set behind the knee envelope so it
  // shields the pipes without eating the clearance it exists to protect.
  const guardHeight = Math.max(bowlUnderside - ADA.TOE.HEIGHT - 0.04, 0.05);
  group.add(part(ctx, {
    id: joinId(sinkId, 'pipe-guard'),
    name: 'Insulated pipe guard panel',
    size: [sinkWidth - 0.1, guardHeight, 0.03],
    position: [sinkCenter, ADA.TOE.HEIGHT + guardHeight / 2, faceZ - kneeDepth - 0.02],
    material: ctx.materials.finish.insulation,
    truth: TRUTH.DERIVED,
    derivations: [ADA_CITATIONS.PIPE_PROTECTION]
  }));

  // Finished end panels where the cabinet run meets the void.
  for (const [side, x] of [['left', sinkStart], ['right', sinkEnd]]) {
    if (x <= runStart + 0.02 || x >= runEnd - 0.02) continue;
    group.add(part(ctx, {
      id: joinId(sinkId, `end-panel-${side}`),
      name: `Finished end panel (${side})`,
      size: [0.018, carcassHeight - toeHeight, cabinetDepth],
      position: [x, (carcassHeight - toeHeight) / 2 + toeHeight, backZ],
      material: ctx.materials.finish.cabinet,
      truth: TRUTH.DEFAULT,
      note: 'Exposed edge created by the removable base cabinet at the sink.'
    }));
  }

  /* -- clearance envelopes -------------------------------------------------- */

  // Knee envelope: 9 in to 27 in AFF, measured back from the approach face.
  // Depth is the UFAS kitchen figure (19 in), not ADA 306.3's 11 in floor.
  const kneeEnvelopeHeight = ADA.KNEE.CLEAR_HEIGHT - ADA.TOE.HEIGHT;
  group.add(clearanceVolume(ctx, {
    id: joinId(sinkId, 'knee-clearance'),
    name: 'Knee clearance envelope',
    size: [sinkWidth, kneeEnvelopeHeight, kneeDepth],
    position: [sinkCenter, ADA.TOE.HEIGHT + kneeEnvelopeHeight / 2, faceZ - kneeDepth / 2],
    citation: `${ADA_CITATIONS.KNEE_HEIGHT} · ${ADA_CITATIONS.KNEE_DEPTH}`
  }));

  group.add(clearanceVolume(ctx, {
    id: joinId(sinkId, 'toe-clearance'),
    name: 'Toe clearance envelope',
    size: [sinkWidth, ADA.TOE.HEIGHT, toeDepth],
    position: [sinkCenter, ADA.TOE.HEIGHT / 2, faceZ - toeDepth / 2],
    citation: ADA_CITATIONS.TOE
  }));

  // Up to 19 in of the 30 x 48 in clear floor space may sit under the sink.
  const underSink = Math.min(kneeDepth, ADA.CLEAR_FLOOR.MAX_UNDER_SINK);
  group.add(clearanceVolume(ctx, {
    id: joinId(sinkId, 'clear-floor-space'),
    name: 'Clear floor space',
    size: [ADA.CLEAR_FLOOR.WIDTH, 0.012, ADA.CLEAR_FLOOR.DEPTH],
    position: [sinkCenter, 0.006, faceZ - underSink + ADA.CLEAR_FLOOR.DEPTH / 2],
    citation: `${ADA_CITATIONS.CLEAR_FLOOR} · ${ADA_CITATIONS.CLEAR_FLOOR_UNDER_SINK}`,
    color: 0xc96442
  }));

  /* -- upper cabinets, stepping around the sink ---------------------------- */

  const upperHeight = spec.upperHeight ?? inches(30);
  const upperBottom = spec.upperBottom ?? height + inches(18);
  let upperIndex = 0;
  for (const bay of bays) {
    const bayLength = bay.to - bay.from;
    const count = Math.max(1, Math.round(bayLength / 0.7));
    const width = bayLength / count;
    for (let i = 0; i < count; i += 1) {
      upperIndex += 1;
      const x = bay.from + width / 2 + i * width;
      group.add(part(ctx, {
        id: joinId(spec.id, `upper-${String(upperIndex).padStart(2, '0')}`),
        name: `Upper cabinet ${String(upperIndex).padStart(2, '0')}`,
        size: [width - 0.035, upperHeight, 0.36],
        position: [x, upperBottom + upperHeight / 2, backZ - cabinetDepth / 2 + 0.18],
        material: ctx.materials.finish.cabinet,
        truth: TRUTH.DEFAULT,
        note: 'Uppers are omitted over the sink so the accessible approach is not obstructed.'
      }));
    }
  }

  /* -- appliances and peninsula -------------------------------------------- */

  for (const appliance of spec.appliances ?? []) {
    const g = appliance.geometry;
    group.add(part(ctx, {
      id: joinId(spec.id, appliance.slug),
      name: appliance.name,
      size: [g.width, g.height ?? height, g.depth],
      position: [
        g.x === 'run-end' ? runEnd + g.width / 2 + 0.04 : g.x,
        (g.height ?? height) / 2,
        backZ + (g.dz ?? 0)
      ],
      material: ctx.materials.finish.appliance,
      truth: appliance.truth ?? TRUTH.DEFAULT,
      derivations: appliance.derivations ?? [],
      note: appliance.note
    }));
  }

  group.position.set(anchor.x, 0, 0);

  ctx.registerAssembly(spec.id, {
    truth: spec.truth,
    source: spec.source,
    displayName: spec.name,
    // Measured off the geometry that was actually built, so the readout can never
    // report a figure the model does not hold.
    metrics: {
      runLength,
      requestedHeight: rawHeight,
      finishedHeight: height,
      finishedHeightIn: toInches(height),
      carcassHeight,
      counterThickness,
      counterDepth,
      cabinetDepth,
      bowlDepth,
      bowlUnderside,
      kneeWidth: sinkWidth,
      kneeDepth,
      toeDepth,
      moduleCount: moduleIndex,
      /** World-space z of the counter's front edge, for aisle checks. */
      counterFrontZ: backZ + 0.04 + counterDepth / 2,
      heightHeldAtMaximum: !heightCheck.compliant
    }
  });

  return group;
}

/* --------------------------------------------------------------- fixture --- */

export function buildFixture(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;
  const g = spec.geometry;
  group.add(part(ctx, {
    id: spec.id,
    name: spec.name,
    size: [g.width, g.height, g.depth],
    position: [g.x, (g.y ?? g.height / 2), g.z],
    rotationY: ((g.rotation ?? 0) / 360) * TWO_PI,
    material: ctx.materials.finish[spec.material ?? 'appliance'] ?? ctx.materials.finish.appliance,
    truth: spec.truth,
    source: spec.source,
    derivations: spec.derivations ?? [],
    note: spec.note
  }));
  return group;
}

/* ---------------------------------------------------------------- volume --- */

/**
 * A room we know exists but have not reconstructed. Deliberately crude: a labelled
 * void at the right footprint, so a floor plan reads as complete while the room
 * itself makes no claim at all.
 */
export function buildVolume(spec, ctx) {
  const group = new THREE.Group();
  group.name = spec.id;
  const g = spec.geometry;
  const geometry = box(ctx, [g.width, g.height, g.depth]);
  const mesh = new THREE.Mesh(geometry, ctx.materials.truth[TRUTH.UNRESOLVED]);
  mesh.name = spec.name;
  mesh.position.set(g.x ?? 0, g.height / 2, g.z ?? 0);
  const cageGeometry = ctx.cached?.(`volume-edges:${g.width}:${g.height}:${g.depth}`,
    () => new THREE.EdgesGeometry(geometry)) ?? new THREE.EdgesGeometry(geometry);
  const cage = new THREE.LineSegments(cageGeometry, ctx.materials.unresolvedCage);
  mesh.add(cage);
  ctx.register(mesh, {
    id: spec.id,
    truth: TRUTH.UNRESOLVED,
    source: null,
    derivations: [],
    displayName: spec.name,
    note: spec.note ?? 'No accepted plan anchor for this scope.'
  });
  group.add(mesh);
  return group;
}

export const GENERATORS = {
  plate: buildPlate,
  zone: buildZone,
  slab: buildSlab,
  wall: buildWall,
  opening: buildOpening,
  'casework-run': buildCaseworkRun,
  fixture: buildFixture,
  volume: buildVolume
};
