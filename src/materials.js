import * as THREE from 'three';
import { TRUTH, TRUTH_DISPLAY } from './truth.js';

/**
 * Parallel material sets over the same geometry.
 *
 * `finish` is the readable architectural view. `truth` recolours every surface by
 * its evidence state so the reader can see, in one glance, how much of what they
 * are looking at is actually supported by a drawing. Switching between them is a
 * material swap only — it never rebuilds or forks geometry.
 *
 * The palette is deliberately narrow and low-chroma. This is a drawing, not a
 * rendering: the strongest contrast in the scene is reserved for the three
 * distinctions the study exists to make — built detail against schematic massing,
 * resolved against unresolved, and selected against everything else. Colour that
 * competes with those makes the model harder to read, not richer.
 */

/** Room-zone fills, grouped so a reader can tell programme apart at a glance. */
const ZONE_COLOURS = {
  living: 0xc9b79a,
  dining: 0xc4b294,
  sleeping: 0xbfa78d,
  bedroom: 0xbfa78d,
  'bedroom-accessible': 0xbf9a72,
  kitchen: 0x8fa39a,
  bath: 0x9aa9b2,
  pantry: 0xb0a68f,
  corridor: 0xa8a79f,
  lobby: 0xc2a878,
  study: 0xc2a878,
  laundry: 0x9c9c98,
  mail: 0x9c9c98,
  bike: 0x9c9c98,
  trash: 0x939390,
  mechanical: 0x8e8e8a,
  stair: 0x6f7377,
  elevator: 0x64686c,
  shaft: 0x5c6064,
  default: 0xb3b0a8
};

export function createMaterialLibrary() {
  const finish = {
    floor: new THREE.MeshStandardMaterial({ color: 0xbfb8ab, roughness: 0.94 }),
    slab: new THREE.MeshStandardMaterial({ color: 0xa9a294, roughness: 0.95 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.86, transparent: true, opacity: 0.92 }),
    wallGhost: new THREE.MeshStandardMaterial({ color: 0x93a3ad, roughness: 0.9, transparent: true, opacity: 0.22, depthWrite: false }),
    cabinet: new THREE.MeshStandardMaterial({ color: 0xa8906f, roughness: 0.66 }),
    cabinetDark: new THREE.MeshStandardMaterial({ color: 0x5f5648, roughness: 0.72 }),
    counter: new THREE.MeshStandardMaterial({ color: 0x2c353c, roughness: 0.34, metalness: 0.06 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x7d868c, roughness: 0.3, metalness: 0.7 }),
    stainless: new THREE.MeshStandardMaterial({ color: 0xa8b1b8, roughness: 0.24, metalness: 0.82 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xa9c7d0, roughness: 0.08, transmission: 0.55, transparent: true, opacity: 0.58 }),
    appliance: new THREE.MeshStandardMaterial({ color: 0x1f262b, roughness: 0.32, metalness: 0.35 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xc98a3f, roughness: 0.5 }),
    insulation: new THREE.MeshStandardMaterial({ color: 0xd8cfb8, roughness: 0.95 })
  };

  /** One material per truth state, plus a hatched treatment for unresolved scope. */
  const truth = {};
  for (const [state, meta] of Object.entries(TRUTH_DISPLAY)) {
    truth[state] = new THREE.MeshStandardMaterial({
      color: meta.color,
      roughness: 0.72,
      transparent: state === TRUTH.UNRESOLVED,
      opacity: state === TRUTH.UNRESOLVED ? 0.44 : 1
    });
  }

  const zone = {};
  for (const [kind, colour] of Object.entries(ZONE_COLOURS)) {
    zone[kind] = new THREE.MeshStandardMaterial({
      color: colour, roughness: 0.95, transparent: true, opacity: 0.97
    });
  }

  /**
   * Drawn edges. An architectural drawing is legible because of its line weight
   * hierarchy, so there are three: plate outlines read hardest, unit and zone
   * boundaries sit under them, and massing is the lightest thing on screen.
   */
  const outline = {
    plate: new THREE.LineBasicMaterial({ color: 0x2f3941, transparent: true, opacity: 0.85 }),
    unit: new THREE.LineBasicMaterial({ color: 0x46525b, transparent: true, opacity: 0.7 }),
    zone: new THREE.LineBasicMaterial({ color: 0x5c6670, transparent: true, opacity: 0.42 }),
    massing: new THREE.LineBasicMaterial({ color: 0x333d44, transparent: true, opacity: 0.95 })
  };

  /**
   * Unresolved scope reads as an open question, not a surface: translucent shell
   * plus a wireframe cage so it is obviously a placeholder at any zoom level.
   */
  const unresolvedCage = new THREE.MeshBasicMaterial({
    color: TRUTH_DISPLAY[TRUTH.UNRESOLVED].color,
    wireframe: true,
    transparent: true,
    opacity: 0.55
  });

  /**
   * Coarse stand-in for a level that is not currently loaded at full detail.
   *
   * Deliberately flat, translucent and edge-drawn: a massing block stands where
   * building fabric would be, so it has to be unmistakably not fabric. It is a
   * designer default and takes the designer-default colour under the truth
   * overlay, because that is exactly what it is — a reversible placeholder that
   * makes no claim about the building.
   */
  const massing = {
    solid: new THREE.MeshStandardMaterial({
      color: 0xbcc1c5, roughness: 0.97, transparent: true, opacity: 0.3,
      depthWrite: false, side: THREE.DoubleSide
    }),
    truth: new THREE.MeshStandardMaterial({
      color: TRUTH_DISPLAY[TRUTH.DEFAULT].color,
      roughness: 0.9, transparent: true, opacity: 0.3,
      depthWrite: false, side: THREE.DoubleSide
    }),
    edges: outline.massing
  };

  return { finish, truth, zone, outline, unresolvedCage, massing };
}

export function disposeMaterialLibrary(library) {
  for (const group of [library.finish, library.truth, library.zone, library.outline]) {
    for (const material of Object.values(group)) material.dispose();
  }
  // massing.edges is outline.massing and is already disposed above.
  library.massing.solid.dispose();
  library.massing.truth.dispose();
  library.unresolvedCage.dispose();
}
