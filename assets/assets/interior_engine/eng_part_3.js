import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { api, state, canvas, hud, errEl, PALETTE, selectable, gltfLoader, gltfCache, activeTvVideos, activeTvTextures, _texCache, LONG_PRESS_MS } from './eng_state.js';

api.applyWallColor = function(obj, colorHex) {
  if (!obj) return;
  const c = api.hexColor(colorHex, 0xb3e5fc);
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

api.glassPanel = function(w, h, d, colorHex, level) {
  const g = GLASS[level] || GLASS.wall;
  return api.wallMesh(w, h, d, colorHex, {
    opacity: g.opacity,
    transmission: g.transmission,
    round: 1.2,
    depthWrite: level === 'door' || level === 'window',
  });
}

api.frameBar = function(w, h, d, colorHex) {
  const mesh = api.wallMesh(w, h, d, colorHex || '#78909C', {
    opacity: GLASS.frame.opacity,
    transmission: GLASS.frame.transmission,
    round: 0.8,
    depthWrite: true,
  });
  return mesh;
}

/** در شیشه‌ای با قاب سه طرفه (بالا + دو کنار) */

/** ابعاد نمای در/پنجره: عرض روی دیوار + ضخامت دیوار؛ چرخش برای شرق/غرب */
api.openingFaceSize = function(node) {
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

api.buildDoor = function(node) {
  const g = new THREE.Group();
  const dim = api.openingFaceSize(node);
  const w = dim.faceW;
  const h = dim.h;
  const d = Math.max(2, dim.thick);
  const glassC = node.colorHex || '#90CAF9';
  const frameC = (node.meta && node.meta.frameColorHex) || '#B0BEC5';
  const ft = Math.max(4, Math.min(8, Math.min(w, h) * 0.06));

  const glass = api.glassPanel(Math.max(2, w - ft * 2), Math.max(2, h - ft), d * 0.55, glassC, 'door');
  glass.position.y = -ft / 2;
  g.add(glass);

  const left = api.frameBar(ft, h, d, frameC);
  left.position.set(-w / 2 + ft / 2, 0, 0);
  g.add(left);
  const right = api.frameBar(ft, h, d, frameC);
  right.position.set(w / 2 - ft / 2, 0, 0);
  g.add(right);
  const top = api.frameBar(w, ft, d, frameC);
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
api.buildWindow = function(node) {
  const g = new THREE.Group();
  const dim = api.openingFaceSize(node);
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
    const pane = api.glassPanel(pw, ph, d * 0.4, glassC, 'window');
    pane.position.set(px, py, 0);
    g.add(pane);
  }

  // قاب بیرونی نازک
  const left = api.frameBar(ft, h, d, frameC);
  left.position.set(-w / 2 + ft / 2, 0, 0);
  g.add(left);
  const right = api.frameBar(ft, h, d, frameC);
  right.position.set(w / 2 - ft / 2, 0, 0);
  g.add(right);
  const top = api.frameBar(w, ft, d, frameC);
  top.position.set(0, h / 2 - ft / 2, 0);
  g.add(top);
  const bot = api.frameBar(w, ft, d, frameC);
  bot.position.set(0, -h / 2 + ft / 2, 0);
  g.add(bot);

  // مولیون عمودی سراسری
  const vBar = api.frameBar(mt, gh, d * 0.9, frameC);
  g.add(vBar);
  // مولیون افقی بین ردیف بالا و پایین
  const hBar = api.frameBar(gw, mt, d * 0.9, frameC);
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
api.buildFurniture = function(node) {
  const kind = (node.meta && node.meta.kindKey) || '';
  const c = api.hexColor(node.colorHex, 0xbcaaa4);
  const g = new THREE.Group();
  // baseY از متا (مثلاً تلویزیون از ۴۰٪ دیوار شروع می‌شود)
  const baseY = (node.meta && node.meta.baseY != null) ? node.meta.baseY : 0;
  g.position.set(node.x, baseY, node.z);
  if (node.rotY) g.rotation.y = node.rotY;

  const W = node.w || 40;
  const H = node.h || 40;
  const D = node.d || 40;

  if (kind === 'bed') {
    const frame = api.boxMesh(W, H * 0.4, D, c, { round: 5, edges: false, roughness: 0.7 });
    frame.position.y = H * 0.22;
    g.add(frame);
    const matress = api.boxMesh(W * 0.92, H * 0.28, D * 0.9, 0xf5f0e8, {
      round: 8,
      edges: false,
      roughness: 0.9,
    });
    matress.position.y = H * 0.48;
    g.add(matress);
    const pillow = api.boxMesh(W * 0.38, H * 0.14, D * 0.28, 0xfff8e1, {
      round: 6,
      edges: false,
      roughness: 0.95,
    });
    pillow.position.set(0, H * 0.62, -D * 0.28);
    g.add(pillow);
  } else if (kind === 'sofa') {
    const fab = api.makeFabricTexture(
      '#' + (typeof c === 'number' ? c.toString(16).padStart(6, '0') : '6d4c41')
    );
    const seat = api.boxMesh(W, H * 0.28, D * 0.78, c, {
      round: 7,
      edges: false,
      map: fab,
      roughness: 0.88,
    });
    seat.position.y = H * 0.28;
    g.add(seat);
    const back = api.boxMesh(W, H * 0.55, D * 0.16, c, {
      round: 6,
      edges: false,
      map: fab,
      roughness: 0.88,
    });
    back.position.set(0, H * 0.62, -D * 0.38);
    g.add(back);
    const armL = api.boxMesh(W * 0.1, H * 0.4, D * 0.72, c, { round: 5, edges: false, map: fab });
    armL.position.set(-W * 0.45, H * 0.4, 0);
    g.add(armL);
    const armR = api.boxMesh(W * 0.1, H * 0.4, D * 0.72, c, { round: 5, edges: false, map: fab });
    armR.position.set(W * 0.45, H * 0.4, 0);
    g.add(armR);
  } else if (kind === 'chair') {
    const seat = api.boxMesh(W, H * 0.1, D, c);
    seat.position.y = H * 0.42;
    g.add(seat);
    const back = api.boxMesh(W, H * 0.42, D * 0.12, c);
    back.position.set(0, H * 0.72, -D * 0.4);
    g.add(back);
    for (const [sx, sz] of [
      [-0.35, -0.35],
      [0.35, -0.35],
      [-0.35, 0.35],
      [0.35, 0.35],
    ]) {
      const leg = api.boxMesh(W * 0.08, H * 0.42, W * 0.08, 0x5d4037, { edges: false });
      leg.position.set(W * sx, H * 0.21, D * sz);
      g.add(leg);
    }
  } else if (kind === 'table' || kind === 'desk') {
    const top = api.boxMesh(W, Math.max(4, H * 0.06), D, c, {
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
      const leg = api.boxMesh(W * 0.07, H * 0.94, W * 0.07, 0x4e342e, {
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
    const body = api.boxMesh(W, H, D, c, { round: 4, edges: false, roughness: 0.65 });
    body.position.y = H / 2;
    g.add(body);
    for (let i = 1; i <= 3; i++) {
      const shelf = api.boxMesh(W * 0.9, 2, D * 0.85, 0x3e2723, {
        edges: false,
        round: 1,
      });
      shelf.position.y = (H * i) / 4;
      g.add(shelf);
    }
    const handle = api.boxMesh(3, H * 0.12, 2, 0xcfd8dc, {
      edges: false,
      round: 1,
      metalness: 0.55,
      roughness: 0.35,
    });
    handle.position.set(W * 0.35, H * 0.5, D * 0.52);
    g.add(handle);
  } else if (kind === 'tv') {
    const bezel = api.boxMesh(W, H, Math.max(5, D), 0x1a1a1a, {
      round: 3,
      edges: false,
      metalness: 0.35,
      roughness: 0.4,
    });
    bezel.position.y = H / 2;
    g.add(bezel);
    const screen = api.boxMesh(W * 0.92, H * 0.88, Math.max(3, D * 0.5), 0x1565c0, {
      round: 2,
      edges: false,
      metalness: 0.2,
      roughness: 0.25,
    });
    screen.position.y = H / 2;
    g.add(screen);
  } else if (kind === 'tv_stand') {
    const body = api.boxMesh(W, H * 0.75, D, c);
    body.position.y = H * 0.38;
    g.add(body);
  } else if (kind === 'plant') {
    const pot = api.boxMesh(W * 0.7, H * 0.22, D * 0.7, 0xa1887f);
    pot.position.y = H * 0.11;
    g.add(pot);
    const leaf = api.boxMesh(W * 0.9, H * 0.72, D * 0.9, 0x388e3c, {
      edgeColor: 0x1b5e20,
    });
    leaf.position.y = H * 0.58;
    g.add(leaf);
  } else if (node.kind === 'content') {
    const plate = api.boxMesh(W, Math.max(4, H), D, c, { edgeColor: 0x1565c0 });
    plate.position.y = Math.max(4, H) / 2;
    g.add(plate);
  } else {
    const body = api.boxMesh(W, H, D, c);
    body.position.y = H / 2;
    g.add(body);
  }

  // همهٔ هندسهٔ ساخته‌شده رویه‌ای‌اند تا با glTF جایگزین شوند
  g.traverse((ch) => {
    if (ch !== g) ch.userData.__procedural = true;
  });
  g.userData.selectable = true;
  g.userData.nodeId = node.id;
  g.userData.sourceId = node.sourceId;
  g.userData.name = node.name || node.id;
  g.userData.kind = node.kind;
  g.userData.layoutW = (node.meta && node.meta.layoutW) || node.w || 80;
  g.userData.layoutH = (node.meta && node.meta.layoutH) || node.d || 56;
  if (node.meta && node.meta.modelUrl) {
    const fit = {
      w: node.meta.fitW || node.w,
      h: node.meta.fitH || node.h,
      d: node.meta.fitD || node.d,
    };
    api.tryAttachGltf(
      g,
      node.meta.modelUrl,
      node.meta.modelScale || 1,
      fit,
      node.colorHex
    );
  }
  // صفحهٔ تلویزیون با بافت ویدئو/پوستر (بعد از glTF تا پاک نشود)
  const kindKey = (node.meta && node.meta.kindKey) || '';
  if (kind === 'tv' || kindKey === 'tv' || kindKey === 'television') {
    api.attachTvScreen(g, node);
  }
  selectable.set(node.id, g);
  return g;
}

/** قاب عکس روی دیوار: حاشیه + صفحه */
