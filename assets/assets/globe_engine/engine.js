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
  function tileUrl(id, src) {
    if (PROXY && src.proxy) return PROXY + id + '/{z}/{x}/{y}';
    return src.url;
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
  function createImageryLayer(id) {
    var src = config.sources[id];
    if (!src) return null;
    var layerOpts = {
      minimumTerrainLevel: src.minTerrainLevel,
      maximumTerrainLevel: src.maxTerrainLevel
    };
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
    refreshMarkerHeights();
    scene.requestRender();
    post('modeChanged', { mode: mode });
  }

  // ---------------------------------------------------------------- canvas images (RTL-safe text)
  // Cesium's Label does not shape Persian/Arabic text, so text is drawn with
  // canvas (which shapes correctly) and shown as billboard images.
  var FONT = '600 13px Vazirmatn, Tahoma, "Noto Sans Arabic", sans-serif';
  var pinCache = new Map();
  function pinImage(kind, selected, text) {
    var key = kind + '|' + (selected ? 1 : 0) + '|' + (text || '');
    if (pinCache.has(key)) return pinCache.get(key);
    var color = kind === 'mine' ? '#FFC107' : (kind === 'shop' ? '#42A5F5' : '#4FC3F7');
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var r = selected ? 11 : 8;
    var tw = 0, measure = document.createElement('canvas').getContext('2d');
    if (text) { measure.font = FONT; tw = Math.ceil(measure.measureText(text).width) + 14; }
    var w = Math.max(2 * r + 6, tw), h = 2 * r + 10 + (text ? 22 : 0);
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
    var top = text ? 22 : 0;
    g.beginPath(); g.moveTo(cx, top + 2 * r + 8); g.lineTo(cx - 5, top + 2 * r - 2); g.lineTo(cx + 5, top + 2 * r - 2); g.closePath();
    g.fillStyle = color; g.fill();
    g.beginPath(); g.arc(cx, top + r + 1, r, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();
    g.lineWidth = selected ? 3 : 2; g.strokeStyle = selected ? '#fff' : 'rgba(255,255,255,.9)'; g.stroke();
    g.beginPath(); g.arc(cx, top + r + 1, r * 0.35, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    var out = { canvas: c, w: w, h: h };
    pinCache.set(key, out);
    return out;
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
    var showText = markerLabelMode && d.title;
    var img = pinImage(d.kind, d.id === selectedId, showText ? d.title : '');
    return { image: img.canvas, width: img.w, height: img.h };
  }
  function setMarkers(list) {
    housesDs.entities.suspendEvents();
    var seen = new Set();
    (list || []).forEach(function (d) {
      if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
      seen.add(d.id);
      var pos = Cesium.Cartesian3.fromDegrees(d.lng, d.lat, 15);
      var g = markerGraphics(d);
      var existing = markers.get(d.id);
      if (existing) {
        existing.data = d;
        existing.entity.position = pos;
        existing.entity.billboard.image = g.image;
        existing.entity.billboard.width = g.width;
        existing.entity.billboard.height = g.height;
        return;
      }
      var e = housesDs.entities.add({
        id: 'house:' + d.id,
        position: pos,
        billboard: {
          image: g.image, width: g.width, height: g.height,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: markerHeightReference(),
          scaleByDistance: new Cesium.NearFarScalar(2.0e3, 1.0, 1.5e7, 0.7)
        }
      });
      e.houseId = d.id;
      markers.set(d.id, { entity: e, data: d });
    });
    Array.from(markers.keys()).forEach(function (id) {
      if (!seen.has(id)) { housesDs.entities.remove(markers.get(id).entity); markers.delete(id); }
    });
    housesDs.entities.resumeEvents();
    scene.requestRender();
    post('markersApplied', { count: markers.size });
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
      heading: Cesium.Math.toDegrees(camera.heading)
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
      post('camera', st);
    };
    clearTimeout(camTimer);
    if (now - lastCamPost > 300) run(); else camTimer = setTimeout(run, 300);
  }

  function flyTo(cmd) {
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(cmd.lng, cmd.lat, cmd.height || 4.5e4),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(cmd.pitch != null ? cmd.pitch : -90), roll: 0 },
      duration: cmd.durationMs != null ? cmd.durationMs / 1000 : 2.0
    });
  }

  function zoomBy(factor) {
    var h = camera.positionCartographic.height;
    if (factor > 1) camera.zoomIn(h * (1 - 1 / factor));
    else camera.zoomOut(h * (1 / factor - 1));
    scene.requestRender();
  }

  // ---------------------------------------------------------------- picking
  function setupPicking() {
    var handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction(function (ev) {
      var picked = scene.pick(ev.position);
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
    if (q === 'low') { g.maximumScreenSpaceError = 3; g.tileCacheSize = 60; widget.resolutionScale = 0.85; }
    else if (q === 'high') { g.maximumScreenSpaceError = 1.5; g.tileCacheSize = 250; widget.resolutionScale = 1.0; }
    else { g.maximumScreenSpaceError = 2; g.tileCacheSize = 120; widget.resolutionScale = 1.0; }
    scene.requestRender();
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
        if (bordersPrim) bordersPrim.show = overlays.borders && camera.positionCartographic.height > 1.5e5;
        updatePlaces(); scene.requestRender(); break;
      case 'select':
        selectedId = cmd.id || null; refreshMarkerImages(); break;
      case 'resetNorth':
        camera.flyTo({ destination: camera.positionWC.clone(), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: 0.6 });
        break;
      case 'setQuality': setQuality(cmd.quality); break;
      case 'reload': tileErrors = {}; applyMode(currentMode); break;
      case 'pause': widget.useDefaultRenderLoop = false; break;
      case 'resume': widget.useDefaultRenderLoop = true; scene.requestRender(); break;
      case 'ping': post('pong', { t: cmd.t }); break;
    }
  }

  window.HouseGlobe = {
    receive: receive,
    _outbox: outbox,
    _state: function () { return { mode: currentMode, markers: markers.size, camera: widget ? cameraState() : null, errors: tileErrors }; },
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
      ctl.inertiaSpin = 0.85; ctl.inertiaTranslate = 0.85; ctl.inertiaZoom = 0.6;

      setQuality(params.get('quality') || 'normal');

      housesDs = new Cesium.CustomDataSource('houses');
      widget.dataSources.add(housesDs);
      setupClustering();
      setupPicking();

      applyMode(currentMode);
      camera.setView({ destination: Cesium.Cartesian3.fromDegrees(51.39, 30.0, 2.0e7) });
      camera.percentageChanged = 0.02;
      camera.changed.addEventListener(onCameraChanged);
      camera.moveEnd.addEventListener(onCameraChanged);

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
