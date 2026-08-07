const v = window.__study.viewer;
const R = {};
R.drawCalls = v.renderInfo.calls;
R.objects = v.objectCount; R.guides = v.guideCount; R.indexed = v.index.size;

// truth overlay must still swap materials on instanced draws
v.setTruthOverlay(true);
const mats = new Set(); for (const e of v.index.values()) mats.add(e.object.material.uuid);
R.overlayMaterials = mats.size;
R.overlayDrawCalls = v.renderInfo.calls;
v.setTruthOverlay(false);

// layer toggles must still hide instanced meshes
R.layers = v.layerNames;
v.setLayerVisible('casework', false);
R.caseworkHidden = v.layerNames.length > 0;
v.setLayerVisible('casework', true);

// selection across floors, and an assembly scope
const picks = ['building-a.floor-02.unit-0201.slab',
               'building-a.floor-05.unit-0504.work-counter',
               'building-a.floor-07.unit-0706.kitchen'];
R.selects = picks.map(id => { const s = v.select(id); return { id, ok: Boolean(s), sel: v.selectedId === id }; });

// rollups and counts must be unchanged by instancing
R.rollupBuilding = v.rollupFor('building-a');
R.countFloor04 = v.countFor('building-a.floor-04');
R.countUnit = v.countFor('building-a.floor-04.unit-0403');

// every id still parses
R.allParse = window.__study.parseAll();
R.fps = Math.round(v.stats.fps);
return R;
