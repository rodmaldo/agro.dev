/* agro.dev · unión de fotos en una sola imagen (sin DOM, probado en Node).
   1) Alinea fotos vecinas por su contenido (correlación de fase en la zona de solapamiento).
   2) Ajusta TODAS las posiciones a la vez (mínimos cuadrados robusto), usando el GPS solo como punto de partida.
   3) Iguala brillo y color entre fotos (ganancia por foto y canal).
   4) Mezcla las fotos con pesos que dan prioridad al centro de cada una (sin costuras duras).
   Supone terreno casi plano y cámara apuntando hacia abajo (vuelo fotogramétrico típico en lotes agrícolas).
   NO es fotogrametría completa: no corrige relieve, paralaje ni distorsión de lente. */
(function (root) {
  'use strict';
  const S = {};
  root.AZStitch = S;
  if (typeof module !== 'undefined') module.exports = S;
  const pow2 = n => { let p = 1; while (p < n) p <<= 1; return p; };

  /* ---------- FFT ---------- */
  function fft1(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const a = i + k, b = a + h, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  function fft2(re, im, N, inv) {
    for (let r = 0; r < N; r++) fft1(re.subarray(r * N, r * N + N), im.subarray(r * N, r * N + N), inv);
    const cr = new Float64Array(N), ci = new Float64Array(N);
    for (let c = 0; c < N; c++) {
      for (let r = 0; r < N; r++) { cr[r] = re[r * N + c]; ci[r] = im[r * N + c]; }
      fft1(cr, ci, inv);
      for (let r = 0; r < N; r++) { re[r * N + c] = cr[r]; im[r * N + c] = ci[r]; }
    }
  }

  /* Correlación de fase. Si B(x) = A(x - t), devuelve t (px). psr = nitidez del pico (cuanto más alto, más confiable). */
  S.phase = function (A, B, W, H) {
    const N = pow2(Math.max(W, H, 32)), ar = new Float64Array(N * N), ai = new Float64Array(N * N), br = new Float64Array(N * N), bi = new Float64Array(N * N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { ar[y * N + x] = A[y * W + x]; br[y * N + x] = B[y * W + x]; }
    fft2(ar, ai, N, false); fft2(br, bi, N, false);
    for (let k = 0; k < N * N; k++) {
      const re = ar[k] * br[k] + ai[k] * bi[k], im = ai[k] * br[k] - ar[k] * bi[k], m = Math.hypot(re, im) + 1e-12;
      ar[k] = re / m; ai[k] = im / m;
    }
    fft2(ar, ai, N, true);
    let pk = -1e9, pi = 0;
    for (let k = 0; k < N * N; k++) if (ar[k] > pk) { pk = ar[k]; pi = k; }
    const px = pi % N, py = (pi / N) | 0;
    let s = 0, s2 = 0, n = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = Math.min(Math.abs(x - px), N - Math.abs(x - px)), dy = Math.min(Math.abs(y - py), N - Math.abs(y - py));
      if (dx <= 3 && dy <= 3) continue; const v = ar[y * N + x]; s += v; s2 += v * v; n++;
    }
    const mu = s / n, sd = Math.sqrt(Math.max(1e-18, s2 / n - mu * mu)), psr = (pk - mu) / sd;
    const g = (x, y) => ar[((y + N) % N) * N + ((x + N) % N)];
    const sub = (m1, c, p1) => { const d = m1 - 2 * c + p1; return Math.abs(d) < 1e-12 ? 0 : 0.5 * (m1 - p1) / d; };
    const fx = sub(g(px - 1, py), pk, g(px + 1, py)), fy = sub(g(px, py - 1), pk, g(px, py + 1));
    /* con F·conj(G) el pico queda en -t */
    return { dx: -((px > N / 2 ? px - N : px) + fx), dy: -((py > N / 2 ? py - N : py) + fy), psr, peak: pk };
  };

  /* ---------- geometría de cada foto ---------- */
  /* ph: {e,n (m, este/norte), rot (rad, horario desde el norte), fw,fh (m), gw,gh, rgb:Uint8Array(gw*gh*3)} */
  const corners = (ph, K, de, dn) => {
    const c = Math.cos(ph.rot), s = Math.sin(ph.rot), hx = ph.fw * K / 2, hy = ph.fh * K / 2, out = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = a * hx, y = b * hy; out.push([ph.e + (de || 0) + x * c - y * s, ph.n + (dn || 0) - (x * s + y * c)]); }
    return out;
  };
  const aabb = pts => { let a = 1e18, b = -1e18, c = 1e18, d = -1e18; for (const p of pts) { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); } return [a, b, c, d]; };
  const out3 = [0, 0, 0];
  /* muestrea el color de la miniatura en (E,N); false si cae fuera del recorte K */
  function samp(ph, E, N, K, o) {
    const c = Math.cos(ph.rot), s = Math.sin(ph.rot), dE = E - ph.e, dN = N - ph.n, x = dE * c - dN * s, y = -dE * s - dN * c;
    if (Math.abs(x) > ph.fw * K / 2 || Math.abs(y) > ph.fh * K / 2) return false;
    let u = (x / ph.fw + 0.5) * ph.gw - 0.5, v = (y / ph.fh + 0.5) * ph.gh - 0.5;
    u = Math.max(0, Math.min(ph.gw - 1.001, u)); v = Math.max(0, Math.min(ph.gh - 1.001, v));
    const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0, i00 = (v0 * ph.gw + u0) * 3, i10 = i00 + 3, i01 = i00 + ph.gw * 3, i11 = i01 + 3, d = ph.rgb;
    for (let k = 0; k < 3; k++) o[k] = (d[i00 + k] * (1 - fu) + d[i10 + k] * fu) * (1 - fv) + (d[i01 + k] * (1 - fu) + d[i11 + k] * fu) * fv;
    return true;
  }

  /* zona de solapamiento entre dos fotos muestreada como dos parches alineados al mundo */
  function overlap(a, b, K, maxP) {
    const A = aabb(corners(a, K)), B = aabb(corners(b, K));
    const x0 = Math.max(A[0], B[0]), x1 = Math.min(A[1], B[1]), y0 = Math.max(A[2], B[2]), y1 = Math.min(A[3], B[3]);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    let pr = Math.max(a.fw / a.gw, b.fw / b.gw), W = Math.ceil((x1 - x0) / pr), H = Math.ceil((y1 - y0) / pr);
    if (Math.max(W, H) > maxP) { pr *= Math.max(W, H) / maxP; W = Math.ceil((x1 - x0) / pr); H = Math.ceil((y1 - y0) / pr); }
    if (W < 24 || H < 24) return null;
    const ga = new Float32Array(W * H), gb = new Float32Array(W * H), va = new Float64Array(3), vb = new Float64Array(3), oa = [0, 0, 0], ob = [0, 0, 0];
    let cnt = 0; const m = new Uint8Array(W * H);
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const E = x0 + (u + 0.5) * pr, N = y1 - (v + 0.5) * pr;
      if (!samp(a, E, N, K, oa) || !samp(b, E, N, K, ob)) continue;
      const k = v * W + u; m[k] = 1; cnt++;
      ga[k] = 0.299 * oa[0] + 0.587 * oa[1] + 0.114 * oa[2]; gb[k] = 0.299 * ob[0] + 0.587 * ob[1] + 0.114 * ob[2];
      for (let q = 0; q < 3; q++) { va[q] += oa[q]; vb[q] += ob[q]; }
    }
    if (cnt < 600 || cnt < 0.12 * W * H) return null;
    for (let q = 0; q < 3; q++) { va[q] /= cnt; vb[q] /= cnt; }
    return { W, H, pr, ga, gb, m, cnt, ma: va, mb: vb, frac: cnt / (W * H) };
  }
  /* normaliza (media 0, desvío 1), ventana de Hann y ceros fuera del solapamiento */
  function prep(g, m, W, H) {
    let s = 0, s2 = 0, n = 0; for (let k = 0; k < g.length; k++) if (m[k]) { s += g[k]; s2 += g[k] * g[k]; n++; }
    const mu = s / n, sd = Math.sqrt(Math.max(1e-6, s2 / n - mu * mu)), out = new Float32Array(g.length);
    for (let v = 0; v < H; v++) { const wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * (v + 0.5) / H); for (let u = 0; u < W; u++) { const k = v * W + u; if (m[k]) out[k] = (g[k] - mu) / sd * wy * (0.5 - 0.5 * Math.cos(2 * Math.PI * (u + 0.5) / W)); } }
    return out;
  }

  /* ---------- solución global: CG con precondicionador diagonal ---------- */
  /* ecuaciones x_j - x_i = c con peso w ; prior x_i ≈ 0 con peso lam */
  function solve(n, edges, comp, lam) {
    const diag = new Float64Array(n).fill(lam), b = new Float64Array(n), x = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    for (const e of edges) { diag[e.i] += e.w; diag[e.j] += e.w; b[e.j] += e.w * e.c[comp]; b[e.i] -= e.w * e.c[comp]; }
    const mv = (v, y) => { for (let i = 0; i < n; i++) y[i] = lam * v[i]; for (const e of edges) { const t = e.w * (v[e.j] - v[e.i]); y[e.j] += t; y[e.i] -= t; } };
    for (let i = 0; i < n; i++) { r[i] = b[i]; z[i] = r[i] / diag[i]; p[i] = z[i]; }
    let rz = 0; for (let i = 0; i < n; i++) rz += r[i] * z[i];
    const b2 = Math.max(1e-30, b.reduce((s, v) => s + v * v, 0));
    for (let it = 0; it < 2000 && rz > 1e-14 * b2; it++) {
      mv(p, Ap); let pAp = 0; for (let i = 0; i < n; i++) pAp += p[i] * Ap[i]; if (pAp <= 0) break;
      const al = rz / pAp; for (let i = 0; i < n; i++) { x[i] += al * p[i]; r[i] -= al * Ap[i]; z[i] = r[i] / diag[i]; }
      let rz2 = 0; for (let i = 0; i < n; i++) rz2 += r[i] * z[i];
      const be = rz2 / rz; rz = rz2; for (let i = 0; i < n; i++) p[i] = z[i] + be * p[i];
    }
    return x;
  }

  /* ---------- alineación ---------- */
  /* Devuelve {d: Float64Array(2n) [dE,dN por foto], edges, gain: Float64Array(3n), stats}. opts: {K, maxP, minPsr, maxShift, onProgress, cancel} */
  S.align = async function (photos, opts) {
    opts = opts || {}; const n = photos.length, K = opts.K || 0.9, maxP = opts.maxP || 160, minPsr = opts.minPsr || 5.5;
    const maxShift = opts.maxShift || Math.max(8, 0.12 * Math.min(...photos.map(p => p.fw)));
    /* vecinos: índice espacial por celdas del tamaño de una foto */
    const cell = Math.max(...photos.map(p => Math.hypot(p.fw, p.fh))) * 0.75, grid = new Map(), key = (a, b) => a + ',' + b;
    photos.forEach((p, i) => { const k = key(Math.floor(p.e / cell), Math.floor(p.n / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    const pairs = [];
    photos.forEach((p, i) => {
      const cx = Math.floor(p.e / cell), cy = Math.floor(p.n / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid.get(key(cx + a, cy + b)) || []) if (j > i) {
        const q = photos[j], rx = (p.fw + q.fw) / 2 * K, ry = (p.fh + q.fh) / 2 * K;   // descarte rápido (conservador para fotos giradas 0/180°)
        if (Math.hypot(p.e - q.e, p.n - q.n) < Math.hypot(rx, ry)) pairs.push([i, j]);
      }
    });
    /* en vuelos con mucho solapamiento alcanza con los vecinos más cercanos de cada foto */
    const NB = opts.neighbors || 6, near = photos.map(() => []);
    pairs.forEach((pr, k) => { const d = Math.hypot(photos[pr[0]].e - photos[pr[1]].e, photos[pr[0]].n - photos[pr[1]].n); near[pr[0]].push([d, k]); near[pr[1]].push([d, k]); });
    const keep = new Set(); near.forEach(l => { l.sort((a, b) => a[0] - b[0]); l.slice(0, NB).forEach(x => keep.add(x[1])); });
    const use = pairs.filter((_, k) => keep.has(k));
    const edges = [], gedges = []; let tried = 0, noOv = 0, weak = 0, far = 0;
    for (let pi = 0; pi < use.length; pi++) {
      const [i, j] = use[pi];
      if (opts.cancel && opts.cancel.v) throw new Error('cancelado');
      if (pi % 6 === 0) { if (opts.onProgress) opts.onProgress(pi / use.length); await new Promise(r => setTimeout(r, 0)); }   // cede el hilo para que la interfaz siga viva
      const ov = overlap(photos[i], photos[j], K, maxP); if (!ov) { noOv++; continue; }
      tried++;
      /* ganancia: g_j·m_j = g_i·m_i  →  lg_j - lg_i = log(m_i/m_j) (por canal) */
      gedges.push({ i, j, w: ov.frac, c: [0, 1, 2].map(q => Math.log(Math.max(1, ov.ma[q]) / Math.max(1, ov.mb[q]))) });
      const r = S.phase(prep(ov.ga, ov.m, ov.W, ov.H), prep(ov.gb, ov.m, ov.W, ov.H), ov.W, ov.H);
      if (r.psr < minPsr) { weak++; continue; }
      const dE = r.dx * ov.pr, dN = -r.dy * ov.pr;           // contenido de j desplazado (dE,dN) respecto de i
      if (Math.hypot(dE, dN) > maxShift) { far++; continue; }
      edges.push({ i, j, c: [-dE, -dN], w: Math.min(2.5, (r.psr - minPsr * 0.5) / minPsr) * Math.sqrt(ov.frac), psr: r.psr });
    }
    const lam = 1e-3 * (edges.length ? edges.reduce((s, e) => s + e.w, 0) / edges.length : 1);
    let d = [new Float64Array(n), new Float64Array(n)], res = [];
    const run = () => { d = [solve(n, edges, 0, lam), solve(n, edges, 1, lam)]; res = edges.map(e => Math.hypot(d[0][e.j] - d[0][e.i] - e.c[0], d[1][e.j] - d[1][e.i] - e.c[1])); };
    if (edges.length) {
      run();
      for (let it = 0; it < 3; it++) {   // IRLS: baja el peso de pares que contradicen al resto
        const sorted = res.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1] || 0, sc = Math.max(0.25, 2.5 * med);
        edges.forEach((e, k) => { e.w0 = e.w0 || e.w; e.w = e.w0 / (1 + (res[k] / sc) * (res[k] / sc)); }); run();
      }
    }
    const sorted = res.slice().sort((a, b) => a - b);
    /* ganancias por foto y canal (en logaritmo), con prior hacia 1 */
    const glam = 0.3 * (gedges.length ? gedges.reduce((s, e) => s + e.w, 0) / gedges.length : 1), gain = new Float64Array(3 * n).fill(1);
    if (gedges.length) for (let q = 0; q < 3; q++) { const lg = solve(n, gedges.map(e => ({ i: e.i, j: e.j, w: e.w, c: [e.c[q]] })), 0, glam); for (let i = 0; i < n; i++) gain[i * 3 + q] = Math.max(0.6, Math.min(1.6, Math.exp(lg[i]))); }
    const dd = new Float64Array(2 * n); for (let i = 0; i < n; i++) { dd[2 * i] = d[0][i]; dd[2 * i + 1] = d[1][i]; }
    return { d: dd, gain, edges, stats: { pairs: use.length, overlapping: tried, accepted: edges.length, weak, far, noOverlap: noOv, medResidual: sorted.length ? sorted[sorted.length >> 1] : 0, p90Residual: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0 } };
  };

  /* ---------- mezcla ---------- */
  /* acumulador de color ponderado para toda la imagen */
  S.newAcc = (W, H) => ({ W, H, sum: new Float32Array(W * H * 3), wt: new Float32Array(W * H) });
  /* ph: foto con posición ya corregida (e,n). src: {data:RGBA, w, h}. cfg: {mpp,cE,cN,K}. gain: [r,g,b] */
  S.accumulate = function (acc, ph, src, cfg, gain) {
    const { W, H } = acc, mpp = cfg.mpp, K = cfg.K || 0.9, c = Math.cos(ph.rot), s = Math.sin(ph.rot), hx = ph.fw / 2, hy = ph.fh / 2;
    const bb = aabb(corners(ph, K));
    const mx0 = Math.max(0, Math.floor(W / 2 + (bb[0] - cfg.cE) / mpp)), mx1 = Math.min(W - 1, Math.ceil(W / 2 + (bb[1] - cfg.cE) / mpp));
    const my0 = Math.max(0, Math.floor(H / 2 - (bb[3] - cfg.cN) / mpp)), my1 = Math.min(H - 1, Math.ceil(H / 2 - (bb[2] - cfg.cN) / mpp));
    const sw = src.w, sh = src.h, d = src.data, g0 = gain ? gain[0] : 1, g1 = gain ? gain[1] : 1, g2 = gain ? gain[2] : 1;
    for (let my = my0; my <= my1; my++) for (let mx = mx0; mx <= mx1; mx++) {
      const E = cfg.cE + (mx + 0.5 - W / 2) * mpp, N = cfg.cN - (my + 0.5 - H / 2) * mpp, dE = E - ph.e, dN = N - ph.n;
      const x = dE * c - dN * s, y = -dE * s - dN * c, aa = Math.abs(x) / hx, bb2 = Math.abs(y) / hy;
      if (aa > K || bb2 > K) continue;
      const t = Math.min(1 - aa / K, 1 - bb2 / K), w = t * t + 1e-3;
      let u = (x / ph.fw + 0.5) * sw - 0.5, v = (y / ph.fh + 0.5) * sh - 0.5;
      u = Math.max(0, Math.min(sw - 1.001, u)); v = Math.max(0, Math.min(sh - 1.001, v));
      const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0, i00 = (v0 * sw + u0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const k = my * W + mx;
      for (let q = 0; q < 3; q++) {
        const val = ((d[i00 + q] * (1 - fu) + d[i10 + q] * fu) * (1 - fv) + (d[i01 + q] * (1 - fu) + d[i11 + q] * fu) * fv) * (q === 0 ? g0 : q === 1 ? g1 : g2);
        acc.sum[k * 3 + q] += val * w;
      }
      acc.wt[k] += w;
    }
  };
  S.finish = function (acc) {
    const { W, H } = acc, out = new Uint8ClampedArray(W * H * 4);
    for (let k = 0; k < W * H; k++) { const w = acc.wt[k]; if (w <= 0) continue; out[k * 4] = acc.sum[k * 3] / w; out[k * 4 + 1] = acc.sum[k * 3 + 1] / w; out[k * 4 + 2] = acc.sum[k * 3 + 2] / w; out[k * 4 + 3] = 255; }
    return out;
  };
  S._corners = corners; S._aabb = aabb;
})(typeof window !== 'undefined' ? window : globalThis);
