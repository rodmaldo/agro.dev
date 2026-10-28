/* agro.dev · capas de análisis sobre la grilla: detección IA (+pincel/borrador), detección manual, capas de histograma
   con varita mágica, buffer, puntos (+)/(−) fijados a celdas, y estadísticas combinadas. Sin DOM. */
(function (root) {
  'use strict';
  const AZ = root.AZ;
  const NN = S => S.gw * S.gh;
  const BUF_TONES = ['#CC79A7', '#56B4E9', '#009E73', '#D55E00'];

  AZ.mchange = S => { S.mver++; S.ver++; };
  AZ.cellAt = (S, x, y) => [Math.min(S.gw - 1, Math.max(0, (x / S.cs) | 0)), Math.min(S.gh - 1, Math.max(0, (y / S.cs) | 0))];
  AZ.layerOf = (S, id) => S.hl.find(l => l.id === id) || null;
  AZ.maskOf = (S, id) => (id === 'det' ? S.det : id === 'man' ? S.man : (AZ.layerOf(S, id) || {}).mask || null);

  /* Resultado del clasificador + ediciones de pincel/borrador (las ediciones sobreviven a una nueva detección) */
  AZ.mergeDet = function (S) {
    const n = NN(S);
    if (!S.auto || S.auto.length !== n) S.auto = new Uint8Array(n);
    if (!S.badd || S.badd.length !== n) S.badd = new Uint8Array(n);
    if (!S.berase || S.berase.length !== n) S.berase = new Uint8Array(n);
    const d = new Uint8Array(n);
    for (let i = 0; i < n; i++) d[i] = ((S.auto[i] | S.badd[i]) && !S.berase[i] && S.inside[i]) ? 1 : 0;
    S.det = d; S.hasDet = true; AZ.mchange(S);
  };

  AZ.union = function (S) {
    const n = NN(S), u = new Uint8Array(n);
    const add = m => { if (m) for (let i = 0; i < n; i++) if (m[i]) u[i] = 1; };
    if (S.meta.det.inc) add(S.det);
    if (S.man && S.meta.man && S.meta.man.inc) add(S.man);
    for (const l of S.hl) if (l.inc) add(l.mask);
    for (let i = 0; i < n; i++) if (!S.inside[i]) u[i] = 0;
    return u;
  };

  AZ.polyChanged = function (S) {
    AZ.calcInside(S); AZ.calcLims(S);
    const n = NN(S), cut = m => { if (m) for (let i = 0; i < n; i++) if (!S.inside[i]) m[i] = 0; };
    cut(S.man); S.hl.forEach(l => { cut(l.mask); l.prev = null; l.range = null; });
    if (S.auto) AZ.mergeDet(S); else AZ.mchange(S);
  };

  /* ---- buffer: múltiplos de la celda (mínimo 1 celda) alrededor de lo detectado ---- */
  AZ.calcBuf = function (S) {
    const n = NN(S), b = S.meta.buf; S.buf = new Uint8Array(n); S.ver++;
    if (!b.on || !b.m) return;
    if (S._dv !== S.mver || !S.dist) { S.dist = AZ._dtf(AZ.union(S), S.gw, S.gh); S._dv = S.mver; }
    const th = Math.max(1, Math.round(b.m / (S.cs * S.mpp))) * 3;
    for (let i = 0; i < n; i++) S.buf[i] = (S.dist[i] > 0 && S.dist[i] <= th && S.inside[i]) ? 1 : 0;
  };
  AZ.setBuffer = function (S, on, m) { S.meta.buf.on = !!on; if (m != null) S.meta.buf.m = m; AZ.calcBuf(S); };

  /* ---- capas ---- */
  AZ.addManual = function (S) {
    if (S.man) return; S.man = new Uint8Array(NN(S));
    S.meta.man = { name: 'Detección manual', color: '#F0E442', vis: true, inc: true }; AZ.mchange(S);
  };
  AZ.combineManual = function (S) {
    if (!S.man) return 0; const n = NN(S); let c = 0;
    if (!S.badd || S.badd.length !== n) S.badd = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (S.man[i]) { S.badd[i] = 1; if (S.berase) S.berase[i] = 0; c++; }
    S.man = null; S.meta.man = null; AZ.mergeDet(S); return c;
  };
  /* idxKey: índice sobre el que se trabaja ('exg', 'bri', 'sat', 'ndvi'); name: nombre de la capa */
  AZ.addHist = function (S, idxKey, name) {
    const id = 'h' + (++S.seq), k = S.hl.length, ix = idxKey && S.idx[idxKey] ? idxKey : (S.idxName || 'exg');
    S.hl.push({ id, name: name || ('Histograma ' + (k + 1)), color: BUF_TONES[k % BUF_TONES.length], vis: true, inc: true, idx: ix, range: null, mask: new Uint8Array(NN(S)), prev: null });
    AZ.mchange(S); return id;
  };
  /* Fusiona el búfer dentro de la detección principal (queda una sola capa, más grande). El búfer se apaga. */
  AZ.combineBuf = function (S) {
    const n = NN(S); if (!S.meta.buf.on) return 0;
    AZ.calcBuf(S);
    if (!S.badd || S.badd.length !== n) S.badd = new Uint8Array(n);
    let c = 0; for (let i = 0; i < n; i++) if (S.buf[i] && S.inside[i]) { S.badd[i] = 1; if (S.berase) S.berase[i] = 0; c++; }
    S.meta.buf.on = false; AZ.mergeDet(S); AZ.calcBuf(S); return c;
  };
  AZ.removeLayer = function (S, id) {
    if (id === 'man') { S.man = null; S.meta.man = null; } else { const k = S.hl.findIndex(l => l.id === id); if (k >= 0) S.hl.splice(k, 1); }
    AZ.mchange(S);
  };


  /* ---- orden de apilado (primero = más arriba) y combinación de varias capas ---- */
  AZ.layerIds = function (S) {
    const ex = [...S.hl.map(l => l.id).reverse(), ...(S.man ? ['man'] : []), 'det', ...(S.meta.buf.on ? ['buf'] : [])];
    const z = (S.zord || []).filter(id => ex.includes(id)), fresh = ex.filter(id => !z.includes(id));
    return [...fresh, ...z];
  };
  AZ.moveLayer = function (S, id, beforeId) {      // beforeId null = al final
    const ids = AZ.layerIds(S).filter(x => x !== id), k = beforeId ? ids.indexOf(beforeId) : -1;
    if (k < 0) ids.push(id); else ids.splice(k, 0, id);
    S.zord = ids; S.ver++;
  };
  /* Combina capas (detección, manual, histograma) en una sola. Si entra la detección principal, el resultado queda en ella. */
  AZ.combineLayers = function (S, ids) {
    const ok = ids.filter(id => id === 'det' || id === 'man' || AZ.layerOf(S, id));
    if (ok.length < 2) return null;
    const n = NN(S), order = AZ.layerIds(S).filter(id => ok.includes(id)), target = ok.includes('det') ? 'det' : order[0];
    const names = order.map(id => (id === 'det' ? S.meta.det : id === 'man' ? S.meta.man : AZ.layerOf(S, id)).name);
    let cells = 0;
    if (target === 'det') {
      if (!S.badd || S.badd.length !== n) S.badd = new Uint8Array(n);
      for (const id of ok) if (id !== 'det') { const m = AZ.maskOf(S, id); for (let i = 0; i < n; i++) if (m[i] && S.inside[i]) { S.badd[i] = 1; if (S.berase) S.berase[i] = 0; cells++; } }
    } else {
      const T = AZ.maskOf(S, target);
      for (const id of ok) if (id !== target) { const m = AZ.maskOf(S, id); for (let i = 0; i < n; i++) if (m[i]) { T[i] = 1; cells++; } }
      const o = target === 'man' ? S.meta.man : AZ.layerOf(S, target); o.name = (names.join(' + ').length <= 40 ? names.join(' + ') : names[0] + ' + ' + (names.length - 1) + ' capas').slice(0, 40); if (o.prev) o.prev = null;
    }
    for (const id of ok) if (id !== target) { if (id === 'man') { S.man = null; S.meta.man = null; } else { const k = S.hl.findIndex(l => l.id === id); if (k >= 0) S.hl.splice(k, 1); } }
    if (target === 'det') AZ.mergeDet(S); else AZ.mchange(S);
    return { target, cells, names };
  };

  /* ---- pincel / borrador: pintan celdas completas (respetan el tamaño de la grilla). n = diámetro en celdas ---- */
  AZ.brush = function (S, id, ci, cj, n, val) {
    const m = AZ.maskOf(S, id); if (!m) return false;
    const r = Math.max(0.5, n / 2), R = Math.ceil(r), len = NN(S);
    if (id === 'det') { if (!S.badd || S.badd.length !== len) S.badd = new Uint8Array(len); if (!S.berase || S.berase.length !== len) S.berase = new Uint8Array(len); }
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      if (Math.hypot(di, dj) > r) continue;
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= S.gw || j >= S.gh) continue;
      const k = j * S.gw + i; if (!S.inside[k]) continue;
      m[k] = val ? 1 : 0;
      if (id === 'det') { S.badd[k] = val ? 1 : 0; S.berase[k] = val ? 0 : 1; }
    }
    if (id === 'det') S.hasDet = true;
    AZ.mchange(S); return true;
  };

  /* ---- capas de histograma: rango de color (barras de umbral) + varita mágica ---- */
  AZ.histRange = function (S, L, lo, hi) {
    const a = S.idx[L.idx], n = NN(S), p = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (S.inside[i] && S.valid[i] && a[i] >= lo && a[i] <= hi) p[i] = 1;
    L.range = [lo, hi]; L.prev = p; S.ver++;
  };
  AZ.histIdx = function (S, L, key) { L.idx = key; L.range = null; L.prev = null; S.idxName = key; S.ver++; };
  function flood(S, c0, ok) {
    const { gw, gh } = S, seen = new Uint8Array(gw * gh), out = new Uint8Array(gw * gh), st = [c0]; seen[c0] = 1; out[c0] = 1;
    while (st.length) {
      const i = st.pop(), x = i % gw, y = (i / gw) | 0;
      for (let q = 0; q < 4; q++) {
        const X = x + (q === 0) - (q === 1), Y = y + (q === 2) - (q === 3);
        if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
        const k = Y * gw + X; if (seen[k]) continue; seen[k] = 1;
        if (ok(k)) { out[k] = 1; st.push(k); }
      }
    }
    return out;
  }
  /* Clic = nueva selección · Mayús (o Ctrl) + clic = suma (add) */
  AZ.wandSel = function (S, L, ci, cj, add, tolPct) {
    const c0 = cj * S.gw + ci, a = S.idx[L.idx];
    if (!S.inside[c0]) return 'Ese punto está fuera del límite del lote';
    if (!L.prev || !L.prev[c0]) { const [lo, hi] = S.lim[L.idx], tol = (tolPct / 100) * (hi - lo), v = a[c0]; AZ.histRange(S, L, v - tol, v + tol); }
    const reg = flood(S, c0, k => L.prev[k] === 1);
    if (add) { for (let i = 0; i < reg.length; i++) if (reg[i]) L.mask[i] = 1; } else L.mask = reg;
    AZ.mchange(S); return null;
  };
  /* Clic derecho = borra la zona seleccionada (componente conexa) bajo el cursor */
  AZ.wandErase = function (S, L, ci, cj) {
    const c0 = cj * S.gw + ci; if (!L.mask[c0]) return 'No hay zona seleccionada en ese punto';
    const reg = flood(S, c0, k => L.mask[k] === 1);
    for (let i = 0; i < reg.length; i++) if (reg[i]) L.mask[i] = 0;
    AZ.mchange(S); return null;
  };
  AZ.selectRange = function (S, L) { if (!L.prev) return 0; let c = 0; for (let i = 0; i < L.prev.length; i++) if (L.prev[i]) { L.mask[i] = 1; c++; } AZ.mchange(S); return c; };
  AZ.clearLayer = function (S, L) { L.mask = new Uint8Array(NN(S)); L.prev = null; L.range = null; AZ.mchange(S); };

  AZ.histBins = function (S, key, B) {
    const a = S.idx[key], [lo, hi] = S.lim[key], U = AZ.union(S), rest = new Float32Array(B), det = new Float32Array(B);
    for (let i = 0; i < a.length; i++) if (S.inside[i] && S.valid[i]) { const b = Math.max(0, Math.min(B - 1, ((a[i] - lo) / (hi - lo) * B) | 0)); (U[i] ? det : rest)[b]++; }
    return { rest, det, lo, hi };
  };

  /* ---- puntos (+)/(−): siempre en el centro de una celda de la grilla ---- */
  AZ.pointCounts = S => ({ pos: S.pts.filter(p => p.v > 0).length, neg: S.pts.filter(p => p.v < 0).length });
  AZ.togglePoint = function (S, ci, cj, sign) {
    const k = S.pts.findIndex(p => Math.floor(p.x / S.cs) === ci && Math.floor(p.y / S.cs) === cj);
    if (k >= 0) { if (S.pts[k].v === sign) S.pts.splice(k, 1); else S.pts[k].v = sign; }
    else S.pts.push({ x: (ci + 0.5) * S.cs, y: (cj + 0.5) * S.cs, v: sign });
    S.ver++; return AZ.pointCounts(S);
  };
  AZ.clearPoints = function (S) { S.pts = []; S.auto = new Uint8Array(NN(S)); AZ.mergeDet(S); S.hasDet = AZ.count(S.det) > 0; };

  /* ---- estadísticas: infértil = unión de las capas incluidas; fértil = resto del lote ---- */
  AZ.stats = function (S) {
    const ch = AZ.cellHa(S), n = NN(S), U = AZ.union(S), key = S.idx.ndvi ? 'ndvi' : 'exg', a = S.idx[key], b = S.meta.buf;
    let nin = 0, ni = 0, nf = 0, nb = 0, nt = 0, sf = 0, si = 0;
    const per = { det: 0, man: 0 }; S.hl.forEach(l => { per[l.id] = 0; });
    for (let i = 0; i < n; i++) {
      if (!S.inside[i]) continue; nin++;
      if (U[i]) { ni++; si += a[i]; } else { nf++; sf += a[i]; if (S.buf[i]) nb++; }
      if (!U[i] && !(b.on && b.inc && S.buf[i])) nt++;
      if (S.det[i]) per.det++; if (S.man && S.man[i]) per.man++;
    }
    for (const l of S.hl) { let c = 0; for (let i = 0; i < n; i++) if (S.inside[i] && l.mask[i]) c++; per[l.id] = c * ch; }
    per.det *= ch; per.man *= ch;
    return { tot: AZ.coverHa(S), lote: nin * ch, inf: ni * ch, fer: nf * ch, buf: nb * ch, treat: nt * ch, avgFer: nf ? sf / nf : 0, avgInf: ni ? si / ni : 0, idxKey: key, per, ch };
  };
})(typeof window !== 'undefined' ? window : globalThis);
