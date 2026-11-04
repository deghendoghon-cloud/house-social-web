/**
 * House Social Interior Engine — هندسهٔ بسته، مبلمان شکلی، دوربین از بالا
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
let lastSceneKey = '';
let editMode = false;
let dragTarget = null;
let dragOffset = new THREE.Vector3();
let dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let pointerDownPos = null;


const PALETTE = {
  floor: 0xc49a6c,
  floorEdge: 0x8d6e4a,
  wall: 0xd7ccc8,
  wallEdge: 0x8d7b6a,
  door: 0x5d4037,
  roomWall: 0xbcaaa4,
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

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.8,
    metalness: opts.metalness ?? 0.03,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
  });
}

function boxMesh(w, h, d, color, opts = {}) {
  const geo = new THREE.BoxGeometry(
    Math.max(0.5, w || 1),
    Math.max(0.5, h || 1),
    Math.max(0.5, d || 1)
  );
  const mesh = new THREE.Mesh(geo, mat(color, opts));
  mesh.castShadow = opts.castShadow !== false;
  mesh.receiveShadow = opts.receiveShadow !== false;
  if (opts.edges !== false) {
    const edges = new THREE.EdgesGeometry(geo, 25);
    mesh.add(
      new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: opts.edgeColor ?? 0x333333,
          transparent: true,
          opacity: 0.45,
        })
      )
    );
  }
  return mesh;
}

/** مبلمان ترکیبی بر اساس kindKey */
function buildFurniture(node) {
  const kind = (node.meta && node.meta.kindKey) || '';
  const c = hexColor(node.colorHex, 0xbcaaa4);
  const g = new THREE.Group();
  g.position.set(node.x, 0, node.z);
  if (node.rotY) g.rotation.y = node.rotY;

  const W = node.w || 40;
  const H = node.h || 40;
  const D = node.d || 40;

  if (kind === 'bed') {
    // قاب تخت
    const frame = boxMesh(W, H * 0.35, D, c, { edgeColor: 0x4e342e });
    frame.position.y = H * 0.2;
    g.add(frame);
    // تشک
    const matress = boxMesh(W * 0.92, H * 0.22, D * 0.9, 0xf5f0e8, {
      edgeColor: 0xbbb,
    });
    matress.position.y = H * 0.42;
    g.add(matress);
    // بالش
    const pillow = boxMesh(W * 0.35, H * 0.12, D * 0.28, 0xfff8e1);
    pillow.position.set(0, H * 0.55, -D * 0.28);
    g.add(pillow);
  } else if (kind === 'sofa') {
    const seat = boxMesh(W, H * 0.35, D * 0.75, c);
    seat.position.y = H * 0.25;
    g.add(seat);
    const back = boxMesh(W, H * 0.55, D * 0.18, c);
    back.position.set(0, H * 0.55, -D * 0.35);
    g.add(back);
    const armL = boxMesh(W * 0.1, H * 0.4, D * 0.7, c);
    armL.position.set(-W * 0.45, H * 0.35, 0);
    g.add(armL);
    const armR = boxMesh(W * 0.1, H * 0.4, D * 0.7, c);
    armR.position.set(W * 0.45, H * 0.35, 0);
    g.add(armR);
  } else if (kind === 'chair') {
    const seat = boxMesh(W, H * 0.12, D, c);
    seat.position.y = H * 0.45;
    g.add(seat);
    const back = boxMesh(W, H * 0.4, D * 0.12, c);
    back.position.set(0, H * 0.7, -D * 0.4);
    g.add(back);
    // پایه ساده
    for (const [sx, sz] of [
      [-0.35, -0.35],
      [0.35, -0.35],
      [-0.35, 0.35],
      [0.35, 0.35],
    ]) {
      const leg = boxMesh(W * 0.08, H * 0.45, W * 0.08, 0x5d4037, { edges: false });
      leg.position.set(W * sx, H * 0.22, D * sz);
      g.add(leg);
    }
  } else if (kind === 'table' || kind === 'desk') {
    const top = boxMesh(W, H * 0.1, D, c);
    top.position.y = H * 0.92;
    g.add(top);
    for (const [sx, sz] of [
      [-0.4, -0.4],
      [0.4, -0.4],
      [-0.4, 0.4],
      [0.4, 0.4],
    ]) {
      const leg = boxMesh(W * 0.07, H * 0.88, W * 0.07, 0x4e342e, { edges: false });
      leg.position.set(W * sx, H * 0.44, D * sz);
      g.add(leg);
    }
  } else if (
    kind === 'cabinet' ||
    kind === 'wardrobe' ||
    kind === 'bookshelf' ||
    kind === 'shelf'
  ) {
    const body = boxMesh(W, H, D, c);
    body.position.y = H / 2;
    g.add(body);
    // قفسه‌ها
    for (let i = 1; i <= 3; i++) {
      const shelf = boxMesh(W * 0.9, 2, D * 0.85, 0x3e2723, { edges: false });
      shelf.position.y = (H * i) / 4;
      g.add(shelf);
    }
  } else if (kind === 'tv') {
    const screen = boxMesh(W, H * 0.85, Math.max(6, D), 0x111111);
    screen.position.y = H / 2;
    g.add(screen);
    const bezel = boxMesh(W * 1.02, H * 0.9, Math.max(4, D * 0.6), 0x222222);
    bezel.position.y = H / 2;
    g.add(bezel);
  } else if (kind === 'tv_stand') {
    const body = boxMesh(W, H * 0.7, D, c);
    body.position.y = H * 0.35;
    g.add(body);
  } else if (kind === 'plant') {
    const pot = boxMesh(W * 0.7, H * 0.25, D * 0.7, 0xa1887f);
    pot.position.y = H * 0.12;
    g.add(pot);
    const leaf = boxMesh(W * 0.9, H * 0.7, D * 0.9, 0x388e3c, {
      edgeColor: 0x1b5e20,
    });
    leaf.position.y = H * 0.6;
    g.add(leaf);
  } else if (node.kind === 'content') {
    const plate = boxMesh(W, Math.max(4, H), D, c, { edgeColor: 0x1565c0 });
    plate.position.y = Math.max(4, H) / 2;
    g.add(plate);
  } else {
    const body = boxMesh(W, H, D, c);
    body.position.y = H / 2;
    g.add(body);
  }

  g.userData.selectable = true;
  g.userData.nodeId = node.id;
  g.userData.sourceId = node.sourceId;
  g.userData.name = node.name || node.id;
  g.userData.kind = node.kind;
  g.userData.layoutW = (node.meta && node.meta.layoutW) || node.w || 80;
  g.userData.layoutH = (node.meta && node.meta.layoutH) || node.d || 56;
  selectable.set(node.id, g);
  return g;
}

function buildNode(node, parent) {
  const kind = node.kind;
  let obj = null;
  const color = hexColor(node.colorHex);

  if (kind === 'floor') {
    obj = boxMesh(node.w, Math.max(node.h, 2), node.d, hexColor(node.colorHex, PALETTE.floor), {
      castShadow: false,
      edgeColor: PALETTE.floorEdge,
    });
    obj.position.set(node.x, node.y != null ? node.y : 1, node.z);
    obj.receiveShadow = true;
    if (node.sourceId) {
      obj.userData.selectable = true;
      obj.userData.nodeId = node.id;
      obj.userData.sourceId = node.sourceId;
      obj.userData.name = node.name || node.id;
      obj.userData.kind = 'roomFloor';
      selectable.set(node.id, obj);
    }
  } else if (kind === 'ceiling') {
    obj = boxMesh(node.w, Math.max(node.h, 2), node.d, hexColor(node.colorHex, 0xf5f5f5), {
      castShadow: false,
      edges: false,
    });
    obj.position.set(node.x, node.y || 0, node.z);
    obj.visible = !!(node.meta && node.meta.showCeiling);
  } else if (kind === 'wall') {
    obj = boxMesh(node.w, node.h, node.d, hexColor(node.colorHex, PALETTE.wall), {
      edgeColor: PALETTE.wallEdge,
    });
    obj.position.set(node.x, node.y, node.z);
  } else if (kind === 'door') {
    obj = boxMesh(node.w, node.h, node.d, hexColor(node.colorHex, PALETTE.door), {
      roughness: 0.45,
      edgeColor: 0x3e2723,
    });
    obj.position.set(node.x, node.y, node.z);
  } else if (kind === 'roomShell') {
    // دیوار کوتاه سالن — مات و قابل انتخاب
    obj = boxMesh(node.w, node.h, node.d, hexColor(node.colorHex, PALETTE.roomWall), {
      transparent: false,
      opacity: 1,
      edgeColor: 0x4e342e,
      castShadow: true,
    });
    obj.position.set(node.x, node.y, node.z);
    obj.userData.selectable = true;
    obj.userData.nodeId = node.id;
    obj.userData.sourceId = node.sourceId;
    obj.userData.name = node.name || node.id;
    obj.userData.kind = 'roomShell';
    selectable.set(node.id, obj);
  } else if (kind === 'furniture' || kind === 'content') {
    obj = buildFurniture(node);
  } else if (kind === 'imageOnWall') {
    obj = boxMesh(node.w || 40, node.h || 30, 3, hexColor(node.colorHex, 0xffffff));
    obj.position.set(node.x, node.y, node.z);
    if (node.rotY) obj.rotation.y = node.rotY;
    obj.userData.selectable = true;
    obj.userData.nodeId = node.id;
    obj.userData.sourceId = node.sourceId;
    selectable.set(node.id, obj);
  } else {
    obj = boxMesh(node.w || 20, node.h || 20, node.d || 20, color);
    obj.position.set(node.x || 0, node.y || 0, node.z || 0);
  }

  if (obj) {
    obj.userData.kind = obj.userData.kind || kind;
    parent.add(obj);
  }

  if (node.children && node.children.length) {
    for (const ch of node.children) buildNode(ch, parent);
  }
}

function applyTopDownCamera(data) {
  const cam = data.camera || {};
  // مرکز هدف: از camera یا وسط صحنه
  let tx = cam.targetX;
  let ty = cam.targetY != null ? cam.targetY : 10;
  let tz = cam.targetZ;
  if (tx == null || tz == null) {
    // محاسبه از گره‌های کف
    tx = (data.width || 400) / 2;
    tz = (data.depth || 400) / 2;
  }
  const target = new THREE.Vector3(tx, ty, tz);
  controls.target.copy(target);

  const span = Math.max(data.width || 400, data.depth || 400);
  const dist = cam.distance != null ? cam.distance : span * 1.2 + 80;
  controls.minDistance = cam.minDistance != null ? cam.minDistance : span * 0.35;
  controls.maxDistance = cam.maxDistance != null ? cam.maxDistance : span * 2.8;
  controls.minPolarAngle = cam.minPolar != null ? cam.minPolar : 0.12;
  controls.maxPolarAngle = cam.maxPolar != null ? cam.maxPolar : 1.05;
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.panSpeed = 0.5;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.9;
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // از بالا
  camera.position.set(target.x, target.y + dist, target.z + 0.5);
  controls.update();
}

function buildScene(data) {
  if (!scene || !camera || !controls) return;

  const key = JSON.stringify({
    id: data.roomId || data.hallId || data.name,
    n: (data.nodes || []).length,
    w: data.width,
    d: data.depth,
    v: data.version || 0,
  });
  if (key === lastSceneKey && roomRoot) {
    postToFlutter({ type: 'ready', roomId: data.roomId || data.hallId });
    return;
  }
  lastSceneKey = key;

  clearRoom();
  roomRoot = new THREE.Group();
  roomRoot.name = 'root_' + (data.roomId || data.hallId || 'x');

  for (const n of data.nodes || []) {
    if (n.kind === 'ceiling') {
      n.meta = n.meta || {};
      n.meta.showCeiling = !!(data.camera && data.camera.showCeiling);
    }
    buildNode(n, roomRoot);
  }

  scene.add(roomRoot);

  const amb = new THREE.AmbientLight(0xffffff, 0.7);
  roomRoot.add(amb);
  const dir = new THREE.DirectionalLight(0xfff6e8, 0.8);
  dir.position.set((data.width || 400) * 0.25, (data.height || 280) * 1.6, (data.depth || 400) * 0.2);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  roomRoot.add(dir);
  const fill = new THREE.DirectionalLight(0xd0e4ff, 0.28);
  fill.position.set(-(data.width || 400) * 0.4, (data.height || 280) * 0.7, -(data.depth || 400) * 0.3);
  roomRoot.add(fill);

  applyTopDownCamera(data);

  setHud((data.name || 'فضا') + ' · از بالا · بکشید برای چرخش · دو انگشت زوم');
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
      42,
      Math.max(window.innerWidth, 1) / Math.max(window.innerHeight, 1),
      2,
      8000
    );
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const _hit = new THREE.Vector3();

    function eventToNDC(ev) {
      const rect = canvas.getBoundingClientRect();
      const src = ev.changedTouches ? ev.changedTouches[0] : ev.touches ? ev.touches[0] : ev;
      const cx = src.clientX - rect.left;
      const cy = src.clientY - rect.top;
      if (!rect.width || !rect.height) return null;
      return {
        x: (cx / rect.width) * 2 - 1,
        y: -(cy / rect.height) * 2 + 1,
        clientX: src.clientX,
        clientY: src.clientY,
      };
    }

    function pickSelectable(ndc) {
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...selectable.values()], true);
      if (!hits.length) return null;
      let obj = hits[0].object;
      while (obj && !obj.userData.nodeId && obj.parent) obj = obj.parent;
      return obj && obj.userData.nodeId ? obj : null;
    }

    function onPointerDown(ev) {
      if (!ready) return;
      const ndc = eventToNDC(ev);
      if (!ndc) return;
      pointerDownPos = { x: ndc.clientX, y: ndc.clientY };
      if (!editMode) return;
      const obj = pickSelectable(ndc);
      if (!obj || !obj.userData.sourceId) return;
      // فقط مبلمان/content قابل کشیدن
      const k = obj.userData.kind;
      if (k === 'roomShell' || k === 'roomFloor') return;
      dragTarget = obj;
      // نقطهٔ برخورد با صفحهٔ کف
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.ray.intersectPlane(dragPlane, _hit)) {
        dragOffset.copy(dragTarget.position).sub(_hit);
      } else {
        dragOffset.set(0, 0, 0);
      }
      controls.enabled = false;
      selectNode(obj.userData.nodeId);
      ev.preventDefault();
    }

    function onPointerMove(ev) {
      if (!dragTarget || !editMode) return;
      const ndc = eventToNDC(ev);
      if (!ndc) return;
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.ray.intersectPlane(dragPlane, _hit)) {
        dragTarget.position.x = _hit.x + dragOffset.x;
        dragTarget.position.z = _hit.z + dragOffset.z;
        // y را از ارتفاع قبلی حفظ نکن — group از y=0 ساخته شده
      }
      ev.preventDefault();
    }

    function onPointerUp(ev) {
      if (dragTarget && editMode) {
        const obj = dragTarget;
        const meta = obj.userData;
        // center → layout top-left
        const lw = meta.layoutW || (obj.userData._w) || 80;
        const lh = meta.layoutH || (obj.userData._h) || 56;
        // از meta گره — در buildFurniture ذخیره می‌کنیم
        const layoutW = obj.userData.layoutW || 80;
        const layoutH = obj.userData.layoutH || 56;
        const layoutX = obj.position.x - layoutW / 2;
        const layoutY = obj.position.z - layoutH / 2;
        postToFlutter({
          type: 'itemMoved',
          sourceId: meta.sourceId,
          nodeId: meta.nodeId,
          layoutX: layoutX,
          layoutY: layoutY,
        });
        dragTarget = null;
        controls.enabled = true;
        ev.preventDefault();
        return;
      }
      dragTarget = null;
      controls.enabled = true;

      // کلیک ساده برای انتخاب
      if (!pointerDownPos) return;
      const ndc = eventToNDC(ev);
      if (!ndc) return;
      const dist = Math.hypot(ndc.clientX - pointerDownPos.x, ndc.clientY - pointerDownPos.y);
      pointerDownPos = null;
      if (dist > 8) return;
      const obj = pickSelectable(ndc);
      if (!obj) return;
      selectNode(obj.userData.nodeId);
      postToFlutter({
        type: 'select',
        nodeId: obj.userData.nodeId,
        sourceId: obj.userData.sourceId,
        name: obj.userData.name,
        kind: obj.userData.kind,
      });
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

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
    prev.traverse((c) => {
      if (c.material && c.material.emissive) c.material.emissive.setHex(0x000000);
    });
  }
  selectedId = id;
  if (id && selectable.has(id)) {
    const m = selectable.get(id);
    m.traverse((c) => {
      if (c.material && c.material.emissive) c.material.emissive.setHex(0x1565c0);
    });
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
      window.parent.postMessage(
        JSON.stringify({ source: 'interior_engine', ...msg }),
        '*'
      );
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
  setEditMode(enabled) {
    editMode = !!enabled;
    dragTarget = null;
    if (controls) controls.enabled = true;
    setHud(
      editMode
        ? 'حالت جابه‌جایی: وسیله را بکشید و رها کنید'
        : ((lastSceneKey && 'از بالا · بکشید برای چرخش') || 'آماده')
    );
  },
};

window.addEventListener('message', (ev) => {
  let d = ev.data;
  if (!d) return;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch (_) {
      return;
    }
  }
  if (!d || d.source === 'interior_engine') return;
  const msg = d.payload && typeof d.payload === 'object' ? d.payload : d;
  if (msg.type === 'loadScene' && msg.scene) {
    window.InteriorEngine.loadScene(msg.scene);
  } else if (msg.type === 'select') {
    window.InteriorEngine.select(msg.nodeId);
  } else if (msg.type === 'setQuality') {
    window.InteriorEngine.setQuality(msg.level || 'normal');
  } else if (msg.type === 'setEditMode') {
    window.InteriorEngine.setEditMode(!!msg.enabled);
  }
});

init();
