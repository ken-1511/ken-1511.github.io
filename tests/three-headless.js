/**
 * The real three.js with the GPU taken out.
 *
 * RoomViewer builds a WebGLRenderer in its constructor, which means the whole
 * class — the scene graph, the index, instancing, progressive detail, explode,
 * visibility, clipping — could otherwise only be exercised by driving a browser.
 * Every one of those is geometry and bookkeeping, not pixels.
 *
 * So: this module re-exports the vendored three unchanged and substitutes one
 * class. An explicit local export shadows the same name coming through
 * `export *`, so `import * as THREE from 'three'` inside the viewer resolves
 * WebGLRenderer here and everything else to the real library. Nothing in the
 * viewer is modified, stubbed, or aware of this.
 *
 * What this cannot check: shading, actual draw calls, and real frame timing.
 * Those need a GPU and belong to page verification.
 */
export * from '../vendor/three/three.module.js';

class HeadlessWebGLRenderer {
  constructor({ canvas } = {}) {
    this.domElement = canvas;
    this.shadowMap = { enabled: false, type: null };
    this.capabilities = { isWebGL2: true };
    this.info = { render: { calls: 0, triangles: 0, lines: 0, points: 0 } };
    this.clippingPlanes = [];
    this.localClippingEnabled = false;
    this.outputColorSpace = null;
    this.toneMapping = null;
    this.toneMappingExposure = 1;
    this.size = { width: 1440, height: 900 };
    this.frames = 0;
  }

  setPixelRatio() {}
  setSize(width, height) { this.size = { width, height }; }
  render() { this.frames += 1; }
  dispose() {}
}

export { HeadlessWebGLRenderer as WebGLRenderer };

/* ------------------------------------------------------------ fake DOM --- */

/**
 * Just enough canvas for the renderer and OrbitControls. Listeners are kept so
 * a test can dispatch a synthetic click and check what got picked.
 */
export function makeCanvas({ width = 1440, height = 900 } = {}) {
  const listeners = new Map();
  const root = {
    addEventListener() {},
    removeEventListener() {}
  };
  return {
    clientWidth: width,
    clientHeight: height,
    style: {},
    listeners,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
    getRootNode: () => root,
    setPointerCapture() {},
    releasePointerCapture() {}
  };
}

/** RoomViewer reads window.devicePixelRatio; Deno has no window. */
export function installWindow() {
  globalThis.window ??= {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {}
  };
}
