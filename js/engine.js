/* agro.dev · motor de zonificación (sin dependencias, sin DOM).
   Trabaja sobre una grilla de celdas (1–25 m) y un clasificador por puntos (+/−). */
(function (root) {
  'use strict';
  const AZ = {};
  root.AZ = AZ;
  if (typeof module !== 'undefined') module.exports = AZ;

  AZ.newState = () => ({
    W: 2000, H: 1200, mpp: 2, orth: null, pix: null, ndvi: null, detailed: false,
    cs: 5, gw: 0, gh: 0, F: null, D: 5, idx: null, valid: null, lim: null,
    pts: [], poly: [], tmp: [], inside: null,
    det: new Uint8Array(0), buf: new Uint8Array(0), man: null, hl: [], seq: 0, rot: 0, mver: 0, capped: false,
    meta: { det: { name: 'Salitre', color: '#E69F00', vis: true, inc: true }, man: null, buf: { m: 0, on: false, color: '#56B4E9', vis: true, inc: true }, ortho: { vis: true, op: 100 }, sat: { vis: true, op: 100 } },
    hasDet: false, limUser: false, idxName: 'exg', dist: null, _dv: -1,
    geo: { lat: -33, lon: -61, rtk: false }, ver: 0, _oc: null
  });
  /* metros por grado de latitud (ky) y de longitud (kx), series WGS84 */
  AZ.mPerDeg = lat => { const p = lat * Math.PI / 180; return { ky: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p), kx: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p) }; };
  AZ.touch = S => { S.ver++; };
  AZ.cellM = S => S.cs * S.mpp;
  AZ.cellHa = S => { const m = S.cs * S.mpp; return m * m / 1e4; };
  AZ.count = m => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; };

  /* c: objeto tipo canvas (width, height, getContext('2d').getImageData). ndvi: Uint8Array W*H opcional */
  AZ.setImage = function (S, c, mpp, poly, opt) {
    opt = opt || {};
    S.orth = c; S.W = c.width; S.H = c.height; S.mpp = mpp;
    S.pix = c.getContext('2d').getImageData(0, 0, S.W, S.H).data;
    S.ndvi = opt.ndvi || null; S.detailed = !!opt.detailed;
    S.poly = poly || [[0, 0], [S.W, 0], [S.W, S.H], [0, S.H]];
    S.tmp = []; S.pts = []; S.auto = null; S.badd = null; S.berase = null; S.rot = 0; S.hasDet = false; S.idxName = 'exg'; S.covPx = 0; S.man = null; S.zord = null; S.amb = null; S.hl = []; S.meta.man = null; S.meta.buf.on = false; S.meta.buf.m = 0;
  };

  /* tamaño de celda en píxeles de análisis y cantidad de celdas (máx. 4 millones) */
  function gridSize(S, gridM) {
    S.cs = Math.max(1, gridM / S.mpp);
    let gw = Math.ceil(S.W / S.cs), gh = Math.ceil(S.H / S.cs);
    S.capped = false;
    while (gw * gh > 4e6) { S.capped = true; S.cs *= 1.25; gw = Math.ceil(S.W / S.cs); gh = Math.ceil(S.H / S.cs); }
    S.gw = gw; S.gh = gh;
  }
  AZ.prepare = function (S, gridM) {
    gridSize(S, gridM);
    feats(S); finishPrep(S);
  };
  function finishPrep(S) {
    const { gw, gh } = S;
    AZ.calcInside(S); AZ.calcLims(S);
    const N = gw * gh;
    S.det = new Uint8Array(N); S.buf = new Uint8Array(N); S.man = S.man ? new Uint8Array(N) : null;
    for (const l of S.hl) { l.mask = new Uint8Array(N); l.prev = null; l.range = null; }
    S.hasDet = false; S.dist = null; S._dv = -1; S.auto = null; S.badd = null; S.berase = null; S.pts = []; S.mver++; S.ver++;
  }

  /* ---- modo por mosaicos (versión de escritorio): el ortomosaico no se carga entero; las celdas las calcula el motor Python sobre los píxeles originales ----
     T: {url, levels, tile, w0, h0 (px nativos), g (m/px nativo), mppV (m/px del marco de análisis)} */
  AZ.setTiled = function (S, T, poly, opt) {
    opt = opt || {};
    S.tiled = T; S.orth = null; S.pix = null; S.ndvi = null; S.detailed = !!opt.detailed; S.mpp = T.mppV;
    S.rot = 0; AZ.tiledFrame(S, 0);
    S.poly = poly || [[0, 0], [S.W, 0], [S.W, S.H], [0, S.H]];
    S.tmp = []; S.pts = []; S.auto = null; S.badd = null; S.berase = null; S.hasDet = false; S.idxName = 'exg'; S.covPx = 0; S.man = null; S.zord = null; S.amb = null; S.hl = []; S.meta.man = null; S.meta.buf.on = false; S.meta.buf.m = 0;
  };
  /* tamaño del marco de análisis (el mosaico girado −rot°, igual que rotateCanvas) */
  AZ.tiledFrame = function (S, rot) {
    const T = S.tiled, t = (rot || 0) * Math.PI / 180, co = Math.abs(Math.cos(t)), si = Math.abs(Math.sin(t)), k = T.g / T.mppV;
    S.W = Math.ceil((T.w0 * co + T.h0 * si) * k); S.H = Math.ceil((T.w0 * si + T.h0 * co) * k); S.rot = rot || 0;
  };
  /* polígono en píxeles nativos -> marco de análisis */
  AZ.tiledPoly = function (S, polyNative, rot) {
    const T = S.tiled, k = T.g / T.mppV;
    const q = polyNative.map(p => [p[0] * k, p[1] * k]);
    return rot ? AZ.rotPts(q, rot, T.w0 * k, T.h0 * k, S.W, S.H) : q;
  };
  /* límite del lote (marco de análisis) -> píxeles nativos del ortomosaico (inverso de tiledPoly) */
  AZ.polyNative = function (S) {
    const T = S.tiled, k = T.g / T.mppV, q = (S.rot || 0) ? AZ.rotPts(S.poly, -(S.rot || 0), S.W, S.H, T.w0 * k, T.h0 * k) : S.poly;
    return q.map(p => [p[0] / k, p[1] / k]);
  };
  AZ.prepareGrid = function (S, gridM) { gridSize(S, gridM); };
  AZ.cellSpec = S => ({ cs: S.cs, W: S.W, H: S.H, mpp_v: S.mpp, theta: S.rot || 0, gw: S.gw, gh: S.gh });
  /* buf: ArrayBuffer del motor ('AZC1', gw, gh, cover_ha, n[u32], sr, sg, sb, sq[f32]) */
  AZ.applyCells = function (S, buf, detailed) {
    const dv = new DataView(buf); if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'AZC1') throw new Error('respuesta del motor inválida');
    const gw = dv.getUint32(4, true), gh = dv.getUint32(8, true), cover = dv.getFloat64(12, true), N = gw * gh;
    if (gw !== S.gw || gh !== S.gh) throw new Error('la grilla del motor no coincide (' + gw + '×' + gh + ' vs ' + S.gw + '×' + S.gh + ')');
    let o = 20; const n = new Uint32Array(buf.slice(o, o + 4 * N)); o += 4 * N;
    const f = () => { const a = new Float32Array(buf.slice(o, o + 4 * N)); o += 4 * N; return a; };
    const sr = f(), sg = f(), sb = f(), sq = f();
    S.detailed = !!detailed;
    finalizeFeats(S, { sr, sg, sb, sq, sn: null, n, cov: cover * 1e4 / (S.mpp * S.mpp) });
    finishPrep(S);
  };

  function feats(S) {
    const { W, H, pix, cs, gw, gh, ndvi } = S, N = gw * gh;
    const sr = new Float32Array(N), sg = new Float32Array(N), sb = new Float32Array(N), sq = new Float32Array(N);
    const sn = ndvi ? new Float32Array(N) : null, n = new Uint32Array(N); let cov = 0;
    for (let y = 0; y < H; y++) {
      const j = Math.min(gh - 1, (y / cs) | 0) * gw;
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4; if (pix[p + 3] === 0) continue;
        const c = j + Math.min(gw - 1, (x / cs) | 0), r = pix[p], g = pix[p + 1], b = pix[p + 2]; cov++;
        sr[c] += r; sg[c] += g; sb[c] += b;
        const l = (r + g + b) / 765; sq[c] += l * l;
        if (sn) sn[c] += ndvi[y * W + x];
        n[c]++;
      }
    }
    finalizeFeats(S, { sr, sg, sb, sq, sn, n, cov });
  }

  function finalizeFeats(S, A) {
    const { gw, gh } = S, N = gw * gh, { sr, sg, sb, sq, sn, n } = A;
    S.covPx = A.cov;
    const tex = S.detailed, D = 5 + (tex ? 1 : 0) + (sn ? 1 : 0); S.D = D;
    const F = new Float32Array(N * D), E = new Float32Array(N), B = new Float32Array(N), Sa = new Float32Array(N);
    const Nd = sn ? new Float32Array(N) : null;
    S.valid = new Uint8Array(N);
    for (let c = 0; c < N; c++) {
      if (!n[c]) continue;
      S.valid[c] = 1;
      const r = sr[c] / n[c], g = sg[c] / n[c], b = sb[c] / n[c], s = r + g + b + 1e-6;
      const rc = r / s, gc = g / s, bc = b / s, exg = 2 * gc - rc - bc, br = s / 765;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sa = (mx - mn) / (mx + 1e-6);
      const k = c * D; let o = 5;
      F[k] = rc; F[k + 1] = gc; F[k + 2] = br; F[k + 3] = sa; F[k + 4] = exg;
      if (tex) { const v = Math.max(0, sq[c] / n[c] - br * br); F[k + o++] = Math.sqrt(v); }
      if (sn) { const v = sn[c] / n[c] / 255; F[k + o++] = v; Nd[c] = v; }
      E[c] = exg; B[c] = br; Sa[c] = sa;
    }
    S.F = F; S.idx = { exg: E, bri: B, sat: Sa };
    if (Nd) S.idx.ndvi = Nd;
  }

  /* relleno de polígono por scanline en espacio de celdas (sin canvas) */
  AZ.calcInside = function (S) {
    const gw = S.gw, gh = S.gh, cs = S.cs, P = S.poly;
    S.inside = new Uint8Array(gw * gh);
    if (P.length < 3) S.inside.fill(1);
    else for (let j = 0; j < gh; j++) {
      const y = (j + 0.5) * cs, xs = [];
      for (let i = 0, k = P.length - 1; i < P.length; k = i++) {
        const a = P[i], b = P[k];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let t = 0; t + 1 < xs.length; t += 2) {
        const i0 = Math.max(0, Math.ceil(xs[t] / cs - 0.5)), i1 = Math.min(gw - 1, Math.floor(xs[t + 1] / cs - 0.5));
        for (let i = i0; i <= i1; i++) S.inside[j * gw + i] = 1;
      }
    }
    if (S.valid) for (let i = 0; i < S.inside.length; i++) if (!S.valid[i]) S.inside[i] = 0;   // sin datos (transparente) = fuera
  };

  AZ.calcLims = function (S) {
    S.lim = {}; const N = S.gw * S.gh, st = Math.max(1, Math.floor(N / 120000));
    for (const k of Object.keys(S.idx)) {
      const a = S.idx[k], v = [];
      for (let i = 0; i < N; i += st) if (S.inside[i] && S.valid[i]) v.push(a[i]);
      v.sort((x, y) => x - y);
      let lo = v.length ? v[(v.length * 0.005) | 0] : 0, hi = v.length ? v[Math.min(v.length - 1, (v.length * 0.995) | 0)] : 1;
      if (hi - lo < 1e-4) hi = lo + 1e-4;
      S.lim[k] = [lo, hi];
    }
  };

  AZ.coverHa = S => (S.covPx || S.W * S.H) * S.mpp * S.mpp / 1e4;

  const cellOf = (S, p) => Math.min(S.gh - 1, Math.max(0, (p.y / S.cs) | 0)) * S.gw + Math.min(S.gw - 1, Math.max(0, (p.x / S.cs) | 0));

  /* Clasificación por distancia a ejemplos: celda afectada si está más cerca de un (+) que de un (−) */
  AZ.detect = function (S, sens, smooth) {
    const P = S.pts.filter(p => p.v > 0), Q = S.pts.filter(p => p.v < 0);
    if (!P.length) return -1;
    const N = S.gw * S.gh, D = S.D, F = S.F, mu = new Float64Array(D), sd = new Float64Array(D);
    let n = 0; const st = Math.max(1, Math.floor(N / 200000));
    for (let c = 0; c < N; c += st) if (S.inside[c] && S.valid[c]) { n++; for (let k = 0; k < D; k++) mu[k] += F[c * D + k]; }
    for (let k = 0; k < D; k++) mu[k] /= Math.max(1, n);
    for (let c = 0; c < N; c += st) if (S.inside[c] && S.valid[c]) for (let k = 0; k < D; k++) { const e = F[c * D + k] - mu[k]; sd[k] += e * e; }
    for (let k = 0; k < D; k++) sd[k] = Math.sqrt(sd[k] / Math.max(1, n)) + 1e-6;
    const vec = c => { const v = new Float64Array(D); for (let k = 0; k < D; k++) v[k] = (F[c * D + k] - mu[k]) / sd[k]; return v; };
    const sp = P.map(p => vec(cellOf(S, p))), sn = Q.map(p => vec(cellOf(S, p)));
    const k = 0.5 + (sens / 100) * 0.9, dn0 = 1.5, out = new Uint8Array(N), v = new Float64Array(D);
    for (let c = 0; c < N; c++) {
      if (!S.inside[c] || !S.valid[c]) continue;
      for (let q = 0; q < D; q++) v[q] = (F[c * D + q] - mu[q]) / sd[q];
      let dp = 1e9; for (const a of sp) { let t = 0; for (let q = 0; q < D; q++) { const e = v[q] - a[q]; t += e * e; } if (t < dp) dp = t; }
      let dn = sn.length ? 1e9 : dn0 * dn0; for (const a of sn) { let t = 0; for (let q = 0; q < D; q++) { const e = v[q] - a[q]; t += e * e; } if (t < dn) dn = t; }
      out[c] = Math.sqrt(dp) < k * Math.sqrt(dn) ? 1 : 0;
    }
    if (smooth) {
      const o2 = new Uint8Array(N), { gw, gh } = S;
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        let t = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const x = i + a, y = j + b; if (x >= 0 && y >= 0 && x < gw && y < gh) t += out[y * gw + x]; }
        o2[j * gw + i] = t >= 5 && S.inside[j * gw + i] ? 1 : 0;
      }
      S.auto = o2;
    } else S.auto = out;
    AZ.mergeDet(S);
    return AZ.count(S.det);
  };

  function dtf(m, gw, gh) {
    const INF = 60000, d = new Uint16Array(m.length);
    for (let i = 0; i < m.length; i++) d[i] = m[i] ? 0 : INF;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x; let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) { v = Math.min(v, d[i - gw] + 3); if (x > 0) v = Math.min(v, d[i - gw - 1] + 4); if (x < gw - 1) v = Math.min(v, d[i - gw + 1] + 4); }
      d[i] = v;
    }
    for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x; let v = d[i];
      if (x < gw - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < gh - 1) { v = Math.min(v, d[i + gw] + 3); if (x < gw - 1) v = Math.min(v, d[i + gw + 1] + 4); if (x > 0) v = Math.min(v, d[i + gw - 1] + 4); }
      d[i] = v;
    }
    return d;
  }

  AZ._dtf = dtf;

  /* ---- plano tangente local ENU exacto (WGS84): mismo cálculo que el motor, para que lo medido en el mapa coincida con el terreno ---- */
  const WA = 6378137, WE2 = (1 / 298.257223563) * (2 - 1 / 298.257223563), RAD = Math.PI / 180;
  const ecef = (lat, lon) => { const p = lat * RAD, l = lon * RAD, sp = Math.sin(p), N = WA / Math.sqrt(1 - WE2 * sp * sp); return [N * Math.cos(p) * Math.cos(l), N * Math.cos(p) * Math.sin(l), N * (1 - WE2) * sp]; };
  const basis = (lat0, lon0) => { const p = lat0 * RAD, l = lon0 * RAD; return { o: ecef(lat0, lon0), x: [-Math.sin(l), Math.cos(l), 0], y: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)], z: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)] }; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  AZ.geoToEnu = function (lat0, lon0, lat, lon) { const B = basis(lat0, lon0), q = ecef(lat, lon), d = [q[0] - B.o[0], q[1] - B.o[1], q[2] - B.o[2]]; return [dot(d, B.x), dot(d, B.y)]; };
  AZ.enuToGeo = function (lat0, lon0, e, n) {
    const B = basis(lat0, lon0), u = -(e * e + n * n) / (2 * 6371000);
    const x = B.o[0] + e * B.x[0] + n * B.y[0] + u * B.z[0], y = B.o[1] + e * B.x[1] + n * B.y[1] + u * B.z[1], z = B.o[2] + e * B.x[2] + n * B.y[2] + u * B.z[2];
    const lon = Math.atan2(y, x), p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - WE2));
    for (let i = 0; i < 6; i++) { const sp = Math.sin(lat), N = WA / Math.sqrt(1 - WE2 * sp * sp); lat = Math.atan2(z + WE2 * N * sp, p); }
    return { lat: lat / RAD, lon: lon / RAD };
  };
  /* píxel del análisis -> lat/lon (deshace la rotación de la grilla; mosaico norte-arriba centrado en S.geo).
     Con S.geo.exact el mosaico está en el plano tangente (lat0,lon0) del motor y el centro del mosaico es (cE,cN) en ese plano. */
  AZ.pxToGeo = function (S, x, y) {
    const th = (S.rot || 0) * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th), dx = x - S.W / 2, dy = y - S.H / 2;
    const xo = dx * c - dy * sn, yo = dx * sn + dy * c, g = S.geo;
    if (g.exact) return AZ.enuToGeo(g.lat0, g.lon0, g.cE + xo * S.mpp, g.cN - yo * S.mpp);
    const m = AZ.mPerDeg(g.lat);
    return { lat: g.lat - (yo * S.mpp) / m.ky, lon: g.lon + (xo * S.mpp) / m.kx };
  };
  /* lat/lon -> píxel del análisis (inverso de pxToGeo) */
  AZ.geoToPx = function (S, lat, lon) {
    const th = (S.rot || 0) * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th), g = S.geo; let xo, yo;
    if (g.exact) { const q = AZ.geoToEnu(g.lat0, g.lon0, lat, lon); xo = (q[0] - g.cE) / S.mpp; yo = (g.cN - q[1]) / S.mpp; }
    else { const m = AZ.mPerDeg(g.lat); xo = (lon - g.lon) * m.kx / S.mpp; yo = (g.lat - lat) * m.ky / S.mpp; }
    return [xo * c + yo * sn + S.W / 2, -xo * sn + yo * c + S.H / 2];
  };
  /* puntos del mosaico original -> imagen rotada (rot° en sentido antihorario para alinear la grilla) */
  AZ.rotPts = function (pts, deg, w0, h0, w1, h1) {
    const th = deg * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
    return pts.map(p => { const dx = p[0] - w0 / 2, dy = p[1] - h0 / 2; return [w1 / 2 + dx * c + dy * sn, h1 / 2 - dx * sn + dy * c]; });
  };

  /* Lote sintético de demostración (devuelve píxeles RGBA; la UI arma el canvas) */
  AZ.demoPixels = function () {
    const W = 1800, H = 1100, d = new Uint8ClampedArray(W * H * 4);
    let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const poly = [[110, 100], [1700, 70], [1745, 1015], [85, 1030]];
    const salt = [[420, 330, 95, 1], [1130, 640, 150, 1], [800, 880, 70, 1], [1500, 260, 60, 1], [300, 780, 55, 1], [980, 300, 80, 0.35], [560, 560, 70, 0.3]];
    const weed = [[1420, 820, 75, 1], [650, 200, 55, 1]];
    const ph = []; for (let i = 0; i < 12; i++) ph.push(rnd() * 6.28);
    const blob = (x, y, b, w) => {
      const dx = x - b[0], dy = y - b[1]; if (Math.abs(dx) > b[2] * 1.6 || Math.abs(dy) > b[2] * 1.6) return 0;
      const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx), rr = b[2] * (1 + 0.28 * Math.sin(3 * a + w) + 0.15 * Math.sin(5 * a + 2 * w)), t = r / rr;
      return b[3] * (t >= 1.25 ? 0 : t <= 0.8 ? 1 : 1 - (t - 0.8) / 0.45);
    };
    const inP = (x, y) => { let o = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) o = !o; } return o; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4; let r, g, b;
      if (!inP(x, y)) { const n = rnd() * 22; r = 100 + n; g = 84 + n; b = 60 + n; }
      else {
        const row = ((x / 7) | 0) % 2, n = rnd() * 16; r = 52 + row * 8 + n * 0.5; g = 118 + row * 12 + n; b = 44 + row * 5 + n * 0.4;
        let fs = 0, fw = 0;
        for (let i = 0; i < salt.length; i++) fs = Math.max(fs, blob(x, y, salt[i], ph[i]));
        for (let i = 0; i < weed.length; i++) fw = Math.max(fw, blob(x, y, weed[i], ph[8 + i]));
        if (fs > 0) { const k = fs * (rnd() < 0.1 ? 0.5 : 0.92); r += (214 - r) * k; g += (205 - g) * k; b += (184 - b) * k; }
        if (fw > 0) { const k = fw * 0.85; r += (150 - r) * k; g += (196 - g) * k; b += (52 - b) * k; }
      }
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
    }
    return { W, H, data: d, mpp: 0.977, poly };
  };
})(typeof window !== 'undefined' ? window : globalThis);
