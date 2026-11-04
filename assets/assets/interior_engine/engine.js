/**
 * House Social — موتور فضای داخلی سه‌بعدی (Three.js)
 * نسخهٔ اولیه: کف، دیوار، در، وسایل ساده، دوربین محدود، انتخاب.
 * داده از Flutter با postMessage / channel دریافت می‌شود.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const errEl = document.getElementById('err');

let renderer, scene, camera, controls;
let roomRoot = null;
let selectable = new Map(); // id -> mesh
let selectedId = null;
let ready = false;

function showError(msg) {
  errEl.style.display = 'flex';
  errEl.textContent = msg;
  console.error(msg);
}

function setHud(t) {
  hud.textContent = t || '';
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
  if (roomRoot) {
    scene.remove(roomRoot);
    disposeObject(roomRoot);
    roomRoot = null;
  }
  selectable.clear();
  selectedId = null;
}

function makeBox(w, h, d, color, opts = {}) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.75,
    metalness: opts.metalness ?? 0.05,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = opts.castShadow !== false;
  mesh.receiveShadow = opts.receiveShadow !== false;
  return mesh;
}

function buildNode(node, parent) {
  const kind = node.kind;
  let mesh = null;
  const color = hexColor(node.colorHex);

  if (kind === 'floor') {
    mesh = makeBox(node.w, Math.max(node.h, 2), node.d, color, { castShadow: false });
    mesh.position.set(node.x || node.w / 2, (node.h || 2) / 2, node.z || node.d / 2);
    mesh.receiveShadow = true;
  } else if (kind === 'ceiling') {
    const visible = node.meta?.visibleDefault !== false && node.meta?.showCeiling;
    mesh = makeBox(node.w, Math.max(node.h, 2), node.d, color, { castShadow: false });
    mesh.position.set(node.x || node.w / 2, node.y || 0, node.z || node.d / 2);
    mesh.visible = !!visible;
  } else if (kind === 'wall') {
    mesh = makeBox(node.w, node.h, node.d, color);
    mesh.position.set(node.x, node.y, node.z);
    // اگر hasDoor روی دیوار جلو است، یک شکاف ساده با رنگ تیره‌تر نشان می‌دهیم (در جدا اضافه می‌شود)
  } else if (kind === 'door') {
    mesh = makeBox(node.w, node.h, node.d, color, { roughness: 0.5 });
    mesh.position.set(node.x, node.y, node.z);
  } else if (kind === 'furniture' || kind === 'content') {
    mesh = makeBox(node.w, node.h, node.d, color);
    mesh.position.set(node.x, node.y, node.z);
    if (node.rotY) mesh.rotation.y = node.rotY;
    // نشانگر انتخاب
    mesh.userData.selectable = true;
    mesh.userData.nodeId = node.id;
    mesh.userData.sourceId = node.sourceId;
    mesh.userData.name = node.name || node.id;
    selectable.set(node.id, mesh);
  } else if (kind === 'imageOnWall') {
    mesh = makeBox(node.w || 40, node.h || 30, 2, color);
    mesh.position.set(node.x, node.y, node.z);
    if (node.rotY) mesh.rotation.y = node.rotY;
    mesh.userData.selectable = true;
    mesh.userData.nodeId = node.id;
    selectable.set(node.id, mesh);
  } else {
    // ناشناخته — جعبهٔ ساده
    mesh = makeBox(node.w || 20, node.h || 20, node.d || 20, color);
    mesh.position.set(node.x || 0, node.y || 0, node.z || 0);
  }

  if (mesh) {
    mesh.userData.kind = kind;
    parent.add(mesh);
  }

  if (node.children && node.children.length) {
    const group = new THREE.Group();
    group.position.copy(mesh ? mesh.position : new THREE.Vector3());
    if (mesh) parent.remove(mesh); // فرزندان نسبت به والد
    // ساده‌سازی نسخهٔ اول: فرزندان در همان سطح (نسخهٔ بعد سلسله‌مراتب واقعی)
    for (const ch of node.children) buildNode(ch, parent);
  }
}

function buildScene(data) {
  clearRoom();
  roomRoot = new THREE.Group();
  roomRoot.name = 'room_' + (data.roomId || 'x');

  const nodes = data.nodes || [];
  for (const n of nodes) {
    // سقف را فقط اگر camera.showCeiling باشد نشان بده
    if (n.kind === 'ceiling') {
      n.meta = n.meta || {};
      n.meta.showCeiling = !!(data.camera && data.camera.showCeiling);
    }
    buildNode(n, roomRoot);
  }

  scene.add(roomRoot);

  // نور
  const amb = new THREE.AmbientLight(0xffffff, 0.55);
  roomRoot.add(amb);
  const dir = new THREE.DirectionalLight(0xfff5e6, 0.85);
  dir.position.set(data.width * 0.4, data.height * 1.2, data.depth * 0.3);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.near = 10;
  dir.shadow.camera.far = 2000;
  roomRoot.add(dir);
  const fill = new THREE.DirectionalLight(0xcce0ff, 0.25);
  fill.position.set(-data.width * 0.5, data.height * 0.6, -data.depth * 0.4);
  roomRoot.add(fill);

  // دوربین محدود
  const cam = data.camera || {};
  const target = new THREE.Vector3(
    cam.targetX ?? data.width / 2,
    cam.targetY ?? 40,
    cam.targetZ ?? data.depth / 2
  );
  controls.target.copy(target);
  const dist = cam.distance ?? 400;
  camera.position.set(target.x, target.y + dist * 0.45, target.z + dist * 0.75);
  controls.minDistance = cam.minDistance ?? 120;
  controls.maxDistance = cam.maxDistance ?? 900;
  controls.minPolarAngle = cam.minPolar ?? 0.35;
  controls.maxPolarAngle = cam.maxPolar ?? 1.35;
  controls.minAzimuthAngle = cam.minAzimuth ?? -1.2;
  controls.maxAzimuthAngle = cam.maxAzimuth ?? 1.2;
  controls.enablePan = true;
  controls.panSpeed = 0.6;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.update();

  setHud(`${data.name || 'اتاق'} · لمس و کشیدن برای چرخش · دو انگشت زوم`);
  ready = true;
  postToFlutter({ type: 'ready', roomId: data.roomId });
}

function init() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e24);
    scene.fog = new THREE.Fog(0x1e1e24, 800, 2200);

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 5, 5000);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // انتخاب با کلیک/لمس
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function onPointer(ev) {
      if (!ready) return;
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX ?? ev.touches?.[0]?.clientX) - rect.left;
      const y = (ev.clientY ?? ev.touches?.[0]?.clientY) - rect.top;
      pointer.x = (x / rect.width) * 2 - 1;
      pointer.y = -(y / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...selectable.values()], false);
      if (hits.length) {
        const m = hits[0].object;
        selectNode(m.userData.nodeId);
        postToFlutter({
          type: 'select',
          nodeId: m.userData.nodeId,
          sourceId: m.userData.sourceId,
          name: m.userData.name,
        });
      }
    }
    canvas.addEventListener('click', onPointer);

    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });

    function loop() {
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    }
    loop();

    setHud('آماده — منتظر دادهٔ صحنه از اپ');
    postToFlutter({ type: 'engine_ready' });
  } catch (e) {
    showError('خطا در راه‌اندازی WebGL: ' + (e.message || e));
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
    if (m.material && m.material.emissive) m.material.emissive.setHex(0x2244aa);
    setHud('انتخاب: ' + (m.userData.name || id));
  }
}

function postToFlutter(msg) {
  const payload = JSON.stringify(msg);
  try {
    if (window.InteriorChannel && window.InteriorChannel.postMessage) {
      window.InteriorChannel.postMessage(payload);
      return;
    }
  } catch (_) {}
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: 'interior_engine', ...msg }, '*');
    }
  } catch (_) {}
}

// API عمومی برای Flutter
window.InteriorEngine = {
  loadScene(data) {
    try {
      if (typeof data === 'string') data = JSON.parse(data);
      buildScene(data);
    } catch (e) {
      showError('خطا در بارگذاری صحنه: ' + (e.message || e));
    }
  },
  select(id) {
    selectNode(id);
  },
  setQuality(level) {
    // low | normal | high
    const pr = level === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, level === 'high' ? 2 : 1.5);
    if (renderer) renderer.setPixelRatio(pr);
  },
};

// پیام از Flutter / parent
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.source === 'interior_engine') return;
  if (d.type === 'loadScene' && d.scene) {
    window.InteriorEngine.loadScene(d.scene);
  } else if (d.type === 'select') {
    window.InteriorEngine.select(d.nodeId);
  } else if (d.type === 'setQuality') {
    window.InteriorEngine.setQuality(d.level || 'normal');
  }
});

init();
