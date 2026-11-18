// CPU microbenchmark for 100,000 cuboids + 120,000 LiDAR points per frame.
// Runs directly on Node 22.18+ / 24+ using built-in TypeScript stripping + module resolution hooks.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BoxGeometry, Mesh, Raycaster, Vector3 } from 'three';
import ts from 'typescript';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const aliasedBase = resolve(REPO_ROOT, 'src', specifier.slice(2));
      const directTs = `${aliasedBase}.ts`;
      if (existsSync(directTs)) {
        return nextResolve(pathToFileURL(directTs).href, context);
      }
      const indexTs = resolve(aliasedBase, 'index.ts');
      if (existsSync(indexTs)) {
        return nextResolve(pathToFileURL(indexTs).href, context);
      }
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL?.startsWith('file:')
    ) {
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const directTs = resolve(parentDir, `${specifier}.ts`);
      if (existsSync(directTs)) {
        return nextResolve(pathToFileURL(directTs).href, context);
      }
      const indexTs = resolve(parentDir, specifier, 'index.ts');
      if (existsSync(indexTs)) {
        return nextResolve(pathToFileURL(indexTs).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const filePath = fileURLToPath(url);
      const rawSource = readFileSync(filePath, 'utf8');
      const transpiled = ts.transpileModule(rawSource, {
        fileName: filePath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      });
      return {
        format: 'module',
        shortCircuit: true,
        source: transpiled.outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const { Cvat3dPreRenderEnhancer, DEFAULT_CVAT_3D_RENDER_OPTIONS } =
  await import('../src/integration/cvat/runtime/pre-render-enhancer.ts');
const { ActiveObjectCameraFollower } =
  await import('../src/integration/cvat/runtime/camera-follow.ts');
const { lockRaycasterHoverToActiveObject } =
  await import('../src/integration/cvat/runtime/hover-lock.ts');
const { evaluateSpatialAndPointCloudWarnings } =
  await import('../src/integration/cvat/runtime/active-object-qa-overlay.ts');

let findObjectStateByClientId = null;
const stateLookupPath = resolve(REPO_ROOT, 'src/integration/cvat/runtime/state-lookup.ts');
if (existsSync(stateLookupPath)) {
  const stateLookupMod = await import(pathToFileURL(stateLookupPath).href);
  if (typeof stateLookupMod.findObjectStateByClientId === 'function') {
    findObjectStateByClientId = stateLookupMod.findObjectStateByClientId;
  }
}

const CUBOID_COUNT = 100_000;
const POINT_COUNT = 120_000;
const POINT_FLOATS = POINT_COUNT * 3;
const FILTERED_CUBOID_COUNT = 200;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function roundMs(ms) {
  return Math.round(ms * 100) / 100;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return roundMs(sorted[Math.floor(sorted.length / 2)]);
}

class MockSceneNode {
  updateMatrix() {}
  updateMatrixWorld() {}
}

class MockArrowHelper extends MockSceneNode {
  constructor() {
    super();
    this.type = 'ArrowHelper';
    this.visible = false;
    this.children = [];
  }
}

class MockWireframe extends MockSceneNode {
  constructor() {
    super();
    this.type = 'LineSegments';
    this.visible = true;
    this.children = [];
  }
}

class MockScene extends MockSceneNode {
  constructor(children = []) {
    super();
    this.type = 'Scene';
    this.background = {
      r: 0,
      g: 0,
      b: 0,
      set(val) {
        const isWhite = val === 0xffffff || val === '#ffffff';
        this.r = isWhite ? 1 : 0;
        this.g = isWhite ? 1 : 0;
        this.b = isWhite ? 1 : 0;
      },
    };
    this.children = children;
  }
  onBeforeRender() {}
}

class MockPoints extends MockSceneNode {
  constructor(geometry, material) {
    super();
    this.type = 'Points';
    this.visible = true;
    this.geometry = geometry;
    this.material = material;
    this.children = [];
  }
  onBeforeRender() {}
}

function createMockColor(r = 0.2, g = 0.85, b = 1.0) {
  return {
    r,
    g,
    b,
    set() {},
  };
}

function createPointsCloud(basePositions, baseColors) {
  const posCopy = new Float32Array(basePositions);
  const colCopy = new Float32Array(baseColors);
  const geometry = {
    attributes: {
      position: { array: posCopy, count: POINT_COUNT, needsUpdate: false },
      color: { array: colCopy, count: POINT_COUNT, needsUpdate: false },
    },
    drawRange: { start: 0, count: POINT_COUNT },
    setDrawRange(start, count) {
      this.drawRange.start = start;
      this.drawRange.count = count;
    },
    clone() {
      const clonedPos = new Float32Array(this.attributes.position.array);
      const clonedCol = new Float32Array(this.attributes.color.array);
      return {
        attributes: {
          position: { array: clonedPos, count: POINT_COUNT, needsUpdate: false },
          color: { array: clonedCol, count: POINT_COUNT, needsUpdate: false },
        },
        drawRange: { start: this.drawRange.start, count: this.drawRange.count },
        setDrawRange(start, count) {
          this.drawRange.start = start;
          this.drawRange.count = count;
        },
      };
    },
  };
  const createMaterial = () => ({
    size: 0.05,
    sizeAttenuation: true,
    vertexColors: true,
    opacity: 1,
    transparent: false,
    needsUpdate: false,
    color: createMockColor(1, 1, 1),
    clone() {
      return createMaterial();
    },
  });
  const perspPoints = new MockPoints(geometry, createMaterial());
  const topPoints = new MockPoints(geometry, createMaterial());
  return { perspPoints, topPoints };
}

function createCanvasDomElement(viewClass) {
  return {
    style: { backgroundColor: '' },
    getAttribute(attr) {
      return attr === 'data-frame-number' ? '1' : null;
    },
    closest(selector) {
      if (typeof selector !== 'string') return null;
      return selector.includes(viewClass) ? {} : null;
    },
  };
}

// Deterministic dataset generation (`seeded(42)`)
const setupStart = performance.now();
const rand = seeded(42);

const sharedBoxGeometry = new BoxGeometry(1, 1, 1);
sharedBoxGeometry.computeBoundingSphere();
const sharedWireframe = new MockWireframe();
const sharedOrthoMeshStub = {
  material: { color: createMockColor(), depthWrite: true },
};

const QA_TARGET_ID = 50_000;
const QA_TARGET_X = 24.0;
const QA_TARGET_Y = 2.0;
const QA_TARGET_Z = 0.35;

const states100k = new Array(CUBOID_COUNT);
const meshList100k = new Array(CUBOID_COUNT);
const allArrows = new Array(CUBOID_COUNT * 3);
const drawnObjects100k = {};
const drawnObjects200 = {};

for (let i = 0; i < CUBOID_COUNT; i += 1) {
  let x = 0;
  let y = 0;
  let z = -0.75 + (rand() - 0.5) * 0.25;
  const rx = (rand() - 0.5) * 0.04;
  const ry = (rand() - 0.5) * 0.04;
  let rz = (rand() - 0.5) * Math.PI * 2;
  let L = 3.8 + rand() * 1.4;
  let W = 1.7 + rand() * 0.35;
  let H = 1.5 + rand() * 0.35;

  if (i === QA_TARGET_ID) {
    x = QA_TARGET_X;
    y = QA_TARGET_Y;
    z = QA_TARGET_Z;
    rz = 0.1;
    L = 4.4;
    W = 1.9;
    H = 1.6;
  } else if (i === CUBOID_COUNT - 2) {
    // Late overlapping duplicate to force full-table [F] scan when unindexed
    x = QA_TARGET_X + 0.25;
    y = QA_TARGET_Y - 0.15;
    z = QA_TARGET_Z;
    rz = 0.12;
    L = 4.4;
    W = 1.9;
    H = 1.6;
  } else if (i === 10 || i === 50_010) {
    // 2 outlier boxes at x = 4500m
    x = 4500;
    y = i === 10 ? 6 : -6;
  } else if (i >= 20 && i < 25) {
    // 5 large 40m x 40m boxes
    x = (rand() - 0.5) * 120;
    y = (rand() - 0.5) * 24;
    L = 40;
    W = 40;
    H = 4.0;
  } else if (rand() < 0.8) {
    // 80% along the [-80..80]m x [-15..15]m road corridor
    x = (rand() - 0.5) * 160;
    y = (rand() - 0.5) * 30;
    if (Math.hypot(x - QA_TARGET_X, y - QA_TARGET_Y) < 3.5) {
      x += 6.0;
    }
  } else {
    // 20% widely dispersed
    x = (rand() - 0.5) * 480;
    y = (rand() - 0.5) * 360;
    if (Math.hypot(x - QA_TARGET_X, y - QA_TARGET_Y) < 3.5) {
      x -= 6.0;
    }
  }

  const points = [x, y, z, rx, ry, rz, L, W, H];
  const state = {
    clientID: i,
    frame: 1,
    shapeType: 'cuboid',
    points,
    hidden: false,
    outside: false,
    occluded: false,
    attributes: {},
  };
  states100k[i] = state;

  const arrowX = new MockArrowHelper();
  const arrowY = new MockArrowHelper();
  const arrowZ = new MockArrowHelper();
  const arrowBase = i * 3;
  allArrows[arrowBase] = arrowX;
  allArrows[arrowBase + 1] = arrowY;
  allArrows[arrowBase + 2] = arrowZ;

  const perspMaterial = { color: createMockColor(), depthWrite: true };
  const mesh = new Mesh(sharedBoxGeometry, perspMaterial);
  mesh.name = String(i);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.scale.set(L, W, H);
  mesh.updateMatrixWorld();
  mesh.children = [arrowX, arrowY, arrowZ, sharedWireframe];
  meshList100k[i] = mesh;

  const entry = {
    data: {
      clientID: i,
      labelColor: '#33ddff',
      points,
      hidden: false,
      outside: false,
    },
    state,
    cuboid: {
      perspective: mesh,
      top: sharedOrthoMeshStub,
      side: sharedOrthoMeshStub,
      front: sharedOrthoMeshStub,
      orientationArrows: {
        perspective: { x: arrowX, y: arrowY, z: arrowZ },
      },
    },
  };
  drawnObjects100k[i] = entry;
  if (i < FILTERED_CUBOID_COUNT) {
    drawnObjects200[i] = entry;
  }
}

const basePositions = new Float32Array(POINT_FLOATS);
const baseColors = new Float32Array(POINT_FLOATS);
for (let i = 0; i < POINT_FLOATS; i += 3) {
  const inCorridor = rand() < 0.16;
  if (inCorridor) {
    basePositions[i] = (rand() - 0.5) * 160;
    basePositions[i + 1] = (rand() - 0.5) * 30;
    // Half road-surface points (~ -1.62m), half elevated object points
    basePositions[i + 2] = rand() < 0.55 ? -1.65 + rand() * 0.12 : -1.2 + rand() * 2.4;
  } else {
    basePositions[i] = (rand() - 0.5) * 320;
    basePositions[i + 1] = (rand() - 0.5) * 220;
    basePositions[i + 2] = -1.6 + rand() * 5.0;
  }
  const intensity = 0.35 + rand() * 0.55;
  baseColors[i] = intensity;
  baseColors[i + 1] = intensity;
  baseColors[i + 2] = intensity;
}

const CUBOID_INITIALIZED_SYM = Symbol.for('meowCuboidInitialized');
const nativeMockNodeUpdateMatrixWorld = MockSceneNode.prototype.updateMatrixWorld;
const nativeThreeMeshUpdateMatrixWorld = Mesh.prototype.updateMatrixWorld;

function resetArrowHooks() {
  for (let i = 0; i < allArrows.length; i += 1) {
    allArrows[i].updateMatrixWorld = nativeMockNodeUpdateMatrixWorld;
  }
  for (let i = 0; i < meshList100k.length; i += 1) {
    meshList100k[i].updateMatrixWorld = nativeThreeMeshUpdateMatrixWorld;
    drawnObjects100k[i].cuboid[CUBOID_INITIALIZED_SYM] = false;
  }
}

function createMockCanvas3d(includeTopView) {
  const initialCloud = createPointsCloud(
    basePositions.subarray(0, 300),
    baseColors.subarray(0, 300)
  );
  const perspScene = new MockScene([initialCloud.perspPoints]);
  const perspDom = createCanvasDomElement('cvat-canvas3d-perspective');
  const perspCamera = { isPerspectiveCamera: true, type: 'PerspectiveCamera' };
  const topScene = includeTopView ? new MockScene([initialCloud.topPoints]) : null;
  const topDom = includeTopView ? createCanvasDomElement('cvat-canvas3d-topview') : null;
  const topCamera = includeTopView
    ? { isOrthographicCamera: true, type: 'OrthographicCamera' }
    : null;

  const views = {
    perspective: {
      scene: perspScene,
      camera: perspCamera,
      renderer: {
        domElement: perspDom,
        setClearColor() {},
        render(scn, cam) {
          scn.onBeforeRender?.(this, scn, cam);
        },
      },
    },
  };

  if (includeTopView && topScene && topDom && topCamera) {
    views.top = {
      scene: topScene,
      camera: topCamera,
      renderer: {
        domElement: topDom,
        setClearColor() {},
        render(scn, cam) {
          scn.onBeforeRender?.(this, scn, cam);
        },
      },
    };
  }

  const model = {
    data: {
      imageID: 0,
      isFrameUpdating: false,
      configuration: { colorBy: 'Label' },
    },
    objects: states100k,
  };

  const view = {
    views,
    drawnObjects: {},
    onSceneImageLoaded(nextCloud) {
      perspScene.children[0] = nextCloud.perspPoints;
      if (topScene && nextCloud.topPoints) {
        topScene.children[0] = nextCloud.topPoints;
      }
    },
    notify() {},
    render() {
      views.perspective.renderer.render(perspScene, perspCamera);
      if (views.top && topScene && topCamera) {
        views.top.renderer.render(topScene, topCamera);
      }
    },
  };

  return { canvas3d: { view, model }, perspScene, topScene };
}

const setupMs = roundMs(performance.now() - setupStart);

// ---------------------------------------------------------------------------
// 1. next-frame-default (1 warmup + 3 runs)
// ---------------------------------------------------------------------------
function measureNextFrameDefault() {
  const samples = [];
  for (let run = 0; run < 4; run += 1) {
    resetArrowHooks();
    const { canvas3d, perspScene } = createMockCanvas3d(false);
    const enhancer = new Cvat3dPreRenderEnhancer({
      ...DEFAULT_CVAT_3D_RENDER_OPTIONS,
      colorPointsByCuboid: false,
      hideGroundPoints: false,
    });
    enhancer.ensureHooked(canvas3d);

    const nextCloud = createPointsCloud(basePositions, baseColors);
    const sceneChildren = new Array(CUBOID_COUNT + 1);
    sceneChildren[0] = nextCloud.perspPoints;
    for (let i = 0; i < CUBOID_COUNT; i += 1) {
      sceneChildren[i + 1] = meshList100k[i];
    }

    const t0 = performance.now();
    canvas3d.model.data.imageID = 1;
    canvas3d.view.notify(canvas3d.model, 'image_changed');
    perspScene.children = sceneChildren;
    canvas3d.view.onSceneImageLoaded(nextCloud);
    canvas3d.view.drawnObjects = drawnObjects100k;
    canvas3d.view.notify(canvas3d.model, 'objects_updated');
    canvas3d.view.render();
    const elapsed = performance.now() - t0;

    if (run >= 1) {
      samples.push(elapsed);
    }
  }
  return { medianMs: median(samples), runsMs: samples.map(roundMs) };
}

// ---------------------------------------------------------------------------
// 2. filter-toggle-default: 100,000 -> 200 -> 100,000 on same frame (1 warmup + 3 runs)
// ---------------------------------------------------------------------------
function measureFilterToggleDefault() {
  resetArrowHooks();
  const { canvas3d, perspScene } = createMockCanvas3d(false);
  const enhancer = new Cvat3dPreRenderEnhancer({
    ...DEFAULT_CVAT_3D_RENDER_OPTIONS,
    colorPointsByCuboid: false,
    hideGroundPoints: false,
  });
  enhancer.ensureHooked(canvas3d);

  const cloud = createPointsCloud(basePositions, baseColors);
  const sceneChildren = new Array(CUBOID_COUNT + 1);
  sceneChildren[0] = cloud.perspPoints;
  for (let i = 0; i < CUBOID_COUNT; i += 1) {
    sceneChildren[i + 1] = meshList100k[i];
  }
  canvas3d.model.data.imageID = 1;
  canvas3d.view.notify(canvas3d.model, 'image_changed');
  perspScene.children = sceneChildren;
  canvas3d.view.onSceneImageLoaded(cloud);
  canvas3d.view.drawnObjects = drawnObjects100k;
  canvas3d.view.notify(canvas3d.model, 'objects_updated');
  canvas3d.view.render();

  const samples = [];
  for (let run = 0; run < 4; run += 1) {
    const t0 = performance.now();
    canvas3d.view.drawnObjects = drawnObjects200;
    canvas3d.view.notify(canvas3d.model, 'objects_updated');
    canvas3d.view.render();

    canvas3d.view.drawnObjects = drawnObjects100k;
    canvas3d.view.notify(canvas3d.model, 'objects_updated');
    canvas3d.view.render();
    const elapsed = performance.now() - t0;

    if (run >= 1) {
      samples.push(elapsed);
    }
  }
  return { medianMs: median(samples), runsMs: samples.map(roundMs) };
}

// ---------------------------------------------------------------------------
// 3. next-frame-colored-ground: colorPointsByCuboid + hideGroundPoints on Perspective + Top
// ---------------------------------------------------------------------------
function measureNextFrameColoredGround() {
  // Lightweight JIT warmup on 200 cuboids + 6,000 points so V8 optimizes hot loops first
  {
    const { canvas3d, perspScene } = createMockCanvas3d(true);
    const warmEnhancer = new Cvat3dPreRenderEnhancer({
      ...DEFAULT_CVAT_3D_RENDER_OPTIONS,
      colorPointsByCuboid: true,
      hideGroundPoints: true,
    });
    warmEnhancer.ensureHooked(canvas3d);
    const warmCloud = createPointsCloud(
      basePositions.subarray(0, 18_000),
      baseColors.subarray(0, 18_000)
    );
    canvas3d.model.data.imageID = 1;
    canvas3d.view.notify(canvas3d.model, 'image_changed');
    perspScene.children = [warmCloud.perspPoints, ...meshList100k.slice(0, FILTERED_CUBOID_COUNT)];
    canvas3d.view.onSceneImageLoaded(warmCloud);
    canvas3d.view.drawnObjects = drawnObjects200;
    canvas3d.view.notify(canvas3d.model, 'objects_updated');
    canvas3d.view.render();
  }

  const samples = [];
  for (let run = 0; run < 3; run += 1) {
    resetArrowHooks();
    const { canvas3d, perspScene } = createMockCanvas3d(true);
    const enhancer = new Cvat3dPreRenderEnhancer({
      ...DEFAULT_CVAT_3D_RENDER_OPTIONS,
      colorPointsByCuboid: true,
      hideGroundPoints: true,
    });
    enhancer.ensureHooked(canvas3d);

    const nextCloud = createPointsCloud(basePositions, baseColors);
    const sceneChildren = new Array(CUBOID_COUNT + 1);
    sceneChildren[0] = nextCloud.perspPoints;
    for (let i = 0; i < CUBOID_COUNT; i += 1) {
      sceneChildren[i + 1] = meshList100k[i];
    }

    const t0 = performance.now();
    canvas3d.model.data.imageID = 1;
    canvas3d.view.notify(canvas3d.model, 'image_changed');
    perspScene.children = sceneChildren;
    canvas3d.view.onSceneImageLoaded(nextCloud);
    canvas3d.view.drawnObjects = drawnObjects100k;
    canvas3d.view.notify(canvas3d.model, 'objects_updated');
    canvas3d.view.render();
    const elapsed = performance.now() - t0;

    samples.push(elapsed);
  }
  return { medianMs: median(samples), runsMs: samples.map(roundMs) };
}

// ---------------------------------------------------------------------------
// 4. steady-render-60-ticks: CameraFollower.tick + hover-locked Raycaster (30 active + 30 idle)
// ---------------------------------------------------------------------------
function measureSteadyRender60Ticks() {
  let activeId = '99999';
  const follower = new ActiveObjectCameraFollower(
    () => activeId,
    () => true
  );
  const followView = {
    views: {
      perspective: {
        camera: { position: { x: 0, y: -15, z: 3 } },
        controls: null,
      },
    },
    drawnObjects: drawnObjects100k,
    render() {},
  };
  const followModel = {
    data: {
      imageID: 1,
      isFrameUpdating: false,
      objects: states100k,
    },
    objects: states100k,
  };

  const rayCaster = new Raycaster(new Vector3(0, 0, 50), new Vector3(0, 0, -1));
  lockRaycasterHoverToActiveObject(
    rayCaster,
    () => activeId,
    () => true
  );

  // Warmup (2 active ticks + 2 idle ticks)
  activeId = '99999';
  follower.tick(followView, followModel);
  rayCaster.intersectObjects(meshList100k, false);
  activeId = null;
  follower.tick(followView, followModel);
  rayCaster.intersectObjects(meshList100k, false);

  const totalSamples = [];
  const activeSamples = [];
  const idleSamples = [];

  for (let run = 0; run < 3; run += 1) {
    activeId = '99999';
    const tActive0 = performance.now();
    for (let tick = 0; tick < 30; tick += 1) {
      follower.tick(followView, followModel);
      rayCaster.intersectObjects(meshList100k, false);
    }
    const activeMs = performance.now() - tActive0;

    activeId = null;
    const tIdle0 = performance.now();
    for (let tick = 0; tick < 30; tick += 1) {
      follower.tick(followView, followModel);
      rayCaster.intersectObjects(meshList100k, false);
    }
    const idleMs = performance.now() - tIdle0;

    activeSamples.push(activeMs);
    idleSamples.push(idleMs);
    totalSamples.push(activeMs + idleMs);
  }

  return {
    medianMs: median(totalSamples),
    active30TicksMedianMs: median(activeSamples),
    idle30TicksMedianMs: median(idleSamples),
    runsMs: totalSamples.map(roundMs),
  };
}

// ---------------------------------------------------------------------------
// 5. qa-spatial-100k: evaluateSpatialAndPointCloudWarnings ([F] + fallback [Z]) + state lookup
// ---------------------------------------------------------------------------
function measureQaSpatial100k() {
  const targetEntry = drawnObjects100k[QA_TARGET_ID];
  const targetPoints = targetEntry.data.points;
  // 8 internal mid-body points inside box #50000 with NO ground ring / under-box points
  // -> exercises full [F] overlap scan AND full [Z] neighbor fallback scan!
  const localBodyPoints = new Float32Array(8 * 3);
  for (let k = 0; k < 8; k += 1) {
    localBodyPoints[k * 3] = QA_TARGET_X + (k % 2 === 0 ? -0.6 : 0.6);
    localBodyPoints[k * 3 + 1] = QA_TARGET_Y + (k < 4 ? -0.35 : 0.35);
    localBodyPoints[k * 3 + 2] = QA_TARGET_Z + (k % 4) * 0.12 - 0.65;
  }

  // Warmup
  const warmQa = evaluateSpatialAndPointCloudWarnings({
    clientID: QA_TARGET_ID,
    currentPoints: targetPoints,
    occluded: false,
    outside: false,
    drawnObjects: drawnObjects100k,
    positionArray: localBodyPoints,
  });

  const qaSamples = [];
  for (let run = 0; run < 5; run += 1) {
    const t0 = performance.now();
    evaluateSpatialAndPointCloudWarnings({
      clientID: QA_TARGET_ID,
      currentPoints: targetPoints,
      occluded: false,
      outside: false,
      drawnObjects: drawnObjects100k,
      positionArray: localBodyPoints,
    });
    qaSamples.push(performance.now() - t0);
  }

  // Compare 60 state lookups (30 hits near tail `99999` + 30 misses `100005` for filtered object)
  const statesFindSamples = [];
  for (let run = 0; run < 5; run += 1) {
    const t0 = performance.now();
    for (let q = 0; q < 30; q += 1) {
      states100k.find((s) => Number(s?.clientID) === 99_999);
      states100k.find((s) => Number(s?.clientID) === 100_005);
    }
    statesFindSamples.push(performance.now() - t0);
  }

  let stateLookup60CallsMedianMs = null;
  let stateLookupCached60CallsMedianMs = null;
  if (findObjectStateByClientId) {
    const freshLookupSamples = [];
    for (let run = 0; run < 5; run += 1) {
      const freshStates = states100k.slice();
      const t0 = performance.now();
      for (let q = 0; q < 30; q += 1) {
        findObjectStateByClientId(freshStates, 99_999);
        findObjectStateByClientId(freshStates, 100_005);
      }
      freshLookupSamples.push(performance.now() - t0);
    }
    stateLookup60CallsMedianMs = median(freshLookupSamples);

    // Warm WeakMap on `states100k` then measure 60 steady-state lookups on same Redux array
    findObjectStateByClientId(states100k, 100_005);
    const cachedLookupSamples = [];
    for (let run = 0; run < 5; run += 1) {
      const t0 = performance.now();
      for (let q = 0; q < 30; q += 1) {
        findObjectStateByClientId(states100k, 99_999);
        findObjectStateByClientId(states100k, 100_005);
      }
      cachedLookupSamples.push(performance.now() - t0);
    }
    stateLookupCached60CallsMedianMs = median(cachedLookupSamples);
  }

  return {
    medianMs: median(qaSamples),
    qaWarningsTriggered: warmQa.warnings.map((w) => w.code),
    statesFind60CallsMedianMs: median(statesFindSamples),
    stateLookup60CallsMedianMs,
    stateLookupCached60CallsMedianMs,
    runsMs: qaSamples.map(roundMs),
  };
}

const totalStart = performance.now();
const results = {
  meta: {
    cuboids: CUBOID_COUNT,
    lidarPoints: POINT_COUNT,
    seed: 42,
    node: process.version,
    setupMs,
  },
  'next-frame-default': measureNextFrameDefault(),
  'filter-toggle-default': measureFilterToggleDefault(),
  'next-frame-colored-ground': measureNextFrameColoredGround(),
  'steady-render-60-ticks': measureSteadyRender60Ticks(),
  'qa-spatial-100k': measureQaSpatial100k(),
};
results.meta.totalBenchmarkMs = roundMs(performance.now() - totalStart);

console.log(JSON.stringify(results, null, 2));
