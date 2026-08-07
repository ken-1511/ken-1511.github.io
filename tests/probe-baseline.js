const v = window.__study.viewer;
return {
  drawCalls: v.renderInfo.calls,
  triangles: v.renderInfo.triangles,
  objects: v.objectCount,
  guides: v.guideCount,
  indexed: v.index.size,
  rooms: v.roomIds.length,
  fps: Math.round(v.stats.fps),
  frameMs: Number(v.stats.frameMs.toFixed(1))
};
