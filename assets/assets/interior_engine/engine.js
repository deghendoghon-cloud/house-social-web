/**
 * House Social — موتور فضای داخلی / سالن سه‌بعدی (Three.js)
 * دوربین پیش‌فرض از بالا (تقریباً عمود)، شیب تا حدود ۳۰ درجه نسبت به افق.
 * صحنه تا دستور بعدی کاربر ثابت می‌ماند (بازسازی فقط با loadScene).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const errEl = document.getElementById('err');

let renderer, scene, camera, controls;
let roomRoot = null;
let selectable = new Map();
let selectedId = null;
let ready = false;
let sceneVersion = 0;
let lastSceneKey = '';

/** پالت متمایز برای تفکیک کف / دیوار / اتاق / وسیله */
const PALETTE = {
  floor: 0xc4a574,
  floorEdge: 0x8d6e4a,
  wall: 0xe8dcc8,
  wallEdge: 0xa89070,
  ceiling: 0xf0f0f0,
  door: 0x5d4037,
  roomShell: 0x90caf9,
  roomShellEdge: 0x1565c0,
  furniture: [
    0xe57373, 0x64b5f6, 0x81c784, 0xffb74d, 0xba68c8,
    0x4db6ac, 0xff8a65, 0xaed581, 0x7986cb, 0xf06292,
  ],
  content: 0x42a5f5,
  hallFloor: 0xbcaaa4,
};

function showError(msg) {
  if (errEl) {
    errEl.style.display = 'flex';
    errEl.textContent = msg;
  }
  console.error(msg);
}

function setHud(t) {
  if (hud) hud.textContent = t || '';
}

function hexColor(hex, fallback = 0xcccccc) {
  if (!hex || typeof hex !== 'string') return fallback;
  let h = hex.replace('#', '');
  if (h.length === 8) h = h.slice(2);
  if (h.length !== 6) return fallback;
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? n : fallback;
}

function disposeObject(obj) {
  obj.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  });
}

function clearRoom() {
  if (roomRoot && scene) {
    scene.remove(roomRoot);
    disposeObject(roomRoot);
    roomRoot = null;
  }
  selectable.clear();
  selectedId = null;
}

function makeBox(w, h, d, color, opts = {}) {
  const geo = new THREE.BoxGeometry(
    Math.max(0.5, w || 1),
    Math.max(0.5, h || 1),
    Math.max(0.5, d || 1)
  );
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.82,
    metalness: opts.metalness ?? 0.02,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = opts.castShadow !== false;
  mesh.receiveShadow = opts.receiveShadow !== false;

  // لبه برای تفکیک بصری
  if (opts.edges !== false) {
    const edges = new THREE.EdgesGeometry(geo, 20);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: opts.edgeColor ?? 0x333333,
        transparent: true,
        opacity: 0.55,
      })
    );
    mesh.add(line);
  }
  return mesh;
}

function furnitureColor(node, index) {
  if (node.colorHex) return hexColor(node.colorHex);
  if (node.kind === 'content') return PALETTE.content;
  return PALETTE.furniture[index % PALETTE.furniture.length];
}

function buildNode(node, parent, colorIndex) {
  const kind = node.kind;
  let mesh = null;
  let idx = colorIndex;

  if (kind === 'floor') {
    const c = hexColor(node.colorHex, PALETTE.floor);
    mesh = makeBox(node.w, Math.max(node.h, 4), node.d, c, {
      castShadow: false,
      edgeColor: PALETTE.floorEdge,
    });
    mesh.position.set(
      node.x != null ? node.x : node.w / 2,
      Math.max(node.h, 4) / 2,
      node.z != null ? node.z : node.d / 2
    );
    mesh.receiveShadow = true;
  } else if (kind === 'ceiling') {
    mesh = makeBox(node.w, Math.max(node.h, 2), node.d, hexColor(node.colorHex, PALETTE.ceiling), {
      castShadow: false,
      edges: false,
    });
    mesh.position.set(
      node.x != null ? node.x : node.w / 2,
      node.y || 0,
      node.z != null ? node.z : node.d / 2
    );
    mesh.visible = !!(node.meta && node.meta.showCeiling);
  } else if (kind === 'wall') {
    const c = hexColor(node.colorHex, PALETTE.wall);
    mesh = makeBox(node.w, node.h, node.d, c, { edgeColor: PALETTE.wallEdge });
    mesh.position.set(node.x, node.y, node.z);
  } else if (kind === 'door') {
    mesh = makeBox(node.w, node.h, node.d, hexColor(node.colorHex, PALETTE.door), {
      roughness: 0.45,
      edgeColor: 0x3e2723,
    });
    mesh.position.set(node.x, node.y, node.z);
  } else if (kind === 'roomShell') {
    // پوستهٔ نیمه‌شفاف اتاق در نمای سالن
    const c = hexColor(node.colorHex, PALETTE.roomShell);
    mesh = makeBox(node.w, node.h, node.d, c, {
      transparent: true,
      opacity: 0.55,
      edgeColor: PALETTE.roomShellEdge,
      castShadow: false,
    });
    mesh.position.set(node.x, node.y, node.z);
    mesh.userData.selectable = true;
    mesh.userData.nodeId = node.id;
    mesh.userData.sourceId = node.sourceId;
    mesh.userData.name = node.name || node.id;
    mesh.userData.kind = 'roomShell';
    selectable.set(node.id, mesh);
  } else if (kind === 'furniture' || kind === 'content') {
    const c = furnitureColor(node, idx++);
    mesh = makeBox(node.w, node.h, node.d, c, {
      edgeColor: 0x222222,
      roughness: kind === 'content' ? 0.5 : 0.75,
    });
    mesh.position.set(node.x, node.y, node.z);
    if (node.rotY) mesh.rotation.y = node.rotY;
    mesh.userData.selectable = true;
    mesh.userData.nodeId = node.id;
    mesh.userData.sourceId = node.sourceId;
    mesh.userData.name = node.name || node.id;
    selectable.set(node.id, mesh);
  } else if (kind === 'imageOnWall') {
    mesh = makeBox(node.w || 40, node.h || 30, 3, hexColor(node.colorHex, 0xffffff), {
      edgeColor: 0x444444,
    });
    mesh.position.set(node.x, node.y, node.z);
    if (node.rotY) mesh.rotation.y = node.rotY;
    mesh.userData.selectable = true;
    mesh.userData.nodeId = node.id;
    mesh.userData.sourceId = node.sourceId;
    mesh.userData.name = node.name || node.id;
    selectable.set(node.id, mesh);
  } else {
    mesh = makeBox(node.w || 20, node.h || 20, node.d || 20, hexColor(node.colorHex));
    mesh.position.set(node.x || 0, node.y || 0, node.z || 0);
  }

  if (mesh) {
    mesh.userData.kind = kind;
    parent.add(mesh);
  }

  if (node.children && node.children.length) {
    for (const ch of node.children) {
      idx = buildNode(ch, parent, idx);
    }
  }
  return idx;
}

function applyTopDownCamera(data) {
  const cam = data.camera || {};
  const width = data.width || 400;
  const depth = data.depth || 400;
  const target = new THREE.Vector3(
    cam.targetX != null ? cam.targetX : width / 2,
    cam.targetY != null ? cam.targetY : 0,
    cam.targetZ != null ? cam.targetZ : depth / 2
  );
  controls.target.copy(target);

  // فاصله بر اساس اندازهٔ صحنه
  const span = Math.max(width, depth);
  const dist = cam.distance != null ? cam.distance : span * 1.15 + 80;
  controls.minDistance = cam.minDistance != null ? cam.minDistance : span * 0.35;
  controls.maxDistance = cam.maxDistance != null ? cam.maxDistance : span * 2.8;

  // از بالا تقریباً عمود؛ شیب تا حدود ۳۰ درجه نسبت به افق
  // polar=0 → عمود از بالا؛ polar = 60° ≈ π/3 → زاویهٔ دید حدود ۳۰° نسبت به افق
  const minP = cam.minPolar != null ? cam.minPolar : 0.08;
  const maxP = cam.maxPolar != null ? cam.maxPolar : Math.PI / 3;
  controls.minPolarAngle = minP;
  controls.maxPolarAngle = maxP;
  // چرخش افقی آزاد در سالن؛ در اتاق محدودتر اگر مشخص شده باشد
  if (cam.minAzimuth != null) controls.minAzimuthAngle = cam.minAzimuth;
  else controls.minAzimuthAngle = -Infinity;
  if (cam.maxAzimuth != null) controls.maxAzimuthAngle = cam.maxAzimuth;
  else controls.maxAzimuthAngle = Infinity;

  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.panSpeed = 0.45;
  controls.rotateSpeed = 0.4;
  controls.zoomSpeed = 0.85;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  // موقعیت اولیه: دقیقاً بالای مرکز
  camera.position.set(target.x, target.y + dist, target.z + 0.01);
  controls.update();
}

function buildScene(data) {
  if (!scene || !camera || !controls) return;

  // جلوگیری از بازسازی بی‌مورد با همان داده
  const key = JSON.stringify({
    id: data.roomId || data.hallId || data.name,
    n: (data.nodes || []).length,
    w: data.width,
    d: data.depth,
    ver: data.version,
  });
  if (key === lastSceneKey && roomRoot) {
    postToFlutter({ type: 'ready', roomId: data.roomId || data.hallId });
    return;
  }
  lastSceneKey = key;
  sceneVersion += 1;

  clearRoom();
  roomRoot = new THREE.Group();
  roomRoot.name = 'root_' + (data.roomId || data.hallId || 'x');

  const nodes = data.nodes || [];
  let colorIndex = 0;
  for (const n of nodes) {
    if (n.kind === 'ceiling') {
      n.meta = n.meta || {};
      n.meta.showCeiling = !!(data.camera && data.camera.showCeiling);
    }
    colorIndex = buildNode(n, roomRoot, colorIndex);
  }

  scene.add(roomRoot);

  // نور ملایم و ثابت
  const amb = new THREE.AmbientLight(0xffffff, 0.65);
  roomRoot.add(amb);
  const dir = new THREE.DirectionalLight(0xfff8e8, 0.75);
  dir.position.set(
    (data.width || 400) * 0.3,
    (data.height || 280) * 1.5,
    (data.depth || 400) * 0.25
  );
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  roomRoot.add(dir);
  const fill = new THREE.DirectionalLight(0xd0e0ff, 0.3);
  fill.position.set(-(data.width || 400) * 0.4, (data.height || 280) * 0.8, -(data.depth || 400) * 0.3);
  roomRoot.add(fill);

  applyTopDownCamera(data);

  const label = data.name || (data.hallId ? 'سالن' : 'اتاق');
  setHud(label + ' · از بالا · بکشید برای چرخش · دو انگشت زوم');
  ready = true;
  postToFlutter({ type: 'ready', roomId: data.roomId || data.hallId });
}

function init() {
  try {
    if (!canvas) throw new Error('canvas missing');
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'default',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2a32);

    camera = new THREE.PerspectiveCamera(
      45,
      Math.max(window.innerWidth, 1) / Math.max(window.innerHeight, 1),
      2,
      8000
    );
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function onPointer(ev) {
      if (!ready) return;
      const rect = canvas.getBoundingClientRect();
      const cx = (ev.clientX != null ? ev.clientX : (ev.changedTouches && ev.changedTouches[0].clientX)) - rect.left;
      const cy = (ev.clientY != null ? ev.clientY : (ev.changedTouches && ev.changedTouches[0].clientY)) - rect.top;
      if (!rect.width || !rect.height) return;
      pointer.x = (cx / rect.width) * 2 - 1;
      pointer.y = -(cy / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...selectable.values()], true);
      if (hits.length) {
        let obj = hits[0].object;
        while (obj && !obj.userData.nodeId && obj.parent) obj = obj.parent;
        if (!obj || !obj.userData.nodeId) return;
        selectNode(obj.userData.nodeId);
        postToFlutter({
          type: 'select',
          nodeId: obj.userData.nodeId,
          sourceId: obj.userData.sourceId,
          name: obj.userData.name,
          kind: obj.userData.kind,
        });
      }
    }
    canvas.addEventListener('click', onPointer);

    window.addEventListener('resize', () => {
      const w = Math.max(window.innerWidth, 1);
      const h = Math.max(window.innerHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });

    function loop() {
      requestAnimationFrame(loop);
      if (controls) controls.update();
      if (renderer && scene && camera) renderer.render(scene, camera);
    }
    loop();

    setHud('آماده');
    postToFlutter({ type: 'engine_ready' });
  } catch (e) {
    showError('خطا در راه‌اندازی WebGL: ' + (e && e.message ? e.message : e));
  }
}

function selectNode(id) {
  if (selectedId && selectable.has(selectedId)) {
    const prev = selectable.get(selectedId);
    if (prev.material && prev.material.emissive) prev.material.emissive.setHex(0x000000);
  }
  selectedId = id;
  if (id && selectable.has(id)) {
    const m = selectable.get(id);
    if (m.material && m.material.emissive) m.material.emissive.setHex(0x1565c0);
    setHud('انتخاب: ' + (m.userData.name || id));
  }
}

function postToFlutter(msg) {
  const payload = JSON.stringify(msg);
  try {
    if (window.InteriorChannel && typeof window.InteriorChannel.postMessage === 'function') {
      window.InteriorChannel.postMessage(payload);
      return;
    }
  } catch (_) {}
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(JSON.stringify({ source: 'interior_engine', ...msg }), '*');
    }
  } catch (_) {}
}

window.InteriorEngine = {
  loadScene(data) {
    try {
      if (typeof data === 'string') data = JSON.parse(data);
      buildScene(data);
    } catch (e) {
      showError('خطا در بارگذاری صحنه: ' + (e && e.message ? e.message : e));
    }
  },
  select(id) {
    selectNode(id);
  },
  setQuality(level) {
    if (!renderer) return;
    const pr =
      level === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, level === 'high' ? 2 : 1.5);
    renderer.setPixelRatio(pr);
  },
  resetCamera() {
    if (lastSceneKey) {
      // فقط دوربین را به حالت از بالا برگردان؛ صحنه را خراب نکن
      try {
        const data = JSON.parse(lastSceneKey);
        // lastSceneKey فشرده است؛ از target فعلی controls استفاده می‌کنیم
        const t = controls.target.clone();
        const dist = camera.position.distanceTo(t) || 400;
        camera.position.set(t.x, t.y + dist, t.z + 0.01);
        controls.update();
      } catch (_) {}
    }
  },
};

window.addEventListener('message', (ev) => {
  let d = ev.data;
  if (!d) return;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (_) { return; }
  }
  if (!d || d.source === 'interior_engine') return;
  const msg = d.payload && typeof d.payload === 'object' ? d.payload : d;
  if (msg.type === 'loadScene' && msg.scene) {
    window.InteriorEngine.loadScene(msg.scene);
  } else if (msg.type === 'select') {
    window.InteriorEngine.select(msg.nodeId);
  } else if (msg.type === 'setQuality') {
    window.InteriorEngine.setQuality(msg.level || 'normal');
  } else if (msg.type === 'resetCamera') {
    window.InteriorEngine.resetCamera();
  }
});

init();
