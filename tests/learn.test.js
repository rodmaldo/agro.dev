const assert = require('assert');
const AZ = require('../js/engine.js'); globalThis.AZ = AZ; require('../js/layers.js');
const Lr = require('../js/learn.js');
const d = AZ.demoPixels(), S = AZ.newState();
AZ.setImage(S, { width: d.W, height: d.H, getContext: () => ({ getImageData: () => ({ data: d.data }) }) }, d.mpp, d.poly); AZ.prepare(S, 10);
assert.strictEqual(Lr.collect(S, { id: 'a', name: 'x' }), null, 'sin detección no hay ejemplos');
[[420, 330, 1], [1130, 640, 1], [800, 880, 1], [300, 500, -1], [900, 200, -1], [1400, 600, -1]].forEach(([x, y, v]) => { const [i, j] = AZ.cellAt(S, x, y); AZ.togglePoint(S, i, j, v); });
AZ.detect(S, 50, true);
// corrección del usuario: agrega 40 celdas y borra 30
const c0 = []; for (let c = 0; c < S.gw * S.gh && c0.length < 70; c++) if (S.inside[c] && S.valid[c]) c0.push(c * 7 % (S.gw * S.gh));
S.badd = new Uint8Array(S.gw * S.gh); S.berase = new Uint8Array(S.gw * S.gh); let na = 0, nd = 0;
for (let c = 0; c < S.gw * S.gh; c++) if (S.inside[c] && S.valid[c]) { if (na < 40 && !S.det[c]) { S.badd[c] = 1; na++; } else if (nd < 30 && S.det[c]) { S.berase[c] = 1; nd++; } }
AZ.mergeDet(S);
const ex = Lr.collect(S, { id: 'lote1', name: 'Lote 1', cfg: { kind: 'rgb', detail: 'norm', detName: 'Salitre', sens: 50 } });
console.log('ejemplos', JSON.stringify(ex.n), 'features', ex.feat.join(','), 'inf %', ex.infPct, 'filas', ex.rows.length);
assert(ex.n.pos > 0 && ex.n.neg > 0); assert.strictEqual(ex.rows[0].length, 2 + S.D); assert.strictEqual(ex.feat.length, S.D);
const bySrc = k => ex.rows.filter(r => r[1] === k).length;
assert.strictEqual(bySrc(1), 6, 'los 6 puntos'); assert.strictEqual(bySrc(2), na); assert.strictEqual(bySrc(3), nd);
assert(ex.rows.filter(r => r[1] === 3).every(r => r[0] === 0) && ex.rows.filter(r => r[1] === 2).every(r => r[0] === 1), 'agregado=salitre, borrado=sano');
assert(ex.rows.length <= 2 * 2000 + 10);
const ex2 = Lr.collect(S, { id: 'lote1', name: 'Lote 1' }); assert.deepStrictEqual(ex.rows, ex2.rows, 'la muestra es reproducible');
console.log('biblioteca de ejemplos: OK');
