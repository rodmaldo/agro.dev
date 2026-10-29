/* agro.dev · dibujo del mapa en canvas: satélite → ortomosaico → capas de análisis (lado "después") → límite, puntos y pincel */
(function (root) {
  'use strict';
  const AZMap = {};
  root.AZMap = AZMap;
  const rgb = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));

  function mk(S, name, key, fill) {
    const K = S._oc || (S._oc = {}); const e = K[name];
    if (e && e.ver === S.ver && e.key === key) return e.c;
    const c = (e && e.c.width === S.gw && e.c.height === S.gh) ? e.c : document.createElement('canvas'); c.width = S.gw; c.height = S.gh;
    const g = c.getContext('2d'), im = g.createImageData(S.gw, S.gh); fill(im.data); g.putImageData(im, 0, 0);
    K[name] = { ver: S.ver, key, c }; return c;
  }
  const mask = (S, name, m, col, al) => mk(S, name, col + al, d => {
    const [r, g, b] = rgb(col), a = Math.round(al * 255);
    for (let i = 0; i < m.length; i++) if (m[i]) { const k = i * 4; d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = a; }
  });
  const ambImg = S => { const A = S.amb; return mk(S, 'amb', A.colors.join() + A.th.join() + A.idx, d => {
    const cols = A.colors.map(rgb), c = A.cls; if (!c) return;
    for (let i = 0; i < c.length; i++) if (c[i] < 255) { const k = i * 4, q = cols[c[i]]; d[k] = q[0]; d[k + 1] = q[1]; d[k + 2] = q[2]; d[k + 3] = 175; }
  }); };
  const ambSel = S => mk(S, 'ambsel', 'sel' + S.ver, d => { const m = S.amb.sel; for (let i = 0; i < m.length; i++) if (m[i]) { const k = i * 4; d[k] = 255; d[k + 1] = 255; d[k + 2] = 255; d[k + 3] = 150; } });
  const STOPS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  function cmap(t) { t = Math.max(0, Math.min(0.999, t)) * 4; const i = t | 0, f = t - i; return STOPS[i].map((v, q) => v + (STOPS[i + 1][q] - v) * f); }
  const heat = (S, key) => mk(S, 'heat', key, d => {
    const a = S.idx[key], [lo, hi] = S.lim[key];
    for (let i = 0; i < a.length; i++) if (S.inside[i] && S.valid[i]) { const [r, g, b] = cmap((a[i] - lo) / (hi - lo)); const k = i * 4; d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 190; }
  });

  /* ---- ortomosaico por mosaicos (escritorio): se dibujan solo los mosaicos visibles, al nivel de detalle que pide el zoom ---- */
  const TC = new Map(); let pend = 0;
  AZMap.pending = () => pend;
  AZMap.hasImage = S => !!(S.orth || S.tiled);
  function tileImg(T, z, x, y, redraw) {
    const key = T.url + '|' + z + '|' + x + '|' + y; let e = TC.get(key);
    if (e) { TC.delete(key); TC.set(key, e); return e; }          // más reciente al final (LRU)
    e = { state: 'load', img: new Image() }; pend++;
    e.img.onload = () => { e.state = 'ok'; pend--; redraw && redraw(); };
    e.img.onerror = () => { e.state = 'none'; pend--; };             // mosaico vacío (fuera del vuelo)
    e.img.src = T.url + '/tile/' + z + '/' + x + '/' + y + '.jpg';
    TC.set(key, e);
    if (TC.size > 700) { let n = 0; for (const k of TC.keys()) { if (TC.get(k).state !== 'load') TC.delete(k); if (++n > 150) break; } }
    return e;
  }
  function drawTiled(g, S, c, redraw) {
    const T = S.tiled, k = T.g / T.mppV, t = (S.rot || 0) * Math.PI / 180, co = Math.cos(t), si = Math.sin(t), cxn = T.w0 / 2, cyn = T.h0 / 2, top = T.levels - 1, TS = T.tile;
    g.save();
    g.transform(k * co, -k * si, k * si, k * co, S.W / 2 - k * (co * cxn + si * cyn), S.H / 2 - k * (-si * cxn + co * cyn));
    const M = g.getTransform(), inv = M.inverse(), sc = Math.hypot(M.a, M.b);       // píxeles de pantalla por píxel nativo
    const pts = [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]].map(p => inv.transformPoint(new DOMPoint(p[0], p[1])));
    const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
    const kl = Math.max(0, Math.min(top, Math.floor(Math.log2(1 / Math.max(sc, 1e-6))))), z = top - kl, span = TS * Math.pow(2, kl);
    const nx = Math.ceil(T.w0 / span), ny = Math.ceil(T.h0 / span), e = 0.5 * Math.pow(2, kl);   // solape para evitar líneas entre mosaicos
    const ta = Math.max(0, Math.floor(x0 / span)), tb = Math.min(nx - 1, Math.floor(x1 / span)), tc = Math.max(0, Math.floor(y0 / span)), td = Math.min(ny - 1, Math.floor(y1 / span));
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    if ((tb - ta + 1) * (td - tc + 1) > 400) { g.restore(); return; }
    for (let ty = tc; ty <= td; ty++) for (let tx = ta; tx <= tb; tx++) {
      const en = tileImg(T, z, tx, ty, redraw);
      if (en.state === 'ok') { g.drawImage(en.img, tx * span - e, ty * span - e, span + 2 * e, span + 2 * e); continue; }
      if (en.state === 'none') continue;
      for (let j = 1; j <= z; j++) {                                  // mientras carga: usar la vista más gruesa que ya esté lista
        const a = TC.get(T.url + '|' + (z - j) + '|' + (tx >> j) + '|' + (ty >> j));
        if (a && a.state === 'ok') { const f = TS / (1 << j), sx = (tx & ((1 << j) - 1)) * f, sy = (ty & ((1 << j) - 1)) * f; g.drawImage(a.img, sx, sy, f, f, tx * span, ty * span, span, span); break; }
      }
    }
    g.restore();
  }

  AZMap.fit = function (S, w, h) {
    const z = Math.min(w / S.W, h / S.H) * 0.94;
    return { z, x: (w - S.W * z) / 2, y: (h - S.H * z) / 2 };
  };
  AZMap.footprint = (S, n) => Math.max(1, n) * S.cs;

  /* v: {x,y,z} en píxeles de dispositivo. o: opciones de vista */
  AZMap.paint = function (c, S, v, o, handles, redraw) {
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#0a0c0b'; g.fillRect(0, 0, c.width, c.height);
    g.setTransform(v.z, 0, 0, v.z, v.x, v.y);
    const lw = p => p / v.z, cs = S.cs, gw = S.gw, gh = S.gh, M = S.meta;

    if (o.vis.sat && !o.gridHeld) { g.globalAlpha = o.satOp / 100; AZGeo.drawTiles(g, S, v, c.width, c.height, redraw); g.globalAlpha = 1; }
    if (S.orth && o.vis.ortho) { g.globalAlpha = o.orthOp / 100; g.imageSmoothingEnabled = true; g.drawImage(S.orth, 0, 0); g.globalAlpha = 1; }
    else if (S.tiled && o.vis.ortho) { g.globalAlpha = o.orthOp / 100; drawTiled(g, S, c, redraw); g.globalAlpha = 1; }
    if (!S.orth && !S.tiled) return;

    /* Antes / después: a la izquierda del divisor queda el ortomosaico limpio; a la derecha, las capas de análisis */
    if (gw && !o.gridHeld) {
      const split = o.ba ? Math.round(o.baPos * c.width) : 0;
      g.save();
      if (o.ba) { g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); g.rect(split, 0, c.width - split, c.height); g.clip(); g.setTransform(v.z, 0, 0, v.z, v.x, v.y); }
      g.imageSmoothingEnabled = false;
      const GW = gw * cs, GH = gh * cs, act = o.active ? S.hl.find(l => l.id === o.active) : null;
      if (act && o.heat && S.idx[act.idx]) g.drawImage(heat(S, act.idx), 0, 0, GW, GH);
      for (const id of AZ.layerIds(S).slice().reverse()) {      // de abajo hacia arriba
        if (id === 'buf') { if (M.buf.vis && M.buf.on && S.buf.length === gw * gh) g.drawImage(mask(S, 'buf', S.buf, M.buf.color, 0.6), 0, 0, GW, GH); }
        else if (id === 'det') { if (M.det.vis && S.det.length === gw * gh) g.drawImage(mask(S, 'det', S.det, M.det.color, 0.65), 0, 0, GW, GH); }
        else if (id === 'amb') { if (S.amb && S.amb.vis && S.amb.cls) { g.drawImage(ambImg(S), 0, 0, GW, GH); if (S.amb.sel) g.drawImage(ambSel(S), 0, 0, GW, GH); } }
        else if (id === 'man') { if (S.man && M.man.vis) g.drawImage(mask(S, 'man', S.man, M.man.color, 0.65), 0, 0, GW, GH); }
        else { const l = S.hl.find(q => q.id === id); if (l && l.vis) g.drawImage(mask(S, 'h' + l.id, l.mask, l.color, 0.65), 0, 0, GW, GH); }
      }
      if (act && act.prev) g.drawImage(mask(S, 'prev', act.prev, '#ffffff', 0.45), 0, 0, GW, GH);
      if (S.poly.length >= 3) {
        g.save(); g.beginPath(); g.rect(-1e6, -1e6, 2e6, 2e6);
        S.poly.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
        g.fillStyle = 'rgba(0,0,0,.5)'; g.fill('evenodd'); g.restore();
      }
      if (o.vis.grid && !o.gridHeld && o.gridOp > 0 && cs * v.z >= 5) {
        const x0 = Math.max(0, Math.floor(-v.x / v.z / cs)), x1 = Math.min(gw, Math.ceil((c.width - v.x) / v.z / cs));
        const y0 = Math.max(0, Math.floor(-v.y / v.z / cs)), y1 = Math.min(gh, Math.ceil((c.height - v.y) / v.z / cs));
        g.strokeStyle = 'rgba(255,255,255,' + (o.gridOp / 100) + ')'; g.lineWidth = lw(1); g.beginPath();
        for (let i = x0; i <= x1; i++) { g.moveTo(i * cs, y0 * cs); g.lineTo(i * cs, y1 * cs); }
        for (let j = y0; j <= y1; j++) { g.moveTo(x0 * cs, j * cs); g.lineTo(x1 * cs, j * cs); }
        g.stroke();
      }
      g.restore();
    }

    /* Límite: siempre visible (también en el lado "antes") para seguir delimitando sobre el ortomosaico limpio */
    const pl = o.tool === 'poly' && S.tmp.length ? S.tmp : S.poly;
    if (o.vis.lim && pl.length && !o.gridHeld) {
      g.strokeStyle = '#fff'; g.lineWidth = lw(1.5); g.setLineDash([lw(8), lw(5)]); g.beginPath();
      pl.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
      if (pl === S.tmp && o.mouse) g.lineTo(o.mouse[0], o.mouse[1]); else g.closePath();
      g.stroke(); g.setLineDash([]);
      if (handles && (o.tool === 'edit' || pl === S.tmp)) {
        g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = lw(1);
        pl.forEach(p => { g.fillRect(p[0] - lw(5), p[1] - lw(5), lw(10), lw(10)); g.strokeRect(p[0] - lw(5), p[1] - lw(5), lw(10), lw(10)); });
      }
    }
    /* Puntos (+)/(−): ocupan la celda completa de la grilla */
    for (const p of S.pts) {
      const ci = Math.floor(p.x / cs), cj = Math.floor(p.y / cs), px = cs * v.z, col = p.v > 0 ? '#D55E00' : '#0072B2';
      g.fillStyle = col + 'cc'; g.fillRect(ci * cs, cj * cs, cs, cs);
      g.strokeStyle = '#fff'; g.lineWidth = lw(1.5); g.strokeRect(ci * cs, cj * cs, cs, cs);
      const r = Math.max(cs * 0.3, lw(5)), cx = (ci + 0.5) * cs, cy = (cj + 0.5) * cs;
      g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); if (p.v > 0) { g.moveTo(cx, cy - r); g.lineTo(cx, cy + r); } g.lineWidth = lw(px > 14 ? 2 : 1.5); g.stroke();
    }
    /* cursor: celda bajo el puntero (puntos) o huella del pincel */
    if (o.mouse && gw && (o.tool === 'padd' || o.tool === 'pneg' || o.tool === 'brush' || o.tool === 'erase')) {
      const ci = Math.floor(o.mouse[0] / cs), cj = Math.floor(o.mouse[1] / cs);
      if (ci >= 0 && cj >= 0 && ci < gw && cj < gh) {
        g.lineWidth = lw(2);
        if (o.tool === 'brush' || o.tool === 'erase') {
          g.strokeStyle = o.tool === 'brush' ? '#b8f04a' : '#ff6b5b'; g.beginPath(); g.arc((ci + 0.5) * cs, (cj + 0.5) * cs, Math.max(0.5, o.brushN / 2) * cs, 0, 7); g.stroke();
        } else { g.strokeStyle = o.tool === 'padd' ? '#D55E00' : '#56B4E9'; g.strokeRect(ci * cs, cj * cs, cs, cs); }
      }
    }
  };
})(window);
