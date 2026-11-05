/**
 * House Social Interior Engine — هندسهٔ بسته، مبلمان شکلی، دوربین از بالا
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

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
let longPressTimer = null;
let longPressTarget = null;
const LONG_PRESS_MS = 5000;



const PALETTE = {
  floor: 0xc4a574,
  floorEdge: 0x8d7355,
  wall: 0xe8e0d5,
  wallEdge: 0xb8a990,
  door: 0x6d4c41,
  roomWall: 0xd5c8b8,
  bg: 0x1e2228,
};

// کش بافت‌های رویه‌ای (بدون فایل خارجی)
const _texCache = new Map();

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
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) {
        if (m.map && m.map.__hsOwned) m.map.dispose();
        m.dispose();
      }
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

/** بافت چوب کف — راه‌راه‌های گرم */
function makeWoodTexture(seed = 1) {
  const key = 'wood_' + seed;
  if (_texCache.has(key)) return _texCache.get(key);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c4a574';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 28; i++) {
    const y = (i / 28) * 256 + (Math.sin(i * 1.7 + seed) * 3);
    const a = 0.08 + (i % 3) * 0.03;
    ctx.strokeStyle = `rgba(90,60,35,${a})`;
    ctx.lineWidth = 2 + (i % 4);
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 256; x += 16) {
      ctx.lineTo(x, y + Math.sin(x * 0.04 + i) * 2.5);
    }
    ctx.stroke();
  }
  // گره‌های چوب
  for (let k = 0; k < 6; k++) {
    const x = ((k * 97 + seed * 13) % 220) + 18;
    const y = ((k * 53 + seed * 7) % 220) + 18;
    const g = ctx.createRadialGradient(x, y, 1, x, y, 10 + (k % 4));
    g.addColorStop(0, 'rgba(110,75,40,0.35)');
    g.addColorStop(1, 'rgba(110,75,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, 12, 6, k, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
  tex.__hsOwned = true;
  _texCache.set(key, tex);
  return tex;
}

/** بافت دیوار — گچ مات با نویز خیلی ملایم */
function makePlasterTexture(seed = 1) {
  const key = 'plaster_' + seed;
  if (_texCache.has(key)) return _texCache.get(key);
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8e0d5';
  ctx.fillRect(0, 0, 128, 128);
  const img = ctx.getImageData(0, 0, 128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] = Math.min(255, Math.max(0, img.data[i] + n));
    img.data[i + 1] = Math.min(255, Math.max(0, img.data[i + 1] + n * 0.95));
    img.data[i + 2] = Math.min(255, Math.max(0, img.data[i + 2] + n * 0.9));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
  tex.__hsOwned = true;
  _texCache.set(key, tex);
  return tex;
}

/** بافت پارچه مبل */
function makeFabricTexture(baseHex = '#6d4c41') {
  const key = 'fabric_' + baseHex;
  if (_texCache.has(key)) return _texCache.get(key);
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let i = 0; i < 64; i += 4) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 64);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(64, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
  tex.__hsOwned = true;
  _texCache.set(key, tex);
  return tex;
}

function mat(color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.75,
    metalness: opts.metalness ?? 0.02,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    map: opts.map || null,
    envMapIntensity: opts.envMapIntensity ?? 0.4,
  });
  if (opts.map) {
    // رنگ پایه را نزدیک سفید نگه می‌داریم تا بافت دیده شود
    if (opts.tintMap) m.color.setHex(0xffffff);
  }
  return m;
}

function radiusFor(w, h, d, requested) {
  const m = Math.min(w, h, d);
  if (m < 4) return 0;
  const r = requested != null ? requested : Math.min(6, m * 0.12);
  return Math.max(0.5, Math.min(r, m * 0.28));
}

/**
 * جعبه با گوشه گرد (یا ساده برای اجسام خیلی کوچک).
 * opts.round — شعاع گردی؛ 0 = تیز
 * opts.edges — خطوط لبه (پیش‌فرض خاموش برای ظاهر نرم‌تر)
 */
function boxMesh(w, h, d, color, opts = {}) {
  w = Math.max(0.5, w || 1);
  h = Math.max(0.5, h || 1);
  d = Math.max(0.5, d || 1);
  const round = opts.round === false ? 0 : radiusFor(w, h, d, opts.round);
  let geo;
  if (round > 0.4 && RoundedBoxGeometry) {
    const seg = opts.segments != null ? opts.segments : 3;
    geo = new RoundedBoxGeometry(w, h, d, seg, round);
  } else {
    geo = new THREE.BoxGeometry(w, h, d);
  }
  const mesh = new THREE.Mesh(geo, mat(color, opts));
  mesh.castShadow = opts.castShadow !== false;
  mesh.receiveShadow = opts.receiveShadow !== false;
  if (opts.edges === true) {
    const edges = new THREE.EdgesGeometry(geo, 30);
    mesh.add(
      new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: opts.edgeColor ?? 0x333333,
          transparent: true,
          opacity: opts.edgeOpacity ?? 0.22,
        })
      )
    );
  }
  return mesh;
}

function floorMesh(w, h, d, colorHex, opts = {}) {
  const tex = makeWoodTexture(opts.seed || 1);
  tex.repeat.set(Math.max(2, w / 180), Math.max(2, d / 180));
  const mesh = boxMesh(w, Math.max(h, 3), d, hexColor(colorHex, PALETTE.floor), {
    map: tex,
    tintMap: true,
    roughness: 0.82,
    metalness: 0.0,
    castShadow: false,
    round: 1.2,
    edges: false,
    ...opts,
  });
  // کمی رنگ پایه چوب روی material
  if (mesh.material) {
    mesh.material.color.setHex(hexColor(colorHex, PALETTE.floor));
    mesh.material.map = tex;
  }
  mesh.receiveShadow = true;
  return mesh;
}

/** دیوار شیشه‌ای نیمه‌شفاف با رنگ قابل تنظیم */
function wallMesh(w, h, d, colorHex, opts = {}) {
  w = Math.max(0.5, w || 1);
  h = Math.max(0.5, h || 1);
  d = Math.max(0.5, d || 1);
  const round = opts.round != null ? opts.round : 2;
  let geo;
  if (round > 0.4 && typeof RoundedBoxGeometry !== 'undefined') {
    geo = new RoundedBoxGeometry(w, h, d, 2, Math.min(round, Math.min(w, h, d) * 0.2));
  } else {
    geo = new THREE.BoxGeometry(w, h, d);
  }
  const base = hexColor(colorHex, 0xb3e5fc);
  const mat = new THREE.MeshPhysicalMaterial({
    color: base,
    transparent: true,
    opacity: opts.opacity != null ? opts.opacity : 0.38,
    roughness: 0.12,
    metalness: 0.05,
    transmission: opts.transmission != null ? opts.transmission : 0.65,
    thickness: Math.min(w, d) * 0.35,
    ior: 1.45,
    clearcoat: 0.6,
    clearcoatRoughness: 0.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  // fallback اگر Physical در دسترس نباشد
  if (!mat.transmission && mat.transmission !== 0) {
    mat.dispose();
    const mat2 = new THREE.MeshStandardMaterial({
      color: base,
      transparent: true,
      opacity: 0.42,
      roughness: 0.15,
      metalness: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat2);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.isGlassWall = true;
    return mesh;
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.isGlassWall = true;
  return mesh;
}

function applyWallColor(obj, colorHex) {
  if (!obj) return;
  const c = hexColor(colorHex, 0xb3e5fc);
  obj.traverse((ch) => {
    if (ch.isMesh && ch.material) {
      const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
      for (const m of mats) {
        if (m.color) m.color.setHex(c);
        m.needsUpdate = true;
      }
    }
  });
}

/** مبلمان ترکیبی بر اساس kindKey */
function buildFurniture(node) {
  const kind = (node.meta && node.meta.kindKey) || '';
  const c = hexColor(node.colorHex, 0xbcaaa4);
  const g = new THREE.Group();
  // baseY از متا (مثلاً تلویزیون از ۴۰٪ دیوار شروع می‌شود)
  const baseY = (node.meta && node.meta.baseY != null) ? node.meta.baseY : 0;
  g.position.set(node.x, baseY, node.z);
  if (node.rotY) g.rotation.y = node.rotY;

  const W = node.w || 40;
  const H = node.h || 40;
  const D = node.d || 40;

  if (kind === 'bed') {
    const frame = boxMesh(W, H * 0.4, D, c, { round: 5, edges: false, roughness: 0.7 });
    frame.position.y = H * 0.22;
    g.add(frame);
    const matress = boxMesh(W * 0.92, H * 0.28, D * 0.9, 0xf5f0e8, {
      round: 8,
      edges: false,
      roughness: 0.9,
    });
    matress.position.y = H * 0.48;
    g.add(matress);
    const pillow = boxMesh(W * 0.38, H * 0.14, D * 0.28, 0xfff8e1, {
      round: 6,
      edges: false,
      roughness: 0.95,
    });
    pillow.position.set(0, H * 0.62, -D * 0.28);
    g.add(pillow);
  } else if (kind === 'sofa') {
    const fab = makeFabricTexture(
      '#' + (typeof c === 'number' ? c.toString(16).padStart(6, '0') : '6d4c41')
    );
    const seat = boxMesh(W, H * 0.28, D * 0.78, c, {
      round: 7,
      edges: false,
      map: fab,
      roughness: 0.88,
    });
    seat.position.y = H * 0.28;
    g.add(seat);
    const back = boxMesh(W, H * 0.55, D * 0.16, c, {
      round: 6,
      edges: false,
      map: fab,
      roughness: 0.88,
    });
    back.position.set(0, H * 0.62, -D * 0.38);
    g.add(back);
    const armL = boxMesh(W * 0.1, H * 0.4, D * 0.72, c, { round: 5, edges: false, map: fab });
    armL.position.set(-W * 0.45, H * 0.4, 0);
    g.add(armL);
    const armR = boxMesh(W * 0.1, H * 0.4, D * 0.72, c, { round: 5, edges: false, map: fab });
    armR.position.set(W * 0.45, H * 0.4, 0);
    g.add(armR);
  } else if (kind === 'chair') {
    const seat = boxMesh(W, H * 0.1, D, c);
    seat.position.y = H * 0.42;
    g.add(seat);
    const back = boxMesh(W, H * 0.42, D * 0.12, c);
    back.position.set(0, H * 0.72, -D * 0.4);
    g.add(back);
    for (const [sx, sz] of [
      [-0.35, -0.35],
      [0.35, -0.35],
      [-0.35, 0.35],
      [0.35, 0.35],
    ]) {
      const leg = boxMesh(W * 0.08, H * 0.42, W * 0.08, 0x5d4037, { edges: false });
      leg.position.set(W * sx, H * 0.21, D * sz);
      g.add(leg);
    }
  } else if (kind === 'table' || kind === 'desk') {
    const top = boxMesh(W, Math.max(4, H * 0.06), D, c, {
      round: 3,
      edges: false,
      roughness: 0.55,
    });
    top.position.y = H * 0.97;
    g.add(top);
    for (const [sx, sz] of [
      [-0.4, -0.4],
      [0.4, -0.4],
      [-0.4, 0.4],
      [0.4, 0.4],
    ]) {
      const leg = boxMesh(W * 0.07, H * 0.94, W * 0.07, 0x4e342e, {
        edges: false,
        round: 1.5,
        roughness: 0.6,
      });
      leg.position.set(W * sx, H * 0.47, D * sz);
      g.add(leg);
    }
  } else if (
    kind === 'cabinet' ||
    kind === 'wardrobe' ||
    kind === 'bookshelf' ||
    kind === 'shelf' ||
    kind === 'fridge'
  ) {
    const body = boxMesh(W, H, D, c, { round: 4, edges: false, roughness: 0.65 });
    body.position.y = H / 2;
    g.add(body);
    for (let i = 1; i <= 3; i++) {
      const shelf = boxMesh(W * 0.9, 2, D * 0.85, 0x3e2723, {
        edges: false,
        round: 1,
      });
      shelf.position.y = (H * i) / 4;
      g.add(shelf);
    }
    const handle = boxMesh(3, H * 0.12, 2, 0xcfd8dc, {
      edges: false,
      round: 1,
      metalness: 0.55,
      roughness: 0.35,
    });
    handle.position.set(W * 0.35, H * 0.5, D * 0.52);
    g.add(handle);
  } else if (kind === 'tv') {
    const bezel = boxMesh(W, H, Math.max(5, D), 0x1a1a1a, {
      round: 3,
      edges: false,
      metalness: 0.35,
      roughness: 0.4,
    });
    bezel.position.y = H / 2;
    g.add(bezel);
    const screen = boxMesh(W * 0.92, H * 0.88, Math.max(3, D * 0.5), 0x1565c0, {
      round: 2,
      edges: false,
      metalness: 0.2,
      roughness: 0.25,
    });
    screen.position.y = H / 2;
    g.add(screen);
  } else if (kind === 'tv_stand') {
    const body = boxMesh(W, H * 0.75, D, c);
    body.position.y = H * 0.38;
    g.add(body);
  } else if (kind === 'plant') {
    const pot = boxMesh(W * 0.7, H * 0.22, D * 0.7, 0xa1887f);
    pot.position.y = H * 0.11;
    g.add(pot);
    const leaf = boxMesh(W * 0.9, H * 0.72, D * 0.9, 0x388e3c, {
      edgeColor: 0x1b5e20,
    });
    leaf.position.y = H * 0.58;
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

/** قاب عکس روی دیوار: حاشیه + صفحه */
function buildWallImage(node) {
  const g = new THREE.Group();
  g.position.set(node.x, node.y, node.z);
  if (node.rotY) g.rotation.y = node.rotY;
  const W = node.w || 60;
  const H = node.h || 50;
  const frame = boxMesh(W * 1.1, H * 1.1, 5, 0x5d4037, {
    round: 4,
    edges: false,
    roughness: 0.55,
  });
  g.add(frame);
  const plate = boxMesh(W, H, 3, hexColor(node.colorHex, 0xfafafa), {
    round: 2,
    edges: false,
    roughness: 0.9,
  });
  plate.position.z = 2;
  g.add(plate);
  const accent = boxMesh(W * 0.7, H * 0.08, 1, 0x90a4ae, {
    edges: false,
    round: 1,
  });
  accent.position.set(0, H * 0.25, 3);
  g.add(accent);
  g.userData.selectable = true;
  g.userData.nodeId = node.id;
  g.userData.sourceId = node.sourceId;
  g.userData.name = node.name || node.id;
  g.userData.kind = 'imageOnWall';
  g.userData.layoutW = (node.meta && node.meta.layoutW) || W;
  g.userData.layoutH = (node.meta && node.meta.layoutH) || H;
  selectable.set(node.id, g);
  return g;
}

function buildNode(node, parent) {
  const kind = node.kind;
  let obj = null;
  const color = hexColor(node.colorHex);

  if (kind === 'floor') {
    obj = floorMesh(node.w, Math.max(node.h, 3), node.d, node.colorHex, { seed: 1 });
    obj.position.set(node.x, node.y != null ? node.y : 1.5, node.z);
    if (node.sourceId) {
      obj.userData.selectable = true;
      obj.userData.nodeId = node.id;
      obj.userData.sourceId = node.sourceId;
      obj.userData.name = node.name || node.id;
      obj.userData.kind = 'roomFloor';
      selectable.set(node.id, obj);
    }
  } else if (kind === 'ceiling') {
    obj = boxMesh(node.w, Math.max(node.h, 2), node.d, hexColor(node.colorHex, 0xf7f4ef), {
      castShadow: false,
      edges: false,
      round: 1,
      roughness: 0.95,
    });
    obj.position.set(node.x, node.y || 0, node.z);
    obj.visible = !!(node.meta && node.meta.showCeiling);
  } else if (kind === 'wall') {
    obj = wallMesh(node.w, node.h, node.d, node.colorHex || '#B3E5FC', {
      round: 2,
      opacity: 0.38,
      transmission: 0.65,
    });
    obj.position.set(node.x, node.y, node.z);
    obj.userData.selectable = true;
    obj.userData.nodeId = node.id;
    obj.userData.sourceId = node.sourceId || null;
    obj.userData.name = node.name || node.id;
    obj.userData.kind = 'wall';
    obj.userData.side = (node.meta && node.meta.side) || null;
    selectable.set(node.id, obj);
  } else if (kind === 'door') {
    obj = boxMesh(node.w, node.h, node.d, hexColor(node.colorHex, PALETTE.door), {
      roughness: 0.55,
      metalness: 0.05,
      round: 4,
      edges: false,
    });
    obj.position.set(node.x, node.y, node.z);
  } else if (kind === 'roomShell') {
    obj = wallMesh(node.w, node.h, node.d, node.colorHex || '#B3E5FC', {
      round: 3,
      opacity: 0.4,
      transmission: 0.6,
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
    obj = buildWallImage(node);
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

  // نورپردازی طبیعی‌تر: آسمان گرم + خورشید نرم + پرکننده
  const hemi = new THREE.HemisphereLight(0xfff5e6, 0x8d8578, 0.55);
  roomRoot.add(hemi);
  const amb = new THREE.AmbientLight(0xfff8f0, 0.35);
  roomRoot.add(amb);
  const dir = new THREE.DirectionalLight(0xfff1d6, 0.85);
  dir.position.set(
    (data.width || 400) * 0.3,
    (data.height || 280) * 1.8,
    (data.depth || 400) * 0.25
  );
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.bias = -0.00015;
  roomRoot.add(dir);
  const fill = new THREE.DirectionalLight(0xc5d8f0, 0.22);
  fill.position.set(
    -(data.width || 400) * 0.45,
    (data.height || 280) * 0.75,
    -(data.depth || 400) * 0.35
  );
  roomRoot.add(fill);

  applyTopDownCamera(data);

  setHud((data.name || 'فضا') + ' · شیشه · بکشید برای چرخش · نگه‌داشتن دیوار ۵ثانیه = رنگ');
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
    if (renderer.toneMapping != null) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping || renderer.toneMapping;
      renderer.toneMappingExposure = 1.05;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x243038);
    scene.fog = new THREE.Fog(PALETTE.bg, 1800, 4200);

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

    function clearLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      longPressTarget = null;
    }

    function onPointerDown(ev) {
      if (!ready) return;
      const ndc = eventToNDC(ev);
      if (!ndc) return;
      pointerDownPos = { x: ndc.clientX, y: ndc.clientY };
      clearLongPress();
      // نگه‌داشتن ۵ ثانیه روی دیوار → انتخاب رنگ
      const hit = pickSelectable(ndc);
      if (hit && (hit.userData.kind === 'wall' || hit.userData.kind === 'roomShell')) {
        longPressTarget = hit;
        longPressTimer = setTimeout(() => {
          if (!longPressTarget) return;
          const o = longPressTarget;
          clearLongPress();
          selectNode(o.userData.nodeId);
          postToFlutter({
            type: 'wallLongPress',
            nodeId: o.userData.nodeId,
            sourceId: o.userData.sourceId,
            name: o.userData.name,
            kind: o.userData.kind,
            side: o.userData.side,
            colorHex: o.userData.colorHex || null,
          });
          setHud('انتخاب رنگ دیوار…');
        }, LONG_PRESS_MS);
      }
      if (!editMode) return;
      const obj = pickSelectable(ndc);
      if (!obj || !obj.userData.sourceId) return;
      // فقط مبلمان/content قابل کشیدن
      const k = obj.userData.kind;
      if (k === 'roomShell' || k === 'roomFloor' || k === 'wall') return;
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
      if (longPressTimer && pointerDownPos) {
        const ndc = eventToNDC(ev);
        if (ndc) {
          const dist = Math.hypot(ndc.clientX - pointerDownPos.x, ndc.clientY - pointerDownPos.y);
          if (dist > 12) clearLongPress();
        }
      }
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
      clearLongPress();
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
        : ((lastSceneKey && 'از بالا · بکشید برای چرخش · نگه‌داشتن دیوار برای رنگ') || 'آماده')
    );
  },
  setWallColor(nodeId, colorHex) {
    const obj = selectable.get(nodeId);
    if (!obj) return;
    applyWallColor(obj, colorHex);
    obj.userData.colorHex = colorHex;
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
  } else if (msg.type === 'setWallColor') {
    window.InteriorEngine.setWallColor(msg.nodeId || '', msg.colorHex || '#B3E5FC');
  }
});

init();
