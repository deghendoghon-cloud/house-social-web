import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { api, state, canvas, hud, errEl, PALETTE, selectable, gltfLoader, gltfCache, activeTvVideos, activeTvTextures, _texCache, LONG_PRESS_MS } from './eng_state.js';

api.buildWallImage = function(node) {
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
    const frame = api.boxMesh(W * scale, H * (frameKind === 'polaroid' ? scale + 0.08 : scale), depth, fc, {
      round: shape === 'round' ? Math.min(W, H) * 0.45 : 4,
      edges: false,
      roughness: frameKind === 'gold' ? 0.35 : 0.55,
      metalness: frameKind === 'gold' ? 0.45 : 0.05,
    });
    g.add(frame);
  }
  const plate = api.boxMesh(W, H, 3, api.hexColor(node.colorHex, 0xfafafa), {
    round: shape === 'round' ? Math.min(W, H) * 0.48 : 2,
    edges: false,
    roughness: 0.9,
  });
  plate.position.z = 2;
  g.add(plate);
  // نوار تزئینی اگر عکس نباشد
  if (!meta.photoContentId) {
    const accent = api.boxMesh(W * 0.7, H * 0.08, 1, 0x90a4ae, {
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

api.buildNode = function(node, parent) {
  const kind = node.kind;
  let obj = null;
  const color = api.hexColor(node.colorHex);

  if (kind === 'floor') {
    const meta = node.meta || {};
    obj = api.floorMesh(node.w, Math.max(node.h, 3), node.d, node.colorHex, {
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
      obj.userData.layoutW = node.w;
      obj.userData.layoutH = node.d;
      obj.userData._w = node.w;
      obj.userData._d = node.d;
      selectable.set(node.id, obj);
    }
  } else if (kind === 'ceiling') {
    obj = api.boxMesh(node.w, Math.max(node.h, 2), node.d, api.hexColor(node.colorHex, 0xf7f4ef), {
      castShadow: false,
      edges: false,
      round: 1,
      roughness: 0.95,
    });
    obj.position.set(node.x, node.y || 0, node.z);
    obj.visible = !!(node.meta && node.meta.showCeiling);
  } else if (kind === 'wall') {
    obj = api.wallMesh(node.w, node.h, node.d, node.colorHex || '#B3E5FC', {
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
    obj = api.buildDoor(node);
    obj.userData.selectable = true;
    obj.userData.nodeId = node.id;
    obj.userData.sourceId = node.sourceId || node.id;
    obj.userData.name = node.name || 'در';
    obj.userData.kind = 'door';
    obj.userData.colorHex = node.colorHex;
    obj.userData.meta = node.meta || {};
    selectable.set(node.id, obj);
  } else if (kind === 'window') {
    obj = api.buildWindow(node);
    obj.userData.selectable = true;
    obj.userData.nodeId = node.id;
    obj.userData.sourceId = node.sourceId || node.id;
    obj.userData.name = node.name || 'پنجره';
    obj.userData.kind = 'window';
    obj.userData.colorHex = node.colorHex;
    obj.userData.meta = node.meta || {};
    selectable.set(node.id, obj);
  } else if (kind === 'roomShell') {
    obj = api.wallMesh(node.w, node.h, node.d, node.colorHex || '#B3E5FC', {
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
    obj = api.buildFurniture(node);
  } else if (kind === 'imageOnWall') {
    obj = api.buildWallImage(node);
  } else {
    obj = api.boxMesh(node.w || 20, node.h || 20, node.d || 20, color);
    obj.position.set(node.x || 0, node.y || 0, node.z || 0);
  }

  if (obj) {
    obj.userData.kind = obj.userData.kind || kind;
    parent.add(obj);
  }

  if (node.children && node.children.length) {
    for (const ch of node.children) api.buildNode(ch, parent);
  }
}

api.applyTopDownCamera = function(data) {
  const cam = data.camera || {};
  // مرکز هدف: از state.camera یا وسط صحنه
  let tx = cam.targetX;
  let ty = cam.targetY != null ? cam.targetY : 10;
  let tz = cam.targetZ;
  if (tx == null || tz == null) {
    // محاسبه از گره‌های کف
    tx = (data.width || 400) / 2;
    tz = (data.depth || 400) / 2;
  }
  const target = new THREE.Vector3(tx, ty, tz);
  state.controls.target.copy(target);

  const W = data.width || 400;
  const D = data.depth || 400;
  const span = Math.max(W, D);
  // فاصلهٔ مناسب با نسبت تصویر واقعی کانواس تا کل سالن/اتاق در فریم باشد
  const aspect = (state.camera && state.camera.aspect) ? state.camera.aspect : (canvas.clientWidth / Math.max(1, canvas.clientHeight));
  const fov = ((state.camera && state.camera.fov) ? state.camera.fov : 42) * Math.PI / 180;
  const halfFov = fov / 2;
  const fitPad = 1.22; // حاشیهٔ کمی دور صحنه
  const distForDepth = (D * 0.5 * fitPad) / Math.tan(halfFov);
  const distForWidth = (W * 0.5 * fitPad) / (Math.tan(halfFov) * Math.max(0.35, aspect));
  const fitDist = Math.max(distForDepth, distForWidth, span * 0.55);
  const dist = cam.distance != null ? Math.max(cam.distance, fitDist * 0.85) : fitDist;
  state.controls.minDistance = cam.minDistance != null ? cam.minDistance : Math.min(span * 0.35, fitDist * 0.45);
  state.controls.maxDistance = cam.maxDistance != null ? cam.maxDistance : Math.max(span * 3.5, fitDist * 2.2);
  state.controls.minPolarAngle = cam.minPolar != null ? cam.minPolar : 0.12;
  state.controls.maxPolarAngle = cam.maxPolar != null ? cam.maxPolar : 1.05;
  state.controls.minAzimuthAngle = -Infinity;
  state.controls.maxAzimuthAngle = Infinity;
  state.controls.enablePan = true;
  state.controls.screenSpacePanning = true;
  state.controls.panSpeed = 0.5;
  state.controls.rotateSpeed = 0.45;
  state.controls.zoomSpeed = 0.9;
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.1;

  // از بالا
  state.camera.position.set(target.x, target.y + dist, target.z + 0.5);
  state.controls.update();
}

api.buildScene = function(data) {
  if (!state.scene || !state.camera || !state.controls) return;
  api.disposeTvMedia();

  const key = JSON.stringify({
    id: data.roomId || data.hallId || data.name,
    n: (data.nodes || []).length,
    w: data.width,
    d: data.depth,
    v: data.version || 0,
  });
  if (key === state.lastSceneKey && state.roomRoot) {
    api.postToFlutter({ type: 'state.ready', roomId: data.roomId || data.hallId });
    return;
  }
  state.lastSceneKey = key;

  api.clearRoom();
  state.roomRoot = new THREE.Group();
  state.roomRoot.name = 'root_' + (data.roomId || data.hallId || 'x');

  for (const n of data.nodes || []) {
    if (n.kind === 'ceiling') {
      n.meta = n.meta || {};
      n.meta.showCeiling = !!(data.camera && data.camera.showCeiling);
    }
    api.buildNode(n, state.roomRoot);
  }

  state.scene.add(state.roomRoot);

  // نور: نیم‌کره + محیطی + خورشید با سایه نرم + پرکننده سرد
  const W = data.width || 400, H = data.height || 280, D = data.depth || 400;
  const hemi = new THREE.HemisphereLight(0xfff6ea, 0x6b6358, 0.62);
  state.roomRoot.add(hemi);
  const amb = new THREE.AmbientLight(0xfff8f0, 0.28);
  state.roomRoot.add(amb);
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
  state.roomRoot.add(dir);
  const fill = new THREE.DirectionalLight(0xb8d0f0, 0.28);
  fill.position.set(-W * 0.5, H * 0.9, -D * 0.4);
  state.roomRoot.add(fill);
  const rim = new THREE.DirectionalLight(0xffe0c0, 0.12);
  rim.position.set(0, H * 0.4, -D * 0.8);
  state.roomRoot.add(rim);

  api.applyTopDownCamera(data);

  api.setHud((data.name || 'فضا') + ' · شیشه · بکشید برای چرخش · نگه‌داشتن دیوار ۵ثانیه = رنگ');
  state.ready = true;
  api.postToFlutter({ type: 'state.ready', roomId: data.roomId || data.hallId });
}

