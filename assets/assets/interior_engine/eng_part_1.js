import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { api, state, canvas, hud, errEl, PALETTE, selectable, gltfLoader, gltfCache, activeTvVideos, activeTvTextures, _texCache, LONG_PRESS_MS } from './eng_state.js';

api.showError = function(msg) {
  if (errEl) {
    errEl.style.display = 'flex';
    errEl.textContent = msg;
  }
  console.error(msg);
}

api.setHud = function(t) {
  if (hud) hud.textContent = t || '';
}

api.hexColor = function(hex, fallback = 0xcccccc) {
  if (!hex || typeof hex !== 'string') return fallback;
  let h = hex.replace('#', '');
  if (h.length === 8) h = h.slice(2);
  if (h.length !== 6) return fallback;
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? n : fallback;
}

api.disposeObject = function(obj) {
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

api.clearRoom = function() {
  if (state.roomRoot && state.scene) {
    state.scene.remove(state.roomRoot);
    api.disposeObject(state.roomRoot);
    state.roomRoot = null;
  }
  selectable.clear();
  state.selectedId = null;
}

/** بافت چوب کف — راه‌راه‌های گرم */
api.makeWoodTexture = function(seed = 1) {
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
api.makePlasterTexture = function(seed = 1) {
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
api.makeFabricTexture = function(baseHex = '#6d4c41') {
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

api.mat = function(color, opts = {}) {
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

api.radiusFor = function(w, h, d, requested) {
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

api.isSolidKind = function(kind) {
  return kind === 'furniture' || kind === 'room' || kind === 'solid';
}

api.aabbOverlapXZ = function(ax, az, aw, ad, bx, bz, bw, bd) {
  const eps = 1;
  return ax < bx + bw - eps && ax + aw > bx + eps && az < bz + bd - eps && az + ad > bz + eps;
}

/** چسباندن در/پنجره به نزدیک‌ترین دیوار و کف (y از ارتفاع بازشو) */
api.snapOpeningToNearestWall = function(obj) {
  const meta = obj.userData || {};
  const kind = meta.kind;
  if (kind !== 'door' && kind !== 'window') return;
  const sceneW = (window.__interiorRoomW) || 400;
  const sceneD = (window.__interiorRoomD) || 300;
  const wallT = 12;
  const inset = 1.5;
  const h = obj.userData._h || (kind === 'door' ? 210 : 120);
  const isDoor = kind === 'door';
  // در همیشه کف؛ پنجره حداقل کمی از کف بالاتر
  const sill = isDoor ? 0 : Math.max(40, meta.sill || 90);
  obj.position.y = sill + h / 2;

  const x = obj.position.x, z = obj.position.z;
  const distS = Math.abs(z - 0);
  const distN = Math.abs(z - sceneD);
  const distW = Math.abs(x - 0);
  const distE = Math.abs(x - sceneW);
  const minD = Math.min(distS, distN, distW, distE);
  let side = 's';
  if (minD === distN) side = 'n';
  else if (minD === distE) side = 'e';
  else if (minD === distW) side = 'w';
  else side = 's';

  const along = (side === 'n' || side === 's') ? sceneW : sceneD;
  let t = (side === 'n' || side === 's') ? (x / sceneW) : (z / sceneD);
  t = Math.max(0.08, Math.min(0.92, t));
  const centerAlong = t * along;

  if (side === 'n') {
    obj.position.x = centerAlong;
    obj.position.z = sceneD + wallT / 2 - inset;
    obj.rotation.y = 0;
  } else if (side === 's') {
    obj.position.x = centerAlong;
    obj.position.z = -wallT / 2 + inset;
    obj.rotation.y = 0;
  } else if (side === 'e') {
    obj.position.x = sceneW + wallT / 2 - inset;
    obj.position.z = centerAlong;
    obj.rotation.y = Math.PI / 2;
  } else {
    obj.position.x = -wallT / 2 + inset;
    obj.position.z = centerAlong;
    obj.rotation.y = Math.PI / 2;
  }
  meta.side = side;
  meta.t = t;
  meta.sill = sill;
}

api.findNestHost = function(obj) {
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

api.solidOverlapsAny = function(obj) {
  const meta = obj.userData || {};
  if (meta.kind !== 'furniture' && meta.kind !== 'room') return false;
  const lw = meta.layoutW || 80, lh = meta.layoutH || 56;
  const ax = obj.position.x - lw / 2, az = obj.position.z - lh / 2;
  for (const [, other] of selectable) {
    if (other === obj) continue;
    const om = other.userData || {};
    if (om.kind !== 'furniture' && om.kind !== 'room') continue;
    const ow = om.layoutW || 80, oh = om.layoutH || 56;
    const bx = other.position.x - ow / 2, bz = other.position.z - oh / 2;
    if (api.aabbOverlapXZ(ax, az, lw, lh, bx, bz, ow, oh)) return true;
  }
  return false;
}

api.setDragValidityVisual = function(obj, invalid) {
  state.dragWasInvalid = !!invalid;
  obj.traverse((c) => {
    if (!c.isMesh || !c.material) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    for (const m of mats) {
      if (m.emissive) {
        m.emissive.setHex(invalid ? 0xc62828 : 0x000000);
        m.emissiveIntensity = invalid ? 0.55 : 0.0;
      }
    }
  });
  if (invalid) api.setHud('هم‌پوشانی — رها کنید تا به نزدیک‌ترین جای آزاد برود');
}

/** جستجوی مارپیچی نزدیک‌ترین نقطهٔ بدون هم‌پوشانی جامد */
api.findNearestFreePosition = function(obj, maxR = 400, step = 16) {
  const meta = obj.userData || {};
  const lw = meta.layoutW || 80, lh = meta.layoutH || 56;
  const ox = obj.position.x, oz = obj.position.z;
  if (!api.solidOverlapsAny(obj)) return { x: ox, z: oz };
  for (let r = step; r <= maxR; r += step) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      obj.position.x = ox + Math.cos(ang) * r;
      obj.position.z = oz + Math.sin(ang) * r;
      if (!api.solidOverlapsAny(obj)) return { x: obj.position.x, z: obj.position.z };
    }
  }
  // برگرد به مبدأ کشیدن
  if (state.dragOrigin) {
    obj.position.x = state.dragOrigin.x;
    obj.position.z = state.dragOrigin.z;
  } else {
    obj.position.x = ox;
    obj.position.z = oz;
  }
  return { x: obj.position.x, z: obj.position.z };
}

api.resolveSolidCollisions = function(obj) {
  const meta = obj.userData || {};
  if (meta.kind !== 'furniture' && meta.kind !== 'room') return;
  // چند پاس هل‌دادن لبه
  for (let pass = 0; pass < 8; pass++) {
    const lw = meta.layoutW || 80, lh = meta.layoutH || 56;
    let ax = obj.position.x - lw / 2, az = obj.position.z - lh / 2;
    let moved = false;
    for (const [, other] of selectable) {
      if (other === obj) continue;
      const om = other.userData || {};
      if (om.kind !== 'furniture' && om.kind !== 'room') continue;
      const ow = om.layoutW || 80, oh = om.layoutH || 56;
      const bx = other.position.x - ow / 2, bz = other.position.z - oh / 2;
      if (api.aabbOverlapXZ(ax, az, lw, lh, bx, bz, ow, oh)) {
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
        moved = true;
      }
    }
    if (!moved) break;
  }
  // اگر هنوز هم‌پوشان است → نزدیک‌ترین جای آزاد یا برگشت
  if (api.solidOverlapsAny(obj)) {
    api.findNearestFreePosition(obj);
  }
  api.setDragValidityVisual(obj, false);
}


api.disposeTvMedia = function() {
  for (const v of activeTvVideos) {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
      if (v.parentNode) v.parentNode.removeChild(v);
    } catch (_) {}
  }
  activeTvVideos.length = 0;
  for (const tex of activeTvTextures) {
    try { tex.dispose(); } catch (_) {}
  }
  activeTvTextures.length = 0;
}

api.applyPosterTexture = function(mesh, url) {
  if (!url || !mesh) return;
  const loader = new THREE.TextureLoader();
  loader.load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      mesh.material = new THREE.MeshBasicMaterial({
        map: tex,
        toneMapped: false,
      });
      mesh.material.needsUpdate = true;
    },
    undefined,
    () => console.warn('tv poster failed', url)
  );
}

