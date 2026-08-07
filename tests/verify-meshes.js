/**
 * Run the real generators over the full stacked building and count what the
 * scene graph would actually hold. Geometry construction needs no WebGL, so this
 * measures the true expansion without a browser.
 */
import * as THREE from '../vendor/three/three.module.js';
import { GENERATORS } from '../src/generators.js';
import { createMaterialLibrary } from '../src/materials.js';
import { loadModel } from './model.js';

const { building } = await loadModel();
const materials = createMaterialLibrary();

let meshes = 0, registered = 0, guides = 0, triangles = 0;
const perLevel = {};
const byType = {};
const geometries = new Set();
const t0 = performance.now();

// Mirrors the ctx RoomViewer#build supplies, so this measures the real path.
const geometryCache = new Map();
const resourceCache = new Map();
const ctx = {
  materials,
  param: v => v,
  register: (mesh, node) => {
    registered += 1;
    if (node?.isClearance || mesh?.userData?.isClearance) guides += 1;
  },
  registerAssembly: () => {},
  geometryCache,
  cached: (key, make) => {
    let v = resourceCache.get(key);
    if (!v) { v = make(); resourceCache.set(key, v); }
    return v;
  }
};

for (const { definition } of building.rooms) {
  for (const partSpec of definition.parts) {
    const generator = GENERATORS[partSpec.type];
    if (!generator) throw new Error(`unknown part type ${partSpec.type}`);
    const group = generator(partSpec, ctx);
    group.traverse(o => {
      if (o.isMesh) {
        meshes += 1;
        byType[partSpec.type] = (byType[partSpec.type] ?? 0) + 1;
        geometries.add(o.geometry);
        const idx = o.geometry.getIndex();
        const pos = o.geometry.getAttribute('position');
        if (idx) triangles += idx.count / 3;
        else if (pos) triangles += pos.count / 3;
      }
    });
  }
}
const ms = performance.now() - t0;

console.log(`  units            ${building.stats.units}`);
console.log(`  clearance guides ${guides}`);
console.log(`  cached geometries${String(geometryCache.size).padStart(6)}  (box cache)`);
console.log(`  cached resources ${resourceCache.size}  (edges + generator materials)`);
console.log(`  part specs       ${building.stats.partSpecs}`);
console.log(`  meshes           ${meshes}`);
console.log(`  registered nodes ${registered}`);
console.log(`  unique geometries${String(geometries.size).padStart(6)}`);
console.log(`  triangles        ${triangles.toLocaleString()}`);
console.log(`  build time       ${ms.toFixed(0)} ms (geometry only, no GL)`);
console.log(`  meshes by type   ${JSON.stringify(byType)}`);
console.log('');
console.log(`  per unit         ${(meshes / building.stats.units).toFixed(1)} meshes`);
console.log(`  draw calls if not instanced ~${meshes}`);
console.log('');
console.log('  per level (full detail):');
for (const floor of building.floors) {
  const ids = new Set(building.rooms
    .filter(r => r.definition.id.startsWith(`${floor.id}.`))
    .flatMap(r => r.definition.parts.map(p => p.id)));
  console.log(`    ${floor.name}  ${floor.role.padEnd(12)} ${String(floor.unitCount).padStart(2)} units  `
    + `${String(ids.size).padStart(4)} part specs  plate ${String(Math.round(floor.plate.area)).padStart(4)} m2  `
    + `${floor.repeated ? 'repeated' : 'unique'}`);
}
