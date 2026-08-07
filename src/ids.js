/**
 * Stable component identity.
 *
 * Every room, floor, and building component carries a dot-separated address that
 * never changes for the life of the component:
 *
 *   building-a.floor-02.room-204.wall-north
 *   building-a.floor-02.room-204.kitchen.base-03
 *   building-a.floor-02.slab
 *   building-a.envelope.east-bay-04
 *
 * IDs are the join key between geometry, source evidence, and the UI. Nothing in
 * the viewer may generate an ID at render time — they come from the manifests, so
 * a link into a component stays valid across rebuilds.
 */

const SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Segment prefixes that carry structural meaning in the address. */
export const KIND = {
  BUILDING: 'building',
  FLOOR: 'floor',
  ROOM: 'room',
  UNIT: 'unit',
  COMMONS: 'commons',
  CORE: 'core'
};

/**
 * Segment prefixes that occupy the room level of the address.
 *
 * A unit is a room-level scope: it sits under a floor and owns parts. Both
 * spellings exist because a hand-authored floor registry names rooms while a
 * stacked building names units, and an address must resolve the same either way.
 *
 * `commons` and `core` are the same level of the address but are not dwellings:
 * a level's plate, corridor and shared rooms belong to its commons, and its
 * stairs, lift and shafts to its core. They sit here rather than hanging off the
 * floor directly so that every part in the building has exactly one owner at the
 * same depth, and so scoping, roll-up and picking need no special case.
 */
const ROOM_LEVEL = [KIND.ROOM, KIND.UNIT, KIND.COMMONS, KIND.CORE];

const isRoomLevel = segment => ROOM_LEVEL.some(kind => segment.startsWith(`${kind}-`));

/**
 * Split an ID into segments, validating the grammar.
 * Throws rather than coercing: a malformed ID is a data defect, not a UI state.
 */
export function parseId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError(`Component id must be a non-empty string, received ${JSON.stringify(id)}`);
  }
  const segments = id.split('.');
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new TypeError(`Invalid id segment "${segment}" in "${id}" — expected lowercase kebab-case`);
    }
  }
  return segments;
}

export function isValidId(id) {
  try {
    parseId(id);
    return true;
  } catch {
    return false;
  }
}

/** Join segments into an ID, skipping empty parts. */
export function joinId(...parts) {
  const id = parts.filter(Boolean).join('.');
  parseId(id);
  return id;
}

/** The address of the containing component, or null at the root. */
export function parentId(id) {
  const segments = parseId(id);
  return segments.length > 1 ? segments.slice(0, -1).join('.') : null;
}

/** Every ancestor address, outermost first, excluding the id itself. */
export function ancestorIds(id) {
  const segments = parseId(id);
  const out = [];
  for (let i = 1; i < segments.length; i += 1) out.push(segments.slice(0, i).join('.'));
  return out;
}

export function isDescendantOf(id, ancestor) {
  return id === ancestor || id.startsWith(`${ancestor}.`);
}

/** Last segment — the local name of the component within its parent. */
export function localName(id) {
  const segments = parseId(id);
  return segments[segments.length - 1];
}

/**
 * Pull the structural scope out of an address.
 * Returns { building, floor, room } with null for anything the id does not name.
 * `building-a.envelope.east-bay-04` yields a building but no floor or room, which
 * is correct — envelope bays span floors.
 */
export function scopeOf(id) {
  const segments = parseId(id);
  const scope = { building: null, floor: null, room: null };
  for (const segment of segments) {
    if (segment.startsWith(`${KIND.BUILDING}-`)) scope.building ??= segment;
    else if (segment.startsWith(`${KIND.FLOOR}-`)) scope.floor ??= segment;
    else if (isRoomLevel(segment)) scope.room ??= segment;
  }
  return scope;
}

/** The room-level address an id belongs to, or null if it is not inside a room. */
export function roomIdOf(id) {
  const segments = parseId(id);
  const index = segments.findIndex(isRoomLevel);
  return index === -1 ? null : segments.slice(0, index + 1).join('.');
}

/** The floor-level address an id belongs to, or null. */
export function floorIdOf(id) {
  const segments = parseId(id);
  const index = segments.findIndex(segment => segment.startsWith(`${KIND.FLOOR}-`));
  return index === -1 ? null : segments.slice(0, index + 1).join('.');
}

/**
 * Human-readable breadcrumb for an address, using display names supplied by the
 * caller where it has them and the raw segment where it does not.
 */
export function breadcrumb(id, names = {}) {
  const segments = parseId(id);
  const trail = [];
  for (let i = 0; i < segments.length; i += 1) {
    const partial = segments.slice(0, i + 1).join('.');
    trail.push(names[partial] ?? segments[i]);
  }
  return trail;
}

/** `building-a.floor-02.room-204` <-> `/building-a/floor-02/room-204` */
export function idToPath(id) {
  return `/${parseId(id).join('/')}`;
}

export function pathToId(path) {
  const segments = String(path).split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const id = segments.join('.');
  return isValidId(id) ? id : null;
}
