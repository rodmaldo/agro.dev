/* agro.dev · biblioteca de ejemplos (paso 1 del aprendizaje).
   Cada vez que se guarda un lote con detección confirmada, se guardan en disco las características de color de una muestra de sus celdas,
   etiquetadas: salitre / sano, y de dónde viene la etiqueta. NO entrena nada todavía: arma el material con el que después se entrena y se mide.
   src: 0 = lo marcó la IA y el usuario lo dejó · 1 = punto (+)/(−) del usuario · 2 = el usuario lo AGREGÓ con pincel/capa · 3 = el usuario lo BORRÓ (corrección). */
(function (root) {
  'use strict';
  const AZ = root.AZ;
  const Lr = (typeof module !== 'undefined' && module.exports) ? module.exports : (root.AZLearn = {});
  const CAP = 2000;              // celdas por clase y lote (las correcciones del usuario entran siempre, hasta CAP)

  Lr.featNames = S => ['rojo', 'verde', 'brillo', 'saturacion', 'exg'].concat(S.detailed ? ['textura'] : [], S.idx && S.idx.ndvi ? ['ndvi'] : []);

  /* generador pseudoaleatorio fijo: el mismo lote da siempre la misma muestra */
  const rng = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

  /* Arma el conjunto de ejemplos del lote. Devuelve null si todavía no hay detección confirmada. */
  Lr.collect = function (S, meta) {
    if (!S.gw || !S.F || !S.hasDet || !S.det) return null;
    const N = S.gw * S.gh, D = S.D, U = AZ.union(S), rnd = rng(N + S.gw), cell = {};
    const ok = c => S.inside[c] && S.valid[c];
    const take = (arr, cap) => { if (arr.length <= cap) return arr; const o = arr.slice(); for (let i = o.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [o[i], o[j]] = [o[j], o[i]]; } return o.slice(0, cap); };
    // 1) lo que el usuario puso: puntos y correcciones (valen más que lo que sólo dedujo la IA)
    const pts = [], add = [], del = [];
    for (const p of S.pts || []) { const c = Math.min(S.gh - 1, Math.max(0, (p.y / S.cs) | 0)) * S.gw + Math.min(S.gw - 1, Math.max(0, (p.x / S.cs) | 0)); if (ok(c)) { cell[c] = [p.v > 0 ? 1 : 0, 1]; pts.push(c); } }
    if (S.badd) for (let c = 0; c < N; c++) if (S.badd[c] && ok(c) && !cell[c]) { cell[c] = [1, 2]; add.push(c); }
    if (S.berase) for (let c = 0; c < N; c++) if (S.berase[c] && ok(c) && !cell[c]) { cell[c] = [0, 3]; del.push(c); }
    const user = { add: take(add, CAP / 2), del: take(del, CAP / 2) };
    // 2) el resto, tal como quedó la detección final (se toma una muestra repartida)
    const pos = [], neg = [];
    for (let c = 0; c < N; c++) if (ok(c) && !cell[c]) (U[c] ? pos : neg).push(c);
    const rows = [], put = (c, lab, src) => { const r = [lab, src]; for (let k = 0; k < D; k++) r.push(Math.round(S.F[c * D + k] * 10000) / 10000); rows.push(r); };
    pts.forEach(c => put(c, cell[c][0], 1)); user.add.forEach(c => put(c, 1, 2)); user.del.forEach(c => put(c, 0, 3));
    let np = rows.filter(r => r[0] === 1).length, nn = rows.length - np;
    take(pos, Math.max(0, CAP - np)).forEach(c => put(c, 1, 0)); take(neg, Math.max(0, CAP - nn)).forEach(c => put(c, 0, 0));
    const cnt = { pos: 0, neg: 0, user: 0 }; rows.forEach(r => { r[0] ? cnt.pos++ : cnt.neg++; if (r[1] > 0) cnt.user++; });
    return { format: 'agro.dev/ejemplos', v: 1, lotId: meta.id, name: meta.name, app: meta.version || '', savedAt: new Date().toISOString(), cellM: +AZ.cellM(S).toFixed(3), D, feat: Lr.featNames(S), cfg: meta.cfg ? { kind: meta.cfg.kind, detail: meta.cfg.detail, detName: meta.cfg.detName, sens: meta.cfg.sens } : null, n: cnt,
      lotHa: +(S.gw * S.gh * AZ.cellHa(S)).toFixed(1), infPct: (() => { let a = 0, b = 0; for (let c = 0; c < N; c++) if (ok(c)) { b++; if (U[c]) a++; } return b ? +(100 * a / b).toFixed(2) : 0; })(), rows };
  };

  Lr.available = () => !!(root.agroDesktop && root.agroDesktop.examples);
  /* Guarda los ejemplos del lote (reemplaza lo anterior de ese lote: así una corrección posterior mejora el ejemplo, no lo duplica). */
  Lr.record = async function (S, meta) {
    if (!Lr.available()) return null;
    try { const ex = Lr.collect(S, meta); if (!ex) return null; await root.agroDesktop.examples.save(meta.id, JSON.stringify(ex)); return ex.n; }
    catch (e) { if (root.AZDesktop) root.AZDesktop.addLog('no se pudieron guardar los ejemplos: ' + e.message, 'Interfaz'); return null; }
  };
  /* Resumen de toda la biblioteca: [{id,name,savedAt,n,...}] */
  Lr.summary = async function () { try { return Lr.available() ? await root.agroDesktop.examples.summary() : []; } catch (e) { return []; } };
})(typeof window !== 'undefined' ? window : globalThis);
