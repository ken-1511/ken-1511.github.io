import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { isValidId, parseId, roomIdOf, floorIdOf } from './ids.js';
import { TRUTH, TRUTH_DISPLAY, rollup, validateClaim } from './truth.js';
import { createMaterialLibrary, disposeMaterialLibrary } from './materials.js';
import { GENERATORS, extrudedPolygon } from './generators.js';
import {
  SHELL_MODES, SHELL_OPACITY, explodeOffsets, clipPlaneSpec, facesCamera,
  outwardNormalFor, detailFloorSet
} from './display.js';

/**
 * RoomViewer — one renderer over one composition, no shell knowledge.
 *
 * A composition is one or more room definitions placed in a shared frame: a
 * single room on its own, or a whole unit with its rooms laid out side by side.
 * The viewer owns the renderer, both cameras, controls, picking, view modes, the
 * selection helper, and the `Map<id, entry>` index that everything else joins
 * against. It touches no DOM beyond the canvas it was handed.
 *
 * Rebuild policy:
 *   - changing a dimension regenerates geometry
 *   - changing the truth overlay swaps materials only, never geometry
 *   - visibility and focus set `.visible` or move the camera, never remove or
 *     fork anything
 */

/** Which visibility layer a part type lands in when the spec does not say. */
const LAYER_BY_TYPE = {
  slab: 'structure',
  wall: 'shell',
  opening: 'shell',
  'casework-run': 'casework',
  fixture: 'fixtures',
  volume: 'volumes'
};

export const VIEW_MODES = ['model', 'plan', 'section'];

const VIEW_LABEL = {
  model: 'AXONOMETRIC STUDY',
  plan: 'ORTHOGRAPHIC PLAN',
  section: 'FRONT SECTION STUDY'
};

/**
 * Wall opacity floor per view mode — a visibility concern, not a geometry one.
 *
 * A composed unit is a nest of enclosed boxes, so in the transparent treatment
 * the shell has to sit well back or the near walls bury everything behind them.
 * Plan and section want it further back still. The shell mode chooses the
 * treatment; this is how far each view pushes it.
 */
const WALL_OPACITY = { model: 0.4, plan: 0.26, section: 0.2 };

/** Layers that stay see-through under the truth overlay, for the same reason. */
const SEE_THROUGH_LAYERS = new Set(['shell']);

export class RoomViewer {
  #canvas;
  #renderer;
  #scene;
  #root;
  #grid;
  #ground;
  #perspective;
  #ortho;
  #camera;
  #controls;
  #materials;
  #guideTruthMaterials = new Map();
  #shellTruthMaterials = new Map();
  #listeners = new Map();

  #composition = null;
  #paramsByRoom = new Map();
  #buildingRoomId = null;
  #index = new Map();
  #layers = new Map();
  #clearance = [];
  #assemblies = new Map();
  #displayNames = {};
  #roomGroups = new Map();
  #roomBounds = new Map();
  // Floors are real groups in the scene graph, not just a prefix on an address.
  // Everything floor-granular — exploding the stack, hiding a level, loading one
  // level at full detail — is then a transform or a flag on one node.
  #floorGroups = new Map();
  #floorOrder = [];
  #floorRecords = new Map();
  #coarseBounds = new Map();
  // Every drawable the build produced, with what it belongs to. One pass over
  // this decides visibility, so layer, level, cutaway and shell mode can never
  // disagree about whether something is on screen.
  #drawables = [];
  #proxies = [];
  // Per-build caches for geometry and generator-owned materials. Owned here, and
  // cleared with the scene, so a rebuild never hands out a disposed resource.
  #geometryCache = new Map();
  #resourceCache = new Map();
  #selectionHelper;
  #selectionProxy;
  #selectedId = null;
  #focusId = null;
  #truthOverlay = false;
  #mode = 'model';
  #shellMode = 'transparent';
  #hiddenLayers = new Set();
  #hiddenFloors = new Set();
  #explodeGap = 0;
  #clip = { enabled: false, axis: 'y', t: 0.55, flip: false };
  #clipPlane = new THREE.Plane();
  #detailMode = 'focused';
  #detailFloors = new Set();
  #lastDetailFloor = null;
  #cameraKey = '';
  #bounds = new THREE.Box3();
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();
  #frameSamples = [];
  #stats = { fps: 0, frameMs: 0 };
  #running = false;

  constructor(canvas) {
    this.#canvas = canvas;

    // Throws on a machine with no WebGL — the shell catches and shows the fallback.
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.shadowMap.enabled = true;
    this.#renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 0.98;

    this.#scene = new THREE.Scene();
    // Density is set for the depth of a building, not of a room. At the previous
    // 0.014 a seventy-metre model faded to background before its far end, which
    // is most of why the whole-building view read as pale.
    this.#scene.fog = new THREE.FogExp2(0xdad6cc, 0.0022);

    this.#materials = createMaterialLibrary();
    for (const [state, meta] of Object.entries(TRUTH_DISPLAY)) {
      this.#guideTruthMaterials.set(state, new THREE.MeshBasicMaterial({
        color: meta.color, transparent: true, opacity: 0.16, depthWrite: false
      }));
      this.#shellTruthMaterials.set(state, new THREE.MeshStandardMaterial({
        color: meta.color, roughness: 0.7, transparent: true, opacity: 0.17, depthWrite: false
      }));
    }

    this.#root = new THREE.Group();
    this.#root.name = 'composition-root';
    this.#scene.add(this.#root);

    // A reference plane the building sits on. Without one a stack of floating
    // plates has no datum and the eye cannot tell a setback from a shift.
    this.#ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0xb9b4a7, roughness: 1 })
    );
    this.#ground.rotation.x = -Math.PI / 2;
    this.#ground.position.y = -0.35;
    this.#ground.receiveShadow = true;
    this.#scene.add(this.#ground);

    this.#grid = new THREE.GridHelper(320, 320, 0x8d979b, 0xbdc0bb);
    this.#grid.position.y = -0.33;
    this.#grid.material.transparent = true;
    this.#grid.material.opacity = 0.32;
    this.#scene.add(this.#grid);

    // Lighting is sized for a seventy-metre building, not for one room. The
    // ambient term is deliberately well below the key: a mostly-ambient scene
    // has no shadow to read form from, which is what made the earlier building
    // look flat and washed out at whole-building scale.
    const hemisphere = new THREE.HemisphereLight(0xdfe7ea, 0x6f6558, 1.15);
    this.#scene.add(hemisphere);

    const key = new THREE.DirectionalLight(0xfff0dc, 2.6);
    key.position.set(46, 78, 40);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -80;
    key.shadow.camera.right = 80;
    key.shadow.camera.top = 80;
    key.shadow.camera.bottom = -80;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 260;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.025;
    this.#scene.add(key);

    const fill = new THREE.DirectionalLight(0xa8c4d6, 0.5);
    fill.position.set(-52, 26, -30);
    this.#scene.add(fill);

    // Apply the mode's wall opacity up front: setViewMode is not called on load,
    // so without this the shell renders at the material library's own default.
    this.#materials.finish.wall.opacity = WALL_OPACITY[this.#mode];

    this.#perspective = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
    this.#ortho = new THREE.OrthographicCamera(-6, 6, 4, -4, -100, 400);
    this.#camera = this.#perspective;
    this.#controls = this.#makeControls(this.#camera);

    // Off-scene stand-in so the BoxHelper can outline a bare Box3 — an
    // instanced part has no Object3D of its own to point at.
    this.#selectionProxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    this.#selectionProxy.visible = false;

    this.#selectionHelper = new THREE.BoxHelper(undefined, 0xc96442);
    this.#selectionHelper.material.depthTest = false;
    this.#selectionHelper.material.transparent = true;
    this.#selectionHelper.material.opacity = 0.95;
    this.#selectionHelper.renderOrder = 10;
    this.#selectionHelper.visible = false;
    this.#scene.add(this.#selectionHelper);

    this.#bindCanvas();
  }

  /* ------------------------------------------------------------- events --- */

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.#listeners.get(event)?.delete(handler);
  }

  #emit(event, payload) {
    for (const handler of this.#listeners.get(event) ?? []) handler(payload);
  }

  /* ------------------------------------------------------- composition --- */

  /**
   * Build the scene from a composition:
   *
   *   {
   *     id, name,
   *     rooms:  [{ definition, placement: { x, y, z, rotation } }],
   *     floors: [{ id, level }]        // optional; stacking order
   *   }
   *
   * Placements come from the floor registry. A room definition is authored in its
   * own local frame and knows nothing about where it sits, which is what lets the
   * same definition be viewed alone or composed into a unit.
   *
   * `floors` gives the levels their stacking order. Without it the levels present
   * in the room addresses are used in the order they appear, which is right for a
   * single-floor composition and good enough for any other.
   */
  setComposition(composition) {
    this.#composition = composition;
    this.#paramsByRoom = new Map();
    for (const { definition } of composition.rooms) {
      const values = {};
      for (const [name, spec] of Object.entries(definition.params ?? {})) values[name] = spec.default;
      this.#paramsByRoom.set(definition.id, values);
    }

    this.#floorOrder = this.#orderFloors(composition);
    this.#lastDetailFloor = this.#floorOrder[0]?.id ?? null;
    this.#focusId = null;
    this.#build();
    this.resetCamera();
    this.#emit('composition', {
      composition,
      objectCount: this.objectCount,
      floors: this.floorIds,
      detailFloors: [...this.#detailFloors],
      proxyCount: this.proxyCount
    });
  }

  /** Levels in stacking order, from the composition or from the addresses. */
  #orderFloors(composition) {
    this.#floorRecords = new Map();
    for (const record of composition.floors ?? []) this.#floorRecords.set(record.id, record);

    if (Array.isArray(composition.floors) && composition.floors.length > 0) {
      return composition.floors
        .map((entry, index) => ({ id: entry.id, level: entry.level ?? index }))
        .sort((a, b) => a.level - b.level);
    }
    const seen = [];
    for (const { definition } of composition.rooms) {
      const id = floorIdOf(definition.id);
      if (id && !seen.includes(id)) seen.push(id);
    }
    return seen.map((id, level) => ({ id, level }));
  }

  /** Single-room convenience wrapper — the composition of one, placed at origin. */
  setRoom(definition) {
    this.setComposition({
      id: definition.id,
      name: definition.name,
      rooms: [{ definition, placement: { x: 0, z: 0, rotation: 0 } }]
    });
  }

  #build() {
    const previousSelection = this.#selectedId;

    this.#disposeScene();
    this.#index = new Map();
    this.#layers = new Map();
    this.#clearance = [];
    this.#assemblies = new Map();
    this.#roomGroups = new Map();
    this.#roomBounds = new Map();
    this.#floorGroups = new Map();
    this.#drawables = [];
    this.#proxies = [];
    this.#coarseBounds = new Map();
    this.#displayNames = { ...(this.#composition.displayNames ?? {}) };

    // Decided before anything is generated: a level outside this set is drawn as
    // massing and its parts are never built at all. That is the whole of step 8 —
    // progressive loading is a decision about what to construct, not a decision
    // about what to hide after constructing it.
    this.#detailFloors = detailFloorSet({
      mode: this.#detailMode,
      focusId: this.#focusId,
      floorIds: this.floorIds,
      fallback: this.#lastDetailFloor
    });
    const detailed = [...this.#detailFloors];
    if (detailed.length === 1) this.#lastDetailFloor = detailed[0];

    const ctx = {
      materials: this.#materials,
      param: value => this.#resolveParam(value),
      register: (mesh, node) => this.#register(mesh, node),
      registerAssembly: (id, node) => this.#registerAssembly(id, node),
      geometryCache: this.#geometryCache,
      cached: (key, make) => {
        let value = this.#resourceCache.get(key);
        if (!value) {
          value = make();
          this.#resourceCache.set(key, value);
        }
        return value;
      }
    };

    const coarse = new Map();

    for (const { definition, placement } of this.#composition.rooms) {
      this.#buildingRoomId = definition.id;
      Object.assign(this.#displayNames, definition.displayNames ?? {});
      this.#displayNames[definition.id] ??= definition.name;

      const floorId = floorIdOf(definition.id);
      const floorGroup = this.#floorGroup(floorId);

      const roomGroup = new THREE.Group();
      roomGroup.name = definition.id;
      roomGroup.position.set(placement?.x ?? 0, placement?.y ?? 0, placement?.z ?? 0);
      roomGroup.rotation.y = ((placement?.rotation ?? 0) / 360) * Math.PI * 2;
      roomGroup.userData.roomId = definition.id;

      // A level outside the detail set contributes an envelope and nothing else.
      // Its parts are not generated, so they cost no geometry, no index entries
      // and no draw calls until the level is asked for.
      if (floorId && !this.#detailFloors.has(floorId)) {
        if (!coarse.has(floorId)) coarse.set(floorId, []);
        coarse.get(floorId).push({ definition, roomGroup });
        floorGroup.add(roomGroup);
        this.#roomGroups.set(definition.id, roomGroup);
        const box = this.#coarseRoomBox(definition, roomGroup);
        if (box) this.#coarseBounds.set(definition.id, box);
        continue;
      }

      for (const spec of definition.parts ?? []) {
        const generator = GENERATORS[spec.type];
        if (!generator) throw new Error(`Room "${definition.id}" uses unknown part type "${spec.type}"`);
        const group = generator(spec, ctx);
        const layer = spec.layer ?? LAYER_BY_TYPE[spec.type] ?? 'fixtures';
        group.userData.layer = layer;
        // Stamp layer, owning room and — for shell parts — the outward face, onto
        // every part the generator registered, so the overlay, the focus logic and
        // the cutaway never have to re-walk the spec tree.
        const normal = this.#shellNormal(spec);
        group.traverse(object => {
          const entry = object.userData?.id ? this.#index.get(object.userData.id) : null;
          if (entry) {
            entry.layer = layer;
            entry.roomId = definition.id;
            entry.floorId = floorId;
            if (normal) entry.outwardNormal = normal;
          }
        });
        this.#addToLayer(layer, group);
        this.#addDrawable(group, { layer, floorId, roomId: definition.id, normal });
        roomGroup.add(group);
      }

      floorGroup.add(roomGroup);
      this.#roomGroups.set(definition.id, roomGroup);
      this.#roomBounds.set(definition.id, new THREE.Box3().setFromObject(roomGroup));
    }

    this.#buildingRoomId = null;
    for (const floorId of coarse.keys()) this.#buildMassing(floorId);
    this.#instanceRepeats();
    this.#applyExplode();
    this.#recomputeBounds();
    this.#applyShellMode();
    this.#applyClipping();
    this.#applyVisibility();
    if (this.#truthOverlay) this.#applyTruthMaterials(true);

    if (previousSelection && this.#index.has(previousSelection)) this.select(previousSelection);
    else if (previousSelection) this.clearSelection();
  }

  /** The group for a level, created on first use. Levels stack in order. */
  #floorGroup(floorId) {
    const key = floorId ?? '';
    let group = this.#floorGroups.get(key);
    if (!group) {
      group = new THREE.Group();
      group.name = key || 'unplaced';
      group.userData.floorId = floorId ?? null;
      this.#floorGroups.set(key, group);
      this.#root.add(group);
    }
    return group;
  }

  /**
   * Outward normal for a shell part, in the room's own frame.
   *
   * Taken from the authored spec rather than from the built mesh: after
   * instancing the mesh no longer has a transform of its own, and the room's
   * geometry is authored about its own centre, so the spec is both the earliest
   * and the most reliable place to ask.
   */
  #shellNormal(spec) {
    if (spec.type !== 'wall' && spec.type !== 'opening') return null;
    const g = spec.geometry ?? {};
    if (!Number.isFinite(g.x) || !Number.isFinite(g.z)) return null;
    return outwardNormalFor(g.rotation ?? 0, [g.x, 0, g.z], [0, 0, 0]);
  }

  #addDrawable(object, meta) {
    this.#drawables.push({ object, ...meta });
    return object;
  }

  /**
   * Draw a level that is not loaded at full detail as its own floor plate,
   * extruded to that level's floor-to-floor height.
   *
   * Not a generic box, and not one block per unit. The whole point of the level
   * variants is that plates differ — one steps back, one has a terrace void, the
   * entry level runs wider than the residential levels above it. If the coarse
   * representation were a repeated box, the building would read as a uniform
   * stack at exactly the zoom level where its shape is the only thing visible,
   * which is the misreading this is all meant to fix.
   *
   * The block is not registered: it has no component address, it is not in the
   * index, and it is not in the object count. A massing block is a note saying
   * "this level exists and has not been built", not a component. It stays
   * pickable so a reader can click it to build that level.
   */
  #buildMassing(floorId) {
    const record = this.#floorRecords.get(floorId);
    if (!record?.plate?.polygon?.length) return;

    const floorGroup = this.#floorGroup(floorId);
    const height = record.floorToFloor?.value ?? 3.048;
    const ctx = { geometryCache: this.#geometryCache };
    const geometry = extrudedPolygon(ctx, record.plate.polygon, height, `massing:${floorId}:${height}`);

    const mesh = new THREE.Mesh(geometry, this.#materials.massing.solid);
    mesh.name = `${floorId}.massing`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // The plate extrudes downward from its own y, so lift it to sit on the slab.
    mesh.position.y = height;
    mesh.userData = { proxy: true, floorId };
    floorGroup.add(mesh);
    this.#addDrawable(mesh, { layer: 'massing', floorId, roomId: null, normal: null });

    const edges = new THREE.LineSegments(
      this.#cachedResource(`massing-edges:${floorId}:${height}`,
        () => new THREE.EdgesGeometry(geometry, 25)),
      this.#materials.massing.edges
    );
    edges.position.y = height;
    edges.userData = { proxy: true, floorId };
    floorGroup.add(edges);
    this.#addDrawable(edges, { layer: 'massing', floorId, roomId: null, normal: null });

    this.#proxies.push({ floorId, parent: floorGroup, height, plate: record.plate });
  }

  /**
   * Bounds for a room on a level that is not loaded.
   *
   * A coarse level draws one block for the whole plate, but a reader can still
   * navigate to a unit on it, and framing that unit needs a box. The unit's own
   * massing envelope supplies one without anything being drawn for it.
   */
  #coarseRoomBox(definition, roomGroup) {
    const m = definition.massing;
    if (!m) return null;
    roomGroup.updateMatrixWorld(true);
    const half = new THREE.Vector3(m.width / 2, m.height / 2, m.depth / 2);
    const centre = new THREE.Vector3(m.x ?? 0, m.height / 2, m.z ?? 0);
    return new THREE.Box3(centre.clone().sub(half), centre.clone().add(half))
      .applyMatrix4(roomGroup.matrixWorld);
  }

  #cachedGeometry(size) {
    const key = size.join(':');
    let geometry = this.#geometryCache.get(key);
    if (!geometry) {
      geometry = new THREE.BoxGeometry(...size);
      this.#geometryCache.set(key, geometry);
    }
    return geometry;
  }

  #cachedResource(key, make) {
    let value = this.#resourceCache.get(key);
    if (!value) {
      value = make();
      this.#resourceCache.set(key, value);
    }
    return value;
  }

  /**
   * Collapse repeated unit types into instanced draws.
   *
   * A stacked building is one authored type repeated, so every attribute the
   * renderer varies on — geometry, material, layer, truth state — is constant
   * across the copies. Only the transform differs, which is exactly the case
   * InstancedMesh exists for.
   *
   * This runs *after* the ordinary build rather than replacing it: ids, index
   * entries, assemblies, layers and room bounds are already correct at this
   * point, so all that changes is how the geometry reaches the GPU. Meshes with
   * children (clearance volumes carry a dashed outline) are left alone — a
   * LineSegments child cannot ride along in an InstancedMesh, and they are
   * guides that toggle off.
   */
  #instanceRepeats() {
    const groups = new Map();
    for (const { definition } of this.#composition.rooms) {
      const typeId = definition.typeId;
      if (!typeId) continue;
      const floorId = floorIdOf(definition.id);
      // Only levels that were actually built have parts to collapse.
      if (floorId && !this.#detailFloors.has(floorId)) continue;
      // Bucketed per level as well as per type, because the instanced draw is
      // parented to its level: exploding the stack, hiding a level, and loading
      // one level at full detail are then transforms on one node rather than a
      // rewrite of every instance matrix in the building.
      const key = `${floorId ?? ''}|${typeId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(definition.id);
    }

    this.#root.updateMatrixWorld(true);
    const matrix = new THREE.Matrix4();
    const clearanceBefore = this.#clearance.length;

    for (const [key, roomIds] of groups) {
      if (roomIds.length < 2) continue;
      const templateRoomId = roomIds[0];
      const floorId = key.slice(0, key.indexOf('|')) || null;
      const floorGroup = this.#floorGroup(floorId);
      const toFloorLocal = new THREE.Matrix4().copy(floorGroup.matrixWorld).invert();

      // Every part of the template, keyed by its id suffix. Meshes whose only
      // children are line overlays are eligible too: the mesh instances and the
      // lines are baked into one merged draw below.
      const lineOnly = object => object.children.every(child => child.isLineSegments);
      const templateEntries = [...this.#index.values()].filter(
        entry => entry.roomId === templateRoomId
                 && entry.object.isMesh
                 && lineOnly(entry.object)
      );

      for (const template of templateEntries) {
        const suffix = template.id.slice(templateRoomId.length);
        const members = [];
        for (const roomId of roomIds) {
          const entry = this.#index.get(`${roomId}${suffix}`);
          // A missing member means the copies are not actually identical; leave
          // the whole bucket as ordinary meshes rather than draw a partial one.
          if (!entry || !entry.object.isMesh) { members.length = 0; break; }
          members.push(entry);
        }
        if (members.length < 2) continue;

        // members[0] is the template's own entry, and the loop below repoints
        // every entry.object at the InstancedMesh — so hold the original mesh.
        const templateMesh = template.object;
        const instanced = new THREE.InstancedMesh(
          templateMesh.geometry, templateMesh.material, members.length
        );
        instanced.name = `${suffix.replace(/^\./, '')}@${members.length}`;
        instanced.castShadow = templateMesh.castShadow;
        instanced.receiveShadow = templateMesh.receiveShadow;
        instanced.userData = { selectable: true, instanced: true, idsByInstance: [] };

        members.forEach((entry, i) => {
          entry.object.updateMatrixWorld(true);
          // Held in the level's frame, not the world's: the level group carries
          // the explode offset, so an instance matrix stays valid while the stack
          // is pulled apart.
          matrix.multiplyMatrices(toFloorLocal, entry.object.matrixWorld);
          instanced.setMatrixAt(i, matrix);
          instanced.userData.idsByInstance.push(entry.id);

          entry.object.removeFromParent();
          entry.object = instanced;
          entry.instanceId = i;
          entry.instanceMatrix = matrix.clone();
          entry.instanceParent = floorGroup;
        });
        instanced.instanceMatrix.needsUpdate = true;

        const layer = template.layer ?? 'fixtures';
        floorGroup.add(instanced);
        this.#addToLayer(layer, instanced);
        this.#addDrawable(instanced, {
          layer, floorId, roomId: null, normal: template.outwardNormal ?? null
        });
        if (template.isClearance) this.#clearance.push(instanced);

        // Line overlays cannot ride in an InstancedMesh, so bake every copy into
        // a single merged LineSegments — one draw for the whole repeat rather
        // than one per unit.
        for (const child of templateMesh.children) {
          if (!child.isLineSegments) continue;
          const merged = this.#mergeLines(child, members.map(m => m.instanceMatrix));
          floorGroup.add(merged);
          this.#addToLayer(layer, merged);
          this.#addDrawable(merged, { layer, floorId, roomId: null, normal: null });
          if (template.isClearance) this.#clearance.push(merged);
        }
      }
    }

    // Guides that were folded into an instanced draw are no longer in the scene
    // graph; leaving them listed would make the guide toggle a partial no-op.
    if (this.#clearance.length !== clearanceBefore) {
      this.#clearance = this.#clearance.filter(object => object.parent !== null);
    }
  }

  /**
   * One LineSegments carrying every copy of a template's line overlay, with the
   * instance transforms baked into the vertices. Dash distances are computed
   * after the merge so the pattern runs correctly along each copy.
   */
  #mergeLines(template, matrices) {
    const source = template.geometry.getAttribute('position');
    const out = new Float32Array(source.count * 3 * matrices.length);
    const v = new THREE.Vector3();
    let offset = 0;
    for (const instanceMatrix of matrices) {
      // The child sits in the parent's local frame; compose so the copy lands
      // exactly where the un-instanced version did.
      const composed = instanceMatrix.clone().multiply(template.matrix);
      for (let i = 0; i < source.count; i += 1) {
        v.fromBufferAttribute(source, i).applyMatrix4(composed);
        out[offset++] = v.x; out[offset++] = v.y; out[offset++] = v.z;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));
    const lines = new THREE.LineSegments(geometry, template.material);
    lines.computeLineDistances();
    lines.renderOrder = template.renderOrder;
    lines.name = `${template.name || 'lines'}@${matrices.length}`;
    // Freed with the scene: the merge is per-build, unlike the shared template.
    this.#resourceCache.set(`merged-lines:${lines.name}:${this.#resourceCache.size}`, geometry);
    return lines;
  }

  /** World-space box for one index entry, instanced or not. */
  #entryBox(entry) {
    const box = new THREE.Box3();
    if (entry.instanceId == null) return box.setFromObject(entry.object);
    const geometry = entry.object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    box.copy(geometry.boundingBox).applyMatrix4(entry.instanceMatrix);
    // The instance matrix is held in its level's frame, so the level's own
    // transform — which is where the explode offset lives — still has to be
    // applied to reach world space.
    const parent = entry.instanceParent;
    if (parent) {
      parent.updateMatrixWorld(true);
      box.applyMatrix4(parent.matrixWorld);
    }
    return box;
  }

  /**
   * Recompute the framing boxes.
   *
   * Room bounds are rebuilt from the index rather than from the scene graph:
   * after instancing a room no longer owns its meshes, and after an explode the
   * box captured at build time is in the wrong place. Coarse levels have no
   * index entries at all, so their massing blocks stand in — otherwise
   * navigating to an unloaded level would frame nothing.
   */
  #recomputeBounds() {
    this.#root.updateMatrixWorld(true);
    this.#roomBounds = new Map();

    const widen = (roomId, box) => {
      if (!roomId || box.isEmpty()) return;
      const existing = this.#roomBounds.get(roomId);
      if (existing) existing.union(box);
      else this.#roomBounds.set(roomId, box);
    };

    for (const entry of this.#index.values()) widen(entry.roomId, this.#entryBox(entry));

    // Rooms on a level that is drawn coarse still need a box, so navigating to
    // one frames the right place rather than the whole building.
    for (const [roomId, box] of this.#coarseBounds) widen(roomId, box.clone());

    this.#bounds.setFromObject(this.#root);
  }

  /** World-space box for a component address, or null if it is not indexed. */
  worldBox(id) {
    const entry = this.#index.get(id);
    return entry ? this.#entryBox(entry) : null;
  }

  /**
   * Box for a component in its own room's frame.
   *
   * Anything that compares built geometry against a spec figure — the ADA aisle
   * check, the work-surface height readout — has to measure in the frame the
   * figure was authored in. Once a unit is one of thirty-six copies stacked six
   * levels up, its world coordinates carry the placement as well as the
   * dimension, and 34 in above the floor of level 5 reads as 634 in.
   *
   * Instanced or not, this undoes the room's placement rather than assuming it
   * is a pure translation, so a rotated placement measures the same as an
   * unrotated one.
   */
  localBox(id) {
    const entry = this.#index.get(id);
    if (!entry) return null;
    const box = this.#entryBox(entry);
    const group = this.#roomGroups.get(entry.roomId);
    if (!group || box.isEmpty()) return box;
    group.updateMatrixWorld(true);
    return box.applyMatrix4(new THREE.Matrix4().copy(group.matrixWorld).invert());
  }

  /** Point the BoxHelper at an arbitrary world box via an off-scene proxy. */
  #outlineBox(box) {
    if (box.isEmpty()) {
      this.#selectionHelper.visible = false;
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.#selectionProxy.position.copy(center);
    this.#selectionProxy.scale.set(
      Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4)
    );
    this.#selectionProxy.updateMatrixWorld(true);
    this.#selectionHelper.setFromObject(this.#selectionProxy);
    this.#selectionHelper.visible = true;
  }

  #disposeScene() {
    for (const child of [...this.#root.children]) {
      // Instanced draws hang off their level group now, so the per-instance
      // buffers are freed by walking the subtree rather than the top row.
      child.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
      this.#root.remove(child);
    }
    // Geometry and generator-owned materials are shared across meshes now, so
    // they are freed once from the caches that own them. Walking the graph and
    // disposing per mesh would free the same resource hundreds of times and, on
    // a partial rebuild, free one still in use.
    for (const geometry of this.#geometryCache.values()) geometry.dispose();
    this.#geometryCache.clear();
    for (const resource of this.#resourceCache.values()) resource.dispose?.();
    this.#resourceCache.clear();
    this.#selectionHelper.visible = false;
  }

  #addToLayer(layer, object) {
    if (!this.#layers.has(layer)) this.#layers.set(layer, []);
    this.#layers.get(layer).push(object);
  }

  /* --------------------------------------------------------- registration --- */

  #register(mesh, node) {
    if (!isValidId(node.id)) throw new TypeError(`Generator produced an unparseable id "${node.id}"`);
    if (this.#index.has(node.id)) throw new Error(`Duplicate component id "${node.id}"`);
    parseId(node.id);
    validateClaim(node);

    const entry = {
      id: node.id,
      object: mesh,
      truth: node.truth,
      source: node.source ?? null,
      derivations: node.derivations ?? [],
      note: node.note ?? null,
      displayName: node.displayName ?? mesh.name ?? node.id,
      isClearance: Boolean(node.isClearance || mesh.userData?.isClearance),
      finishMaterial: mesh.material,
      roomId: roomIdOf(node.id)
    };

    mesh.userData = { ...mesh.userData, selectable: true, id: node.id, isClearance: entry.isClearance };
    this.#index.set(node.id, entry);
    this.#displayNames[node.id] = entry.displayName;
    if (entry.isClearance) this.#clearance.push(mesh);
    return entry;
  }

  /**
   * A metadata node with no geometry of its own — the assembly a set of parts
   * belongs to. It is addressable and inspectable but never picked directly.
   */
  #registerAssembly(id, node) {
    if (!isValidId(id)) throw new TypeError(`Assembly id "${id}" does not parse`);
    validateClaim({ ...node, id });
    this.#assemblies.set(id, {
      id,
      truth: node.truth,
      source: node.source ?? null,
      displayName: node.displayName ?? id,
      metrics: node.metrics ?? {},
      note: node.note ?? null,
      roomId: roomIdOf(id)
    });
    this.#displayNames[id] = node.displayName ?? id;
  }

  /* ------------------------------------------------------------- params --- */

  #resolveParam(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.startsWith('$')) {
      const key = value.slice(1);
      const values = this.#paramsByRoom.get(this.#buildingRoomId) ?? {};
      if (!(key in values)) {
        throw new Error(`Room "${this.#buildingRoomId}" references undeclared parameter "${key}"`);
      }
      return values[key];
    }
    throw new TypeError(`Cannot resolve parameter value ${JSON.stringify(value)}`);
  }

  paramsFor(roomId) {
    return { ...(this.#paramsByRoom.get(roomId) ?? {}) };
  }

  paramSpecsFor(roomId) {
    return this.#composition?.rooms.find(r => r.definition.id === roomId)?.definition.params ?? {};
  }

  /**
   * Set a parameter on one room and regenerate. Values are stored as requested —
   * governing maxima are enforced by the generator, which reports the overage
   * rather than quietly rewriting the input.
   */
  setParam(roomId, name, value) {
    const values = this.#paramsByRoom.get(roomId);
    if (!values || !(name in values)) throw new Error(`Unknown parameter "${name}" on ${roomId}`);
    values[name] = value;
    this.#build();
    this.#emit('rebuild', { roomId, objectCount: this.objectCount });
  }

  /* -------------------------------------------------------------- truth --- */

  get truthOverlay() {
    return this.#truthOverlay;
  }

  /**
   * Recolour by evidence state. This is a material swap over the existing meshes:
   * no geometry is created, destroyed, or re-parented, so the object count is
   * identical on both sides of the switch.
   */
  setTruthOverlay(on) {
    this.#truthOverlay = Boolean(on);
    this.#applyTruthMaterials(this.#truthOverlay);
    this.#emit('truth-overlay', { on: this.#truthOverlay, objectCount: this.objectCount });
  }

  #applyTruthMaterials(on) {
    // Massing carries no address, so it is not in the index — but it is a
    // designer default and has to recolour with everything else, or the overlay
    // would leave the coarse levels reading as a fifth state.
    for (const drawable of this.#drawables) {
      if (drawable.layer !== 'massing' || !drawable.object.isMesh) continue;
      drawable.object.material = on ? this.#materials.massing.truth : this.#materials.massing.solid;
    }

    for (const entry of this.#index.values()) {
      if (!on) {
        entry.object.material = entry.finishMaterial;
      } else if (entry.isClearance) {
        entry.object.material = this.#guideTruthMaterials.get(entry.truth) ?? this.#guideTruthMaterials.get(TRUTH.DERIVED);
      } else if (SEE_THROUGH_LAYERS.has(entry.layer)) {
        entry.object.material = this.#shellTruthMaterials.get(entry.truth) ?? this.#shellTruthMaterials.get(TRUTH.UNRESOLVED);
      } else {
        entry.object.material = this.#materials.truth[entry.truth] ?? this.#materials.truth[TRUTH.UNRESOLVED];
      }
    }
  }

  /* -------------------------------------------------------- visibility --- */

  /**
   * Every visibility rule, resolved in one place.
   *
   * Layer, level, shell treatment and cutaway all decide whether the same object
   * is drawn, and they used to each write `.visible` directly. Two of them
   * disagreeing meant whichever ran last won, which is how a hidden layer came
   * back on its own after an orbit. Now they are inputs and this is the only
   * writer, so the answer is a function of the state rather than of the order
   * the user clicked things in.
   *
   * Nothing here removes an object, re-parents it, or touches a truth state.
   */
  #applyVisibility() {
    const cameraPosition = [this.#camera.position.x, this.#camera.position.y, this.#camera.position.z];
    const cutaway = this.#shellMode === 'cutaway' && this.#mode === 'model';

    for (const drawable of this.#drawables) {
      const { object, layer, floorId, normal } = drawable;
      let visible = !this.#hiddenLayers.has(layer);
      if (visible && floorId && this.#hiddenFloors.has(floorId)) visible = false;
      if (visible && layer === 'shell' && this.#shellMode === 'hidden') visible = false;
      if (visible && cutaway && layer === 'shell' && normal) {
        const center = drawable.center ?? this.#drawableCenter(drawable);
        visible = !facesCamera(normal, center, cameraPosition);
      }
      object.visible = visible;
    }

    // Guides are a layer of their own that cuts across the others, so they are
    // resolved after: a clearance envelope inside a hidden level stays hidden.
    if (this.#hiddenLayers.has('guides')) {
      for (const mesh of this.#clearance) mesh.visible = false;
    }
  }

  /** World centre of a drawable, cached per build — cutaway asks every frame. */
  #drawableCenter(drawable) {
    const box = new THREE.Box3().setFromObject(drawable.object);
    const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    drawable.center = [centre.x, centre.y, centre.z];
    return drawable.center;
  }

  setLayerVisible(layer, visible) {
    if (layer === 'grid') {
      this.#grid.visible = visible;
      return;
    }
    if (visible) this.#hiddenLayers.delete(layer);
    else this.#hiddenLayers.add(layer);
    this.#applyVisibility();
    this.#emit('layers', { hidden: [...this.#hiddenLayers] });
  }

  isLayerVisible(layer) {
    return layer === 'grid' ? this.#grid.visible : !this.#hiddenLayers.has(layer);
  }

  /**
   * Is this component actually on screen?
   *
   * Visibility is applied to whichever node owns the drawable — a part group for
   * an ordinary mesh, the instanced draw itself for a repeated one — so reading
   * `.visible` off the mesh answers a different question depending on how the
   * part happened to be built. This walks to the root and gives the answer that
   * matters, which is the one a reader sees.
   */
  isVisible(id) {
    const entry = this.#index.get(id);
    return entry ? this.#effectivelyVisible(entry.object) : false;
  }

  /**
   * Is this node drawn, accounting for every ancestor?
   *
   * `.visible` is set on whichever node owns the drawable — a part group for an
   * ordinary mesh, the instanced draw itself for a repeated one, the level group
   * for a hidden level. Reading the flag off the mesh answers a different
   * question depending on how the part happened to be built, and three's
   * raycaster does not check visibility at all, so this is also what keeps a
   * hidden level from being clickable.
   */
  #effectivelyVisible(object) {
    let node = object;
    while (node) {
      if (!node.visible) return false;
      if (node === this.#root) break;
      node = node.parent;
    }
    return true;
  }

  get layerNames() {
    return [...this.#layers.keys()];
  }

  /* ------------------------------------------------------------- levels --- */

  get floorIds() {
    return this.#floorOrder.map(entry => entry.id);
  }

  get floorOrder() {
    return this.#floorOrder.map(entry => ({ ...entry }));
  }

  /**
   * Show or hide a whole level.
   *
   * Hiding is a display state, not a deletion: the level keeps its geometry, its
   * addresses stay resolvable, and its components stay in the object count. A
   * reader who hides level 4 has not been told the building has five floors.
   */
  setFloorVisible(floorId, visible) {
    if (visible) this.#hiddenFloors.delete(floorId);
    else this.#hiddenFloors.add(floorId);
    this.#applyVisibility();
    this.#emit('levels', { hidden: [...this.#hiddenFloors] });
  }

  isFloorVisible(floorId) {
    return !this.#hiddenFloors.has(floorId);
  }

  get hiddenFloors() {
    return [...this.#hiddenFloors];
  }

  /* ------------------------------------------------------------ explode --- */

  get explodeGap() {
    return this.#explodeGap;
  }

  /**
   * Pull the stack apart vertically by `gap` metres per level.
   *
   * The offset goes on the level group, so no geometry moves relative to
   * anything inside its own level and no instance matrix is rewritten. The
   * lowest level stays where it was, which keeps the ground plane honest.
   */
  setExplode(gap) {
    this.#explodeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
    this.#applyExplode();
    this.#recomputeBounds();
    // The section plane is positioned across the model's extent, and pulling the
    // stack apart changes that extent — so it has to be re-derived, or the cut
    // stays where the collapsed model used to be.
    this.#applyClipping();
    // Centres move with the levels, so a cached cutaway centre is stale.
    for (const drawable of this.#drawables) drawable.center = null;
    this.#applyVisibility();
    this.#emit('explode', { gap: this.#explodeGap });
  }

  #applyExplode() {
    const offsets = explodeOffsets(this.#floorOrder, this.#explodeGap);
    for (const [key, group] of this.#floorGroups) {
      group.position.y = offsets.get(key) ?? 0;
    }
    this.#root.updateMatrixWorld(true);
  }

  /* -------------------------------------------------------------- shell --- */

  get shellMode() {
    return this.#shellMode;
  }

  /**
   * How the building shell is treated: solid, transparent, cut away, or hidden.
   *
   * Transparent and hidden are material and visibility settings. Cutaway drops
   * the walls the camera is outside of, so interiors read at full contrast from
   * any angle — it only applies in the 3D study, since a plan is already a cut.
   */
  setShellMode(mode) {
    if (!SHELL_MODES.includes(mode)) throw new Error(`Unknown shell mode "${mode}"`);
    this.#shellMode = mode;
    this.#applyShellMode();
    this.#applyVisibility();
    this.#emit('shell', { mode });
  }

  #applyShellMode() {
    const opacity = this.#shellMode === 'transparent' || this.#shellMode === 'cutaway'
      ? WALL_OPACITY[this.#mode]
      : SHELL_OPACITY[this.#shellMode];
    const wall = this.#materials.finish.wall;
    wall.opacity = this.#shellMode === 'solid' ? 0.92 : opacity;
    wall.transparent = wall.opacity < 1;
    wall.depthWrite = this.#shellMode === 'solid';
  }

  /* ----------------------------------------------------------- clipping --- */

  get clipping() {
    return { ...this.#clip };
  }

  /**
   * A section plane across the whole scene.
   *
   * Clipping removes fragments at draw time. It creates nothing and destroys
   * nothing: the index, the object count and every truth state are identical
   * with the plane on and off, which is what stops a cut view from reading as a
   * different model.
   */
  setClipping(partial = {}) {
    this.#clip = { ...this.#clip, ...partial };
    this.#applyClipping();
    this.#emit('clip', { ...this.#clip });
  }

  #applyClipping() {
    if (!this.#clip.enabled || this.#bounds.isEmpty()) {
      this.#renderer.clippingPlanes = [];
      return;
    }
    const spec = clipPlaneSpec(this.#clip.axis, this.#clip.t, this.#bounds, { flip: this.#clip.flip });
    this.#clipPlane.set(new THREE.Vector3(...spec.normal), spec.constant);
    this.#renderer.clippingPlanes = [this.#clipPlane];
  }

  /* --------------------------------------------------- progressive detail --- */

  get detailMode() {
    return this.#detailMode;
  }

  get detailFloors() {
    return [...this.#detailFloors];
  }

  get proxyCount() {
    return this.#proxies.length;
  }

  /** `focused` builds only the level in view; `all` builds the whole stack. */
  setDetailMode(mode) {
    if (mode !== 'focused' && mode !== 'all') throw new Error(`Unknown detail mode "${mode}"`);
    if (mode === this.#detailMode) return;
    this.#detailMode = mode;
    this.#build();
    this.#emit('detail', {
      mode, detailFloors: this.detailFloors, objectCount: this.objectCount, proxyCount: this.proxyCount
    });
  }

  /* ------------------------------------------------------------ picking --- */

  #bindCanvas() {
    this.#canvas.addEventListener('click', event => {
      const hit = this.#hitTest(event);
      if (!hit) {
        this.clearSelection();
        return;
      }
      // A massing block is not a component and cannot be selected as one. It
      // stands for a level that has not been built, so clicking it is a request
      // to build that level.
      if (hit.kind === 'proxy') this.#emit('proxy-pick', { floorId: hit.floorId, roomId: hit.id });
      else this.select(hit.id);
    });

    this.#canvas.addEventListener('pointermove', event => {
      const hit = this.#hitTest(event);
      const rect = this.#canvas.getBoundingClientRect();
      if (!hit) {
        this.#canvas.style.cursor = 'grab';
        this.#emit('hover', null);
        return;
      }
      this.#canvas.style.cursor = 'pointer';
      this.#emit('hover', {
        kind: hit.kind,
        entry: hit.kind === 'proxy' ? null : this.#index.get(hit.id),
        id: hit.id,
        floorId: hit.floorId ?? null,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      });
    });

    this.#canvas.addEventListener('pointerleave', () => this.#emit('hover', null));
  }

  /**
   * Nearest thing under the pointer, as `{ kind, id, floorId }`.
   *
   * Three cases have to resolve to an address: a plain mesh carries its own, an
   * instanced draw reports which copy was hit, and a massing block reports the
   * unit it stands for. Only the first two are components.
   */
  #hitTest(event) {
    const rect = this.#canvas.getBoundingClientRect();
    this.#pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);

    for (const hit of this.#raycaster.intersectObjects(this.#root.children, true)) {
      const data = hit.object.userData;
      // Effective visibility, not the mesh's own flag: a hidden level hides its
      // parts by hiding the level group, and something a reader cannot see must
      // not be selectable.
      if (!data || !this.#effectivelyVisible(hit.object)) continue;

      // A massing block stands for a whole level, so that is what it resolves to.
      if (data.proxy) {
        if (data.floorId) return { kind: 'proxy', id: data.floorId, floorId: data.floorId, distance: hit.distance };
        continue;
      }
      if (!data.selectable) continue;

      const id = data.instanced ? data.idsByInstance[hit.instanceId] : data.id;
      if (id && this.#index.has(id)) {
        return { kind: 'part', id, floorId: this.#index.get(id).floorId ?? null, distance: hit.distance };
      }
    }
    return undefined;
  }

  /* ---------------------------------------------------------- selection --- */

  get index() {
    return this.#index;
  }

  get assemblies() {
    return this.#assemblies;
  }

  get displayNames() {
    return { ...this.#displayNames };
  }

  get roomIds() {
    return [...this.#roomGroups.keys()];
  }

  entry(id) {
    return this.#index.get(id) ?? this.#assemblies.get(id) ?? null;
  }

  /** Rolled-up state for a scope: every registered descendant of `id`. */
  rollupFor(id) {
    const states = [];
    for (const entry of this.#index.values()) {
      if (entry.id === id || entry.id.startsWith(`${id}.`)) states.push(entry.truth);
    }
    return states.length ? rollup(states) : null;
  }

  /** Solid, selectable meshes. Clearance envelopes are guides and are excluded. */
  countFor(scopeId = null) {
    let count = 0;
    for (const entry of this.#index.values()) {
      if (entry.isClearance) continue;
      if (scopeId && entry.id !== scopeId && !entry.id.startsWith(`${scopeId}.`)) continue;
      count += 1;
    }
    return count;
  }

  get objectCount() {
    return this.countFor(null);
  }

  get guideCount() {
    // Counted from the index, not the scene graph: instancing collapses many
    // clearance volumes into a few draws, and the readout means "how many
    // clearances does this model assert", not "how many objects render".
    let count = 0;
    for (const entry of this.#index.values()) if (entry.isClearance) count += 1;
    return count;
  }

  select(id) {
    const entry = this.#index.get(id);
    if (entry) {
      this.#selectedId = id;
      this.#outlineBox(this.#entryBox(entry));
      this.#emit('select', { id, entry, kind: 'part' });
      return entry;
    }

    // Assemblies and rooms have no mesh of their own: outline their whole group.
    const scope = this.#assemblies.get(id) ?? (this.#roomGroups.has(id) ? { id, kind: 'room' } : null);
    if (!scope) return null;
    this.#selectedId = id;
    // Room bounds were captured before instancing, when the room still had a
    // group of its own; an assembly is outlined from the union of its parts.
    const bounds = this.#roomBounds.get(id);
    if (bounds && !bounds.isEmpty()) {
      this.#outlineBox(bounds.clone());
    } else {
      const union = new THREE.Box3();
      for (const entry of this.#index.values()) {
        if (entry.id === id || entry.id.startsWith(`${id}.`)) union.union(this.#entryBox(entry));
      }
      this.#outlineBox(union);
    }
    this.#emit('select', { id, entry: scope, kind: this.#roomGroups.has(id) ? 'room' : 'assembly' });
    return scope;
  }

  clearSelection() {
    this.#selectedId = null;
    this.#selectionHelper.visible = false;
    this.#emit('select', null);
  }

  get selectedId() {
    return this.#selectedId;
  }

  /* ---------------------------------------------------------------- focus --- */

  get focusId() {
    return this.#focusId;
  }

  /** True when any room in the composition sits under `scopeId`. */
  #scopeHasRooms(scopeId) {
    for (const id of this.#roomGroups.keys()) {
      if (id.startsWith(`${scopeId}.`)) return true;
    }
    return false;
  }

  /**
   * Frame a scope: one room, an intermediate scope such as a floor, or the whole
   * composition when given null. Floors are not room groups — they are a prefix
   * over them — so anything that is not a room falls through to a union of the
   * rooms beneath it.
   *
   * This is also where progressive loading is triggered. Focusing something on a
   * level that is currently drawn as massing builds that level, and lets the one
   * it replaced fall back to massing. The rebuild is skipped when the detail set
   * would not change, so orbiting around within a level costs nothing.
   */
  focus(scopeId) {
    if (scopeId && (this.#roomGroups.has(scopeId) || this.#scopeHasRooms(scopeId))) {
      this.#focusId = scopeId;
    } else {
      this.#focusId = null;
    }

    const wanted = detailFloorSet({
      mode: this.#detailMode,
      focusId: this.#focusId,
      floorIds: this.floorIds,
      fallback: this.#lastDetailFloor
    });
    const changed = wanted.size !== this.#detailFloors.size
      || [...wanted].some(id => !this.#detailFloors.has(id));

    if (changed) {
      this.#build();
      this.#emit('detail', {
        mode: this.#detailMode,
        detailFloors: this.detailFloors,
        objectCount: this.objectCount,
        proxyCount: this.proxyCount
      });
    }

    this.resetCamera();
    this.#emit('focus', { roomId: this.#focusId, detailFloors: this.detailFloors });
  }

  /* --------------------------------------------------------------- view --- */

  get mode() {
    return this.#mode;
  }

  /** The active camera. Exposed so the cutaway can be checked without a GPU. */
  get camera() {
    return this.#camera;
  }

  /**
   * The composition's scene graph. Read-only by convention: the viewer owns what
   * is in it, and anything that mutates it from outside will be discarded on the
   * next rebuild. Exposed so what is actually drawn can be counted and inspected
   * without a renderer.
   */
  get root() {
    return this.#root;
  }

  get viewLabel() {
    return VIEW_LABEL[this.#mode];
  }

  setViewMode(mode) {
    if (!VIEW_MODES.includes(mode)) throw new Error(`Unknown view mode "${mode}"`);
    this.#mode = mode;
    // Cast shadows in the 3D study only. In plan and section they read as smears
    // across the drawing rather than as depth.
    this.#renderer.shadowMap.enabled = mode === 'model';
    this.#camera = mode === 'model' ? this.#perspective : this.#ortho;
    // The shell treatment is per view: how far back a transparent wall sits
    // differs between a 3D study and a plan, and a cutaway means nothing in a
    // plan, which is already a cut.
    this.#applyShellMode();
    this.#applyVisibility();
    this.resetCamera();
    this.#emit('view', { mode, label: this.viewLabel });
  }

  #activeBounds() {
    if (!this.#focusId) return this.#bounds;
    const room = this.#roomBounds.get(this.#focusId);
    if (room && !room.isEmpty()) return room;
    const union = new THREE.Box3();
    for (const [id, bounds] of this.#roomBounds) {
      if (id === this.#focusId || id.startsWith(`${this.#focusId}.`)) union.union(bounds);
    }
    return union.isEmpty() ? this.#bounds : union;
  }

  /** Frame the focused room, or the whole composition, in the active camera. */
  resetCamera() {
    if (this.#root.children.length === 0) return;
    const bounds = this.#activeBounds();
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());

    this.#controls?.dispose();

    if (this.#mode === 'model') {
      // Fit the bounding sphere, so a wide unit and a compact room both frame
      // sensibly. On a portrait viewport the horizontal FOV is the tighter of
      // the two, so fit against whichever is smaller or a phone crops the width.
      this.#perspective.fov = 38;
      const aspect = Math.max(this.#canvas.clientWidth, 1) / Math.max(this.#canvas.clientHeight, 1);
      const fovV = (this.#perspective.fov * Math.PI) / 180;
      const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
      const radius = size.length() / 2 || 1;
      const distance = (radius / Math.sin(Math.min(fovV, fovH) / 2)) * 0.78;
      const direction = new THREE.Vector3(0.62, 0.74, 0.66).normalize();
      this.#perspective.position.copy(center).addScaledVector(direction, distance);
      this.#perspective.updateProjectionMatrix();
    } else if (this.#mode === 'plan') {
      this.#ortho.position.set(center.x, center.y + Math.max(size.y, 4) * 6, center.z + 0.001);
      this.#ortho.up.set(0, 0, -1);
    } else {
      this.#ortho.position.set(center.x, center.y, center.z + Math.max(size.z, 4) * 6);
      this.#ortho.up.set(0, 1, 0);
    }

    this.#controls = this.#makeControls(this.#camera);
    this.#controls.target.copy(this.#mode === 'plan' ? new THREE.Vector3(center.x, 0, center.z) : center);
    this.#camera.lookAt(this.#controls.target);
    this.#controls.update();
    this.resize();
  }

  #makeControls(camera) {
    const controls = new OrbitControls(camera, this.#canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controls.minDistance = 1.5;
    controls.maxDistance = 140;
    if (this.#mode === 'model') controls.maxPolarAngle = Math.PI * 0.495;
    controls.update();
    return controls;
  }

  resize() {
    const width = Math.max(this.#canvas.clientWidth, 1);
    const height = Math.max(this.#canvas.clientHeight, 1);
    this.#renderer.setSize(width, height, false);
    this.#perspective.aspect = width / height;
    this.#perspective.updateProjectionMatrix();

    // Fit the footprint (plan) or the elevation (section) on *both* axes —
    // fitting only the vertical one crops anything wider than the canvas.
    const size = this.#activeBounds().getSize(new THREE.Vector3());
    const margin = 1.16;
    const needWidth = Math.max(size.x, 1) * margin;
    const needHeight = Math.max(this.#mode === 'section' ? size.y : size.z, 1) * margin;
    const aspect = width / height;
    const viewHeight = Math.max(needHeight, needWidth / aspect);
    const viewWidth = viewHeight * aspect;

    this.#ortho.left = -viewWidth / 2;
    this.#ortho.right = viewWidth / 2;
    this.#ortho.top = viewHeight / 2;
    this.#ortho.bottom = -viewHeight / 2;
    this.#ortho.updateProjectionMatrix();
  }

  /* --------------------------------------------------------------- loop --- */

  get stats() {
    return { ...this.#stats };
  }

  /** What the GPU was actually asked to do on the last frame. */
  get renderInfo() {
    const r = this.#renderer.info.render;
    return { calls: r.calls, triangles: r.triangles, lines: r.lines, points: r.points };
  }

  get rendererLabel() {
    return `WEBGL · ${this.#renderer.capabilities.isWebGL2 ? 'WEBGL 2' : 'WEBGL 1'}`;
  }

  /**
   * Re-resolve the cutaway when the camera has actually moved.
   *
   * Which walls are in the way changes as the model is orbited, so this has to
   * be a per-frame question. Recomputing visibility every frame regardless would
   * touch every drawable sixty times a second to change nothing, so the camera
   * position is rounded to a centimetre and compared: an idle scene does no work
   * at all, and a drag re-resolves once per frame.
   */
  #refreshCutaway() {
    if (this.#shellMode !== 'cutaway' || this.#mode !== 'model') return;
    const p = this.#camera.position;
    const key = `${p.x.toFixed(2)}:${p.y.toFixed(2)}:${p.z.toFixed(2)}`;
    if (key === this.#cameraKey) return;
    this.#cameraKey = key;
    this.#applyVisibility();
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    let last = performance.now();
    let statsAt = last;
    const tick = now => {
      if (!this.#running) return;
      const delta = Math.min((now - last) / 1000, 0.05);
      this.#frameSamples.push(now - last);
      last = now;
      this.#controls.update(delta);
      this.#refreshCutaway();
      if (this.#selectionHelper.visible) this.#selectionHelper.update();
      this.#renderer.render(this.#scene, this.#camera);

      if (now - statsAt >= 500 && this.#frameSamples.length) {
        const mean = this.#frameSamples.reduce((a, b) => a + b, 0) / this.#frameSamples.length;
        this.#stats = { frameMs: mean, fps: mean > 0 ? 1000 / mean : 0 };
        this.#frameSamples.length = 0;
        statsAt = now;
        this.#emit('stats', this.stats);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  dispose() {
    this.#running = false;
    this.#disposeScene();
    this.#controls?.dispose();
    disposeMaterialLibrary(this.#materials);
    for (const material of this.#guideTruthMaterials.values()) material.dispose();
    for (const material of this.#shellTruthMaterials.values()) material.dispose();
    this.#renderer.dispose();
  }
}
