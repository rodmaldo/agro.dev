/* Guardar y reabrir un lote: la instantánea reconstruye exactamente el mismo estado (detección, capas, búfer, ambientación, límite, puntos) sin reprocesar. */
const assert = require('assert');
const AZ = require('../js/engine.js'); globalThis.AZ = AZ; require('../js/layers.js');
const L = require('../js/lotstate.js');
(async () => {
  const T = { url: 'http://x', server: 's1', levels: 3, tile: 512, w0: 4000, h0: 3000, g: 0.05, mppV: 0.25, dir: '/ortomosaicos/Lote_1' };
  const S = AZ.newState(); AZ.setTiled(S, T, null, { detailed: false }); AZ.tiledFrame(S, 12.5); AZ.prepareGrid(S, 5);
  const gw = S.gw, gh = S.gh, N = gw * gh;
  // buffer AZC1 sintético: verdor alto fuera de dos manchas
  const buf = new ArrayBuffer(20 + 20 * N), dv = new DataView(buf); 'AZC1'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, gw, true); dv.setUint32(8, gh, true); dv.setFloat64(12, 10, true);
  const n = new Uint32Array(buf, 20, N), f = k => new Float32Array(buf, 20 + 4 * N * (1 + k), N);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const c = j * gw + i, bad = Math.hypot(i - gw * .3, j - gh * .4) < gw * .12 || Math.hypot(i - gw * .7, j - gh * .6) < gw * .1; n[c] = 100; f(0)[c] = (bad ? 200 : 60) * 100; f(1)[c] = (bad ? 190 : 150) * 100 + i; f(2)[c] = (bad ? 170 : 50) * 100; f(3)[c] = 0.2 * 100; }
  S.poly = AZ.tiledPoly(S, [[0, 0], [4000, 0], [4000, 3000], [0, 3000]], 12.5); S.geo = { lat: -33.1, lon: -61.2, lat0: -33.1, lon0: -61.2, cE: 0, cN: 0, exact: true, rtk: true };
  AZ.applyCells(S, buf, false); S.cellsBuf = buf;
  [[Math.round(gw * .3), Math.round(gh * .4), 1], [Math.round(gw * .7), Math.round(gh * .6), 1], [3, 3, -1], [gw - 4, gh - 4, -1]].forEach(([i, j, v]) => AZ.togglePoint(S, i, j, v));
  AZ.detect(S, 50, true);
  AZ.setBuffer(S, true, 5); AZ.addManual(S); S.man[10] = 1; S.man[11] = 1;
  const h = AZ.addHist(S, 'exg', 'Mi histograma'); S.hl[0].mask[20] = 1; S.hl[0].mask[21] = 1; S.hl[0].range = [0.1, 0.2];
  AZ.addAmb(S); AZ.ambAdd(S); S.amb.rates = [0, 0, 20, 30, 40, 40]; AZ.ambPalette(S, 'az'); AZ.ambWand(S, 5, 5, false);   // 6 niveles y una selección en curso (la selección no se guarda)
  S.badd[30] = 1; S.berase[31] = 1; AZ.mergeDet(S); S.meta.det.name = 'Salitre fuerte'; S.zord = ['amb', 'det'];
  // límite -> píxeles nativos del ortomosaico y de vuelta (para recortar el .tif exactamente al límite)
  { const nat = [[400, 300], [3500, 500], [3000, 2600], [600, 2400]], keep = S.poly; S.poly = AZ.tiledPoly(S, nat, S.rot); const back = AZ.polyNative(S);
    back.forEach((p, i) => assert(Math.hypot(p[0] - nat[i][0], p[1] - nat[i][1]) < 1e-6, 'polyNative')); S.poly = keep; }
  S.limUser = true;
  const cfg = { gridM: 5, rot: 12.5, prec: 'rtk', detName: 'Salitre fuerte', color: '#E69F00' };
  const snap = await L.snapshot(S, { field: { id: 'f1', name: 'Lote 1' }, cfg, job: { note: 'n', timing: { seconds: 5 }, folders: ['/a'] }, stage: 'dash' });
  const json = JSON.stringify(snap); console.log('estado.json', (json.length / 1024).toFixed(0), 'KB para', N, 'celdas');
  // restaurar en un estado nuevo (el ortomosaico se "reabre" con un servidor distinto)
  const S2 = AZ.newState();
  const r = await L.restore(S2, JSON.parse(json), new Uint8Array(buf), async (dir, rtk) => { assert.strictEqual(dir, T.dir); assert.strictEqual(rtk, true); return { tiled: { ...T, server: 'otro' }, geo: S.geo, polyNative: null, mpp: T.mppV, note: 'x' }; });
  const eq = (a, b, nm) => { assert(a && b && a.length === b.length, nm + ' largo'); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(nm + ' difiere en ' + i); };
  eq(S.det, S2.det, 'det'); eq(S.auto, S2.auto, 'auto'); eq(S.badd, S2.badd, 'badd'); eq(S.berase, S2.berase, 'berase'); eq(S.man, S2.man, 'man'); eq(S.buf, S2.buf, 'buf'); eq(S.inside, S2.inside, 'inside');
  eq(S.hl[0].mask, S2.hl[0].mask, 'capa'); assert.strictEqual(S2.hl[0].name, 'Mi histograma'); assert.deepStrictEqual(S2.hl[0].range, [0.1, 0.2]);
  eq(S.amb.cls, S2.amb.cls, 'ambientación'); assert.deepStrictEqual(S2.amb.rates, [0, 0, 20, 30, 40, 40]); assert.strictEqual(S2.amb.th.length, 5); assert(!/"sel"/.test(json), 'la selección no se guarda'); assert.strictEqual(S2.amb.pal, 'az');
  assert.deepStrictEqual(S2.pts, S.pts); assert.deepStrictEqual(S2.poly, S.poly); assert.deepStrictEqual(S2.zord, S.zord);
  assert.strictEqual(S2.meta.det.name, 'Salitre fuerte'); assert.strictEqual(S2.meta.buf.on, true); assert.strictEqual(S2.rot, 12.5); assert.strictEqual(S2.cs, S.cs);
  assert.strictEqual(S2.limUser, true); eq(S.F, S2.F, 'características'); assert.strictEqual(S2.tiled.server, 'otro');
  const a = AZ.stats(S), b = AZ.stats(S2); assert(Math.abs(a.inf - b.inf) < 1e-9 && Math.abs(a.lote - b.lote) < 1e-9);
  assert.strictEqual(r.stage, 'dash'); assert.deepStrictEqual(r.cfg, cfg); assert.strictEqual(r.job.folders[0], '/a');
  // un guardado de otra versión o dañado se rechaza con un mensaje claro
  await assert.rejects(() => L.restore(AZ.newState(), { ...snap, v: 99 }, new Uint8Array(buf), async () => ({})), /más nueva/);
  await assert.rejects(() => L.restore(AZ.newState(), JSON.parse(json), null, async () => ({})), /faltan los datos/);
  await assert.rejects(() => L.restore(AZ.newState(), { ...JSON.parse(json), grid: { ...snap.grid, W: 1 } }, new Uint8Array(buf), async () => ({ tiled: T, geo: S.geo })), /no coincide/);
  console.log('lote guardado y reabierto: OK  (infértil', b.inf.toFixed(1), 'ha)');
})().catch(e => { console.error(e); process.exit(1); });
