/**
 * Truth states.
 *
 * The whole point of this viewer is that a reader can tell, without asking, which
 * parts of what they are looking at came from a drawing and which parts we made
 * up to fill the gap. Four states, and geometry must declare one:
 *
 *   source-verified   traced to accepted plan evidence, with a source link
 *   derived           computed from a verified parent by a stated relationship
 *   designer-default  a reversible placeholder we chose; carries no claim
 *   unresolved        building information we do not have
 *
 * `unresolved` is not an error state. A room with no accepted anchor is a legitimate
 * thing to show, as long as the interface never lets it pass for evidence.
 */

export const TRUTH = {
  SOURCE: 'source-verified',
  DERIVED: 'derived',
  DEFAULT: 'designer-default',
  UNRESOLVED: 'unresolved'
};

/** Roll-up order: the weakest claim present wins when summarising a subtree. */
const STRENGTH = {
  [TRUTH.SOURCE]: 3,
  [TRUTH.DERIVED]: 2,
  [TRUTH.DEFAULT]: 1,
  [TRUTH.UNRESOLVED]: 0
};

export const TRUTH_DISPLAY = {
  [TRUTH.SOURCE]: {
    label: 'Source verified',
    badge: 'SOURCE VERIFIED',
    color: 0xc96442,
    css: '#c96442',
    claim: 'Geometry traced to accepted plan evidence.',
    requiresSource: true
  },
  [TRUTH.DERIVED]: {
    label: 'Derived relationship',
    badge: 'DERIVED',
    color: 0x48836c,
    css: '#48836c',
    claim: 'Computed from a verified parent by a stated rule.',
    requiresSource: false
  },
  [TRUTH.DEFAULT]: {
    label: 'Designer default',
    badge: 'DESIGNER DEFAULT',
    color: 0x7b8794,
    css: '#7b8794',
    claim: 'Reversible placeholder. Carries no claim about the building.',
    requiresSource: false
  },
  [TRUTH.UNRESOLVED]: {
    label: 'Unresolved',
    badge: 'UNRESOLVED',
    color: 0xd7b16a,
    css: '#d7b16a',
    claim: 'Building information is missing. Shown as a gap, not a guess.',
    requiresSource: false
  },
  mixed: {
    label: 'Mixed evidence',
    badge: 'MIXED EVIDENCE',
    color: 0x8d7b65,
    css: '#8d7b65',
    claim: 'This scope contains components at more than one truth state.',
    requiresSource: false
  }
};

export function isTruthState(value) {
  return Object.prototype.hasOwnProperty.call(STRENGTH, value);
}

export function assertTruthState(value, context = '') {
  if (!isTruthState(value)) {
    throw new TypeError(`Unknown truth state "${value}"${context ? ` for ${context}` : ''}`);
  }
  return value;
}

export function display(state) {
  return TRUTH_DISPLAY[state] ?? TRUTH_DISPLAY[TRUTH.UNRESOLVED];
}

/**
 * Summarise a set of states. Returns a single state when they agree, otherwise
 * 'mixed' — never silently promotes to the strongest member.
 */
export function rollup(states) {
  const present = new Set(states.filter(isTruthState));
  if (present.size === 0) return TRUTH.UNRESOLVED;
  if (present.size === 1) return [...present][0];
  return 'mixed';
}

/** The weakest state in a set — used for the "can this be trusted at all" question. */
export function weakest(states) {
  const valid = states.filter(isTruthState);
  if (valid.length === 0) return TRUTH.UNRESOLVED;
  return valid.reduce((acc, state) => (STRENGTH[state] < STRENGTH[acc] ? state : acc));
}

/**
 * A component may not claim to be source-verified without a source link. This is
 * checked at load time so bad data fails loudly instead of rendering as a claim.
 */
export function validateClaim(node) {
  const state = assertTruthState(node.truth, node.id);
  if (display(state).requiresSource && !node.source) {
    throw new Error(`"${node.id}" claims ${state} but carries no source link`);
  }
  return state;
}

/** Ordered list for legends — strongest claim first. */
export const TRUTH_ORDER = [TRUTH.SOURCE, TRUTH.DERIVED, TRUTH.DEFAULT, TRUTH.UNRESOLVED];
