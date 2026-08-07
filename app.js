import { RoomViewer } from './src/room-viewer.js';
import { Router } from './src/router.js';
import { breadcrumb, parseId, roomIdOf, floorIdOf } from './src/ids.js';
import { composeBuilding } from './src/building.js';
import { createSelectionStore, resolveScope, assertCoherent, SCOPE } from './src/selection.js';
import { TRUTH, TRUTH_DISPLAY, TRUTH_ORDER, display } from './src/truth.js';
import { assessSink, toInches } from './src/ada.js';

/**
 * Shell bootstrap.
 *
 * Router + registries decide what to build; RoomViewer builds it; this file wires
 * the panels around it. The whole unit is composed at once from the floor
 * registry's placements — a room route focuses a room within that unit rather
 * than loading it in isolation.
 */

const $ = selector => document.querySelector(selector);

const canvas = $('#threeCanvas');
const loadingState = $('#loadingState');
const rendererState = $('#rendererState');
const fallback = $('#webglFallback');
const tooltip = $('#objectTooltip');
const srStatus = $('#srStatus');
const routeError = $('#routeError');

/* ------------------------------------------------------------------ boot --- */

let viewer;
try {
  viewer = new RoomViewer(canvas);
} catch (error) {
  fallback.hidden = false;
  rendererState.textContent = 'WEBGL UNAVAILABLE';
  loadingState.classList.add('done');
  console.warn('WebGL unavailable:', error);
}

let manifest = null;
let floor = null;
let rooms = new Map();

// The only selection state in this file. There is deliberately no separate
// "focused level" or "focused room" variable: those are derivations of one
// address, and keeping them apart is what let the interface contradict itself.
let selection = null;

const router = new Router({ onRoute: route => applyRoute(route) });

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

/**
 * Expand a building spec into the same `{ definition, placement }` composition the
 * viewer has always taken. A unit is an instance of an authored type, so the
 * scope the shell navigates is the building rather than a single floor registry —
 * but its shape is identical, and every panel downstream is unchanged.
 */
async function loadBuilding(path) {
  const spec = await loadJson(path);
  const types = new Map();
  for (const [id, typePath] of Object.entries(spec.types ?? {})) {
    types.set(id, await loadJson(typePath));
  }
  const variants = new Map();
  for (const [id, variantPath] of Object.entries(spec.variants ?? {})) {
    variants.set(id, await loadJson(variantPath));
  }
  const building = composeBuilding(spec, variants, types);
  for (const { definition } of building.rooms) rooms.set(definition.id, definition);

  // Records are derived from the composition rather than authored, so the
  // navigator stays in step with the spec instead of drifting from it.
  manifest = {
    ...manifest,
    displayNames: { ...manifest.displayNames, ...building.displayNames },
    rooms: building.rooms.map(({ definition }, i) => ({
      id: definition.id,
      floor: floorIdOf(definition.id),
      name: definition.name,
      shortName: definition.shortName,
      truth: definition.truth,
      kind: definition.kind ?? 'unit',
      bedrooms: definition.bedrooms ?? null,
      accessibility: definition.accessibility ?? null,
      sourceRef: null,
      sourceLabel: null,
      order: i + 1
    }))
  };

  floor = {
    id: building.id,
    name: building.name,
    displayName: building.name,
    truth: building.truth,
    floors: building.floors,
    rooms: building.rooms.map(({ definition, placement }) => ({ id: definition.id, placement })),
    composition: { note: spec._comment ?? null }
  };
  return building;
}

async function boot() {
  manifest = await loadJson('rooms/manifest.json');

  let composed;
  if (manifest.building) {
    const building = await loadBuilding(manifest.building);
    composed = building.rooms;
  } else {
    floor = await loadJson(manifest.floor ?? 'floors/floor-02.json');
    const definitions = await Promise.all(floor.rooms.map(entry => loadJson(entry.ref)));
    definitions.forEach(definition => rooms.set(definition.id, definition));
    composed = floor.rooms.map(entry => ({
      definition: rooms.get(entry.id),
      placement: entry.placement
    }));
  }

  renderTruthLegend();

  if (viewer) {
    wireViewer();
    viewer.setComposition({
      id: floor.id,
      name: floor.displayName ?? floor.name,
      displayNames: { ...manifest.displayNames, [floor.id]: floor.displayName ?? floor.name },
      // Stacking order, each level's own plate and its floor-to-floor height.
      // The viewer needs all three: the order to pull the stack apart, the plate
      // to draw that level's massing from its real outline rather than a generic
      // box, and the height to extrude it to.
      floors: floor.floors?.map(level => ({
        id: level.id,
        level: level.level,
        plate: level.plate,
        floorToFloor: level.floorToFloor
      })),
      rooms: composed
    });
    viewer.start();
    rendererState.textContent = viewer.rendererLabel;
  }

  // One store, created once the model exists, wired so that every change runs
  // the same render pass no matter what caused it — a route, a click in the
  // canvas, a click in the tree, or a rebuild.
  selection = createSelectionStore({
    buildingId: floor.id,
    floors: floor.floors ?? [],
    rooms,
    displayNames: { ...manifest.displayNames, [floor.id]: floor.displayName ?? floor.name },
    entryOf: id => viewer?.entry(id) ?? null
  }, { onChange: (scope, meta) => renderSelection(scope, meta) });

  loadingState.classList.add('done');
  router.start();
}

/* ----------------------------------------------------------------- route --- */

function roomRecord(id) {
  return manifest.rooms.find(entry => entry.id === id) ?? null;
}

/**
 * A route is a selection. It sets one address; everything else derives.
 *
 * Progressive loading means the geometry for the target level may not exist yet,
 * so the order matters: focus first — which builds the level if it is coarse —
 * then resolve and render, so every panel sees the model that is actually there.
 */
function applyRoute(route) {
  if (!route.ok) {
    showRouteError('Unknown address',
      `"#${route.raw}" is not a component address. Addresses look like `
      + '#/building-a/floor-04 or #/building-a/floor-04/unit-0401.');
    return;
  }
  if (route.empty) {
    router.navigate(manifest.default ?? floor.id, { replace: true });
    return;
  }

  if (!isKnownScope(route.id)) {
    const levels = floor.floors?.map(f => f.id).join(', ') ?? '';
    showRouteError('No such scope',
      `"${route.id}" is not in this building. Known scopes: ${floor.id}, ${levels}, `
      + `and ${rooms.size} rooms across ${floor.floors?.length ?? 1} levels.`);
    return;
  }

  hideRouteError();
  select(route.id, { from: 'route' });
}

/** Does this address name something the model actually holds? */
function isKnownScope(id) {
  if (id === floor.id) return true;
  if (floor.floors?.some(level => level.id === id)) return true;
  const roomId = roomIdOf(id);
  if (!roomId || !rooms.has(roomId)) return false;
  if (id === roomId) return true;
  // A component address only resolves once its level is built. Accept it if the
  // room exists; the render pass reports it if the component does not.
  return true;
}

/* ------------------------------------------------------------- selection --- */

/**
 * The single write path for "what is selected".
 *
 * Nothing else in this file may set a level, a unit, a component or a camera
 * target. They are all the same fact, they are all derived here, and every
 * consumer below renders from the one resolved object it is handed.
 */
let applyingSelection = false;

function select(id, meta = {}) {
  if (!selection) return null;

  // Building the target level first: a component on a coarse level has no entry
  // until its level exists, and a panel that resolved before the build would
  // render the state from before it.
  //
  // focus() may rebuild, which fires `detail`. That handler re-renders from the
  // store — which still holds the *previous* address at this point. Suppressing
  // it here is what stops a half-applied state reaching the screen; the render
  // below covers the same ground with the new address anyway.
  const wanted = selection.resolve(id);
  applyingSelection = true;
  try {
    viewer?.focus(wanted.focusId);
  } finally {
    applyingSelection = false;
  }

  return selection.set(id, meta);
}

/** Everything that renders from a selection, in one pass, in one order. */
function renderSelection(scope, meta = {}) {
  if (meta.from !== 'viewer') syncViewerSelection(scope);

  renderInspector(scope);
  renderDimensions(scope.roomId);
  renderAda(scope.roomId);
  renderRoomList(scope);
  renderModelTree(scope);
  renderFloorComposition(scope);
  renderLevelToggles(scope);
  highlightTree(scope.componentId);
  setPath(scope);
  updateCounts(scope);

  if (meta.from !== 'route') router.replaceSilent(scope.id);

  srStatus.textContent = announce(scope);
  checkCoherence(scope);
}

/** Point the viewer's own selection at the scope, without echoing back. */
function syncViewerSelection(scope) {
  if (!viewer) return;
  if (scope.kind === SCOPE.BUILDING || scope.kind === SCOPE.LEVEL) {
    viewer.clearSelection();
    return;
  }
  if (viewer.selectedId !== scope.id) viewer.select(scope.id);
}

function announce(scope) {
  const where = scope.levelLabel ? ` on ${scope.levelLabel}` : '';
  if (scope.kind === SCOPE.BUILDING) {
    return `${scope.title}. Whole building, ${floor.floors?.length ?? 0} levels, `
      + `${viewer?.objectCount ?? 0} components built.`;
  }
  if (scope.kind === SCOPE.LEVEL) {
    const level = scope.level;
    return `${scope.title}. ${level?.role ?? ''} level, ${level?.unitCount ?? 0} units, `
      + `plate ${Math.round(level?.plate.area ?? 0)} square metres. `
      + `${viewer?.countFor(scope.id) ?? 0} components built.`;
  }
  return `${scope.title}${where}. ${display(scope.entry?.truth ?? scope.room?.truth ?? TRUTH.UNRESOLVED).label}.`;
}

/**
 * Development coherence check.
 *
 * Reads the strings that are actually in the DOM and compares them against the
 * scope they were supposed to be rendered from. This is the assertion that a
 * tooltip saying Level 07 while the inspector says Level 06 can never come back.
 */
function checkCoherence(scope) {
  const rendered = {
    'inspector heading': $('#selectedName').textContent,
    'inspector kind': $('#selectedKind').textContent,
    'selection path': $('#selectionPath').textContent,
    'floor composition': $('#compositionLevel')?.textContent,
    'navigator active': document.querySelector('.tree-item.active strong')?.textContent
    // #detailStat deliberately excluded: it names the levels that are *built*,
    // which is a different fact from what is selected and may legitimately
    // differ from it.
  };
  assertCoherent(scope, rendered, problems => {
    for (const problem of problems) console.error(`[selection incoherent] ${problem}`);
    const banner = $('#coherenceWarning');
    if (banner) {
      banner.textContent = `Selection state disagreed with the interface: ${problems[0]}`;
      banner.hidden = false;
    }
  });
}

function showRouteError(title, detail) {
  $('#routeErrorTitle').textContent = title;
  $('#routeErrorDetail').textContent = detail;
  routeError.hidden = false;
  loadingState.classList.add('done');
  srStatus.textContent = `Route did not resolve. ${title}. ${detail}`;
}

function hideRouteError() {
  routeError.hidden = true;
}

$('#routeErrorHome').addEventListener('click', () => router.navigate(manifest?.default ?? floor.id));

/* -------------------------------------------------------------- room list --- */

/**
 * The navigator. Active state comes from the resolved scope, so what is
 * highlighted here is by construction the same thing the inspector is showing.
 *
 * Levels collapse: only the selected level lists its rooms. Seven levels of
 * nine units is sixty-three rows, which is a list nobody reads, and it also
 * hides the thing the navigator is for — the shape of the building.
 */
function renderRoomList(scope) {
  const list = $('#roomList');
  list.replaceChildren();

  const scoped = floor.floors?.length > 0;
  list.setAttribute('aria-label', scoped ? 'Levels and rooms in this building' : 'Rooms on this level');

  list.append(navButton({
    id: floor.id,
    order: '—',
    title: floor.displayName ?? floor.name,
    subtitle: scoped ? `Whole building · ${floor.floors.length} levels` : 'Whole unit',
    state: viewer?.rollupFor(floor.id) ?? TRUTH.UNRESOLVED,
    active: scope.kind === SCOPE.BUILDING
  }));

  const records = [...manifest.rooms].sort((a, b) => a.order - b.order);

  if (scoped) {
    for (const level of floor.floors) {
      const onLevel = records.filter(record => record.floor === level.id);
      const loaded = viewer?.detailFloors.includes(level.id) ?? true;
      const isOpen = scope.levelId === level.id;

      const button = navButton({
        id: level.id,
        order: String(level.level).padStart(2, '0'),
        title: level.name,
        subtitle: `${level.role} · ${level.unitCount} units · ${loaded ? 'loaded' : 'massing'}`,
        state: viewer?.rollupFor(level.id) ?? level.truth,
        active: scope.kind === SCOPE.LEVEL && scope.levelId === level.id
      });
      button.classList.add('is-level');
      button.classList.toggle('is-open', isOpen);
      button.classList.toggle('is-massing', !loaded);
      list.append(button);

      if (!isOpen) continue;
      for (const record of onLevel) {
        const nested = navButton({
          id: record.id,
          order: record.kind === 'unit' ? record.id.split('.').pop().replace('unit-', '') : '··',
          title: record.shortName,
          subtitle: record.kind === 'unit'
            ? `${record.bedrooms ? `${record.bedrooms} bed` : 'studio'}`
              + `${record.accessibility ? ` · ${record.accessibility}` : ''}`
            : display(record.truth).label,
          state: record.truth,
          active: scope.roomId === record.id
        });
        nested.classList.add('nested');
        list.append(nested);
      }
    }
    return;
  }

  for (const record of records) {
    list.append(navButton({
      id: record.id,
      order: String(record.order).padStart(2, '0'),
      title: record.shortName,
      subtitle: record.sourceLabel ?? display(record.truth).label,
      state: record.truth,
      active: scope.roomId === record.id
    }));
  }
}

function navButton({ id, order, title, subtitle, state, active }) {
  const meta = display(state);
  const button = document.createElement('button');
  button.className = 'tree-item';
  button.classList.toggle('active', active);
  button.dataset.scopeId = id;
  button.setAttribute('aria-current', active ? 'page' : 'false');

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.style.color = meta.css;
  icon.style.borderColor = meta.css;
  icon.textContent = order;

  const label = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = subtitle;
  label.append(strong, small);

  button.append(icon, label);
  button.addEventListener('click', () => select(id, { from: 'navigator' }));
  return button;
}

/* ------------------------------------------------------------- model tree --- */

function renderModelTree(scope) {
  const container = $('#modelTree');
  container.replaceChildren();
  if (!viewer) return;

  // Only built rooms have components to list, and only the selected level's
  // rooms are worth listing — the tree is for the thing in front of you, not an
  // inventory of the building.
  const onLevel = id => !scope?.levelId || floorIdOf(id) === scope.levelId;
  const built = viewer.roomIds.filter(id => viewer.countFor(id) > 0 && onLevel(id));
  const elsewhere = viewer.roomIds.filter(id => viewer.countFor(id) === 0).length;
  if (elsewhere > 0) {
    const note = document.createElement('p');
    note.className = 'tree-note';
    note.textContent = `${elsewhere} rooms on levels that are not loaded. Select a level to build it.`;
    container.append(note);
  }

  for (const roomId of built) {
    const record = roomRecord(roomId);
    const roomBlock = document.createElement('details');
    roomBlock.className = 'tree-group tree-room';
    roomBlock.open = true;

    const summary = document.createElement('summary');
    summary.append(dot(viewer.rollupFor(roomId) ?? TRUTH.UNRESOLVED));
    const name = document.createElement('span');
    name.textContent = record?.shortName ?? roomId;
    summary.append(name);
    const count = document.createElement('em');
    count.textContent = String(viewer.countFor(roomId));
    summary.append(count);
    summary.addEventListener('click', event => {
      event.preventDefault();
      roomBlock.open = !roomBlock.open;
      select(roomId, { from: 'tree' });
    });
    roomBlock.append(summary);

    const prefix = `${roomId}.`;
    const groups = new Map();
    for (const entry of viewer.index.values()) {
      if (entry.roomId !== roomId) continue;
      const rest = entry.id.slice(prefix.length).split('.');
      if (rest.length === 1) {
        roomBlock.append(treeButton(entry.id, entry.displayName, entry.truth, entry.isClearance));
      } else {
        const groupId = `${roomId}.${rest[0]}`;
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(entry);
      }
    }

    for (const [groupId, members] of groups) {
      const details = document.createElement('details');
      details.className = 'tree-group';
      const groupSummary = document.createElement('summary');
      const assembly = viewer.assemblies.get(groupId);
      groupSummary.append(dot(viewer.rollupFor(groupId)));
      const groupName = document.createElement('span');
      groupName.textContent = assembly?.displayName ?? groupId.slice(prefix.length);
      groupSummary.append(groupName);
      const groupCount = document.createElement('em');
      groupCount.textContent = String(members.filter(m => !m.isClearance).length);
      groupSummary.append(groupCount);
      groupSummary.addEventListener('click', event => {
        event.preventDefault();
        details.open = !details.open;
        if (assembly) select(groupId, { from: 'tree' });
      });
      details.append(groupSummary);
      for (const entry of members) {
        details.append(treeButton(entry.id, entry.displayName, entry.truth, entry.isClearance));
      }
      roomBlock.append(details);
    }

    container.append(roomBlock);
  }
}

function dot(state) {
  const span = document.createElement('i');
  span.className = 'state-dot';
  span.style.background = display(state).css;
  return span;
}

function treeButton(id, label, state, isGuide = false) {
  const button = document.createElement('button');
  button.className = 'tree-leaf';
  button.dataset.componentId = id;
  if (isGuide) button.classList.add('is-guide');
  button.append(dot(state));
  const text = document.createElement('span');
  text.textContent = label;
  button.append(text);
  button.title = id;
  button.addEventListener('click', () => select(id, { from: 'tree' }));
  return button;
}

function highlightTree(id) {
  for (const button of document.querySelectorAll('.tree-leaf')) {
    button.classList.toggle('active', button.dataset.componentId === id);
  }
}

/* -------------------------------------------------------------- inspector --- */

function setBadge(state) {
  const meta = display(state);
  const badge = $('#truthBadge');
  badge.textContent = meta.badge;
  badge.style.color = meta.css;
  badge.style.borderColor = meta.css;
  badge.style.background = `${meta.css}1a`;
  $('#truthClaim').textContent = meta.claim;
}

function setMetadata(source) {
  $('#sourceRef').textContent = source ? `${source.label} · ${source.ref}` : '—';
  $('#sheetRef').textContent = source ? `${source.sheet} · ${source.document}` : '—';
  $('#viewType').textContent = source?.viewType ?? '—';
  $('#reviewState').textContent = source?.reviewState ?? 'No accepted anchor';
}

/**
 * This build publishes no evidence, so every scope takes the no-source path.
 * `source` is still threaded through: if a publishable source is ever accepted,
 * this is the one place that has to grow a branch again.
 */
function setEvidence(source, state, missing) {
  const none = $('#noEvidenceCard');
  none.hidden = false;
  $('#noEvidenceDetail').textContent = {
    [TRUTH.DERIVED]: 'Computed from a stated rule rather than a drawing. The rule is listed below and is checkable; no source link is claimed.',
    [TRUTH.DEFAULT]: 'A reversible placeholder. It carries no source link because it makes no claim about the building.',
    [TRUTH.UNRESOLVED]: 'No source link is published for this scope. It is shown as a gap, not a guess.'
  }[state] ?? 'No source link.';

  const list = $('#missingList');
  list.replaceChildren();
  for (const item of missing ?? []) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  list.hidden = !(missing?.length);
}

function setDerivations(derivations) {
  const section = $('#derivationSection');
  const list = $('#derivationList');
  list.replaceChildren();
  for (const item of derivations ?? []) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  section.hidden = !(derivations?.length);
}

function setNote(note) {
  const element = $('#componentNote');
  element.textContent = note ?? '';
  element.hidden = !note;
}

function setPath(scope) {
  const path = $('#selectionPath');
  path.textContent = scope.id;
  path.title = scope.breadcrumb.join(' › ');
}

function setRollup(id, ownState) {
  const element = $('#containsRollup');
  const rolled = viewer?.rollupFor(id);
  if (!rolled || rolled === ownState) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.textContent = `Contains: ${display(rolled).label.toLowerCase()} — ${display(rolled).claim}`;
  element.style.borderLeftColor = display(rolled).css;
}

/**
 * The inspector, rendered from the resolved scope and nothing else.
 *
 * There used to be four of these — one per kind of thing that could be selected
 * — each reading its own variable. The heading, the badge and the missing-list
 * are decided here, once, from the scope object, so they cannot disagree with
 * the tooltip or the status bar about what is selected.
 */
function renderInspector(scope) {
  $('#selectedKind').textContent = scope.kindLabel;
  $('#selectedName').textContent = scope.title;

  const missing = {
    [SCOPE.BUILDING]: [
      'Overall plans, sections and elevations',
      'A drawn floor plate for any level',
      'Verified floor-to-floor heights',
      'Unit mix and unit count per level'
    ],
    [SCOPE.LEVEL]: [
      'A drawn plate for this level',
      'Corridor location and configuration',
      'Stair, lift and shaft locations',
      'How many units this level holds, and where they sit'
    ]
  }[scope.kind] ?? scope.room?.missing ?? null;

  if (scope.kind === SCOPE.BUILDING) {
    setBadge(viewer?.rollupFor(floor.id) ?? TRUTH.UNRESOLVED);
    setMetadata(null);
    setEvidence(null, TRUTH.UNRESOLVED, missing);
    setDerivations(floor.levelStructure ? [floor.levelStructure.note] : null);
    setNote(floor.composition?.note ?? null);
  } else if (scope.kind === SCOPE.LEVEL) {
    const level = scope.level;
    setBadge(viewer?.rollupFor(scope.id) ?? level?.truth ?? TRUTH.UNRESOLVED);
    setMetadata(null);
    setEvidence(null, TRUTH.UNRESOLVED, missing);
    setDerivations([
      level?.elevation?.note,
      level?.floorToFloor?.note,
      level?.ceilingHeight?.note
    ].filter(Boolean));
    setNote(level?.evidence?.basis ?? null);
  } else if (scope.kind === SCOPE.ROOM) {
    const room = scope.room;
    setBadge(room?.truth ?? TRUTH.UNRESOLVED);
    setMetadata(room?.source ?? null);
    setEvidence(room?.source ?? null, room?.truth ?? TRUTH.UNRESOLVED, missing);
    setDerivations(room?.instanceOf ? [room.instanceOf.note] : null);
    setNote(room?.summary ?? null);
  } else {
    const entry = scope.entry;
    setBadge(entry?.truth ?? TRUTH.UNRESOLVED);
    setMetadata(entry?.source ?? null);
    setEvidence(entry?.source ?? null, entry?.truth ?? TRUTH.UNRESOLVED, null);
    setDerivations(entry?.derivations ?? null);
    setNote(entry?.note ?? null);
  }

  setRollup(scope.id, scope.entry?.truth ?? scope.room?.truth ?? null);
}

/* --------------------------------------------------- floor composition --- */

/**
 * What this level is made of, and how much of that is actually established.
 *
 * The point of the panel is that a reader can see the difference between "this
 * level has these units because a tag in the source says so" and "this level
 * repeats the plate next door because nothing says otherwise". Both are shown;
 * neither is dressed up as the other.
 */
function renderFloorComposition(scope) {
  const section = $('#compositionSection');
  const level = scope.level;
  if (!level) {
    section.hidden = true;
    // Cleared, not just hidden: a stale level name left in the DOM is precisely
    // the contradiction this panel is supposed to make impossible.
    $('#compositionLevel').textContent = '';
    $('#compositionRole').textContent = '';
    $('#compositionVariant').textContent = '';
    $('#compositionRepeat').textContent = '';
    $('#compositionFacts').replaceChildren();
    $('#compositionMix').replaceChildren();
    $('#compositionNotes').replaceChildren();
    return;
  }
  section.hidden = false;

  $('#compositionLevel').textContent = level.name;
  $('#compositionRole').textContent = level.role;
  $('#compositionVariant').textContent = level.variantName;

  const repeat = $('#compositionRepeat');
  repeat.textContent = level.repeated
    ? `Repeated plate — also on ${level.sharesVariantWith
      .map(id => floor.floors.find(f => f.id === id)?.name ?? id).join(', ')}`
    : 'Unique plate';
  repeat.className = `composition-tag ${level.repeated ? 'is-repeated' : 'is-unique'}`;

  const facts = $('#compositionFacts');
  facts.replaceChildren();
  const rows = [
    ['Units', String(level.unitCount)],
    ['Plate area', `${Math.round(level.plate.area)} m²`],
    ['Plate extent', `${(level.plate.bounds.maxX - level.plate.bounds.minX).toFixed(1)} × `
      + `${(level.plate.bounds.maxZ - level.plate.bounds.minZ).toFixed(1)} m`],
    ['Floor level', `${level.elevation.value.toFixed(2)} m`],
    ['Floor to floor', `${level.floorToFloor.value.toFixed(2)} m`],
    ['Ceiling', `${level.ceilingHeight.value.toFixed(2)} m`]
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.append(dt, dd);
    facts.append(row);
  }

  const mix = $('#compositionMix');
  mix.replaceChildren();
  for (const [type, count] of Object.entries(level.inventory)) {
    const chip = document.createElement('li');
    chip.className = 'mix-chip';
    const n = document.createElement('b');
    n.textContent = `${count}×`;
    chip.append(n, document.createTextNode(` ${type}`));
    mix.append(chip);
  }
  if (level.roomTypes.length) {
    const chip = document.createElement('li');
    chip.className = 'mix-chip is-rooms';
    chip.textContent = level.roomTypes.join(' · ');
    mix.append(chip);
  }

  const notes = $('#compositionNotes');
  notes.replaceChildren();
  for (const text of [level.evidence?.basis, ...(level.notes ?? [])].filter(Boolean)) {
    const li = document.createElement('li');
    li.textContent = text;
    notes.append(li);
  }
}

/* ------------------------------------------------------- fixed dimensions --- */

function renderDimensions(roomId) {
  const host = $('#dimensionList');
  const empty = $('#noDimensions');
  const note = $('#dimensionNote');
  host.replaceChildren();

  const definition = roomId ? rooms.get(roomId) : null;
  const fixed = definition?.dimensions?.fixed ?? [];

  if (!fixed.length) {
    empty.hidden = false;
    empty.textContent = definition
      ? 'This room has no reconstructed geometry, so it carries no dimensions.'
      : 'Select a room to see its pinned dimensions. The unit overall extent is a designer default.';
    note.hidden = true;
    return;
  }

  empty.hidden = true;
  for (const item of fixed) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = item.label;
    const dd = document.createElement('dd');
    dd.textContent = item.governing;
    const metric = document.createElement('span');
    metric.className = 'dimension-metric';
    metric.textContent = item.metric;
    dd.append(metric);
    row.append(dt, dd);
    if (item.note) {
      const small = document.createElement('small');
      small.textContent = item.note;
      row.append(small);
    }
    host.append(row);
  }
  note.textContent = definition.dimensions.note ?? '';
  note.hidden = !definition.dimensions.note;
}

/* -------------------------------------------------------------------- ADA --- */

function adaRow(result) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = result.label;
  const dd = document.createElement('dd');

  const value = document.createElement('span');
  value.textContent = `${result.actual.toFixed(3)} m · ${result.actualIn.toFixed(2)} in`;
  dd.append(value);

  const flag = document.createElement('b');
  flag.className = result.compliant ? 'ada-pass' : 'ada-fail';
  flag.textContent = result.compliant ? 'PASS' : 'FAIL';
  dd.append(flag);

  // The margin is the point. A half-inch pass and a six-inch pass are not the
  // same thing, and only one of them survives a shop drawing.
  const margin = document.createElement('b');
  const tight = result.compliant && result.marginIn < 1;
  margin.className = `ada-margin${tight ? ' ada-tight' : ''}`;
  margin.textContent = `${result.marginIn >= 0 ? '+' : ''}${result.marginIn.toFixed(2)} in`;
  margin.title = `${result.direction === 'min' ? 'Minimum' : 'Maximum'} ${result.governingIn.toFixed(2)} in`;
  dd.append(margin);

  wrap.append(dt, dd);
  const cite = document.createElement('small');
  cite.textContent = result.citation;
  wrap.append(cite);
  return wrap;
}

function renderAda(roomId) {
  const section = $('#adaSection');
  const readout = $('#adaReadout');
  readout.replaceChildren();

  const kitchen = viewer && roomId
    ? [...viewer.assemblies.values()].find(a => a.roomId === roomId && a.metrics?.finishedHeight != null)
    : null;

  if (!kitchen) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const m = kitchen.metrics;

  // Aisle is measured off the built geometry: counter face to the nearest
  // opposing work surface in the same room. Measured in the room's own frame —
  // `counterFrontZ` is a figure from the unit type, and a unit six levels up
  // carries its placement in every world coordinate it reports.
  let aisle = null;
  for (const entry of viewer.index.values()) {
    if (entry.roomId !== roomId || entry.layer !== 'fixtures') continue;
    if (!/work-counter/.test(entry.id)) continue;
    const box = viewer.localBox(entry.id);
    if (box && !box.isEmpty()) aisle = box.min.z - m.counterFrontZ;
  }

  const assessment = assessSink({
    finishedHeight: m.finishedHeight,
    bowlDepth: m.bowlDepth,
    kneeWidth: m.kneeWidth,
    kneeDepth: m.kneeDepth,
    toeDepth: m.toeDepth,
    aisle
  });

  for (const result of assessment.results) readout.append(adaRow(result));

  if (m.heightHeldAtMaximum) {
    const held = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = 'Requested height';
    const dd = document.createElement('dd');
    dd.textContent = `${toInches(m.requestedHeight).toFixed(2)} in — over the maximum, held at 34 in and reported`;
    held.append(dt, dd);
    readout.append(held);
  }

  const verdict = $('#adaVerdict');
  const tightest = assessment.tightest;
  verdict.textContent = assessment.compliant
    ? `COMPLIANT · TIGHTEST ${tightest.marginIn.toFixed(2)} IN`
    : 'NOT COMPLIANT';
  verdict.className = assessment.compliant ? 'ada-pass' : 'ada-fail';
  $('#adaTightest').textContent = assessment.compliant
    ? `Tightest margin: ${tightest.label.toLowerCase()}, ${tightest.marginIn.toFixed(2)} in. ${tightest.citation}`
    : `Failing: ${assessment.results.filter(r => !r.compliant).map(r => r.label.toLowerCase()).join(', ')}.`;
  $('#adaTightest').hidden = false;
}

/* ----------------------------------------------------------------- legend --- */

/**
 * The legend is a key to the model, not an inventory of the scene — all four
 * states stay listed even when nothing occupies one. But a colour that matches
 * nothing on screen is ambiguous: a reader cannot tell "absent" from "broken".
 * So states with no occurrences are marked as absent rather than left to
 * inference. With no published evidence, source-verified is currently empty, and
 * saying so is the honest version of showing it.
 */
function renderTruthLegend() {
  const host = $('#truthLegend');
  host.replaceChildren();

  const present = new Set();
  if (viewer) for (const entry of viewer.index.values()) present.add(entry.truth);

  for (const state of TRUTH_ORDER) {
    const meta = TRUTH_DISPLAY[state];
    const row = document.createElement('div');
    row.classList.toggle('state-absent', viewer !== undefined && !present.has(state));

    const swatch = document.createElement('span');
    swatch.className = 'dot';
    swatch.style.background = meta.css;

    const text = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = meta.label;
    if (viewer && !present.has(state)) {
      const tag = document.createElement('em');
      tag.className = 'state-none';
      tag.textContent = 'none in this build';
      strong.append(' ', tag);
    }
    const small = document.createElement('small');
    small.textContent = meta.claim;
    text.append(strong, small);
    row.append(swatch, text);
    host.append(row);
  }
}

/* ------------------------------------------------------------- status bar --- */

function updateCounts(scope) {
  if (!viewer) return;
  $('#objectCount').textContent = String(viewer.objectCount);
  $('#guideCount').textContent = String(viewer.guideCount);

  // The object count is a count of components, so it moves when levels load and
  // unload. Naming the loaded levels keeps that from reading as instability —
  // and the names come from the level records, the same source the inspector and
  // the tooltip use, so the status bar cannot name a level the rest disagrees on.
  const loaded = viewer.detailFloors
    .map(id => floor.floors?.find(f => f.id === id)?.name ?? id);
  const stat = $('#detailStat');
  stat.textContent = viewer.proxyCount > 0
    ? `${loaded.join(', ')} built · ${viewer.proxyCount} levels massing`
    : `${loaded.length} ${loaded.length === 1 ? 'level' : 'levels'} built`;
  stat.title = viewer.proxyCount > 0
    ? 'Only the level in view is built at full detail. The others are massing blocks '
      + 'drawn from their own plate outlines, and are not counted as components.'
    : 'Every level is built at full detail.';

  const scoped = $('#scopeCount');
  if (scoped) {
    scoped.textContent = scope && scope.kind !== SCOPE.BUILDING
      ? `${viewer.countFor(scope.id)} in ${scope.kind === SCOPE.LEVEL ? scope.levelLabel : scope.title}`
      : '';
  }
}

/* ------------------------------------------------------------------ wire --- */

function wireViewer() {
  // A pick in the canvas is a selection like any other: it goes through the one
  // write path so the tree, the inspector, the status bar and the tooltip are
  // re-derived together rather than each catching up on its own.
  viewer.on('select', payload => {
    if (!selection) return;
    if (!payload) {
      // Clearing a component falls back to its room, not to nothing — the reader
      // is still looking at the same place.
      const current = selection.scope;
      if (current && current.kind !== SCOPE.BUILDING && current.roomId) {
        select(current.roomId, { from: 'viewer' });
      }
      return;
    }
    select(payload.id, { from: 'viewer' });
  });

  viewer.on('composition', () => {
    updateCounts(selection?.scope);
    renderTruthLegend();
    // The rails are built from what the composition turned out to contain, so
    // they are rendered here rather than at wire time — before the first build
    // the viewer has no layers and no levels to report.
    renderLayerToggles();
    renderLevelToggles(selection?.scope);
    renderDetailNote();
    $('#viewLabel').textContent = viewer.viewLabel;
  });

  viewer.on('rebuild', () => {
    updateCounts(selection?.scope);
    renderModelTree(selection?.scope);
  });

  viewer.on('truth-overlay', ({ on, objectCount }) => {
    srStatus.textContent = `Truth overlay ${on ? 'on' : 'off'}. ${objectCount} objects, unchanged.`;
    updateCounts(selection?.scope);
  });

  viewer.on('view', ({ label }) => {
    $('#viewLabel').textContent = label;
    srStatus.textContent = `${label} enabled.`;
  });

  viewer.on('stats', stats => {
    $('#frameStat').textContent = `${stats.frameMs.toFixed(1)} ms · ${stats.fps.toFixed(0)} fps`;
  });

  viewer.on('hover', payload => {
    if (!payload) {
      tooltip.hidden = true;
      return;
    }
    tooltip.hidden = false;
    if (payload.kind === 'proxy') {
      const level = floor.floors?.find(f => f.id === payload.floorId);
      tooltip.textContent = `${level?.name ?? payload.floorId} — massing, not loaded. Click to build.`;
    } else {
      // Same resolver as the inspector, so the tooltip cannot name a different
      // level for the same address.
      tooltip.textContent = selection?.resolve(payload.id).shortLabel ?? payload.id;
    }
    tooltip.style.left = `${payload.x}px`;
    tooltip.style.top = `${payload.y}px`;
  });

  for (const button of document.querySelectorAll('.mode-button')) {
    button.addEventListener('click', () => {
      viewer.setViewMode(button.dataset.mode);
      for (const other of document.querySelectorAll('.mode-button')) {
        const active = other === button;
        other.classList.toggle('active', active);
        other.setAttribute('aria-pressed', String(active));
      }
    });
  }

  // A massing block is not a component, so clicking one is not a selection —
  // it is a request to build the level it stands for.
  viewer.on('proxy-pick', ({ floorId }) => {
    if (floorId) select(floorId, { from: 'massing' });
  });

  // A level loading or unloading changes what exists, so the whole selection is
  // re-derived against the model that is now there.
  viewer.on('detail', () => {
    renderLayerToggles();
    renderDetailNote();
    if (applyingSelection) return;
    if (selection?.id) selection.refresh({ from: 'detail' });
    else {
      updateCounts(null);
      renderLevelToggles(null);
    }
  });

  $('#truthToggle').addEventListener('change', event => viewer.setTruthOverlay(event.target.checked));
  $('#gridToggle').addEventListener('change', event => viewer.setLayerVisible('grid', event.target.checked));
  $('#resetCamera').addEventListener('click', () => viewer.resetCamera());

  wireDisplayControls();

  window.addEventListener('resize', () => viewer.resize());
}

/* ------------------------------------------------------ display controls --- */

const layerLabel = name => manifest.layers?.[name]
  ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

function toggleRow(label, checked, onChange, { title = null, disabled = false } = {}) {
  const row = document.createElement('label');
  row.className = 'toggle-row';
  if (title) row.title = title;
  const text = document.createElement('span');
  text.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  const knob = document.createElement('i');
  row.append(text, input, knob);
  return row;
}

/**
 * Layer toggles come from the build, not from a hard-coded list.
 *
 * The rail used to name three layers because three were wired by hand, which
 * meant a room introducing a fourth got no control at all. The viewer reports
 * which layers its parts actually landed in; this names them and offers one
 * toggle each. Clearance guides cut across the layers rather than being one of
 * them, and massing only exists while some level is unloaded, so both are added
 * only when the build contains them.
 */
function renderLayerToggles() {
  const host = $('#layerToggles');
  host.replaceChildren();
  if (!viewer) return;

  const names = viewer.layerNames.filter(name => name !== 'massing');
  for (const name of names) {
    host.append(toggleRow(layerLabel(name), viewer.isLayerVisible(name),
      on => viewer.setLayerVisible(name, on)));
  }

  if (viewer.guideCount > 0) {
    host.append(toggleRow(layerLabel('guides'), viewer.isLayerVisible('guides'),
      on => viewer.setLayerVisible('guides', on),
      { title: 'Clearance envelopes are guides, not building fabric, and are excluded from the object count.' }));
  }

  if (viewer.proxyCount > 0) {
    host.append(toggleRow(layerLabel('massing'), viewer.isLayerVisible('massing'),
      on => viewer.setLayerVisible('massing', on),
      { title: 'Coarse blocks standing in for levels that are not loaded at full detail.' }));
  }
}

/** One visibility toggle per level, plus which level is currently loaded. */
function renderLevelToggles(scope) {
  const host = $('#levelToggles');
  host.replaceChildren();
  if (!viewer || !floor.floors?.length) return;

  const loaded = new Set(viewer.detailFloors);
  // Top level first: the list reads like an elevation rather than like a table.
  for (const level of [...floor.floors].reverse()) {
    const row = toggleRow(level.name, viewer.isFloorVisible(level.id),
      on => viewer.setFloorVisible(level.id, on),
      { title: `${level.name} — ${level.role}, ${level.unitCount} units, `
             + `${level.variantName}. Hiding a level hides it; it keeps its `
             + 'addresses and its components.' });
    row.classList.add('level-row');
    row.classList.toggle('is-selected', scope?.levelId === level.id);
    if (loaded.has(level.id)) {
      const tag = document.createElement('em');
      tag.className = 'level-loaded';
      tag.textContent = 'loaded';
      row.querySelector('span').append(' ', tag);
    }
    // The label selects the level; the switch controls its visibility. Two
    // different intentions, so two different targets.
    const label = row.querySelector('span');
    label.tabIndex = 0;
    label.setAttribute('role', 'button');
    label.addEventListener('click', event => {
      event.preventDefault();
      select(level.id, { from: 'levels' });
    });
    host.append(row);
  }
}

function renderDetailNote() {
  if (!viewer) return;
  const note = $('#detailNote');
  note.textContent = viewer.detailMode === 'all'
    ? `Every level built: ${viewer.objectCount} components.`
    : `One level built at a time: ${viewer.objectCount} components and ${viewer.proxyCount} massing blocks, `
      + 'instead of the whole stack. Selecting a level builds it.';
}

function wireDisplayControls() {
  for (const button of document.querySelectorAll('#shellModes button')) {
    button.addEventListener('click', () => {
      viewer.setShellMode(button.dataset.shell);
      for (const other of document.querySelectorAll('#shellModes button')) {
        const active = other === button;
        other.classList.toggle('active', active);
        other.setAttribute('aria-pressed', String(active));
      }
      srStatus.textContent = `Shell: ${button.textContent}.`;
    });
  }

  const clipToggle = $('#clipToggle');
  const clipControls = $('#clipControls');
  const clipAxis = $('#clipAxis');
  const clipT = $('#clipT');
  const clipFlip = $('#clipFlip');

  const applyClip = () => {
    viewer.setClipping({
      enabled: clipToggle.checked,
      axis: clipAxis.value,
      t: Number(clipT.value),
      flip: clipFlip.getAttribute('aria-pressed') === 'true'
    });
  };

  clipToggle.addEventListener('change', () => {
    clipControls.hidden = !clipToggle.checked;
    applyClip();
    srStatus.textContent = clipToggle.checked
      ? 'Section plane on. It removes fragments at draw time; no component is added or removed.'
      : 'Section plane off.';
  });
  clipAxis.addEventListener('change', applyClip);
  clipT.addEventListener('input', applyClip);
  clipFlip.addEventListener('click', () => {
    const next = clipFlip.getAttribute('aria-pressed') !== 'true';
    clipFlip.setAttribute('aria-pressed', String(next));
    clipFlip.classList.toggle('active', next);
    applyClip();
  });

  const explode = $('#explodeRange');
  const explodeReadout = $('#explodeReadout');
  explode.addEventListener('input', () => {
    const gap = Number(explode.value);
    viewer.setExplode(gap);
    explodeReadout.textContent = `${gap.toFixed(2)} m`;
  });
  explode.addEventListener('change', () => {
    srStatus.textContent = Number(explode.value) > 0
      ? `Levels separated by ${Number(explode.value).toFixed(2)} metres. A display offset, not an elevation.`
      : 'Levels stacked at their modelled elevations.';
  });

  const detailToggle = $('#detailToggle');
  detailToggle.checked = viewer.detailMode === 'all';
  detailToggle.addEventListener('change', event => {
    viewer.setDetailMode(event.target.checked ? 'all' : 'focused');
    srStatus.textContent = event.target.checked
      ? `All levels built: ${viewer.objectCount} components.`
      : `One level built: ${viewer.objectCount} components and ${viewer.proxyCount} massing blocks.`;
  });
}

/* -------------------------------------------------------------- evidence --- */

/*
 * There is no evidence UI in this build. The plan raster carried client drawing
 * identity, so it is withheld and the public tree ships no raster at all — which
 * means the evidence card, the drawing dialog and its zoom controls have no
 * subject and are gone from the DOM rather than left pointing at a missing file.
 * The topbar button is disabled and says why. Everything routes through
 * #noEvidenceCard.
 */

/* ----------------------------------------------------------- dev chrome --- */

/**
 * The study panels are an overlay on a full-bleed canvas, not the other way
 * around. `E` toggles them; absence of `body.chrome-on` is the clean state.
 */
const CHROME_KEY = 'msh.devChrome';
const chromeToggle = $('#chromeToggle');
const chromeLabel = $('#chromeToggleLabel');
let hintTimer = null;

const chromeIsOn = () => document.body.classList.contains('chrome-on');

function armHint() {
  clearTimeout(hintTimer);
  chromeToggle.classList.remove('idle');
  hintTimer = setTimeout(() => chromeToggle.classList.add('idle'), 4000);
}

function setChrome(on, { announce = true, persist = true } = {}) {
  document.body.classList.toggle('chrome-on', on);
  chromeToggle.setAttribute('aria-expanded', String(on));
  chromeLabel.textContent = on ? 'hide overlays' : 'dev overlays';
  chromeToggle.title = on ? 'Hide the study panels (E)' : 'Show the study panels (E)';
  // Only a deliberate toggle writes. Applying the initial state must not create
  // the key, or "absent" stops meaning "never chose" after the first visit.
  if (persist) {
    try { localStorage.setItem(CHROME_KEY, on ? 'on' : 'off'); } catch { /* storage blocked */ }
  }

  // A class change fires no window resize event, so without this the renderer
  // keeps its old drawing-buffer size and the model stretches. rAF lets layout
  // settle before we read the canvas box.
  requestAnimationFrame(() => viewer?.resize());

  if (announce) {
    srStatus.textContent = on
      ? 'Dev overlays shown. Rooms, model tree, display toggles and inspector are available.'
      : 'Dev overlays hidden. Canvas is full bleed. Press E to bring the panels back.';
  }
  if (on) {
    // With the chrome up the toggle stays put: it is the only way back for a
    // touch user, and a stale .idle from full bleed would leave it invisible.
    clearTimeout(hintTimer);
    chromeToggle.classList.remove('idle');
  } else {
    armHint();
  }
}

chromeToggle.addEventListener('click', () => setChrome(!chromeIsOn()));

window.addEventListener('keydown', event => {
  if (event.key !== 'e' && event.key !== 'E') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // Any modal that regains a keyboard of its own must be excluded here; the
  // evidence dialog that used to need it is gone with the raster.
  if (document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return;
    if (/^(input|textarea|select)$/i.test(target.tagName)) return;
  }
  event.preventDefault();
  setChrome(!chromeIsOn());
});

// The hint fades out of the way, and comes back when the pointer moves.
window.addEventListener('pointermove', () => { if (!chromeIsOn()) armHint(); }, { passive: true });

let storedChrome = null;
try { storedChrome = localStorage.getItem(CHROME_KEY); } catch { /* storage blocked */ }
setChrome(storedChrome === 'on', { announce: false, persist: false });

/* ------------------------------------------------------------------ go --- */

boot().catch(error => {
  console.error(error);
  showRouteError('Study failed to start', error.message);
});

// Surfaced for verification: counts, addresses and clearance margins without
// scraping the DOM.
window.__study = {
  get viewer() { return viewer; },
  get floor() { return floor; },
  get rooms() { return rooms; },
  get manifest() { return manifest; },
  /** The one authoritative selection. Everything on screen derives from this. */
  get scope() { return selection?.scope ?? null; },
  get focusedRoomId() { return selection?.scope?.roomId ?? null; },
  get focusedScopeId() { return selection?.scope?.levelId ?? null; },
  select: (id) => select(id, { from: 'test' }),
  /**
   * Read back the strings actually on screen, so a test can assert that the
   * interface agrees with itself rather than that the state object is tidy.
   */
  labels: () => ({
    inspectorName: $('#selectedName').textContent,
    inspectorKind: $('#selectedKind').textContent,
    path: $('#selectionPath').textContent,
    composition: $('#compositionLevel')?.textContent ?? null,
    navigator: document.querySelector('.tree-item.active strong')?.textContent ?? null,
    detail: $('#detailStat').textContent,
    levelChecked: [...document.querySelectorAll('#levelToggles .toggle-row')]
      .filter(row => row.querySelector('input')?.checked)
      .map(row => row.querySelector('span').firstChild.textContent.trim())
  }),
  get chromeOn() { return chromeIsOn(); },
  setChrome,
  get renderInfo() { return viewer?.renderInfo ?? null; },
  ids: () => (viewer ? [...viewer.index.keys()] : []),
  parseAll: () => (viewer ? [...viewer.index.keys()].every(id => { parseId(id); return true; }) : false),
  /**
   * Measure the built geometry rather than trusting the readout.
   *
   * Heights are above the component's own floor, not above the ground plane, so
   * "34 in work surface" reads the same on level 2 and level 7.
   */
  measure: id => {
    const box = viewer?.localBox(id);
    if (!box || box.isEmpty()) return null;
    return {
      minY: box.min.y,
      maxY: box.max.y,
      minYIn: toInches(box.min.y),
      maxYIn: toInches(box.max.y)
    };
  }
};
