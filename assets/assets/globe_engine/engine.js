/*
 * House Social — CesiumJS globe engine.
 *
 * Runs inside a WebView (Android/iOS, served by the in-app localhost server)
 * or an <iframe> (Flutter web). Talks to Flutter only through JSON messages:
 *
 *   Flutter -> JS : window.HouseGlobe.receive('{"cmd":"flyTo",...}')
 *                   (web: window.postMessage({channel:'house-globe-cmd', payload}))
 *   JS -> Flutter : HouseGlobeBridge.postMessage('{"type":"ready",...}')
 *                   (web: parent.postMessage({channel:'house-globe-evt', payload}))
 *
 * Query parameters (all optional):
 *   proxy=<base>    mobile tile proxy, tiles become <base><sourceId>/{z}/{x}/{y}
 *   sources=<url>   alternative sources.json (e.g. on your own server)
 *   lang=fa|en      language for place names
 *   mode=satellite|street|terrain
 *   quality=low|normal|high
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var PROXY = params.get('proxy') || '';
  var LANG = params.get('lang') || 'fa';
  var SOURCES_URL = params.get('sources') || 'sources.json';

  // ---------------------------------------------------------------- bridge
  var outbox = []; // kept for automated tests / debugging
  function post(type, data) {
    var msg = Object.assign({ type: type }, data || {});
    var json = JSON.stringify(msg);
    outbox.push(msg);
    if (outbox.length > 200) outbox.shift();
    try {
      if (window.HouseGlobeBridge && window.HouseGlobeBridge.postMessage) {
        window.HouseGlobeBridge.postMessage(json);
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage({ channel: 'house-globe-evt', payload: json }, window.location.origin);
      }
    } catch (e) { /* bridge not ready */ }
  }

  // ---------------------------------------------------------------- state
  var config = null;
  var widget = null;
  var scene = null;
  var camera = null;
  var currentMode = params.get('mode') || 'satellite';
  var overlays = { borders: true, places: true };
  var housesDs = null;
  var featuredDs = null; // دفتر مرکزی و رویدادها: بدون خوشه‌بندی
  var specialsDs = null; // مرحلهٔ ۳: مناسبت‌ها و هشدارهای مدیر (نقطه + دایرهٔ اختیاری)
  var bordersPrim = null;
  var placesBillboards = null;
  var placesData = null;
  var placeImgCache = new Map();
  var placeShown = new Map();
  var markers = new Map(); // id -> {entity, data}
  var selectedId = null;
  var tileErrors = {};
  var lastErrorReport = 0;
  var markerLabelMode = false;
  // Phase-1 additions: day/night, daily imagery, auto-rotate, auto quality
  var lighting = { dayNight: params.get('daynight') !== '0', cityLights: params.get('lights') !== '0' };
  var nightLayer = null;
  var dailyLayer = null;
  var autoRotate = { enabled: params.get('autorotate') === '1', idleMs: 5000 };
  var lastInput = Date.now();
  var rotating = false;
  var clockTimer = null;
  var currentQuality = 'normal';

  var LOD_BANDS = [
    { band: 'global', min: 6.0e6 },
    { band: 'regional', min: 6.0e5 },
    { band: 'city', min: 4.0e4 },
    { band: 'neighborhood', min: 5.0e3 },
    { band: 'street', min: 8.0e2 },
    { band: 'building', min: 0 }
  ];
  function bandFor(height) {
    for (var i = 0; i < LOD_BANDS.length; i++) if (height >= LOD_BANDS[i].min) return LOD_BANDS[i].band;
    return 'building';
  }

  // ---------------------------------------------------------------- helpers
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  // Daily GIBS layers: today's composite is usually still incomplete, so use
  // UTC now minus `dateLagHours` (default 36 h), as YYYY-MM-DD.
  function sourceDate(src) {
    // GIBS publishes a day's global composite with a delay of many hours, so
    // "yesterday" is often still missing just after midnight UTC: use a lag in hours.
    var lagH = src.dateLagHours != null ? src.dateLagHours : 36;
    var d = new Date(Date.now() - lagH * 3600000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function tileUrl(id, src) {
    var dated = src.url.indexOf('{date}') >= 0;
    if (PROXY && src.proxy) return PROXY + id + '/{z}/{x}/{y}' + (dated ? '?date=' + sourceDate(src) : '');
    return dated ? src.url.replace('{date}', sourceDate(src)) : src.url;
  }
  function rect(r) { return r ? Cesium.Rectangle.fromDegrees(r[0], r[1], r[2], r[3]) : undefined; }

  function reportTileError(id) {
    tileErrors[id] = (tileErrors[id] || 0) + 1;
    var now = Date.now();
    if (now - lastErrorReport > 3000) {
      lastErrorReport = now;
      post('tileErrors', { counts: tileErrors, online: navigator.onLine });
    }
  }

  function attachErrorHandling(provider, id) {
    if (!provider || !provider.errorEvent) return;
    provider.errorEvent.addEventListener(function (err) {
      reportTileError(id);
      // Retry a tile at most twice, and only while online.
      if (err && err.timesRetried < 2 && navigator.onLine) err.retry = true;
    });
  }

  // ---------------------------------------------------------------- imagery
  function createImageryLayer(id, extra) {
    var src = config.sources[id];
    if (!src) return null;
    var layerOpts = Object.assign({
      minimumTerrainLevel: src.minTerrainLevel,
      maximumTerrainLevel: src.maxTerrainLevel
    }, extra || {});
    if (src.type === 'tms-local') {
      var p = Cesium.TileMapServiceImageryProvider.fromUrl(src.url, {
        fileExtension: 'jpg', maximumLevel: src.maxLevel, credit: new Cesium.Credit(src.credit)
      });
      return Cesium.ImageryLayer.fromProviderAsync(p, layerOpts);
    }
    if (src.type === 'xyz') {
      var provider = new Cesium.UrlTemplateImageryProvider({
        url: tileUrl(id, src),
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        maximumLevel: src.maxLevel,
        minimumLevel: 0,
        rectangle: rect(src.rectangle),
        tileWidth: 256,
        tileHeight: 256,
        credit: new Cesium.Credit(src.credit)
      });
      attachErrorHandling(provider, id);
      return new Cesium.ImageryLayer(provider, layerOpts);
    }
    return null;
  }

  // ---------------------------------------------------------------- terrain
  // Terrarium PNG (AWS Terrain Tiles) -> Cesium heightmap. Levels deeper than
  // the source maximum are resampled from the deepest available ancestor.
  function createTerrariumProvider(id) {
    var src = config.sources[id];
    var SIZE = 65;
    var maxZ = src.maxLevel || 15;
    var cache = new Map();
    var CACHE_MAX = 64;

    function decode(z, x, y) {
      var key = z + '/' + x + '/' + y;
      if (cache.has(key)) {
        var hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit;
      }
      var url = tileUrl(id, src).replace('{z}', z).replace('{x}', x).replace('{y}', y);
      var pr = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (b) { return createImageBitmap(b); }).then(function (bmp) {
        var c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        var d = ctx.getImageData(0, 0, c.width, c.height);
        return { w: c.width, h: c.height, px: d.data };
      });
      pr.catch(function () { cache.delete(key); reportTileError(id); });
      cache.set(key, pr);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return pr;
    }

    function heightAt(img, u, v) {
      var fx = Math.min(Math.max(u, 0), img.w - 1), fy = Math.min(Math.max(v, 0), img.h - 1);
      var x0 = Math.floor(fx), y0 = Math.floor(fy);
      var x1 = Math.min(x0 + 1, img.w - 1), y1 = Math.min(y0 + 1, img.h - 1);
      var tx = fx - x0, ty = fy - y0;
      function h(x, y) {
        var i = (y * img.w + x) * 4, p = img.px;
        return (p[i] * 256 + p[i + 1] + p[i + 2] / 256) - 32768;
      }
      var a = h(x0, y0) * (1 - tx) + h(x1, y0) * tx;
      var b = h(x0, y1) * (1 - tx) + h(x1, y1) * tx;
      return a * (1 - ty) + b * ty;
    }

    return new Cesium.CustomHeightmapTerrainProvider({
      width: SIZE,
      height: SIZE,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      credit: new Cesium.Credit(src.credit),
      callback: function (x, y, level) {
        var z = level, tx = x, ty = y, sub = 1, ox = 0, oy = 0;
        if (level > maxZ) {
          var d = level - maxZ;
          sub = 1 << d; tx = x >> d; ty = y >> d; ox = x - (tx << d); oy = y - (ty << d); z = maxZ;
        }
        return decode(z, tx, ty).then(function (img) {
          var out = new Float32Array(SIZE * SIZE);
          var span = (img.w - 1) / sub;
          for (var r = 0; r < SIZE; r++) {
            for (var c = 0; c < SIZE; c++) {
              var u = (ox + c / (SIZE - 1)) * span;
              var v = (oy + r / (SIZE - 1)) * span;
              out[r * SIZE + c] = Math.max(heightAt(img, u, v), -500);
            }
          }
          return out;
        }).catch(function () {
          return new Float32Array(SIZE * SIZE); // flat fallback (offline)
        });
      }
    });
  }

  // ---------------------------------------------------------------- modes
  function applyMode(mode) {
    if (!config.modes[mode]) mode = 'satellite';
    currentMode = mode;
    var m = config.modes[mode];
    var layers = widget.imageryLayers;
    layers.removeAll(true);
    m.imagery.forEach(function (id) {
      var layer = createImageryLayer(id);
      if (layer) layers.add(layer);
    });
    if (m.terrain && config.sources[m.terrain]) {
      scene.terrainProvider = createTerrariumProvider(m.terrain);
      scene.verticalExaggeration = m.exaggeration || 1.0;
    } else {
      scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      scene.verticalExaggeration = 1.0;
    }
    addExtraLayers();
    refreshMarkerHeights();
    scene.requestRender();
    post('modeChanged', { mode: mode });
  }

  // ---------------------------------------------------------------- daily imagery + night lights
  // Layers that sit on top of the mode's base imagery. Re-created on every
  // mode switch (applyMode clears the imagery collection).
  function addExtraLayers() {
    var layers = widget.imageryLayers;
    dailyLayer = null; nightLayer = null;
    var dcfg = config.overlays && config.overlays.daily;
    if (overlays.daily && dcfg && config.sources[dcfg.source]) {
      // Swath gaps in the daily composite are pure black -> made transparent.
      dailyLayer = createImageryLayer(dcfg.source, {
        alpha: dcfg.alpha != null ? dcfg.alpha : 0.85,
        colorToAlpha: Cesium.Color.BLACK, colorToAlphaThreshold: 0.03
      });
      if (dailyLayer) layers.add(dailyLayer);
    }
    var lcfg = config.lighting;
    if (lcfg && lcfg.night && config.sources[lcfg.night]) {
      // Visible only on the night side of the globe (Cesium day/night blend).
      nightLayer = createImageryLayer(lcfg.night, { dayAlpha: 0.0, nightAlpha: 1.0 });
      if (nightLayer) layers.add(nightLayer);
    }
    applyLighting();
    updateDailyVisibility();
  }

  function updateNightVisibility() {
    if (!nightLayer) return;
    var lcfg = config.lighting || {};
    // Night side is otherwise multiplied dark by Cesium; boost the lights.
    nightLayer.brightness = lcfg.lightsBrightness || 2.5;
    // At city zoom the lights are blurry blobs: show the day imagery instead.
    nightLayer.show = !!lighting.dayNight && !!lighting.cityLights &&
      camera.positionCartographic.height >= (lcfg.lightsMinHeight || 1.2e6);
  }

  function updateDailyVisibility() {
    updateNightVisibility();
    if (!dailyLayer) return;
    var dcfg = config.overlays.daily;
    dailyLayer.show = camera.positionCartographic.height >= (dcfg.minHeight || 3.0e5);
  }

  // Real-time sun position: the terminator moves with the real clock.
  function applyLighting() {
    var g = scene.globe;
    var on = !!lighting.dayNight;
    var lcfg = config.lighting || {};
    g.enableLighting = on;
    g.dynamicAtmosphereLighting = on;
    g.dynamicAtmosphereLightingFromSun = on;
    // Cesium measures these fade distances from the Earth's CENTRE, so the
    // configured values are heights above the surface plus the radius.
    var R = 6378137.0;
    g.lightingFadeOutDistance = R + (lcfg.fadeOutHeight || 1.5e6);
    g.lightingFadeInDistance = R + (lcfg.fadeInHeight || 4.0e6);
    // Keep the night-side darkness / night imagery active at every distance;
    // close-range readability is handled by hiding the night layer below.
    g.nightFadeOutDistance = 1.0e9;
    g.nightFadeInDistance = 2.0e9;
    if (scene.sun) scene.sun.show = on;
    updateNightVisibility();
    widget.clock.shouldAnimate = false;
    widget.clock.currentTime = Cesium.JulianDate.now();
    clearInterval(clockTimer);
    if (on) {
      clockTimer = setInterval(function () {
        widget.clock.currentTime = Cesium.JulianDate.now();
        scene.requestRender();
      }, 60000);
    }
    scene.requestRender();
  }

  // Sub-solar point (where the sun is overhead) for Flutter's day/night chip.
  function sunInfo() {
    var t = widget.clock.currentTime;
    var p = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t);
    var m = Cesium.Transforms.computeTemeToPseudoFixedMatrix(t);
    if (!m) return null;
    var f = Cesium.Matrix3.multiplyByVector(m, p, new Cesium.Cartesian3());
    var c = Cesium.Cartographic.fromCartesian(f, Cesium.Ellipsoid.WGS84);
    return c ? { sunLat: Cesium.Math.toDegrees(c.latitude), sunLng: Cesium.Math.toDegrees(c.longitude) } : null;
  }

  // ---------------------------------------------------------------- auto-rotate
  // After `idleMs` without touch, the camera turns slowly around the Earth's
  // polar axis (eastward spin, like the real Earth). Apparent screen speed is
  // the same at every height; disabled below city level and while a house is
  // selected.
  function markInput() { lastInput = Date.now(); }
  function setupIdleTracking() {
    ['pointerdown', 'pointermove', 'wheel', 'touchstart', 'keydown'].forEach(function (ev) {
      scene.canvas.addEventListener(ev, function (e) {
        if (ev === 'pointermove' && !(e.buttons || e.pointerType === 'touch')) return;
        markInput();
      }, { passive: true });
    });
    var last = performance.now();
    function tick(now) {
      var dt = Math.min((now - last) / 1000, 0.1); last = now;
      var h = camera.positionCartographic.height;
      var want = autoRotate.enabled && !paused && !selectedId &&
        Date.now() - lastInput > autoRotate.idleMs && h >= 4.0e4;
      if (want) {
        var base = (2 * Math.PI) / (currentQuality === 'low' ? 180 : 120); // one turn per 2-3 min at globe view
        var rate = base * Math.min(1, h / 2.0e7);
        // Real Earth spins eastward: the ground slides left-to-right, i.e. the
        // longitude under the camera decreases over time.
        camera.rotate(Cesium.Cartesian3.UNIT_Z, rate * dt);
        scene.requestRender();
      }
      if (want !== rotating) { rotating = want; post('autoRotate', { active: want }); }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var paused = false;

  // ---------------------------------------------------------------- performance probe
  // Hints for Flutter's automatic low-power mode: weak device, slow tiles.
  var tileTimes = [];
  function setupPerfProbe() {
    try {
      var po = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (/\/t\/|\{z\}|\/tile\/|wmts|\.png|\.jpe?g/.test(e.name) && e.duration > 0) {
            tileTimes.push(e.duration);
            if (tileTimes.length > 40) tileTimes.shift();
          }
        });
      });
      po.observe({ type: 'resource', buffered: false });
    } catch (e) { /* not supported */ }
    setInterval(function () {
      var avg = 0;
      if (tileTimes.length) avg = tileTimes.reduce(function (a, b) { return a + b; }, 0) / tileTimes.length;
      post('perf', {
        cores: navigator.hardwareConcurrency || 0,
        memoryGb: navigator.deviceMemory || 0,
        avgTileMs: Math.round(avg),
        samples: tileTimes.length,
        saveData: !!(navigator.connection && navigator.connection.saveData),
        effectiveType: (navigator.connection && navigator.connection.effectiveType) || ''
      });
    }, 15000);
  }

  // ---------------------------------------------------------------- canvas images (RTL-safe text)
  // Cesium's Label does not shape Persian/Arabic text, so text is drawn with
  // canvas (which shapes correctly) and shown as billboard images.
  var FONT = '600 13px Vazirmatn, Tahoma, "Noto Sans Arabic", sans-serif';
  var pinCache = new Map();
  var PIN_COLORS = { mine: '#FFC107', shop: '#42A5F5', friend: '#F06292', house: '#4FC3F7', hq: '#7E57C2', event: '#FF7043' };
  function safeColor(c) { return typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c) ? c : null; }
  function pinImage(kind, selected, text, online, live, customColor, icon) {
    var key = kind + '|' + (selected ? 1 : 0) + '|' + (text || '') + '|' + (online ? 1 : 0) + '|' + (live ? 1 : 0) + '|' + (customColor || '') + '|' + (icon || '');
    if (pinCache.has(key)) return pinCache.get(key);
    var color = safeColor(customColor) || PIN_COLORS[kind] || PIN_COLORS.house;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var big = kind === 'hq' || kind === 'special';
    var r = (selected ? 11 : 8) + (big ? 4 : 0);
    var halo = online ? 5 : 0;
    var tw = 0, measure = document.createElement('canvas').getContext('2d');
    if (text) { measure.font = FONT; tw = Math.ceil(measure.measureText(text).width) + 14; }
    var w = Math.max(2 * (r + halo) + 6, tw), h = 2 * r + 10 + halo + (text ? 22 : 0);
    var c = document.createElement('canvas');
    c.width = w * dpr; c.height = h * dpr;
    var g = c.getContext('2d'); g.scale(dpr, dpr);
    var cx = w / 2;
    if (text) {
      g.font = FONT; g.direction = 'rtl'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(8,12,24,.78)';
      roundRect(g, cx - tw / 2, 0, tw, 20, 10); g.fill();
      g.fillStyle = '#fff'; g.fillText(text, cx, 10.5);
    }
    var top = (text ? 22 : 0) + halo;
    var cy = top + r + 1;
    if (online) {
      // هالهٔ سبز آنلاین
      g.beginPath(); g.arc(cx, cy, r + halo, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0,230,118,.35)'; g.fill();
      g.lineWidth = 2; g.strokeStyle = '#00E676'; g.stroke();
    }
    g.beginPath(); g.moveTo(cx, top + 2 * r + 8); g.lineTo(cx - 5, top + 2 * r - 2); g.lineTo(cx + 5, top + 2 * r - 2); g.closePath();
    g.fillStyle = color; g.fill();
    if (kind === 'event') {
      // رویداد: مربع گرد (تقویم) به‌جای دایره
      roundRect(g, cx - r, cy - r, 2 * r, 2 * r, 4);
    } else {
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    }
    g.fillStyle = color; g.fill();
    g.lineWidth = selected ? 3 : 2; g.strokeStyle = selected ? '#fff' : 'rgba(255,255,255,.9)'; g.stroke();
    if (kind === 'hq' || (kind === 'special' && icon === 'star')) {
      star(g, cx, cy, r * 0.62, r * 0.27);
      g.fillStyle = '#fff'; g.fill();
    } else if (kind === 'special') {
      specialGlyph(g, icon, cx, cy, r);
    } else if (kind === 'event') {
      g.fillStyle = '#fff'; g.fillRect(cx - r * 0.5, cy - r * 0.1, r, r * 0.55);
      g.fillRect(cx - r * 0.5, cy - r * 0.5, r, r * 0.22);
    } else {
      g.beginPath(); g.arc(cx, cy, r * 0.35, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    }
    if (online) {
      // نقطهٔ سبز کوچک بالا-راست
      g.beginPath(); g.arc(cx + r * 0.75, cy - r * 0.75, 3.6, 0, Math.PI * 2);
      g.fillStyle = '#00E676'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
    }
    if (live) {
      g.beginPath(); g.arc(cx + r * 0.8, cy - r * 0.8, 4, 0, Math.PI * 2);
      g.fillStyle = '#FF1744'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
    }
    var out = { canvas: c, w: w, h: h };
    pinCache.set(key, out);
    return out;
  }
  // نمادهای لایهٔ ویژه (با canvas، بدون فونت/ایموجی تا روی همهٔ دستگاه‌ها یکسان باشد)
  function specialGlyph(g, icon, cx, cy, r) {
    g.fillStyle = '#fff'; g.strokeStyle = '#fff';
    if (icon === 'alert') {
      g.beginPath(); g.moveTo(cx, cy - r * 0.62); g.lineTo(cx + r * 0.6, cy + r * 0.45); g.lineTo(cx - r * 0.6, cy + r * 0.45); g.closePath(); g.fill();
      g.fillStyle = '#333';
      g.fillRect(cx - r * 0.06, cy - r * 0.25, r * 0.12, r * 0.38);
      g.fillRect(cx - r * 0.06, cy + r * 0.2, r * 0.12, r * 0.12);
    } else if (icon === 'info') {
      g.beginPath(); g.arc(cx, cy - r * 0.42, r * 0.14, 0, Math.PI * 2); g.fill();
      g.fillRect(cx - r * 0.11, cy - r * 0.18, r * 0.22, r * 0.62);
    } else { // flag
      g.fillRect(cx - r * 0.42, cy - r * 0.55, r * 0.12, r * 1.1);
      g.beginPath(); g.moveTo(cx - r * 0.3, cy - r * 0.55); g.lineTo(cx + r * 0.5, cy - r * 0.32); g.lineTo(cx - r * 0.3, cy - r * 0.08); g.closePath(); g.fill();
    }
  }
  function star(g, cx, cy, ro, ri) {
    g.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? ri : ro;
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.closePath();
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  var clusterCache = new Map();
  function clusterImage(n) {
    var label = n > 999 ? '999+' : String(n);
    if (clusterCache.has(label)) return clusterCache.get(label);
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var s = n < 10 ? 30 : (n < 100 ? 36 : 44);
    var c = document.createElement('canvas'); c.width = s * dpr; c.height = s * dpr;
    var g = c.getContext('2d'); g.scale(dpr, dpr);
    g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2); g.fillStyle = 'rgba(79,195,247,.35)'; g.fill();
    g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 5, 0, Math.PI * 2); g.fillStyle = '#0288D1'; g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 12px Tahoma, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, s / 2, s / 2 + 0.5);
    var out = { canvas: c, w: s, h: s };
    clusterCache.set(label, out);
    return out;
  }

  // ---------------------------------------------------------------- house markers
  function markerHeightReference() {
    return config.modes[currentMode].terrain ? Cesium.HeightReference.RELATIVE_TO_GROUND : Cesium.HeightReference.NONE;
  }
  function markerGraphics(d) {
    var showText = (markerLabelMode || d.kind === 'hq' || d.kind === 'special') && d.title;
    var img = pinImage(d.kind, d.id === selectedId, showText ? d.title : '', !!d.online, !!d.live, d.color, d.icon);
    return { image: img.canvas, width: img.w, height: img.h };
  }
  function setMarkers(list) {
    housesDs.entities.suspendEvents();
    featuredDs.entities.suspendEvents();
    specialsDs.entities.suspendEvents();
    var seen = new Set();
    (list || []).forEach(function (d) {
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
      seen.add(d.id);
      var pos = Cesium.Cartesian3.fromDegrees(d.lng, d.lat, 15);
      var g = markerGraphics(d);
      var ds = d.layer === 'specials' ? specialsDs : (d.layer === 'featured' ? featuredDs : housesDs);
      var existing = markers.get(d.id);
      if (existing && existing.ds !== ds) {
        existing.ds.entities.remove(existing.entity); markers.delete(d.id); existing = null;
      }
      if (existing) {
        existing.data = d;
        existing.entity.position = pos;
        existing.entity.billboard.image = g.image;
        existing.entity.billboard.width = g.width;
        existing.entity.billboard.height = g.height;
        applyArea(existing.entity, d);
        return;
      }
      var e = ds.entities.add({
        id: 'house:' + d.id,
        position: pos,
        billboard: {
          image: g.image, width: g.width, height: g.height,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: markerHeightReference(),
          scaleByDistance: new Cesium.NearFarScalar(2.0e3, 1.0, 1.5e7, 0.7),
          // نقاط ویژه کمی جلوتر از خانه‌ها رسم می‌شوند
          eyeOffset: ds !== housesDs ? new Cesium.Cartesian3(0, 0, ds === specialsDs ? -80 : -50) : Cesium.Cartesian3.ZERO
        }
      });
      applyArea(e, d);
      e.houseId = d.id;
      markers.set(d.id, { entity: e, data: d, ds: ds });
    });
    Array.from(markers.keys()).forEach(function (id) {
      if (!seen.has(id)) { var m = markers.get(id); m.ds.entities.remove(m.entity); markers.delete(id); }
    });
    housesDs.entities.resumeEvents();
    featuredDs.entities.resumeEvents();
    specialsDs.entities.resumeEvents();
    scene.requestRender();
    post('markersApplied', { count: markers.size });
  }
  // دایرهٔ نیمه‌شفاف ناحیه (مثلاً منطقهٔ جنگی) برای موارد ویژه با شعاع > ۰.
  // روی سطح زمین رسم می‌شود و کره را تخت نمی‌کند.
  function applyArea(e, d) {
    var rKm = d.kind === 'special' ? Number(d.radiusKm) || 0 : 0;
    if (rKm <= 0) { if (e.ellipse) e.ellipse = undefined; return; }
    var c = Cesium.Color.fromCssColorString(safeColor(d.color) || '#E53935');
    var m = Math.min(rKm, 3000) * 1000;
    e.ellipse = new Cesium.EllipseGraphics({
      semiMajorAxis: m, semiMinorAxis: m,
      material: c.withAlpha(0.22),
      classificationType: Cesium.ClassificationType.TERRAIN
    });
  }
  function refreshMarkerImages() {
    markers.forEach(function (m) {
      var g = markerGraphics(m.data);
      m.entity.billboard.image = g.image; m.entity.billboard.width = g.width; m.entity.billboard.height = g.height;
    });
    scene.requestRender();
  }
  function refreshMarkerHeights() {
    var hr = markerHeightReference();
    markers.forEach(function (m) { m.entity.billboard.heightReference = hr; });
  }

  function setupClustering() {
    var cl = housesDs.clustering;
    cl.enabled = true;
    cl.pixelRange = 36;
    cl.minimumClusterSize = 2;
    cl.clusterBillboards = true;
    cl.clusterLabels = true;
    cl.clusterPoints = true;
    cl.clusterEvent.addEventListener(function (entities, cluster) {
      var img = clusterImage(entities.length);
      cluster.label.show = false;
      cluster.billboard.show = true;
      cluster.billboard.image = img.canvas;
      cluster.billboard.width = img.w;
      cluster.billboard.height = img.h;
      cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
      cluster.billboard.id = entities; // picked.id -> array of entities
    });
  }

  // ---------------------------------------------------------------- overlays
  function loadBorders() {
    return fetch(config.overlays.borders.url).then(function (r) { return r.json(); }).then(function (data) {
      var coll = new Cesium.PolylineCollection();
      var mat = Cesium.Material.fromType('Color', { color: Cesium.Color.WHITE.withAlpha(0.55) });
      data.lines.forEach(function (flat) {
        if (flat.length < 4) return;
        coll.add({ positions: Cesium.Cartesian3.fromDegreesArray(flat), width: 1.2, material: mat });
      });
      bordersPrim = scene.primitives.add(coll);
      bordersPrim.show = overlays.borders;
      if (config.overlays.borders.credit) widget.creditDisplay.addStaticCredit(new Cesium.Credit(config.overlays.borders.credit));
    }).catch(function (e) { post('warning', { message: 'borders: ' + e }); });
  }

  function loadPlaces() {
    return fetch(config.overlays.places.url).then(function (r) { return r.json(); }).then(function (data) {
      placesData = data.places;
      placesBillboards = scene.primitives.add(new Cesium.BillboardCollection({ scene: scene }));
      if (config.overlays.places.credit) widget.creditDisplay.addStaticCredit(new Cesium.Credit(config.overlays.places.credit));
      updatePlaces();
    }).catch(function (e) { post('warning', { message: 'places: ' + e }); });
  }

  function placeImage(i, p) {
    if (placeImgCache.has(i)) return placeImgCache.get(i);
    var name = (LANG === 'fa' && p[5]) ? p[5] : p[6];
    var big = p[2] <= 3;
    var font = (big ? '700 14px ' : '500 12px ') + 'Vazirmatn, Tahoma, "Noto Sans Arabic", sans-serif';
    var ctx = document.createElement('canvas').getContext('2d'); ctx.font = font;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var w = Math.ceil(ctx.measureText(name).width) + 8, h = big ? 22 : 18;
    var c = document.createElement('canvas'); c.width = w * dpr; c.height = h * dpr;
    var g = c.getContext('2d'); g.scale(dpr, dpr); g.font = font; g.direction = 'rtl';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(name, w / 2, h / 2);
    g.fillStyle = big ? '#ffffff' : '#e8eefc'; g.fillText(name, w / 2, h / 2);
    var out = { canvas: c, w: w, h: h };
    placeImgCache.set(i, out);
    if (placeImgCache.size > 1500) placeImgCache.delete(placeImgCache.keys().next().value);
    return out;
  }

  // Shows only the place names that fit the current zoom and are in view.
  function updatePlaces() {
    if (!placesBillboards || !placesData) return;
    placesBillboards.show = overlays.places;
    if (!overlays.places) return;
    var height = camera.positionCartographic.height;
    // Natural Earth min_zoom -> visible below this camera height.
    var zoomNow = Math.log2(4.0e7 / Math.max(height, 1));
    var view = camera.computeViewRectangle(scene.globe.ellipsoid);
    var want = new Set();
    var limit = 160;
    for (var i = 0; i < placesData.length && want.size < limit; i++) {
      var p = placesData[i];
      if (p[2] > zoomNow + 0.5) continue;
      if (view && !Cesium.Rectangle.contains(view, Cesium.Cartographic.fromDegrees(p[0], p[1]))) continue;
      want.add(i);
    }
    placeShown.forEach(function (bb, i) {
      if (!want.has(i)) { placesBillboards.remove(bb); placeShown.delete(i); }
    });
    want.forEach(function (i) {
      if (placeShown.has(i)) return;
      var p = placesData[i], img = placeImage(i, p);
      var bb = placesBillboards.add({
        position: Cesium.Cartesian3.fromDegrees(p[0], p[1], 50),
        image: img.canvas, width: img.w, height: img.h,
        verticalOrigin: Cesium.VerticalOrigin.TOP,
        pixelOffset: new Cesium.Cartesian2(0, 4),
        heightReference: config.modes[currentMode].terrain ? Cesium.HeightReference.CLAMP_TO_GROUND : Cesium.HeightReference.NONE,
        disableDepthTestDistance: 0
      });
      placeShown.set(i, bb);
    });
    scene.requestRender();
  }

  // ---------------------------------------------------------------- camera
  var lastCamPost = 0, camTimer = null;
  function cameraState() {
    var c = camera.positionCartographic;
    var center = pickCenter();
    return {
      lat: Cesium.Math.toDegrees(center ? center.latitude : c.latitude),
      lng: Cesium.Math.toDegrees(center ? center.longitude : c.longitude),
      height: c.height,
      band: bandFor(c.height),
      heading: Cesium.Math.toDegrees(camera.heading),
      pitch: Cesium.Math.toDegrees(camera.pitch),
      camLat: Cesium.Math.toDegrees(c.latitude),
      camLng: Cesium.Math.toDegrees(c.longitude)
    };
  }
  function pickCenter() {
    var canvas = scene.canvas;
    var ray = camera.getPickRay(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    var hit = ray && scene.globe.pick(ray, scene);
    return hit ? Cesium.Cartographic.fromCartesian(hit) : null;
  }
  function onCameraChanged() {
    var now = Date.now();
    var run = function () {
      lastCamPost = Date.now();
      var st = cameraState();
      var wantLabels = st.height < 1.2e5;
      if (wantLabels !== markerLabelMode) { markerLabelMode = wantLabels; refreshMarkerImages(); }
      if (bordersPrim) bordersPrim.show = overlays.borders && st.height > 1.5e5;
      updatePlaces();
      updateDailyVisibility();
      var sun = lighting.dayNight ? sunInfo() : null;
      if (sun) { st.sunLat = sun.sunLat; st.sunLng = sun.sunLng; }
      post('camera', st);
    };
    clearTimeout(camTimer);
    if (now - lastCamPost > 300) run(); else camTimer = setTimeout(run, 300);
  }

  function flyTo(cmd) {
    markInput();
    var opts = {
      destination: Cesium.Cartesian3.fromDegrees(cmd.lng, cmd.lat, cmd.height || 4.5e4),
      orientation: {
        heading: Cesium.Math.toRadians(cmd.heading || 0),
        // مرحلهٔ ۳.۱: همیشه نگاه عمود؛ pitch ذخیره‌شدهٔ قدیمی نادیده گرفته می‌شود
        pitch: -Math.PI / 2,
        roll: 0
      }
    };
    // `cameraView`: lat/lng are the camera position itself (saved default view).
    if (cmd.durationMs === 0) camera.setView(opts);
    else camera.flyTo(Object.assign(opts, { duration: cmd.durationMs != null ? cmd.durationMs / 1000 : 2.0 }));
    scene.requestRender();
  }

  // ---------------------------------------------------------------- nadir lock
  // اگر دوربین به هر دلیلی (اینرسی، flyTo قدیمی، رویداد ناشناخته) کج شده باشد،
  // پیش از رسم فریم، بدون جابه‌جا کردن خود دوربین، دوباره عمود می‌شود.
  // جهت شمال (heading) حفظ می‌شود. هنگام پرواز (flyTo) کاری نمی‌کند.
  var NADIR_EPS = 1e-4; // رادیان (~۰٫۰۰۶ درجه)
  var nadirFixes = 0;
  function keepNadir() {
    if (!camera || camera._currentFlight) return;
    var pitch = camera.pitch;
    if (Math.abs(pitch + Math.PI / 2) < NADIR_EPS && Math.abs(camera.roll) < NADIR_EPS) return;
    camera.setView({
      destination: camera.positionWC.clone(),
      orientation: { heading: camera.heading, pitch: -Math.PI / 2, roll: 0 }
    });
    nadirFixes++;
  }

  function zoomBy(factor) {
    markInput();
    var h = camera.positionCartographic.height;
    if (factor > 1) camera.zoomIn(h * (1 - 1 / factor));
    else camera.zoomOut(h * (1 / factor - 1));
    scene.requestRender();
  }

  // ---------------------------------------------------------------- picking
  function setupPicking() {
    var handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction(function (ev) {
      // برچسب شهرها/مرزها ممکن است روی نشانگر یا دایرهٔ ناحیه باشند؛ از زیر آن‌ها
      // اولین چیز قابل انتخاب (نشانگر، خوشه یا ناحیه) برداشته می‌شود.
      var picked = null;
      var hits = scene.drillPick(ev.position, 6);
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        if (h && h.id && (Array.isArray(h.id) || h.id.houseId)) { picked = h; break; }
      }
      if (picked && Array.isArray(picked.id)) {
        var ids = picked.id.map(function (e) { return e.houseId; }).filter(Boolean);
        handleClusterTap(ids, picked.id);
        return;
      }
      if (picked && picked.id && picked.id.houseId) {
        post('markerTap', { id: picked.id.houseId });
        return;
      }
      post('mapTap', {});
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function handleClusterTap(ids, entities) {
    // If the cluster members are spread out, zoom in to separate them;
    // if they share (almost) the same spot, let Flutter show a list instead.
    var now = Cesium.JulianDate.now();
    var pts = entities.map(function (e) { return e.position.getValue(now); }).filter(Boolean);
    var sphere = Cesium.BoundingSphere.fromPoints(pts);
    var h = camera.positionCartographic.height;
    if (sphere.radius < 1500 || h < 6000) {
      post('clusterTap', { ids: ids });
      return;
    }
    var range = Math.max(sphere.radius * 4, 3000);
    camera.flyToBoundingSphere(sphere, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90), Math.min(range, h * 0.4))
    });
  }

  // ---------------------------------------------------------------- quality
  function setQuality(q) {
    var g = scene.globe;
    currentQuality = q === 'low' || q === 'high' ? q : 'normal';
    if (q === 'low') {
      // battery / weak GPU / slow network: fewer & coarser tiles, 30 fps cap, no fog
      g.maximumScreenSpaceError = 3; g.tileCacheSize = 60; widget.resolutionScale = 0.75;
      widget.targetFrameRate = 30; scene.fog.enabled = false; g.showGroundAtmosphere = false;
    } else if (q === 'high') {
      g.maximumScreenSpaceError = 1.5; g.tileCacheSize = 250; widget.resolutionScale = 1.0;
      widget.targetFrameRate = undefined; scene.fog.enabled = true; g.showGroundAtmosphere = true;
    } else {
      g.maximumScreenSpaceError = 2; g.tileCacheSize = 120; widget.resolutionScale = 1.0;
      widget.targetFrameRate = undefined; scene.fog.enabled = true; g.showGroundAtmosphere = true;
    }
    scene.requestRender();
    post('qualityApplied', { quality: currentQuality });
  }

  // ---------------------------------------------------------------- commands
  function receive(json) {
    var cmd;
    try { cmd = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
    if (!cmd || !widget) return;
    switch (cmd.cmd) {
      case 'setMarkers': setMarkers(cmd.markers); break;
      case 'flyTo': flyTo(cmd); break;
      case 'zoom': zoomBy(cmd.factor || 2); break;
      case 'setMode': applyMode(cmd.mode); break;
      case 'setOverlays':
        if (cmd.borders != null) overlays.borders = !!cmd.borders;
        if (cmd.places != null) overlays.places = !!cmd.places;
        if (cmd.daily != null && !!cmd.daily !== !!overlays.daily) {
          overlays.daily = !!cmd.daily;
          applyMode(currentMode); // rebuild layer stack (keeps order: base, daily, night)
        }
        if (bordersPrim) bordersPrim.show = overlays.borders && camera.positionCartographic.height > 1.5e5;
        updatePlaces(); scene.requestRender(); break;
      case 'select':
        selectedId = cmd.id || null; refreshMarkerImages(); markInput(); break;
      case 'setLighting':
        if (cmd.dayNight != null) lighting.dayNight = !!cmd.dayNight;
        if (cmd.cityLights != null) lighting.cityLights = !!cmd.cityLights;
        applyLighting(); onCameraChanged(); break;
      case 'setAutoRotate':
        autoRotate.enabled = !!cmd.enabled;
        if (cmd.idleMs) autoRotate.idleMs = Math.max(1000, cmd.idleMs);
        markInput(); break;
      case 'resetNorth':
        camera.flyTo({ destination: camera.positionWC.clone(), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: 0.6 });
        break;
      case 'setQuality': setQuality(cmd.quality); break;
      case 'reload': tileErrors = {}; applyMode(currentMode); break;
      case 'pause': paused = true; widget.useDefaultRenderLoop = false; break;
      case 'resume': paused = false; markInput(); widget.useDefaultRenderLoop = true; scene.requestRender(); break;
      case 'ping': post('pong', { t: cmd.t }); break;
    }
  }

  window.HouseGlobe = {
    receive: receive,
    _outbox: outbox,
    // آزمایش: داده‌ها و موقعیت صفحهٔ نقاط (فقط خواندنی)
    _markers: function () {
      return Array.from(markers.values()).map(function (m) {
        var d = Object.assign({}, m.data, { ds: m.ds === specialsDs ? 'specials' : (m.ds === featuredDs ? 'featured' : 'houses'), area: !!m.entity.ellipse });
        var p = m.entity.position && m.entity.position.getValue(widget.clock.currentTime);
        var w = p && Cesium.SceneTransforms.worldToWindowCoordinates(scene, p);
        if (w) { d.sx = w.x; d.sy = w.y; }
        return d;
      });
    },
    _state: function () {
      return {
        mode: currentMode, markers: markers.size, featured: featuredDs ? featuredDs.entities.values.length : 0, specials: specialsDs ? specialsDs.entities.values.filter(function (e) { return !!e.billboard; }).length : 0, camera: widget ? cameraState() : null, errors: tileErrors,
        lighting: lighting, daily: !!overlays.daily, dailyShown: !!(dailyLayer && dailyLayer.show),
        nightShown: !!(nightLayer && nightLayer.show), rotating: rotating, quality: currentQuality,
        layers: widget ? widget.imageryLayers.length : 0,
        nadirFixes: nadirFixes
      };
    },
    _widget: function () { return widget; }
  };
  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin || !e.data || e.data.channel !== 'house-globe-cmd') return;
    receive(e.data.payload);
  });

  // ---------------------------------------------------------------- boot
  function fatal(reason, detail) {
    var el = document.getElementById('fatal');
    el.hidden = false;
    el.textContent = 'نمایش سه‌بعدی روی این دستگاه ممکن نیست (' + reason + ')';
    post('fatal', { reason: reason, detail: String(detail || '') });
  }

  function boot() {
    if (typeof Cesium === 'undefined') { fatal('cesium-missing'); return; }
    fetch(SOURCES_URL).then(function (r) {
      if (!r.ok) throw new Error('sources HTTP ' + r.status);
      return r.json();
    }).then(function (cfg) {
      config = cfg;
      Cesium.Ion.defaultAccessToken = undefined;
      try {
        widget = new Cesium.CesiumWidget('globe', {
          baseLayer: false,
          terrainProvider: new Cesium.EllipsoidTerrainProvider(),
          scene3DOnly: true,           // never morphs to 2D / Columbus view
          sceneMode: Cesium.SceneMode.SCENE3D,
          requestRenderMode: true,     // render only when something changes (battery)
          maximumRenderTimeChange: Infinity,
          useBrowserRecommendedResolution: true,
          msaaSamples: 1,
          creditContainer: document.getElementById('credits'),
          shadows: false,
          contextOptions: { webgl: { alpha: false, antialias: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false } }
        });
      } catch (e) {
        fatal('webgl', e && e.message); return;
      }
      scene = widget.scene;
      camera = widget.camera;
      var g = scene.globe;
      g.enableLighting = false;
      g.showGroundAtmosphere = true;
      g.baseColor = Cesium.Color.fromCssColorString('#0b1a33');
      g.preloadAncestors = true;   // low-res parent shown until high-res arrives
      g.preloadSiblings = false;   // do not download tiles outside the view
      g.depthTestAgainstTerrain = false;
      scene.fog.enabled = true;
      scene.highDynamicRange = false;
      scene.postProcessStages.fxaa.enabled = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;

      var ctl = scene.screenSpaceCameraController;
      ctl.minimumZoomDistance = 150;      // ~ building level
      ctl.maximumZoomDistance = 3.0e7;    // whole globe
      ctl.enableLook = false;
      // مرحلهٔ ۳.۱: مرکز زمین همیشه وسط صفحه. کج شدن دوربین (حرکت عمودی دو انگشت
      // هنگام زوم) کره را به پایین صفحه می‌برد، پس tilt خاموش است و keepNadir
      // هر کجی باقی‌مانده را برمی‌گرداند. چرخش دو انگشتی (جهت شمال) آزاد است.
      ctl.enableTilt = false;
      ctl.inertiaSpin = 0.85; ctl.inertiaTranslate = 0.85; ctl.inertiaZoom = 0.6;

      setQuality(params.get('quality') || 'normal');

      housesDs = new Cesium.CustomDataSource('houses');
      widget.dataSources.add(housesDs);
      featuredDs = new Cesium.CustomDataSource('featured');
      widget.dataSources.add(featuredDs);
      specialsDs = new Cesium.CustomDataSource('specials');
      widget.dataSources.add(specialsDs);
      setupClustering();
      setupPicking();
      setupIdleTracking();
      setupPerfProbe();
      overlays.daily = params.get('daily') === '1';

      applyMode(currentMode);
      camera.setView({ destination: Cesium.Cartesian3.fromDegrees(51.39, 30.0, 2.0e7) });
      camera.percentageChanged = 0.02;
      camera.changed.addEventListener(onCameraChanged);
      camera.moveEnd.addEventListener(onCameraChanged);
      scene.preRender.addEventListener(keepNadir);

      scene.renderError.addEventListener(function (s, err) { fatal('render', err && err.message); });
      scene.canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); post('fatal', { reason: 'context-lost' }); }, false);

      var toggle = document.getElementById('creditToggle');
      var panel = document.getElementById('creditPanel');
      toggle.addEventListener('click', function () { panel.hidden = !panel.hidden; });

      window.addEventListener('online', function () { post('network', { online: true }); receive({ cmd: 'reload' }); });
      window.addEventListener('offline', function () { post('network', { online: false }); });

      Promise.all([loadBorders(), loadPlaces()]).then(function () {
        post('overlaysLoaded', {});
      });
      post('ready', { cesium: Cesium.VERSION, mode: currentMode, online: navigator.onLine });
    }).catch(function (e) { fatal('config', e && e.message); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
