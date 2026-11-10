import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { api, state, canvas, hud, errEl, PALETTE, selectable, gltfLoader, gltfCache, activeTvVideos, activeTvTextures, _texCache, LONG_PRESS_MS } from './eng_state.js';

api.applyVideoTexture = function(mesh, url) {
  if (!url || !mesh) return;
  try {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.src = url;
    video.style.display = 'none';
    document.body.appendChild(video);
    activeTvVideos.push(video);
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    activeTvTextures.push(tex);
    mesh.material = new THREE.MeshBasicMaterial({
      map: tex,
      toneMapped: false,
    });
    mesh.material.needsUpdate = true;
    const tryPlay = () => {
      video.play().catch(() => {
        // autoplay blocked — پوستر/صفحهٔ تیره می‌ماند تا کاربر تعامل کند
      });
    };
    video.addEventListener('canplay', tryPlay);
    tryPlay();
  } catch (e) {
    console.warn('tv video texture failed', url, e);
  }
}

api.attachTvScreen = function(group, node) {
  const meta = node.meta || {};
  const W = node.w || 80;
  const H = node.h || 50;
  const D = Math.max(node.d || 8, 6);
  // صفحهٔ تخت جلوی بدنه
  const geom = new THREE.PlaneGeometry(W * 0.86, H * 0.78);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x0a1628,
    toneMapped: false,
  });
  const screen = new THREE.Mesh(geom, mat);
  screen.position.set(0, 0, D * 0.55 + 1.2);
  screen.userData.tvScreen = true;
  screen.userData.sourceId = node.sourceId;
  screen.name = 'tv_screen';
  group.add(screen);

  const mode = meta.tvVideoMode || 'none';
  if (mode === 'file' && meta.tvStreamUrl) {
    api.applyVideoTexture(screen, meta.tvStreamUrl);
  } else if ((mode === 'youtube' || mode === 'aparat') && meta.tvPosterUrl) {
    api.applyPosterTexture(screen, meta.tvPosterUrl);
  } else if (mode === 'youtube' && meta.tvStreamUrl) {
    // fallback: بدون poster
    screen.material.color.setHex(0x111827);
  } else {
    // idle glow
    screen.material.color.setHex(0x0c1a2e);
  }
  return screen;
}

api.resolveModelUrl = function(url) {
  if (!url) return url;
  // نسبی نسبت به صفحهٔ موتور
  try {
    return new URL(url, window.location.href).href;
  } catch (_) {
    return url;
  }
}

/** فیت مدل glTF داخل جعبهٔ هدف؛ مبدأ گروه = مرکز جسم (مثل جعبه‌های رویه‌ای) */
api.fitGltfToBox = function(root, targetW, targetH, targetD) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.x < 1e-6 || size.y < 1e-6 || size.z < 1e-6) return;
  const sx = (targetW || size.x) / size.x;
  const sy = (targetH || size.y) / size.y;
  const sz = (targetD || size.z) / size.z;
  const s = Math.min(sx, sy, sz) * 0.92;
  root.scale.multiplyScalar(s);
  root.updateMatrixWorld(true);
  box.setFromObject(root);
  const center = new THREE.Vector3();
  box.getCenter(center);
  // مرکز افقی روی مبدأ گروه
  root.position.x -= center.x;
  root.position.z -= center.z;
  // کف مدل روی -targetH/2 (مبدأ گروه = وسط ارتفاع)
  const th = targetH || size.y;
  root.position.y -= box.min.y;
  root.position.y -= th / 2;
}

api.tintGltfMaterials = function(root, colorHex) {
  if (!colorHex || !root) return;
  const tint = new THREE.Color(api.hexColor(colorHex, 0xffffff));
  // فقط متریال‌های غیر فلزی/تیره را با رنگ آیتم مخلوط کن
  root.traverse((c) => {
    if (!c.isMesh || !c.material) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    mats.forEach((m) => {
      if (!m || !m.color) return;
      const metal = m.metalness != null ? m.metalness : 0;
      // فلز و صفحهٔ خیلی تیره را دست نزن
      const lum = m.color.r * 0.3 + m.color.g * 0.59 + m.color.b * 0.11;
      if (metal > 0.4 || lum < 0.12) return;
      m.color.lerp(tint, 0.55);
      m.needsUpdate = true;
    });
  });
}

api.tryAttachGltf = function(group, modelUrl, scale, fit, colorHex) {
  if (!modelUrl || !gltfLoader) return;
  const url = api.resolveModelUrl(modelUrl);
  const key = url + '|' + (scale || 1) + '|' + JSON.stringify(fit || {});
  const apply = (sceneRoot) => {
    const root = sceneRoot.clone(true);
    const s = scale || 1;
    if (s !== 1) root.scale.setScalar(s);
    root.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
        if (c.material) {
          // clone materials so tint per-instance does not pollute cache
          if (Array.isArray(c.material)) {
            c.material = c.material.map((m) => (m ? m.clone() : m));
          } else {
            c.material = c.material.clone();
          }
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          mats.forEach((m) => {
            if (m) {
              m.side = THREE.DoubleSide;
              m.needsUpdate = true;
            }
          });
        }
      }
    });
    if (fit && (fit.w || fit.h || fit.d)) {
      api.fitGltfToBox(root, fit.w, fit.h, fit.d);
    }
    api.tintGltfMaterials(root, colorHex);
    group.children.slice().forEach((ch) => {
      if (ch.userData && ch.userData.__procedural) group.remove(ch);
    });
    root.userData.__gltf = true;
    group.add(root);
  };
  if (gltfCache.has(key)) {
    apply(gltfCache.get(key));
    return;
  }
  gltfLoader.load(
    url,
    (gltf) => {
      gltfCache.set(key, gltf.scene);
      apply(gltf.scene);
    },
    undefined,
    (err) => console.warn('gltf load failed', url, err)
  );
}


api.boxMesh = function(w, h, d, color, opts = {}) {
  w = Math.max(0.5, w || 1);
  h = Math.max(0.5, h || 1);
  d = Math.max(0.5, d || 1);
  const round = opts.round === false ? 0 : api.radiusFor(w, h, d, opts.round);
  let geo;
  if (round > 0.4 && RoundedBoxGeometry) {
    const seg = opts.segments != null ? opts.segments : 3;
    geo = new RoundedBoxGeometry(w, h, d, seg, round);
  } else {
    geo = new THREE.BoxGeometry(w, h, d);
  }
  const mesh = new THREE.Mesh(geo, api.mat(color, opts));
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


api.makeFloorPatternTexture = function(pattern, baseHex, patternHex, intensity) {
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

api.floorMesh = function(w, h, d, colorHex, opts = {}) {
  const pattern = (opts.pattern || 'wood');
  const pColor = opts.patternColorHex || opts.patternColor || '#8D6E63';
  const intensity = opts.intensity != null ? opts.intensity : 0.55;
  let tex = null;
  if (pattern === 'image' && opts.imageUrl) {
    // بافت از عکس آلبوم — بارگذاری ناهمگام
    tex = null;
  } else if (pattern === 'wood' || pattern === 'solid') {
    tex = pattern === 'solid' ? null : api.makeWoodTexture(opts.seed || 1);
    if (tex) tex.repeat.set(Math.max(2, w / 180), Math.max(2, d / 180));
  } else {
    tex = api.makeFloorPatternTexture(pattern, colorHex, pColor, intensity);
    tex.repeat.set(Math.max(1, w / 220), Math.max(1, d / 220));
  }
  const mesh = api.boxMesh(w, Math.max(h, 3), d, api.hexColor(colorHex, PALETTE.floor), {
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
    mesh.material.color.setHex(api.hexColor(colorHex, PALETTE.floor));
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
api.wallMesh = function(w, h, d, colorHex, opts = {}) {
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
  const base = api.hexColor(colorHex, 0xb3e5fc);
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

