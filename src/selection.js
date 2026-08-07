/**
 * One authoritative answer to "what is selected".
 *
 * The bug this exists to kill: the viewport tooltip, the inspector heading, the
 * status bar, the navigator, the model tree, the level checkbox and the camera
 * each worked out for themselves what was selected, from whichever variable was
 * nearest. They disagreed. A tooltip could say Level 07 while the inspector said
 * Level 06, and both were "right" about their own variable.
 *
 * So: a selection is one address. Everything else — which level that is, which
 * unit, which component, what to call it, what to frame, which checkbox to tick
 * — is *derived* from that address by `resolveScope`, in one place, once per
 * change. A consumer that renders something not on the resolved object is a bug,
 * and `assertCoherent` is here to catch exactly that.
 *
 * This module knows nothing about the DOM or about three.js.
 */

import { breadcrumb, floorIdOf, roomIdOf, parseId } from './ids.js';

export const SCOPE = {
  BUILDING: 'building',
  LEVEL: 'level',
  ROOM: 'room',
  ASSEMBLY: 'assembly',
  COMPONENT: 'component'
};

/** What a room-level scope is, from its address rather than from a lookup. */
function roomKindOf(roomId) {
  if (!roomId) return null;
  const last = roomId.split('.').pop();
  if (last.startsWith('unit-')) return 'unit';
  if (last.startsWith('commons-')) return 'commons';
  if (last.startsWith('core-')) return 'core';
  return 'room';
}

/**
 * Resolve an address against the model.
 *
 * @param {string|null} id            the selected address, or null for the building
 * @param {object} model
 * @param {string} model.buildingId
 * @param {Array}  model.floors       composed level records
 * @param {Map}    model.rooms        roomId -> definition
 * @param {object} model.displayNames
 * @param {Function} [model.entryOf]  address -> viewer index entry or assembly
 * @returns {object} the single object every consumer renders from
 */
export function resolveScope(id, model) {
  const { buildingId, floors, rooms, displayNames = {}, entryOf = () => null } = model;
  const address = id ?? buildingId;

  parseId(address);

  const levelId = floorIdOf(address);
  const level = levelId ? floors.find(f => f.id === levelId) ?? null : null;
  const roomId = roomIdOf(address);
  const room = roomId ? rooms.get(roomId) ?? null : null;
  const entry = address !== roomId && address !== levelId && address !== buildingId
    ? entryOf(address)
    : null;

  let kind;
  if (address === buildingId) kind = SCOPE.BUILDING;
  else if (address === levelId) kind = SCOPE.LEVEL;
  else if (address === roomId) kind = SCOPE.ROOM;
  else kind = entry?.kind === 'assembly' || entry?.metrics ? SCOPE.ASSEMBLY : SCOPE.COMPONENT;

  const roomKind = roomKindOf(roomId);
  const trail = breadcrumb(address, displayNames);

  // The one place a human-readable level name is produced. Everything that shows
  // a level shows this string, so two consumers cannot disagree about it.
  const levelLabel = level ? level.name : null;

  const title = {
    [SCOPE.BUILDING]: displayNames[buildingId] ?? buildingId,
    [SCOPE.LEVEL]: levelLabel ?? address,
    [SCOPE.ROOM]: room?.name ?? displayNames[address] ?? address,
    [SCOPE.ASSEMBLY]: entry?.displayName ?? address,
    [SCOPE.COMPONENT]: entry?.displayName ?? address
  }[kind];

  const kindLabel = {
    [SCOPE.BUILDING]: 'SELECTED SCOPE · BUILDING',
    [SCOPE.LEVEL]: 'SELECTED SCOPE · LEVEL',
    [SCOPE.ROOM]: roomKind === 'unit' ? 'SELECTED SCOPE · UNIT'
      : roomKind === 'commons' ? 'SELECTED SCOPE · PLATE & COMMONS'
        : roomKind === 'core' ? 'SELECTED SCOPE · VERTICAL CORE'
          : 'SELECTED SCOPE · ROOM',
    [SCOPE.ASSEMBLY]: 'SELECTED SCOPE · ASSEMBLY',
    [SCOPE.COMPONENT]: 'SELECTED COMPONENT'
  }[kind];

  return {
    id: address,
    kind,
    roomKind,
    levelId,
    level,
    roomId,
    room,
    componentId: kind === SCOPE.COMPONENT || kind === SCOPE.ASSEMBLY ? address : null,
    entry,
    title,
    kindLabel,
    levelLabel,
    breadcrumb: trail,
    /** What the camera should frame. A component frames its room, not itself. */
    focusId: kind === SCOPE.BUILDING ? null : (kind === SCOPE.LEVEL ? levelId : roomId ?? levelId),
    /** Short form for the tooltip and the status bar — always the same string. */
    shortLabel: levelLabel && kind !== SCOPE.BUILDING && kind !== SCOPE.LEVEL
      ? `${title} · ${levelLabel}`
      : title
  };
}

/**
 * Development check: every label on screen must agree with the resolved scope.
 *
 * Cheap string comparisons over the handful of places a scope name is written.
 * It runs on every selection change and reports rather than throws — a
 * contradiction should be loud during development without taking the page down
 * in front of a reader.
 *
 * @param {object} scope   the resolved scope
 * @param {object} rendered  { label: text } actually written to the DOM
 * @param {Function} report  called with an array of problems
 */
export function assertCoherent(scope, rendered, report) {
  const problems = [];

  for (const [where, text] of Object.entries(rendered)) {
    if (text == null) continue;

    // Any level named on screen must be the resolved level, not a neighbour.
    const named = String(text).match(/Level\s+(\d{2})/g);
    if (named && scope.levelLabel) {
      for (const hit of new Set(named)) {
        if (hit !== scope.levelLabel) {
          problems.push(`${where} says "${hit}" but the selection is on ${scope.levelLabel}`);
        }
      }
    }
    if (named && !scope.levelLabel) {
      problems.push(`${where} names ${named[0]} but the selection is not on any level`);
    }
  }

  if (problems.length) report(problems);
  return problems;
}

/**
 * The selection store. Holds one address and nothing else.
 *
 * `set` resolves and publishes; consumers subscribe. There is deliberately no
 * way to publish a partial update — a caller cannot change the level without
 * changing the selection, because those are the same fact.
 */
export function createSelectionStore(model, { onChange } = {}) {
  let current = null;
  let resolved = null;

  return {
    get id() { return current; },
    get scope() { return resolved; },
    resolve(id) { return resolveScope(id, model); },
    set(id, meta = {}) {
      const next = resolveScope(id, model);
      const changed = !resolved || resolved.id !== next.id;
      current = next.id;
      resolved = next;
      onChange?.(next, { ...meta, changed });
      return next;
    },
    /** Re-derive without changing the address — after a rebuild, for instance. */
    refresh(meta = {}) {
      if (current === null) return null;
      return this.set(current, { ...meta, refresh: true });
    }
  };
}
