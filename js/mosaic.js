/* agro.dev · arma UNA sola imagen (ortomosaico aproximado) a partir de las fotos RGB geoetiquetadas.
   Posición inicial por GPS + rumbo; luego AZStitch alinea las fotos vecinas por contenido, ajusta todas las posiciones a la vez,
   iguala brillo/color y las mezcla. Supone terreno casi plano y cámara hacia abajo.
   NO es fotogrametría completa (no corrige relieve ni distorsión de lente): para la entrega final usar DJI Terra, ODM o Pix4D. */
(function (root) {
  'use strict';
  const AZMosaic = {};
  root.AZMosaic = AZMosaic;
  if (typeof module !== 'undefined') module.exports = AZMosaic;
  const KY = 110574;

  function hull(pts) {                                   // envolvente convexa (monotone chain)
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    const up = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop(); return lo.concat(up);
  }

  /* Cálculo puro de posiciones. metas: [{lat,lon,yaw,w,h}] · o: {res (m/px original), maxD (px máx. del mosaico)} */
  AZMosaic.layout = function (metas, o) {
    if (!metas.length) throw new Error('No hay fotos con GPS');
    let a = 1e9, b = -1e9, c = 1e9, d = -1e9;
    for (const m of metas) { a = Math.min(a, m.lat); b = Math.max(b, m.lat); c = Math.min(c, m.lon); d = Math.max(d, m.lon); }
    const lat0 = (a + b) / 2, lon0 = (c + d) / 2, KX = 111320 * Math.cos(lat0 * Math.PI / 180);
    const P = metas.map((m, i) => ({ e: (m.lon - lon0) * KX + (o.adj ? o.adj[2 * i] : 0), n: (m.lat - lat0) * KY + (o.adj ? o.adj[2 * i + 1] : 0), rot: m.yaw || 0, fw: (m.w || 5280) * o.res * (m.scale || 1), fh: (m.h || 3956) * o.res * (m.scale || 1) }));
    const corners = [], K = o.crop || 1;   // K: fracción central de cada foto que realmente se usa
    let e0 = 1e12, e1 = -1e12, n0 = 1e12, n1 = -1e12;
    for (const p of P) {
      const r = p.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
      p.cr = [];
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {   // dx a la derecha de la foto, dy hacia abajo
        const x = dx * p.fw * K / 2, y = dy * p.fh * K / 2;
        const E = p.e + x * cs - y * sn, N = p.n - (x * sn + y * cs);    // rumbo horario desde el norte
        p.cr.push([E, N]); e0 = Math.min(e0, E); e1 = Math.max(e1, E); n0 = Math.min(n0, N); n1 = Math.max(n1, N);
      }
    }
    const cE = (e0 + e1) / 2, cN = (n0 + n1) / 2, ext = Math.max(e1 - e0, n1 - n0);
    const mpp = Math.max(o.res, ext / o.maxD);
    const W = Math.max(1, Math.ceil((e1 - e0) / mpp)), H = Math.max(1, Math.ceil((n1 - n0) / mpp));
    const px = (E, N) => [W / 2 + (E - cE) / mpp, H / 2 - (N - cN) / mpp];
    for (const p of P) { const q = px(p.e, p.n); p.cx = q[0]; p.cy = q[1]; p.pw = p.fw / mpp; p.ph = p.fh / mpp; corners.push(...p.cr.map(k => px(k[0], k[1]))); }
    return { W, H, mpp, cE, cN, lat: lat0 + cN / KY, lon: lon0 + cE / KX, items: P, hull: hull(corners) };
  };

  async function decode(file, wTarget) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, { resizeWidth: wTarget, resizeQuality: 'medium' }); } catch (e) { /* cae al método clásico */ }
    }
    const u = URL.createObjectURL(file);
    try { return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('foto ilegible')); i.src = u; }); }
    finally { URL.revokeObjectURL(u); }
  }

  const mkCanvas = (w, h) => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  async function pixels(file, w) {                       // decodifica a ancho w y devuelve RGBA
    const bmp = await decode(file, w), c = mkCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  }
  /* corre fn(i) sobre 0..n-1 con 'conc' tareas en paralelo */
  async function pool(n, conc, fn, cancel) {
    let next = 0; const run = async () => { for (;;) { if (cancel && cancel.v) return; const i = next++; if (i >= n) return; await fn(i); } };
    await Promise.all(Array.from({ length: conc }, run));
    if (cancel && cancel.v) throw new Error('cancelado');
  }

  /* items: [{f: File, path}] (solo fotos *_D.JPG). o: {res (m/px a la altura mediana), maxD (px máx. del mosaico), cancel:{v}, onProgress(p,msg)} */
  AZMosaic.build = async function (items, o) {
    const prog = (p, m) => o.onProgress && o.onProgress(p, m);
    const files = items.slice().sort((a, b) => (a.path < b.path ? -1 : 1));
    const metas = []; let skipped = 0, noYaw = 0;
    for (let i = 0; i < files.length; i++) {
      if (o.cancel && o.cancel.v) throw new Error('cancelado');
      const e = await AZGeo.exif(files[i].f);
      if (e && isFinite(e.lat) && isFinite(e.lon)) { if (e.yaw == null) noYaw++; metas.push({ f: files[i].f, lat: e.lat, lon: e.lon, yaw: e.yaw, w: e.w, h: e.h, alt: e.relAlt }); } else skipped++;
      if (i % 20 === 0) prog(0.08 * i / files.length, 'Leyendo posiciones GPS · ' + (i + 1) + ' / ' + files.length);
    }
    if (!metas.length) throw new Error('las fotos no tienen coordenadas GPS');
    /* tamaño de cada foto sobre el terreno ∝ altura de vuelo (si todas la informan) */
    const alts = metas.map(m => m.alt).filter(a => a > 5).sort((a, b) => a - b);
    if (alts.length >= 0.8 * metas.length) { const med = alts[alts.length >> 1]; metas.forEach(m => { const k = m.alt > 5 ? m.alt / med : 1; m.scale = Math.max(0.5, Math.min(2, k)); }); }
    const K = 0.9;
    let L = AZMosaic.layout(metas, { res: o.res, maxD: o.maxD, crop: K });
    if (L.W * L.H > 16e6) throw new Error('el mosaico resultante es demasiado grande; bajá la calidad');
    let adj = null, stats = null, gain = null;

    if (metas.length >= 2 && !root.__NOALIGN) {
      /* 1) miniaturas en color para alinear */
      const TW = 192, ph = new Array(metas.length); let done = 0;
      await pool(metas.length, 3, async i => {
        try {
          const im = await pixels(metas[i].f, TW), rgb = new Uint8Array(im.width * im.height * 3);
          for (let k = 0, q = 0; k < im.data.length; k += 4) { rgb[q++] = im.data[k]; rgb[q++] = im.data[k + 1]; rgb[q++] = im.data[k + 2]; }
          const it = L.items[i]; ph[i] = { e: it.e, n: it.n, rot: it.rot * Math.PI / 180, fw: it.fw, fh: it.fh, gw: im.width, gh: im.height, rgb };
        } catch (e) { ph[i] = null; }
        done++; if (done % 5 === 0 || done === metas.length) prog(0.08 + 0.27 * done / metas.length, 'Analizando fotos · ' + done + ' / ' + metas.length);
      }, o.cancel);
      /* 2) alineación global (las fotos ilegibles quedan fuera) */
      const ok = ph.map((p, i) => p ? i : -1).filter(i => i >= 0), sub = ok.map(i => ph[i]);
      const A = await AZStitch.align(sub, { K, cancel: o.cancel, onProgress: p => prog(0.35 + 0.15 * p, 'Alineando fotos vecinas…') });
      adj = new Float64Array(2 * metas.length); gain = new Float64Array(3 * metas.length).fill(1);
      ok.forEach((i, k) => { adj[2 * i] = A.d[2 * k]; adj[2 * i + 1] = A.d[2 * k + 1]; for (let q = 0; q < 3; q++) gain[3 * i + q] = A.gain[3 * k + q]; });
      stats = A.stats;
      L = AZMosaic.layout(metas, { res: o.res, maxD: o.maxD, crop: K, adj });
      if (L.W * L.H > 16e6) throw new Error('el mosaico resultante es demasiado grande; bajá la calidad');
    }

    /* 3) mezcla final a la resolución del mosaico */
    const acc = AZStitch.newAcc(L.W, L.H), cfg = { mpp: L.mpp, cE: L.cE, cN: L.cN, K }; let failed = 0, n3 = 0;
    await pool(metas.length, 3, async i => {
      const it = L.items[i];
      try {
        const im = await pixels(metas[i].f, Math.max(48, Math.min(1600, Math.round(it.fw / L.mpp))));
        AZStitch.accumulate(acc, { e: it.e, n: it.n, rot: it.rot * Math.PI / 180, fw: it.fw, fh: it.fh }, { data: im.data, w: im.width, h: im.height }, cfg, gain ? [gain[3 * i], gain[3 * i + 1], gain[3 * i + 2]] : null);
      } catch (e) { failed++; }
      n3++; if (n3 % 5 === 0 || n3 === metas.length) prog(0.5 + 0.5 * n3 / metas.length, 'Armando el ortomosaico · ' + n3 + ' / ' + metas.length + ' fotos');
    }, o.cancel);
    const canvas = Object.assign(document.createElement('canvas'), { width: L.W, height: L.H });
    canvas.getContext('2d').putImageData(new ImageData(AZStitch.finish(acc), L.W, L.H), 0, 0);
    return { canvas, mpp: L.mpp, lat: L.lat, lon: L.lon, poly: L.hull, used: metas.length - failed, total: files.length, skipped, failed, noYaw, align: stats };
  };
})(typeof window !== 'undefined' ? window : globalThis);
