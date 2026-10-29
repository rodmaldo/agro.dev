/* agro.dev · archivos del vuelo: lectura de carpetas, análisis del contenido, armado del mosaico base y rotación de la grilla */
(function (root) {
  'use strict';
  const F = root.AZFiles = {};
  const nameOf = it => it.f.name, dirOf = p => { const a = p.split('/'); a.pop(); return a.join('/') || '(raíz)'; };
  F.keyOf = it => it.path + '|' + it.f.size;
  F.MAXD = { baja: 1600, media: 3200, alta: 6000 };

  /* Carpetas soltadas con arrastrar y soltar: Chrome entrega los archivos de a 100, hay que repetir readEntries hasta que devuelva vacío */
  F.readDrop = async function (dt) {
    const ents = Array.from(dt.items || []).map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!ents.length) return Array.from(dt.files || []).map(f => ({ f, path: f.name }));
    const out = [];
    const walk = async en => {
      if (en.isFile) await new Promise(r => en.file(f => { out.push({ f, path: (en.fullPath || f.name).replace(/^\//, '') }); r(); }, r));
      else if (en.isDirectory) {
        const rd = en.createReader(); let batch;
        do { batch = await new Promise((res, rej) => rd.readEntries(res, rej)); for (const e of batch) await walk(e); } while (batch.length);
      }
    };
    for (const e of ents) await walk(e);
    return out;
  };

  /* Clasifica los archivos del Mavic 3M: *_D.JPG (RGB), *_MS_G/R/RE/NIR.TIF (bandas) y candidatos a ortomosaico (JPG/PNG exportado) */
  F.analyze = async function (items) {
    let ms = 0, tif = 0, bytes = 0, cand = null, other = 0; const raw = [], byDir = {};
    const isOrtho = n => /orto|ortho|mosaic|mosaico/i.test(n);
    for (const it of items) {
      const n = nameOf(it), d = dirOf(it.path); bytes += it.f.size;
      const row = byDir[d] || (byDir[d] = { rgb: 0, ms: 0, otros: 0 });
      if (/_D\.jpe?g$/i.test(n)) { raw.push(it); row.rgb++; }
      else if (/_MS_(G|R|RE|NIR)\.tiff?$/i.test(n)) { ms++; row.ms++; }
      else if (/\.tiff?$/i.test(n)) { tif++; row.otros++; }
      else if (/\.(jpe?g|png)$/i.test(n)) { row.otros++; if (!cand || isOrtho(n) || (it.f.size > cand.f.size && !isOrtho(nameOf(cand)))) cand = it; }
      else other++;
    }
    raw.sort((a, b) => (a.path < b.path ? -1 : 1));
    const step = Math.max(1, Math.floor(raw.length / 6)), probe = raw.filter((_, i) => i % step === 0).slice(0, 6);
    const ex = []; for (const it of probe) { const e = await AZGeo.exif(it.f); if (e) ex.push(e); }
    let gps = null, rtk = null, alt = null, yaw = null, pw = null;
    if (ex.length) {
      gps = { lat: ex.reduce((s, e) => s + e.lat, 0) / ex.length, lon: ex.reduce((s, e) => s + e.lon, 0) / ex.length };
      rtk = ex.every(e => e.rtk === 50) ? 50 : (ex.some(e => e.rtk != null) ? 0 : null);
      pw = ex[0].w || null; const al = ex.filter(e => e.relAlt != null); if (al.length) alt = al.reduce((s, e) => s + e.relAlt, 0) / al.length;
      const ys = ex.filter(e => e.yaw != null);
      if (ys.length) { /* media circular del rumbo; las pasadas de ida y vuelta difieren 180°, por eso se trabaja módulo 90° */
        const sx = ys.reduce((s, e) => s + Math.cos(e.yaw * Math.PI / 180 * 4), 0), sy = ys.reduce((s, e) => s + Math.sin(e.yaw * Math.PI / 180 * 4), 0);
        yaw = (Math.atan2(sy, sx) / 4 * 180 / Math.PI + 360) % 90;
      }
    }
    const folders = Object.keys(byDir).sort().map(k => [k, byDir[k]]);
    return { n: items.length, mb: bytes / 1048576, folders, raw, ms, tif, other, ortho: cand, gps, rtk, alt, yaw, pw, geoPhotos: ex.length };
  };

  F.loadCanvas = function (file, maxD) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        const sc = Math.min(1, maxD / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = Math.round(im.width * sc); c.height = Math.round(im.height * sc);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res({ canvas: c, scale: sc });
      };
      im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('formato de imagen no soportado')); };
      im.src = u;
    });
  };
  F.grayOf = function (c) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; return out;
  };

  /* Arma la imagen base (sin rotar) según lo elegido en el asistente. Devuelve {canvas,mpp,poly,geo,ndviCanvas,note} */
  F.buildBase = async function (o, onProgress, cancel) {
    const maxD = F.MAXD[o.quality] || 3200; let note = '';
    if (o.source === 'mosaic') {
      const r = await AZMosaic.build(o.items, { res: o.res / 100, maxD, cancel, onProgress });
      note = r.used + ' de ' + r.total + ' fotos' + (r.skipped ? ' (' + r.skipped + ' sin GPS)' : '') + (r.failed ? ' (' + r.failed + ' ilegibles)' : '') + (r.noYaw ? ' · sin rumbo en ' + r.noYaw + ' fotos: se asumió norte arriba' : '') + (r.align ? ' · alineación: ' + r.align.accepted + ' de ' + r.align.overlapping + ' pares (residuo mediano ' + r.align.medResidual.toFixed(2) + ' m)' : '');
      return { canvas: r.canvas, mpp: r.mpp, poly: r.poly, geo: { lat: r.lat, lon: r.lon, rtk: o.rtk }, ndviCanvas: null, note };
    }
    onProgress && onProgress(0.3, 'Procesando imagen…');
    const c = await F.loadCanvas(o.file, maxD); let nd = null;
    if (o.ndvi) { const g = await F.loadCanvas(o.ndvi, 1e6), t = document.createElement('canvas'); t.width = c.canvas.width; t.height = c.canvas.height; t.getContext('2d').drawImage(g.canvas, 0, 0, t.width, t.height); nd = t; }
    return { canvas: c.canvas, mpp: (o.res / 100) / c.scale, poly: null, geo: { lat: o.lat, lon: o.lon, rtk: o.rtk }, ndviCanvas: nd, note: '' };
  };

  /* Gira la imagen -deg° (la grilla queda alineada a los ejes) con el lienzo ampliado; las esquinas quedan transparentes */
  F.rotateCanvas = function (c, deg) {
    if (!deg) return c;
    const t = deg * Math.PI / 180, co = Math.abs(Math.cos(t)), si = Math.abs(Math.sin(t));
    const w = Math.ceil(c.width * co + c.height * si), h = Math.ceil(c.width * si + c.height * co), o = document.createElement('canvas');
    o.width = w; o.height = h; const g = o.getContext('2d'); g.translate(w / 2, h / 2); g.rotate(-t); g.drawImage(c, -c.width / 2, -c.height / 2); return o;
  };

  /* Carga la base en el estado del motor con grilla y orientación */
  F.apply = function (S, base, gridM, rot, detailed) {
    const w0 = base.canvas.width, h0 = base.canvas.height, c = F.rotateCanvas(base.canvas, rot);
    const poly0 = base.poly || [[0, 0], [w0, 0], [w0, h0], [0, h0]];
    const poly = rot ? AZ.rotPts(poly0, rot, w0, h0, c.width, c.height) : poly0;
    const nd = base.ndviCanvas ? F.grayOf(F.rotateCanvas(base.ndviCanvas, rot)) : null;
    const keep = { det: S.meta.det.name, col: S.meta.det.color };
    AZ.setImage(S, c, base.mpp, poly, { ndvi: nd, detailed: !!detailed });
    S.rot = rot || 0; S.geo = base.geo; S.meta.det.name = keep.det; S.meta.det.color = keep.col;
    AZ.prepare(S, gridM);
  };


  /* Versión por mosaicos (escritorio): el motor calcula las celdas sobre los píxeles originales. Devuelve una promesa. */
  F.applyTiled = async function (S, base, gridM, rot, detailed, onProgress, cancel) {
    const keep = { det: S.meta.det.name, col: S.meta.det.color };
    if (S.tiled !== base.tiled) AZ.setTiled(S, base.tiled, null, { detailed: !!detailed });
    S.detailed = !!detailed; AZ.tiledFrame(S, rot || 0);
    S.poly = AZ.tiledPoly(S, base.polyNative, rot || 0); S.geo = base.geo; S.meta.det.name = keep.det; S.meta.det.color = keep.col;
    AZ.prepareGrid(S, gridM);
    const spec = AZ.cellSpec(S), gw = S.gw, gh = S.gh; S.gw = 0; S.gh = 0;          // sin grilla mientras se recalcula
    try { const buf = await AZDesktop.cells(base.tiled, spec, onProgress, cancel); S.gw = gw; S.gh = gh; AZ.applyCells(S, buf, detailed); S.cellsBuf = buf; }
    catch (e) { S.gw = gw; S.gh = gh; throw e; }
  };

  F.download = function (name, data, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000); };
})(window);
