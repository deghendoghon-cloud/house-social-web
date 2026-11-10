import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { api, state, canvas, hud, errEl, PALETTE, selectable, gltfLoader, gltfCache, activeTvVideos, activeTvTextures, _texCache, LONG_PRESS_MS } from './eng_state.js';

api.init = function() {
  try {
    if (!canvas) throw new Error('canvas missing');
    state.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'default',
    });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    state.renderer.setSize(window.innerWidth, window.innerHeight, false);
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.SRGBColorSpace) state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (state.renderer.toneMapping != null) {
      state.renderer.toneMapping = THREE.ACESFilmicToneMapping || state.renderer.toneMapping;
      state.renderer.toneMappingExposure = 1.05;
    }

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x243038);
    state.scene.fog = new THREE.Fog(PALETTE.bg, 1800, 4200);

    state.camera = new THREE.PerspectiveCamera(
      42,
      Math.max(window.innerWidth, 1) / Math.max(window.innerHeight, 1),
      2,
      8000
    );
    state.controls = new OrbitControls(state.camera, canvas);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.1;

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
      raycaster.setFromCamera(pointer, state.camera);
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
      if (state.longPressTimer) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
      state.longPressTarget = null;
    }

    function onPointerDown(ev) {
      if (!state.ready) return;
      const ndc = eventToNDC(ev);
      if (!ndc) return;
      state.pointerDownPos = { x: ndc.clientX, y: ndc.clientY };
      clearLongPress();
      // نگه‌داشتن ۵ ثانیه روی دیوار → انتخاب رنگ
      const hit = pickSelectable(ndc);
      if (hit && (hit.userData.kind === 'wall' || hit.userData.kind === 'roomShell'
          || hit.userData.kind === 'door' || hit.userData.kind === 'window')) {
        state.longPressTarget = hit;
        state.longPressTimer = setTimeout(() => {
          if (!state.longPressTarget) return;
          const o = state.longPressTarget;
          clearLongPress();
          api.selectNode(o.userData.nodeId);
          const meta = o.userData.meta || {};
          const type = (o.userData.kind === 'door' || o.userData.kind === 'window')
            ? 'openingLongPress'
            : 'wallLongPress';
          api.postToFlutter({
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
          api.setHud(type === 'openingLongPress' ? 'تنظیم در/پنجره…' : 'انتخاب رنگ دیوار…');
        }, LONG_PRESS_MS);
      }
      if (!state.editMode) return;
      const obj = pickSelectable(ndc);
      if (!obj) return;
      const k = obj.userData.kind;
      if (k === 'roomShell' || k === 'roomFloor' || k === 'wall') return;
      // مبلمان یا در/پنجره
      if (k !== 'door' && k !== 'window' && !obj.userData.sourceId) return;
      state.dragTarget = obj;
      // نقطهٔ برخورد با صفحهٔ کف
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      raycaster.setFromCamera(pointer, state.camera);
      if (raycaster.ray.intersectPlane(state.dragPlane, _hit)) {
        state.dragOffset.copy(state.dragTarget.position).sub(_hit);
      } else {
        state.dragOffset.set(0, 0, 0);
      }
      state.controls.enabled = false;
      api.selectNode(obj.userData.nodeId);
      ev.preventDefault();
    }

    function onPointerMove(ev) {
      if (state.longPressTimer && state.pointerDownPos) {
        const ndc = eventToNDC(ev);
        if (ndc) {
          const dist = Math.hypot(ndc.clientX - state.pointerDownPos.x, ndc.clientY - state.pointerDownPos.y);
          if (dist > 12) clearLongPress();
        }
      }
      if (!state.dragTarget || !state.editMode) return;
      const ndc = eventToNDC(ev);
      if (!ndc) return;
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      raycaster.setFromCamera(pointer, state.camera);
      if (raycaster.ray.intersectPlane(state.dragPlane, _hit)) {
        state.dragTarget.position.x = _hit.x + state.dragOffset.x;
        state.dragTarget.position.z = _hit.z + state.dragOffset.z;
        const k = (state.dragTarget.userData && state.dragTarget.userData.kind) || '';
        if (k === 'furniture' || k === 'room' || k === 'solid') {
          api.setDragValidityVisual(state.dragTarget, api.solidOverlapsAny(state.dragTarget));
        }
        if (k === 'door' || k === 'window') {
          api.snapOpeningToNearestWall(state.dragTarget);
        }
        // y را از ارتفاع قبلی حفظ نکن — group از y=0 ساخته شده
      }
      ev.preventDefault();
    }

    function onPointerUp(ev) {
      clearLongPress();
      if (state.dragTarget && state.editMode) {
        const obj = state.dragTarget;
        const meta = obj.userData || {};
        const k = meta.kind || '';
        // جابه‌جایی اتاق روی پلان سالن
        if (k === 'roomFloor' && meta.sourceId) {
          const rw = obj.userData._w || obj.geometry?.parameters?.width || 220;
          const rd = obj.userData._d || obj.geometry?.parameters?.depth || 160;
          // ترجیح: ابعاد از userData که در build ست می‌شود
          const layoutW = meta.layoutW || rw || 220;
          const layoutH = meta.layoutH || rd || 160;
          const lx = obj.position.x - layoutW / 2;
          const ly = obj.position.z - layoutH / 2;
          api.postToFlutter({
            type: 'roomMoved',
            sourceId: meta.sourceId,
            nodeId: meta.nodeId,
            layoutX: lx,
            layoutY: ly,
            layoutW,
            layoutH,
          });
          state.dragTarget = null;
          dragRoomParts = null;
          state.controls.enabled = true;
          api.setHud('اتاق جابه‌جا شد');
          ev.preventDefault();
          return;
        }
        // از meta گره — در buildFurniture ذخیره می‌کنیم
        const layoutW = obj.userData.layoutW || 80;
        const layoutH = obj.userData.layoutH || 56;
        api.resolveSolidCollisions(obj);
        const nest = api.findNestHost(obj);
        if (nest) {
          obj.position.y = Math.max(obj.position.y, 12);
          api.setHud('قرارگیری روی «' + (nest.userData.name || nest.userData.sourceId || 'میزبان') + '»');
        }
        const lx = obj.position.x - layoutW / 2;
        const ly = obj.position.z - layoutH / 2;
        api.postToFlutter({
          type: 'itemMoved',
          sourceId: meta.sourceId,
          nodeId: meta.nodeId,
          layoutX: lx,
          layoutY: ly,
          nestHostId: nest && (nest.userData.sourceId || nest.userData.nodeId) || null,
        });
        state.dragTarget = null;
        dragRoomParts = null;
        state.controls.enabled = true;
        ev.preventDefault();
        return;
      }
      // در / پنجره جابه‌جا شد
      if (state.dragTarget && (state.dragTarget.userData.kind === 'door' || state.dragTarget.userData.kind === 'window')) {
        api.snapOpeningToNearestWall(state.dragTarget);
        api.postToFlutter({
          type: 'openingMoved',
          nodeId: state.dragTarget.userData.nodeId,
          kind: state.dragTarget.userData.kind,
          x: state.dragTarget.position.x,
          y: state.dragTarget.position.y,
          z: state.dragTarget.position.z,
          meta: Object.assign({}, state.dragTarget.userData.meta || {}, {
            side: state.dragTarget.userData.side || (state.dragTarget.userData.meta && state.dragTarget.userData.meta.side),
            t: state.dragTarget.userData.t || (state.dragTarget.userData.meta && state.dragTarget.userData.meta.t),
            sill: state.dragTarget.userData.kind === 'door' ? 0 : (state.dragTarget.userData.sill || 90),
          }),
        });
        state.dragTarget = null;
        state.controls.enabled = true;
        api.setHud('موقعیت در/پنجره به‌روز شد — برای دیوار دقیق از تنظیمات استفاده کنید');
        ev.preventDefault();
        return;
      }
      state.dragTarget = null;
      state.controls.enabled = true;

      // کلیک ساده برای انتخاب
      if (!state.pointerDownPos) return;
      const ndc = eventToNDC(ev);
      if (!ndc) return;
      const dist = Math.hypot(ndc.clientX - state.pointerDownPos.x, ndc.clientY - state.pointerDownPos.y);
      state.pointerDownPos = null;
      if (dist > 8) return;
      const obj = pickSelectable(ndc);
      if (!obj) return;
      api.selectNode(obj.userData.nodeId);
      api.postToFlutter({
        type: 'select',
        nodeId: obj.userData.nodeId,
        sourceId: obj.userData.sourceId,
        name: obj.userData.name,
        kind: obj.userData.kind,
      });
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('touchstart', (ev) => {
      if (!state.editMode || !ev.targetTouches || ev.targetTouches.length !== 2) return;
      const obj = state.dragTarget || (state.selectedId && selectable.get(state.selectedId));
      if (!obj) return;
      const k = obj.userData && obj.userData.kind;
      if (k !== 'furniture' && k !== 'roomFloor' && k !== 'content') return;
      const d0 = api.touchDist(ev.targetTouches[0], ev.targetTouches[1]);
      state.pinchResize = {
        obj,
        startDist: d0,
        startW: obj.userData.layoutW || 80,
        startH: obj.userData.layoutH || 56,
        kind: k,
      };
      state.controls.enabled = false;
      ev.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (ev) => {
      if (!state.pinchResize || !ev.targetTouches || ev.targetTouches.length < 2) return;
      const d = api.touchDist(ev.targetTouches[0], ev.targetTouches[1]);
      const scale = d / Math.max(1, state.pinchResize.startDist);
      state.pinchResize.obj.userData.layoutW = state.pinchResize.startW;
      state.pinchResize.obj.userData.layoutH = state.pinchResize.startH;
      api.applyPinchScale(state.pinchResize.obj, scale, state.pinchResize.kind);
      api.setHud('اندازه: ' + Math.round(state.pinchResize.obj.userData.layoutW) + '×' + Math.round(state.pinchResize.obj.userData.layoutH));
      ev.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', (ev) => {
      if (!state.pinchResize) return;
      if (ev.targetTouches && ev.targetTouches.length >= 2) return;
      const obj = state.pinchResize.obj;
      const meta = obj.userData || {};
      api.postToFlutter({
        type: meta.kind === 'roomFloor' ? 'roomResized' : 'itemResized',
        sourceId: meta.sourceId,
        nodeId: meta.nodeId,
        layoutW: meta.layoutW,
        layoutH: meta.layoutH,
        layoutX: obj.position.x - (meta.layoutW || 80) / 2,
        layoutY: obj.position.z - (meta.layoutH || 56) / 2,
      });
      state.pinchResize = null;
      state.controls.enabled = true;
      api.setHud('اندازه ذخیره شد');
    });
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    window.addEventListener('resize', () => {
      const w = Math.max(window.innerWidth, 1);
      const h = Math.max(window.innerHeight, 1);
      state.camera.aspect = w / h;
      state.camera.updateProjectionMatrix();
      state.renderer.setSize(w, h, false);
    });

    function loop() {
      requestAnimationFrame(loop);
      if (state.controls) state.controls.update();
      if (state.renderer && state.scene && state.camera) state.renderer.render(state.scene, state.camera);
    }
    loop();

    api.setHud('آماده');
    api.postToFlutter({ type: 'engine_ready' });
  } catch (e) {
    api.showError('خطا در راه‌اندازی WebGL: ' + (e && e.message ? e.message : e));
  }
}

api.selectNode = function(id) {
  if (state.selectedId && selectable.has(state.selectedId)) {
    const prev = selectable.get(state.selectedId);
    prev.traverse((c) => {
      if (c.material && c.material.emissive) c.material.emissive.setHex(0x000000);
    });
  }
  state.selectedId = id;
  if (id && selectable.has(id)) {
    const m = selectable.get(id);
    m.traverse((c) => {
      if (c.material && c.material.emissive) c.material.emissive.setHex(0x1565c0);
    });
    api.setHud('انتخاب: ' + (m.userData.name || id));
  }
}

