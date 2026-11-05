/**
 * House Social Interior Engine — هندسهٔ بسته، مبلمان شکلی، دوربین از بالا
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const errEl = document.getElementById('err');

let renderer, scene, camera, controls;
let roomRoot = null;
let selectable = new Map();
const gltfLoader = new GLTFLoader();
const gltfCache = new Map();
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

function isSolidKind(kind) {
  return kind === 'furniture' || kind === 'room' || kind === 'solid';
}

function aabbOverlapXZ(ax, az, aw, ad, bx, bz, bw, bd) {
  const eps = 1;
  return ax < bx + bw - eps && ax + aw > bx + eps && az < bz + bd - eps && az + ad > bz + eps;
}

function findNestHost(obj) {
  const meta = obj.userData || {};
  if (meta.kind === 'furniture' || meta.kind === 'room') return null;
  const lw = meta.layoutW || 40, lh = meta.layoutH || 40;
  const ax = obj.position.x - lw / 2, az = obj.position.z - lh / 2;
  for (const [, other] of selectable) {
    if (other === obj) continue;
    const om = other.userData || {};
    if (om.kind !== 'furniture' && om.kind !== 'room') continue;
    const ow = om.layoutW || 80, oh = om.layoutH || 56;
    const bx = other.position.x - ow / 2, bz = other.position.z - oh / 2;
    const cx = obj.position.x, cz = obj.position.z;
    if (cx >= bx && cx <= bx + ow && cz >= bz && cz <= bz + oh) {
      return other;
    }
  }
  return null;
}

function resolveSolidCollisions(obj) {
  const meta = obj.userData || {};
  if (meta.kind !== 'furniture' && meta.kind !== 'room') return;
  const lw = meta.layoutW || 80, lh = meta.layoutH || 56;
  let ax = obj.position.x - lw / 2, az = obj.position.z - lh / 2;
  for (const [, other] of selectable) {
    if (other === obj) continue;
    const om = other.userData || {};
    if (om.kind !== 'furniture' && om.kind !== 'room') continue;
    const ow = om.layoutW || 80, oh = om.layoutH || 56;
    const bx = other.position.x - ow / 2, bz = other.position.z - oh / 2;
    if (aabbOverlapXZ(ax, az, lw, lh, bx, bz, ow, oh)) {
      // هل دادن به نزدیک‌ترین لبه
      const cx = obj.position.x, cz = obj.position.z;
      const ocy = other.position.x, ocz = other.position.z;
      const dx = cx - ocy, dz = cz - ocz;
      if (Math.abs(dx) > Math.abs(dz)) {
        obj.position.x = ocy + (dx >= 0 ? 1 : -1) * (lw / 2 + ow / 2 + 2);
      } else {
        obj.position.z = ocz + (dz >= 0 ? 1 : -1) * (lh / 2 + oh / 2 + 2);
      }
      ax = obj.position.x - lw / 2;
      az = obj.position.z - lh / 2;
    }
  }
}

function tryAttachGltf(group, modelUrl, scale) {
  if (!modelUrl || !gltfLoader) return;
  const key = modelUrl + '|' + (scale || 1);
  const apply = (scene) => {
    const root = scene.clone(true);
    const s = scale || 1;
    root.scale.setScalar(s);
    root.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    // مخفی کردن جعبه‌های رویه‌ای تقریبی
    group.children.slice().forEach((ch) => {
      if (ch.userData && ch.userData.__procedural) group.remove(ch);
    });
    group.add(root);
  };
  if (gltfCache.has(key)) {
    apply(gltfCache.get(key));
    return;
  }
  gltfLoader.load(
    modelUrl,
    (gltf) => {
      gltfCache.set(key, gltf.scene);
      apply(gltf.scene);
    },
    undefined,
    (err) => console.warn('gltf load failed', modelUrl, err)
  );
}


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


function makeFloorPatternTexture(pattern, baseHex, patternHex, intensity) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const base = '#' + (baseHex || 'c4a574').toString(16).replace('0x','').padStart(6,'0');
  // baseHex may already be number from hexColor
  function cssHex(v, fb) {
    if (typeof v === 'string' && v.startsWith('#')) return v;
    if (typeof v === 'number') return '#' + (v & 0xffffff).toString(16).padStart(6, '0');
    return fb;
  }
  const b = cssHex(baseHex, '#c4a574');
  const p = cssHex(patternHex, '#8d6e63');
  const t = Math.max(0, Math.min(1, intensity == null ? 0.55 : intensity));
  ctx.fillStyle = b;
  ctx.fillRect(0, 0, 256, 256);
  ctx.globalAlpha = 0.25 + t * 0.55;
  ctx.fillStyle = p;
  ctx.strokeStyle = p;
  ctx.lineWidth = 2;
  const kind = pattern || 'wood';
  if (kind === 'wood') {
    for (let y = 0; y < 256; y += 32) {
      ctx.fillRect(0, y, 256, 28);
      ctx.beginPath(); ctx.moveTo(0, y + 30); ctx.lineTo(256, y + 30); ctx.stroke();
      const off = ((y / 32) % 2) * 40;
      for (let x = off; x < 256; x += 80) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 28); ctx.stroke();
      }
    }
  } else if (kind === 'tile') {
    for (let y = 0; y < 256; y += 32)
      for (let x = 0; x < 256; x += 32)
        ctx.strokeRect(x + 2, y + 2, 28, 28);
  } else if (kind === 'checker') {
    for (let y = 0; y < 256; y += 32)
      for (let x = 0; x < 256; x += 32)
        if (((x + y) / 32) % 2 < 1) ctx.fillRect(x, y, 32, 32);
  } else if (kind === 'grid') {
    for (let i = 0; i <= 256; i += 24) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
  } else if (kind === 'dots') {
    for (let y = 12; y < 256; y += 20)
      for (let x = 12; x < 256; x += 20) {
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      }
  } else if (kind === 'carpet') {
    ctx.fillRect(0, 0, 256, 24); ctx.fillRect(0, 232, 256, 24);
    ctx.fillRect(0, 0, 24, 256); ctx.fillRect(232, 0, 24, 256);
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
  return tex;
}

function floorMesh(w, h, d, colorHex, opts = {}) {
  const pattern = (opts.pattern || 'wood');
  const pColor = opts.patternColorHex || opts.patternColor || '#8D6E63';
  const intensity = opts.intensity != null ? opts.intensity : 0.55;
  let tex = null;
  if (pattern === 'image' && opts.imageUrl) {
    // بافت از عکس آلبوم — بارگذاری ناهمگام
    tex = null;
  } else if (pattern === 'wood' || pattern === 'solid') {
    tex = pattern === 'solid' ? null : makeWoodTexture(opts.seed || 1);
    if (tex) tex.repeat.set(Math.max(2, w / 180), Math.max(2, d / 180));
  } else {
    tex = makeFloorPatternTexture(pattern, colorHex, pColor, intensity);
    tex.repeat.set(Math.max(1, w / 220), Math.max(1, d / 220));
  }
  const mesh = boxMesh(w, Math.max(h, 3), d, hexColor(colorHex, PALETTE.floor), {
    map: tex || undefined,
    tintMap: !!tex,
    roughness: 0.82,
    metalness: 0.0,
    castShadow: false,
    round: 1.2,
    edges: false,
    ...opts,
  });
  if (mesh.material) {
    mesh.material.color.setHex(hexColor(colorHex, PALETTE.floor));
    if (tex) mesh.material.map = tex;
  }
  mesh.receiveShadow = true;
  if (pattern === 'image' && opts.imageUrl) {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      opts.imageUrl,
      (texture) => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(Math.max(1, w / 400), Math.max(1, d / 400));
        if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
        if (mesh.material) {
          mesh.material.map = texture;
          mesh.material.needsUpdate = true;
        }
      },
      undefined,
      (err) => console.warn('floor image load failed', err)
    );
  }
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
    depthWrite: opts.depthWrite === true,
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
      depthWrite: opts.depthWrite === true,
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
  obj.userData.colorHex = colorHex;
  obj.traverse((ch) => {
    if (!ch.isMesh || !ch.material) return;
    const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
    for (const m of mats) {
      if (m.color) m.color.setHex(c);
      // برای شیشه کمی opaqueتر تا رنگ دیده شود
      if (m.transparent && m.opacity != null && m.opacity < 0.35) {
        m.opacity = Math.max(m.opacity, 0.28);
      }
      m.needsUpdate = true;
    }
  });
}


/** شفافیت: ۱ پنجره > ۲ دیوار > ۳ در > ۴ قاب */
const GLASS = {
  window: { opacity: 0.18, transmission: 0.92 },
  wall: { opacity: 0.38, transmission: 0.65 },
  door: { opacity: 0.52, transmission: 0.42 },
  frame: { opacity: 0.82, transmission: 0.08 },
};

function glassPanel(w, h, d, colorHex, level) {
  const g = GLASS[level] || GLASS.wall;
  return wallMesh(w, h, d, colorHex, {
    opacity: g.opacity,
    transmission: g.transmission,
    round: 1.2,
    depthWrite: level === 'door' || level === 'window',
  });
}

function frameBar(w, h, d, colorHex) {
  const mesh = wallMesh(w, h, d, colorHex || '#78909C', {
    opacity: GLASS.frame.opacity,
    transmission: GLASS.frame.transmission,
    round: 0.8,
    depthWrite: true,
  });
  return mesh;
}

/** در شیشه‌ای با قاب سه طرفه (بالا + دو کنار) */

/** ابعاد نمای در/پنجره: عرض روی دیوار + ضخامت دیوار؛ چرخش برای شرق/غرب */
function openingFaceSize(node) {
  const side = (node.meta && node.meta.side) || 's';
  const isEW = side === 'e' || side === 'w';
  const wRaw = Math.abs(node.w || 90);
  const dRaw = Math.abs(node.d || 8);
  const h = Math.abs(node.h || 180);
  // روی دیوار N/S: w=عرض، d=ضخامت ؛ روی E/W برعکس ذخیره شده
  const faceW = isEW ? Math.max(wRaw, dRaw) : wRaw;
  const thick = isEW ? Math.min(wRaw, dRaw) : dRaw;
  // اگر E/W و w از اول thickness بوده
  const faceW2 = isEW ? dRaw : wRaw;
  const thick2 = isEW ? wRaw : dRaw;
  return {
    faceW: faceW2 > 0 ? faceW2 : faceW,
    thick: thick2 > 0 ? thick2 : thick,
    h,
    side,
    isEW,
    rotY: isEW ? Math.PI / 2 : 0,
  };
}

function buildDoor(node) {
  const g = new THREE.Group();
  const dim = openingFaceSize(node);
  const w = dim.faceW;
  const h = dim.h;
  const d = Math.max(2, dim.thick);
  const glassC = node.colorHex || '#90CAF9';
  const frameC = (node.meta && node.meta.frameColorHex) || '#B0BEC5';
  const ft = Math.max(4, Math.min(8, Math.min(w, h) * 0.06));

  const glass = glassPanel(Math.max(2, w - ft * 2), Math.max(2, h - ft), d * 0.55, glassC, 'door');
  glass.position.y = -ft / 2;
  g.add(glass);

  const left = frameBar(ft, h, d, frameC);
  left.position.set(-w / 2 + ft / 2, 0, 0);
  g.add(left);
  const right = frameBar(ft, h, d, frameC);
  right.position.set(w / 2 - ft / 2, 0, 0);
  g.add(right);
  const top = frameBar(w, ft, d, frameC);
  top.position.set(0, h / 2 - ft / 2, 0);
  g.add(top);

  g.position.set(node.x, node.y || h / 2, node.z);
  g.rotation.y = dim.rotY;
  g.userData.isOpening = true;
  g.userData.openingKind = 'door';
  g.renderOrder = 20;
  g.traverse((c) => { c.renderOrder = 20; });
  return g;
}

/**
 * پنجره چهارخانه مثل نمونه:
 * دو شیشه کوچک بالا + دو شیشه بلند پایین، قاب و مولیون نازک
 * ضخامت = ضخامت دیوار (نه چندلایه ضخیم)
 */
function buildWindow(node) {
  const g = new THREE.Group();
  const dim = openingFaceSize(node);
  const w = dim.faceW;
  const h = dim.h;
  const d = Math.max(2, dim.thick); // = ضخامت دیوار
  const glassC = node.colorHex || '#B3E5FC';
  const frameC = (node.meta && node.meta.frameColorHex) || '#CFD8DC';
  const ft = Math.max(3.5, Math.min(7, Math.min(w, h) * 0.05));
  const mt = Math.max(2.5, ft * 0.65);

  const gw = Math.max(2, w - ft * 2);
  const gh = Math.max(2, h - ft * 2);
  // ردیف بالا حدود ۳۲٪ ارتفاع داخلی — شبیه عکس مرجع
  const upperRatio = 0.32;
  const upperH = Math.max(2, gh * upperRatio - mt / 2);
  const lowerH = Math.max(2, gh * (1 - upperRatio) - mt / 2);
  const paneW = Math.max(2, (gw - mt) / 2);
  const xL = - (paneW + mt) / 2;
  const xR = (paneW + mt) / 2;
  // مرکز عمودی هر ردیف نسبت به مرکز پنجره
  const yUpper = gh / 2 - upperH / 2;
  const yLower = -gh / 2 + lowerH / 2;

  const panes = [
    [xL, yUpper, paneW, upperH],
    [xR, yUpper, paneW, upperH],
    [xL, yLower, paneW, lowerH],
    [xR, yLower, paneW, lowerH],
  ];
  for (const [px, py, pw, ph] of panes) {
    const pane = glassPanel(pw, ph, d * 0.4, glassC, 'window');
    pane.position.set(px, py, 0);
    g.add(pane);
  }

  // قاب بیرونی نازک
  const left = frameBar(ft, h, d, frameC);
  left.position.set(-w / 2 + ft / 2, 0, 0);
  g.add(left);
  const right = frameBar(ft, h, d, frameC);
  right.position.set(w / 2 - ft / 2, 0, 0);
  g.add(right);
  const top = frameBar(w, ft, d, frameC);
  top.position.set(0, h / 2 - ft / 2, 0);
  g.add(top);
  const bot = frameBar(w, ft, d, frameC);
  bot.position.set(0, -h / 2 + ft / 2, 0);
  g.add(bot);

  // مولیون عمودی سراسری
  const vBar = frameBar(mt, gh, d * 0.9, frameC);
  g.add(vBar);
  // مولیون افقی بین ردیف بالا و پایین
  const hBar = frameBar(gw, mt, d * 0.9, frameC);
  hBar.position.y = (yUpper - upperH / 2 + yLower + lowerH / 2) / 2;
  g.add(hBar);

  g.position.set(node.x, node.y || h / 2, node.z);
  g.rotation.y = dim.rotY;
  g.userData.isOpening = true;
  g.userData.openingKind = 'window';
  g.renderOrder = 20;
  g.traverse((c) => { c.renderOrder = 20; });
  return g;
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
  if (node.meta && node.meta.modelUrl) {
    tryAttachGltf(g, node.meta.modelUrl, node.meta.modelScale || 1);
  }
  selectable.set(node.id, g);
  return g;
}

/** قاب عکس روی دیوار: حاشیه + صفحه */
function buildWallImage(node) {
  const g = new THREE.Group();
  g.position.set(node.x || 0, node.y || 0, node.z || 0);
  if (node.rotY) g.rotation.y = node.rotY;
  const W = node.w || 60;
  const H = node.h || 50;
  const meta = node.meta || {};
  const frameKind = meta.frame || 'thin';
  const shape = meta.shape || 'rect_h';
  const frameColors = {
    none: null,
    thin: 0x37474f,
    wood: 0x5d4037,
    gold: 0xc9a227,
    passepartout: 0xeceff1,
    polaroid: 0xfafafa,
  };
  const fc = frameColors[frameKind];
  if (fc != null && frameKind !== 'none') {
    const scale = frameKind === 'polaroid' ? 1.18 : (frameKind === 'passepartout' ? 1.22 : 1.1);
    const depth = frameKind === 'wood' ? 7 : 5;
    const frame = boxMesh(W * scale, H * (frameKind === 'polaroid' ? scale + 0.08 : scale), depth, fc, {
      round: shape === 'round' ? Math.min(W, H) * 0.45 : 4,
      edges: false,
      roughness: frameKind === 'gold' ? 0.35 : 0.55,
      metalness: frameKind === 'gold' ? 0.45 : 0.05,
    });
    g.add(frame);
  }
  const plate = boxMesh(W, H, 3, hexColor(node.colorHex, 0xfafafa), {
    round: shape === 'round' ? Math.min(W, H) * 0.48 : 2,
    edges: false,
    roughness: 0.9,
  });
  plate.position.z = 2;
  g.add(plate);
  // نوار تزئینی اگر عکس نباشد
  if (!meta.photoContentId) {
    const accent = boxMesh(W * 0.7, H * 0.08, 1, 0x90a4ae, {
      edges: false,
      round: 1,
    });
    accent.position.set(0, H * 0.25, 3);
    g.add(accent);
  }
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
    const meta = node.meta || {};
    obj = floorMesh(node.w, Math.max(node.h, 3), node.d, node.colorHex, {
      seed: 1,
      pattern: meta.pattern,
      patternColor: meta.patternColor,
      intensity: meta.intensity,
      imageUrl: meta.imageUrl,
    });
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
    obj = buildDoor(node);
    obj.userData.selectable = true;
    obj.userData.nodeId = node.id;
    obj.userData.sourceId = node.sourceId || node.id;
    obj.userData.name = node.name || 'در';
    obj.userData.kind = 'door';
    obj.userData.colorHex = node.colorHex;
    obj.userData.meta = node.meta || {};
    selectable.set(node.id, obj);
  } else if (kind === 'window') {
    obj = buildWindow(node);
    obj.userData.selectable = true;
    obj.userData.nodeId = node.id;
    obj.userData.sourceId = node.sourceId || node.id;
    obj.userData.name = node.name || 'پنجره';
    obj.userData.kind = 'window';
    obj.userData.colorHex = node.colorHex;
    obj.userData.meta = node.meta || {};
    selectable.set(node.id, obj);
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

  // نور: نیم‌کره + محیطی + خورشید با سایه نرم + پرکننده سرد
  const W = data.width || 400, H = data.height || 280, D = data.depth || 400;
  const hemi = new THREE.HemisphereLight(0xfff6ea, 0x6b6358, 0.62);
  roomRoot.add(hemi);
  const amb = new THREE.AmbientLight(0xfff8f0, 0.28);
  roomRoot.add(amb);
  const dir = new THREE.DirectionalLight(0xfff1d6, 0.95);
  dir.position.set(W * 0.35, H * 2.2, D * 0.28);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1536, 1536);
  dir.shadow.bias = -0.00012;
  dir.shadow.camera.near = 10;
  dir.shadow.camera.far = Math.max(W, D) * 4;
  dir.shadow.camera.left = -Math.max(W, D);
  dir.shadow.camera.right = Math.max(W, D);
  dir.shadow.camera.top = Math.max(W, D);
  dir.shadow.camera.bottom = -Math.max(W, D);
  roomRoot.add(dir);
  const fill = new THREE.DirectionalLight(0xb8d0f0, 0.28);
  fill.position.set(-W * 0.5, H * 0.9, -D * 0.4);
  roomRoot.add(fill);
  const rim = new THREE.DirectionalLight(0xffe0c0, 0.12);
  rim.position.set(0, H * 0.4, -D * 0.8);
  roomRoot.add(rim);

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

    function resolveSelectable(mesh) {
      let obj = mesh;
      while (obj && !obj.userData.nodeId && obj.parent) obj = obj.parent;
      return obj && obj.userData.nodeId ? obj : null;
    }

    function pickSelectable(ndc) {
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      raycaster.setFromCamera(pointer, camera);
      // دیوارها depthWrite=false دارند؛ همهٔ برخوردها را می‌گیریم و اولویت می‌دهیم
      const roots = [...selectable.values()];
      const hits = raycaster.intersectObjects(roots, true);
      if (!hits.length) return null;
      const resolved = [];
      for (const h of hits) {
        const o = resolveSelectable(h.object);
        if (o) resolved.push(o);
      }
      if (!resolved.length) return null;
      // ۱) در و پنجره ۲) مبلمان/محتوا ۳) دیوار
      for (const o of resolved) {
        if (o.userData.kind === 'door' || o.userData.kind === 'window') return o;
      }
      for (const o of resolved) {
        const k = o.userData.kind;
        if (k !== 'wall' && k !== 'roomShell') return o;
      }
      return resolved[0];
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
      if (hit && (hit.userData.kind === 'wall' || hit.userData.kind === 'roomShell'
          || hit.userData.kind === 'door' || hit.userData.kind === 'window')) {
        longPressTarget = hit;
        longPressTimer = setTimeout(() => {
          if (!longPressTarget) return;
          const o = longPressTarget;
          clearLongPress();
          selectNode(o.userData.nodeId);
          const meta = o.userData.meta || {};
          const type = (o.userData.kind === 'door' || o.userData.kind === 'window')
            ? 'openingLongPress'
            : 'wallLongPress';
          postToFlutter({
            type,
            nodeId: o.userData.nodeId,
            sourceId: o.userData.sourceId,
            name: o.userData.name,
            kind: o.userData.kind,
            side: o.userData.side || meta.side || null,
            colorHex: o.userData.colorHex || null,
            meta,
            w: o.userData._w || (meta.width) || null,
            h: o.userData._h || null,
          });
          setHud(type === 'openingLongPress' ? 'تنظیم در/پنجره…' : 'انتخاب رنگ دیوار…');
        }, LONG_PRESS_MS);
      }
      if (!editMode) return;
      const obj = pickSelectable(ndc);
      if (!obj) return;
      const k = obj.userData.kind;
      if (k === 'roomShell' || k === 'roomFloor' || k === 'wall') return;
      // مبلمان یا در/پنجره
      if (k !== 'door' && k !== 'window' && !obj.userData.sourceId) return;
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
        resolveSolidCollisions(obj);
        const nest = findNestHost(obj);
        if (nest) {
          // محتوا کمی بالاتر از سطح میز/میزبان
          obj.position.y = Math.max(obj.position.y, 12);
          setHud('قرارگیری روی «' + (nest.userData.name || nest.userData.sourceId || 'میزبان') + '»');
        }
        const lx = obj.position.x - layoutW / 2;
        const ly = obj.position.z - layoutH / 2;
        postToFlutter({
          type: 'itemMoved',
          sourceId: meta.sourceId,
          nodeId: meta.nodeId,
          layoutX: lx,
          layoutY: ly,
          nestHostId: nest && (nest.userData.sourceId || nest.userData.nodeId) || null,
        });
        dragTarget = null;
        controls.enabled = true;
        ev.preventDefault();
        return;
      }
      // در / پنجره جابه‌جا شد
      if (dragTarget && (dragTarget.userData.kind === 'door' || dragTarget.userData.kind === 'window')) {
        postToFlutter({
          type: 'openingMoved',
          nodeId: dragTarget.userData.nodeId,
          kind: dragTarget.userData.kind,
          x: dragTarget.position.x,
          y: dragTarget.position.y,
          z: dragTarget.position.z,
          meta: dragTarget.userData.meta || {},
        });
        dragTarget = null;
        controls.enabled = true;
        setHud('موقعیت در/پنجره به‌روز شد — برای دیوار دقیق از تنظیمات استفاده کنید');
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
  setOpeningColor(nodeId, colorHex) {
    this.setWallColor(nodeId, colorHex);
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
  } else if (msg.type === 'setOpeningColor') {
    window.InteriorEngine.setOpeningColor(msg.nodeId || '', msg.colorHex || '#90CAF9');
  }
});

init();
