/**
 * Bridge Flutter ↔ engine + public InteriorEngine API
 */
import { api, state, selectable } from './eng_state.js';

// --- helpers (module scope — not inside object literal) ---
function touchDist(t0, t1) {
  const dx = t0.clientX - t1.clientX;
  const dy = t0.clientY - t1.clientY;
  return Math.hypot(dx, dy);
}

function applyPinchScale(obj, scale, kind) {
  if (!obj) return;
  const sw = Math.max(36, (obj.userData.layoutW || 80) * scale);
  const sh = Math.max(36, (obj.userData.layoutH || 56) * scale);
  if (!obj.userData._baseW) {
    obj.userData._baseW = obj.userData.layoutW || 80;
    obj.userData._baseH = obj.userData.layoutH || 56;
    obj.userData._baseScaleX = obj.scale.x;
    obj.userData._baseScaleZ = obj.scale.z;
  }
  obj.userData.layoutW = sw;
  obj.userData.layoutH = sh;
  const sx = sw / obj.userData._baseW;
  const sz = sh / obj.userData._baseH;
  obj.scale.x = (obj.userData._baseScaleX || 1) * sx;
  obj.scale.z = (obj.userData._baseScaleZ || 1) * sz;
}

// Expose for eng_part_5 event handlers
api.touchDist = touchDist;
api.applyPinchScale = applyPinchScale;
if (state.pinchResize === undefined) state.pinchResize = null;

api.postToFlutter = function (msg) {
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
};

window.InteriorEngine = {
  loadScene(data) {
    try {
      if (typeof data === 'string') data = JSON.parse(data);
      api.buildScene(data);
    } catch (e) {
      api.showError('خطا در بارگذاری صحنه: ' + (e && e.message ? e.message : e));
    }
  },
  select(id) {
    api.selectNode(id);
  },
  setQuality(level) {
    if (!state.renderer) return;
    const pr =
      level === 'low'
        ? 1
        : Math.min(window.devicePixelRatio || 1, level === 'high' ? 2 : 1.5);
    state.renderer.setPixelRatio(pr);
  },
  setEditMode(enabled) {
    state.editMode = !!enabled;
    state.dragTarget = null;
    state.pinchResize = null;
    if (state.controls) state.controls.enabled = true;
    api.setHud(
      state.editMode
        ? 'حالت جابه‌جایی: وسیله را بکشید و رها کنید'
        : (state.lastSceneKey && 'از بالا · بکشید برای چرخش · نگه‌داشتن دیوار برای رنگ') ||
            'آماده'
    );
  },
  setWallColor(nodeId, colorHex) {
    const obj = selectable.get(nodeId);
    if (!obj) return;
    api.applyWallColor(obj, colorHex);
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
