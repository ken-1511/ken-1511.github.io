const v = window.__study.viewer;
const idx = v.index;
let instanced = 0, plain = 0;
for (const e of idx.values()) (e.instanceId == null ? plain++ : instanced++);
// selection round-trip on an instanced part deep in the stack
const target = 'building-a.floor-07.unit-0706.wall-north';
const sel = v.select(target);
const help = v.__proto__; // not used; keep select result only
return {
  drawCalls: v.renderInfo.calls,
  triangles: v.renderInfo.triangles,
  objects: v.objectCount,
  guides: v.guideCount,
  indexed: idx.size,
  instancedEntries: instanced,
  plainEntries: plain,
  rootChildren: v.__rootCount ?? null,
  selectOk: Boolean(sel && sel.id === target),
  selectedId: v.selectedId,
  fps: Math.round(v.stats.fps),
  frameMs: Number(v.stats.frameMs.toFixed(1))
};
