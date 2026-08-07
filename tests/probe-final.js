const v = window.__study.viewer;
const R = { drawCalls: v.renderInfo.calls, triangles: v.renderInfo.triangles,
            objects: v.objectCount, guides: v.guideCount, indexed: v.index.size };
let inst = 0, plain = 0;
for (const e of v.index.values()) (e.instanceId == null ? plain++ : inst++);
R.instanced = inst; R.plain = plain;

// guide toggle must actually hide every guide draw
const before = v.renderInfo.calls;
v.setLayerVisible('guides', false);
v.render?.(); 
R.guidesOffDrawCalls = 'see next frame';
R.guideObjects = v.guideCount;
v.setLayerVisible('guides', true);

v.setTruthOverlay(true);
R.overlayOk = [...v.index.values()].every(e => e.object.material);
v.setTruthOverlay(false);

const picks = ['building-a.floor-02.unit-0201.slab',
               'building-a.floor-05.unit-0504.work-counter',
               'building-a.floor-07.unit-0706.anchor-envelope',
               'building-a.floor-04.unit-0403'];
R.selects = picks.map(id => ({ id, ok: Boolean(v.select(id)), sel: v.selectedId === id }));
R.rollup = v.rollupFor('building-a');
R.countFloor = v.countFor('building-a.floor-04');
R.allParse = window.__study.parseAll();
R.fps = Math.round(v.stats.fps);
return R;
