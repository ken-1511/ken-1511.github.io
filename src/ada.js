/**
 * Accessibility dimensions, with citations.
 *
 * These are code-derived, not plan-derived. Geometry built from them is `derived`
 * in the truth model, never `source-verified` — the rule is stated and checkable,
 * but no drawing in the set was measured to produce it.
 *
 * Two documents govern here, and they are not interchangeable:
 *
 *   2010 ADA Standards for Accessible Design — general knee/toe clearance,
 *     work surface height, faucets, exposed pipes, clear floor space.
 *   UFAS 4.34.6.5 — kitchen sinks in accessible dwelling units. This is where
 *     the 6 1/2 in bowl depth and the 19 in knee depth actually come from.
 *     There is no sink-depth requirement anywhere in the 2010 ADA Standards,
 *     and section 606 ends at 606.5.
 *
 * All values are metres. Inch equivalents are the governing figures — the metric
 * numbers are conversions, so round-tripping through inches is the check.
 *
 * Margins here are small on purpose. A 34 in finished surface over a 6 1/2 in
 * bowl leaves exactly 27.5 in of knee height against a 27 in requirement: half an
 * inch. The two figures are designed to pair, and anything that quietly adds
 * thickness — a counter slab counted twice, a deeper bowl — eats the whole
 * margin. Report the margin, never just a pass.
 */

export const IN = 0.0254;

/** Convert inches to metres. */
export const inches = value => value * IN;

/** Convert metres to inches, for readouts that must show the governing figure. */
export const toInches = value => value / IN;

export const ADA = {
  /**
   * 2010 ADA 606.3 — measured to the rim or the counter surface, *whichever is
   * higher*, 34 in maximum above the finish floor. This is a ceiling on the
   * finished top surface, not on the cabinet carcass beneath it.
   */
  WORK_SURFACE_MAX_HEIGHT: inches(34),

  /**
   * UFAS 4.34.6.5 permits an adjustable kitchen work surface at 28, 32 and 36 in.
   * 29 in is the low end of the continuously adjustable range used here; below
   * that the knee clearance stops working against any usable bowl.
   */
  WORK_SURFACE_MIN_HEIGHT: inches(29),

  /** UFAS 4.34.6.5 — kitchen sink bowl 6 1/2 in deep maximum. Not an ADA figure. */
  SINK_MAX_BOWL_DEPTH: inches(6.5),

  /** 2010 ADA 306.3 — knee clearance, plus the UFAS kitchen-sink depth. */
  KNEE: {
    /** 306.3.1 — knee clearance is the space between 9 in and 27 in AFF. */
    CLEAR_HEIGHT: inches(27),
    /** 306.3.2 — 11 in deep minimum at 9 in AFF. */
    DEPTH_AT_9: inches(11),
    /** 306.3.2 — 8 in deep minimum at 27 in AFF. */
    DEPTH_AT_27: inches(8),
    /** 306.3.2 — shall extend 25 in maximum under the element. */
    MAX_EXTENSION: inches(25),
    /** 306.3.4 — 30 in wide minimum. */
    MIN_WIDTH: inches(30),
    /**
     * UFAS 4.34.6.5 — a kitchen sink knee space is 30 in wide and 19 in deep.
     * Deeper than ADA 306.3's 11 in, and this is the governing figure for a
     * dwelling-unit kitchen sink.
     */
    KITCHEN_DEPTH: inches(19)
  },

  /** 2010 ADA 306.2 — toe clearance below the knee space. */
  TOE: {
    /** 306.2.1 — toe clearance is the space up to 9 in AFF. */
    HEIGHT: inches(9),
    /** 306.2.3 — 17 in deep minimum where it is part of the clear floor space. */
    MIN_DEPTH: inches(17),
    /** 306.2.2 — 25 in maximum under the element. */
    MAX_DEPTH: inches(25),
    /** 306.2.4 — 30 in wide minimum. */
    MIN_WIDTH: inches(30)
  },

  /** 2010 ADA 305.3 — clear floor space at an accessible element. */
  CLEAR_FLOOR: {
    WIDTH: inches(30),
    DEPTH: inches(48),
    /** UFAS 4.34.6.5 — up to 19 in of it may extend under the sink. */
    MAX_UNDER_SINK: inches(19)
  },

  /** 2010 ADA 804.2.1 — clearance between opposing kitchen work surfaces. */
  KITCHEN_AISLE_MIN: inches(40),

  /**
   * 2010 ADA 606.5 — water supply and drain pipes under a sink shall be insulated
   * or otherwise configured to protect against contact. Modelled as a panel.
   */
  PIPE_PROTECTION_CLEARANCE: inches(1)
};

export const ADA_CITATIONS = {
  WORK_SURFACE_MAX_HEIGHT: '2010 ADA 606.3 — 34 in max AFF to rim or counter, whichever is higher',
  SINK_MAX_BOWL_DEPTH: 'UFAS 4.34.6.5 — 6.5 in max bowl depth (no ADA sink-depth rule exists)',
  KNEE_HEIGHT: '2010 ADA 306.3.1 — knee clearance is the space from 9 in to 27 in AFF',
  KNEE_DEPTH: 'UFAS 4.34.6.5 — 19 in deep kitchen sink knee space (ADA 306.3.2 floor is 11 in at 9 in AFF)',
  KNEE_WIDTH: '2010 ADA 306.3.4 · UFAS 4.34.6.5 — 30 in wide minimum',
  KNEE_MAX_EXTENSION: '2010 ADA 306.3.2 — 25 in maximum extension under the element',
  TOE: '2010 ADA 306.2 — 9 in high, 17 in deep minimum, 30 in wide minimum',
  CLEAR_FLOOR: '2010 ADA 305.3 — 30 in × 48 in clear floor space',
  CLEAR_FLOOR_UNDER_SINK: 'UFAS 4.34.6.5 — 19 in maximum of the clear floor space may extend under the sink',
  PIPE_PROTECTION: '2010 ADA 606.5 — exposed pipes insulated or configured against contact',
  KITCHEN_AISLE: '2010 ADA 804.2.1 — 40 in minimum between opposing work surfaces'
};

/**
 * One clearance result. `margin` is the signed slack in metres against the
 * governing figure — the number that actually matters at a compliance
 * breakpoint, and the reason this returns a margin rather than a boolean.
 */
function check({ label, actual, governing, direction = 'min', citation }) {
  const margin = direction === 'min' ? actual - governing : governing - actual;
  return {
    label,
    actual,
    governing,
    direction,
    citation,
    margin,
    compliant: margin >= -1e-9,
    actualIn: toInches(actual),
    governingIn: toInches(governing),
    marginIn: toInches(margin)
  };
}

export { check as clearanceCheck };

/**
 * Check a proposed finished work-surface height against the governing maximum.
 * Returns a result rather than throwing: the UI shows non-compliance as a visible
 * state, it does not silently clamp the designer's input away.
 */
export function checkWorkSurfaceHeight(height) {
  const result = check({
    label: 'Work surface height',
    actual: height,
    governing: ADA.WORK_SURFACE_MAX_HEIGHT,
    direction: 'max',
    citation: ADA_CITATIONS.WORK_SURFACE_MAX_HEIGHT
  });
  return {
    ...result,
    height,
    overBy: Math.max(-result.margin, 0),
    readout: `${height.toFixed(3)} m · ${toInches(height).toFixed(2)} in`
  };
}

/**
 * The clear knee height under a sink bowl.
 *
 * `finishedHeight` is the top of the counter or the rim, whichever is higher —
 * the surface 606.3 measures. Bowl depth is measured down from that surface, so
 * the underside is a straight subtraction and the counter slab is not counted
 * twice.
 */
export function sinkKneeOpening(finishedHeight, bowlDepth = ADA.SINK_MAX_BOWL_DEPTH) {
  const underside = finishedHeight - bowlDepth;
  return {
    ...check({
      label: 'Knee clearance under bowl',
      actual: underside,
      governing: ADA.KNEE.CLEAR_HEIGHT,
      direction: 'min',
      citation: ADA_CITATIONS.KNEE_HEIGHT
    }),
    underside,
    required: ADA.KNEE.CLEAR_HEIGHT
  };
}

/**
 * Full accessible-sink assessment against the figures that actually govern a
 * dwelling-unit kitchen sink. Every entry carries its margin, so a half-inch
 * pass is visibly a half-inch pass.
 */
export function assessSink({ finishedHeight, bowlDepth, kneeWidth, kneeDepth, toeDepth, aisle = null }) {
  const results = [
    checkWorkSurfaceHeight(finishedHeight),
    check({
      label: 'Sink bowl depth',
      actual: bowlDepth,
      governing: ADA.SINK_MAX_BOWL_DEPTH,
      direction: 'max',
      citation: ADA_CITATIONS.SINK_MAX_BOWL_DEPTH
    }),
    sinkKneeOpening(finishedHeight, bowlDepth),
    check({
      label: 'Knee clearance width',
      actual: kneeWidth,
      governing: ADA.KNEE.MIN_WIDTH,
      direction: 'min',
      citation: ADA_CITATIONS.KNEE_WIDTH
    }),
    check({
      label: 'Knee clearance depth',
      actual: kneeDepth,
      governing: ADA.KNEE.KITCHEN_DEPTH,
      direction: 'min',
      citation: ADA_CITATIONS.KNEE_DEPTH
    }),
    check({
      label: 'Knee clearance extension',
      actual: kneeDepth,
      governing: ADA.KNEE.MAX_EXTENSION,
      direction: 'max',
      citation: ADA_CITATIONS.KNEE_MAX_EXTENSION
    }),
    check({
      label: 'Toe clearance depth',
      actual: toeDepth,
      governing: ADA.TOE.MIN_DEPTH,
      direction: 'min',
      citation: ADA_CITATIONS.TOE
    })
  ];

  if (aisle != null) {
    results.push(check({
      label: 'Aisle to opposing counter',
      actual: aisle,
      governing: ADA.KITCHEN_AISLE_MIN,
      direction: 'min',
      citation: ADA_CITATIONS.KITCHEN_AISLE
    }));
  }

  const tightest = results.reduce((a, b) => (b.margin < a.margin ? b : a));
  return {
    results,
    compliant: results.every(r => r.compliant),
    tightest
  };
}
