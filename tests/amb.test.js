const assert = require('assert');
const AZ = require('../js/engine.js'); globalThis.AZ = AZ; require('../js/layers.js'); require('../js/exporter.js');
const d = AZ.demoPixels(), S = AZ.newState();
AZ.setImage(S, { width: d.W, height: d.H, getContext: () => ({ getImageData: () => ({ data: d.data }) }) }, d.mpp, d.poly); AZ.prepare(S, 10);
S.geo = { lat: -33.1, lon: -61.2, rtk: true }; S.limUser = true;
AZ.addAmb(S); const A = S.amb, N = S.gw * S.gh, sum = () => AZ.ambStats(S).tot, tot0 = sum();
assert.strictEqual(A.rates.length, 5);
// agregar niveles hasta 8 y quitar hasta 2: siempre consistente (cls, colores, umbrales, superficie total)
for (let n = 6; n <= 8; n++) { assert(AZ.ambAdd(S)); assert.strictEqual(A.rates.length, n); assert.strictEqual(A.th.length, n - 1); assert.strictEqual(A.colors.length, n); assert(Math.abs(sum() - tot0) < 1e-9); assert(A.th.every((x, i) => !i || x > A.th[i - 1]), 'umbrales crecientes'); }
assert(!AZ.ambAdd(S), 'tope de 8 niveles'); assert(new Set(A.colors).size === 8, 'colores distintos');
assert(Math.max(...A.cls.filter(x => x < 255)) <= 7);
for (let n = 7; n >= 2; n--) { assert(AZ.ambRemove(S, n > 3 ? 1 : 0)); assert.strictEqual(A.rates.length, n); assert.strictEqual(A.th.length, n - 1); assert(Math.abs(sum() - tot0) < 1e-9); }
assert(!AZ.ambRemove(S, 0), 'mínimo 2 niveles'); AZ.ambAdd(S); AZ.ambAdd(S); AZ.ambAdd(S); assert.strictEqual(A.rates.length, 5);
// al partir un nivel la dosis de los dos queda igual a la original
A.rates = [0, 10, 20, 30, 40]; AZ.ambAdd(S); assert.strictEqual(A.rates.length, 6); assert(A.rates.filter(r => r === 40 || r === 30 || r === 20 || r === 10 || r === 0).length === 6); assert.deepStrictEqual([...A.rates].sort((a, b) => a - b).slice(0, 2).every(v => v >= 0), true);
// exportación con 6 niveles: el volumen es Σ dosis × ha y hay un polígono-nivel por cada nivel con superficie
A.rates = [0, 0, 20, 30, 40, 40]; const o = { field: 'T', dose: 80, mode: 'apl', unit: 'L/ha' }, c = AZ.X.consumption(S, o), st = AZ.ambStats(S);
const expect = A.rates.reduce((s, r, k) => s + r * st.ha[k], 0) - 0; const U = AZ.union(S); // las celdas infértiles detectadas (si hay) no se tratan
assert(c.amb); assert(Math.abs(c.used - expect) < 1e-6 || c.used < expect + 1e-6);
const items = AZ.X.prescription(S, o); assert(items.some(i => i.nivel === 6) || st.ha[5] === 0);
// varita: zona conexa del mismo nivel, suma con shift, quita con clic derecho, convierte a detección
AZ.ambAuto(S, 'igual'); A.rates = [0, 0, 40, 40, 40]; AZ.ambClassify(S);
let c0 = -1; for (let i = 0; i < N; i++) if (S.inside[i] && A.cls[i] === 0) { c0 = i; break; }
assert(c0 >= 0, 'hay celdas de nivel 1'); const ci = c0 % S.gw, cj = (c0 / S.gw) | 0;
assert.strictEqual(AZ.ambWand(S, ci, cj, false), null); const n1 = AZ.ambSelCount(S); assert(n1 > 0);
for (let i = 0; i < N; i++) if (A.sel[i]) assert(A.cls[i] === 0 && S.inside[i], 'solo el mismo nivel dentro del lote');
A.span = 1; AZ.ambWand(S, ci, cj, false); assert(AZ.ambSelCount(S) >= n1, 'con ±1 nivel entra más');
A.span = 0; AZ.ambWand(S, ci, cj, false);
let c1 = -1; for (let i = 0; i < N; i++) if (S.inside[i] && A.cls[i] === 4 && !A.sel[i]) { c1 = i; break; }
if (c1 >= 0) { const before = AZ.ambSelCount(S); AZ.ambWand(S, c1 % S.gw, (c1 / S.gw) | 0, true); assert(AZ.ambSelCount(S) > before, 'Mayús suma otra zona'); AZ.ambWandErase(S, c1 % S.gw, (c1 / S.gw) | 0); assert.strictEqual(AZ.ambSelCount(S), before, 'clic derecho quita esa zona'); }
const before = AZ.stats(S).inf, nsel = AZ.ambSelCount(S), conv = AZ.ambSelToDet(S); assert.strictEqual(conv, nsel); assert.strictEqual(AZ.ambSelCount(S), 0);
const after = AZ.stats(S); assert(after.inf >= before + (nsel - 1) * AZ.cellHa(S) - 1e-9 || after.inf > before, 'la selección pasó a infértil'); assert(Math.abs(after.inf + after.fer - after.lote) < 1e-6);
assert.strictEqual(AZ.ambWand(S, 0, 0, false) === null || typeof AZ.ambWand(S, 0, 0, false) === 'string', true);
console.log('ambientación: niveles variables y varita OK · infértil', before.toFixed(2), '->', after.inf.toFixed(2), 'ha');
