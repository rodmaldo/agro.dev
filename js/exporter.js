/* agro.dev · exportación: mapa de prescripción (shapefile para John Deere GEN5 / Operations Center),
   GeoJSON, cálculo de consumos y ahorro, e informe imprimible (PDF). Sin DOM; solo bytes y texto. */
(function (root) {
  'use strict';
  const AZ = root.AZ, X = {};
  AZ.X = X;
  /* Límites de lote desde KML o GeoJSON (monitor del pulverizador/tractor/sembradora): devuelve anillos [[lon,lat],...] */
  X.parseBoundary = function (text) {
    const rings = [];
    const clean = r => { const o = r.filter(p => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90); if (o.length > 1 && o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1]) o.pop(); return o; };
    const add = r => { const c = clean(r); if (c.length >= 3) rings.push(c); };
    const t = String(text || '').trim();
    if (t[0] === '{' || t[0] === '[') {
      let j; try { j = JSON.parse(t); } catch (e) { return rings; }
      const geom = g => {
        if (!g) return;
        if (g.type === 'Polygon') add(g.coordinates[0] || []);
        else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => add(p[0] || []));
        else if (g.type === 'LineString') add(g.coordinates);
        else if (g.type === 'GeometryCollection') (g.geometries || []).forEach(geom);
        else if (g.type === 'Feature') geom(g.geometry);
        else if (g.type === 'FeatureCollection') (g.features || []).forEach(geom);
      };
      geom(j); return rings;
    }
    const re = /<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi; let m;
    while ((m = re.exec(t))) {
      add(m[1].trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(a => a.length >= 2));
    }
    return rings;
  };

  X.MACHINES = [
    { id: 'jd-gen5', name: 'John Deere · Display GEN5 (4600) · pulverizadoras 4730 / 4040M', note: 'Shapefile en carpeta Rx del USB (.shp .shx .dbf .prj).' },
    { id: 'jd-gen4', name: 'John Deere · Display GEN4 (4240 / 4640) · pulverizadoras 4730 / 4040M', note: 'Shapefile en carpeta Rx del USB (.shp .shx .dbf .prj).' }
  ];
  X.MODES = {
    apl: { name: 'Aplicación (pulverizadora)', unit: 'L/ha', prod: 'Producto', field: 'RATE' },
    fer: { name: 'Fertilización', unit: 'kg/ha', prod: 'Fertilizante', field: 'RATE' },
    sie: { name: 'Siembra', unit: 'semillas/ha', prod: 'Semilla', field: 'RATE' }
  };

  /* Dosis por celda. Infértil y búfer = 0. Con Ambientación activa, cada nivel lleva su dosis (L/ha); sin ella, el fértil recibe la dosis única.
     cls: 0 = fuera del lote · 1 = INFERTIL · 2 = BUFFER · 3 = FERTIL (dosis única) · 4.. = NIVEL 1..n de la ambientación (hasta 8 niveles) */
  X.cellRates = function (S, o) {
    const n = S.gw * S.gh, U = AZ.union(S), b = S.meta.buf, A = S.amb && S.amb.inc && S.amb.cls ? S.amb : null, dose = +o.dose || 0;
    const rate = new Float32Array(n), cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!S.inside[i]) continue;
      if (U[i]) cls[i] = 1;
      else if (b.on && b.inc && S.buf[i]) cls[i] = 2;
      else if (A && A.cls[i] < 255) { cls[i] = 4 + A.cls[i]; rate[i] = Math.max(0, +A.rates[A.cls[i]] || 0); }
      else { cls[i] = 3; rate[i] = dose; }
    }
    return { rate, cls, amb: !!A };
  };
  X.CLASS_NAME = ['', 'INFERTIL', 'BUFFER', 'FERTIL', 'NIVEL 1', 'NIVEL 2', 'NIVEL 3', 'NIVEL 4', 'NIVEL 5', 'NIVEL 6', 'NIVEL 7', 'NIVEL 8'];

  /* Regiones: polígonos con huecos (un anillo exterior en sentido horario + huecos antihorarios) de las celdas marcadas en m.
     Mucho menos polígonos que un rectángulo por corrida: el display JD carga más rápido y es más estable. Coordenadas en vértices de grilla (i, j). */
  X.regions = function (m, gw, gh) {
    const W1 = gw + 1, out = new Uint8Array(W1 * (gh + 1) * 4), has = (i, j) => i >= 0 && j >= 0 && i < gw && j < gh && m[j * gw + i] === 1;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      if (!m[j * gw + i]) continue;
      if (!has(i, j - 1)) out[(j * W1 + i) * 4] = 1;               // arriba, hacia el este
      if (!has(i + 1, j)) out[(j * W1 + i + 1) * 4 + 1] = 1;       // derecha, hacia el sur
      if (!has(i, j + 1)) out[((j + 1) * W1 + i + 1) * 4 + 2] = 1; // abajo, hacia el oeste
      if (!has(i - 1, j)) out[((j + 1) * W1 + i) * 4 + 3] = 1;     // izquierda, hacia el norte
    }
    // componentes conexas (4 vecinos)
    const lab = new Int32Array(gw * gh); let nl = 0; const st = [];
    for (let k = 0; k < gw * gh; k++) {
      if (!m[k] || lab[k]) continue; lab[k] = ++nl; st.push(k);
      while (st.length) { const q = st.pop(), x = q % gw, y = (q / gw) | 0;
        if (x > 0 && m[q - 1] && !lab[q - 1]) { lab[q - 1] = nl; st.push(q - 1); } if (x < gw - 1 && m[q + 1] && !lab[q + 1]) { lab[q + 1] = nl; st.push(q + 1); }
        if (y > 0 && m[q - gw] && !lab[q - gw]) { lab[q - gw] = nl; st.push(q - gw); } if (y < gh - 1 && m[q + gw] && !lab[q + gw]) { lab[q + gw] = nl; st.push(q + gw); } }
    }
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1], regs = new Map();
    for (let v = 0; v < out.length; v += 4) for (let d0 = 0; d0 < 4; d0++) {
      if (!out[v + d0]) continue;
      const x0 = (v / 4) % W1, y0 = ((v / 4) / W1) | 0, ring = [];
      let x = x0, y = y0, d = d0, first = true, area = 0;
      for (;;) {
        const vi = (y * W1 + x) * 4;
        if (!first && x === x0 && y === y0 && d === d0) break;
        out[vi + d] = 0; first = false;
        const nx = x + DX[d], ny = y + DY[d], nv = (ny * W1 + nx) * 4;
        let nd = -1; for (const t of [(d + 1) & 3, d, (d + 3) & 3]) if (out[nv + t] || (nx === x0 && ny === y0 && t === d0)) { nd = t; break; }
        if (nd < 0) break;
        if (nd !== d) ring.push([nx, ny]);
        area += x * ny - nx * y; x = nx; y = ny; d = nd;
        if (x === x0 && y === y0 && d === d0) break;
      }
      if (ring.length < 3) continue;
      // celda que queda a la derecha de la primera arista = componente del anillo
      const cx = d0 === 0 ? x0 : d0 === 1 ? x0 - 1 : d0 === 2 ? x0 - 1 : x0, cy = d0 === 0 ? y0 : d0 === 1 ? y0 : d0 === 2 ? y0 - 1 : y0 - 1, L = lab[cy * gw + cx];
      let r = regs.get(L); if (!r) { r = { rings: [], cells: 0 }; regs.set(L, r); }
      area /= 2; r.rings.push({ pts: ring, a: area }); r.cells += area;
    }
    return [...regs.values()].map(r => { r.rings.sort((p, q) => q.a - p.a); return { rings: r.rings.map(q => q.pts), cells: r.rings.reduce((t, q) => t + q.a, 0) }; });
  };

  /* vértices de grilla -> [lon, lat] (con la rotación y georreferencia del mosaico) */
  X.geoRing = function (S, ring) {
    const cs = S.cs, o = ring.map(p => { const g = AZ.pxToGeo(S, p[0] * cs, p[1] * cs); return [g.lon, g.lat]; });
    o.push(o[0]); return o;
  };

  /* lista de polígonos a exportar: {clase, nivel, rate, ha, rings:[[lon,lat]…]} */
  X.prescription = function (S, o) {
    const R = X.cellRates(S, o), n = S.gw * S.gh, ch = AZ.cellHa(S), items = [], A = R.amb ? S.amb : null;
    const groups = new Map();
    for (let i = 0; i < n; i++) { const c = R.cls[i]; if (!c) continue; let g = groups.get(c); if (!g) { g = new Uint8Array(n); groups.set(c, g); } g[i] = 1; }
    for (const [c, m] of groups) {
      const rate = c >= 4 ? Math.max(0, +A.rates[c - 4] || 0) : c === 3 ? (+o.dose || 0) : 0;
      if (o.omitZero && rate === 0) continue;
      for (const r of X.regions(m, S.gw, S.gh)) items.push({ clase: X.CLASS_NAME[c], nivel: c >= 4 ? c - 3 : 0, rate, ha: r.cells * ch, rings: r.rings.map(q => X.geoRing(S, q)) });
    }
    return items;
  };

  /* ---------- Shapefile ---------- */
  const enc = s => new TextEncoder().encode(s);
  /* Shapefile de polígonos (tipo 5): cada registro tiene uno o más anillos (exterior horario, huecos antihorarios) */
  function shapefile(items) {
    const recs = items.map(it => ({ parts: it.rings, np: it.rings.reduce((a, r) => a + r.length, 0) }));
    const lens = recs.map(r => 8 + 44 + 4 * r.parts.length + 16 * r.np), shpLen = 100 + lens.reduce((a, b) => a + b, 0), shxLen = 100 + recs.length * 8;
    const shp = new DataView(new ArrayBuffer(shpLen)), shx = new DataView(new ArrayBuffer(shxLen));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    items.forEach(it => it.rings.forEach(r => r.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); })));
    if (!recs.length) { x0 = y0 = x1 = y1 = 0; }
    const head = (v, len) => { v.setInt32(0, 9994); v.setInt32(24, len / 2); v.setInt32(28, 1000, true); v.setInt32(32, 5, true); [x0, y0, x1, y1].forEach((q, k) => v.setFloat64(36 + k * 8, q, true)); };
    head(shp, shpLen); head(shx, shxLen);
    let o = 100;
    recs.forEach((r, k) => {
      const all = r.parts.flat(), xs = all.map(p => p[0]), ys = all.map(p => p[1]), cl = lens[k] - 8;
      shp.setInt32(o, k + 1); shp.setInt32(o + 4, cl / 2); shp.setInt32(o + 8, 5, true);
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity; for (let q = 0; q < xs.length; q++) { mnx = Math.min(mnx, xs[q]); mxx = Math.max(mxx, xs[q]); mny = Math.min(mny, ys[q]); mxy = Math.max(mxy, ys[q]); }
      [mnx, mny, mxx, mxy].forEach((q, m) => shp.setFloat64(o + 12 + m * 8, q, true));
      shp.setInt32(o + 44, r.parts.length, true); shp.setInt32(o + 48, r.np, true);
      let idx = 0; r.parts.forEach((p, m) => { shp.setInt32(o + 52 + 4 * m, idx, true); idx += p.length; });
      let po = o + 52 + 4 * r.parts.length; all.forEach(p => { shp.setFloat64(po, p[0], true); shp.setFloat64(po + 8, p[1], true); po += 16; });
      shx.setInt32(100 + k * 8, o / 2); shx.setInt32(104 + k * 8, cl / 2); o += lens[k];
    });
    return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer) };
  }
  X._shapefile = shapefile;

  /* dBASE III: ID(N10) CLASE(C12) NIVEL(N3) RATE(N12.3) AREA_HA(N12.4). El display JD pide elegir la columna de dosis: es RATE. */
  function dbf(items) {
    const F = [['ID', 'N', 10, 0], ['CLASE', 'C', 12, 0], ['NIVEL', 'N', 3, 0], ['RATE', 'N', 12, 3], ['AREA_HA', 'N', 12, 4]];
    const rl = 1 + F.reduce((a, f) => a + f[2], 0), hl = 32 + F.length * 32 + 1, buf = new Uint8Array(hl + items.length * rl + 1), v = new DataView(buf.buffer);
    const d = new Date(); buf[0] = 3; buf[1] = d.getFullYear() - 1900; buf[2] = d.getMonth() + 1; buf[3] = d.getDate();
    v.setUint32(4, items.length, true); v.setUint16(8, hl, true); v.setUint16(10, rl, true);
    F.forEach((f, k) => { const o = 32 + k * 32; buf.set(enc(f[0]), o); buf[o + 11] = f[1].charCodeAt(0); buf[o + 16] = f[2]; buf[o + 17] = f[3]; });
    buf[32 + F.length * 32] = 13;
    const put = (o, s, w, right) => { s = String(s).slice(0, w); const pad = ' '.repeat(w - s.length); buf.set(enc(right ? pad + s : s + pad), o); };
    items.forEach((it, k) => {
      let o = hl + k * rl; buf[o++] = 32;
      put(o, k + 1, 10, true); o += 10; put(o, it.clase, 12, false); o += 12; put(o, it.nivel || 0, 3, true); o += 3;
      put(o, it.rate.toFixed(3), 12, true); o += 12; put(o, it.ha.toFixed(4), 12, true);
    });
    buf[buf.length - 1] = 26;
    return buf;
  }
  X._dbf = dbf;
  X.PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

  /* ---------- ZIP (sin compresión) ---------- */
  let CRC = null;
  function crc32(b) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
  }
  X.zip = function (files) {
    const parts = [], cen = []; let off = 0;
    files.forEach(f => {
      const nm = enc(f.name), data = f.data instanceof Uint8Array ? f.data : enc(f.data), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(h.buffer), nm, data);
      const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
      cen.push(new Uint8Array(c.buffer), nm);
      off += 30 + nm.length + data.length;
    });
    const csz = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csz, true); e.setUint32(16, off, true);
    const all = [...parts, ...cen, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0;
    all.forEach(b => { out.set(b, p); p += b.length; });
    return out;
  };

  const slug = s => (s || 'lote').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'lote';

  /* ---------- consumos y ahorro ---------- */
  X.consumption = function (S, o) {
    const st = AZ.stats(S), dose = +o.dose || 0, price = +o.price || 0, R = X.cellRates(S, o), ch = AZ.cellHa(S);
    let used = 0, treat = 0; for (let i = 0; i < R.rate.length; i++) if (R.cls[i] && R.rate[i] > 0) { used += R.rate[i] * ch; treat += ch; }
    const base = st.lote * dose, save = base - used;
    return {
      st, dose, unit: o.unit || (X.MODES[o.mode] || X.MODES.apl).unit, loteHa: st.lote, treatHa: treat, skipHa: st.lote - treat, amb: R.amb,
      base, used, save, savePct: base ? save / base * 100 : 0, avg: st.lote ? used / st.lote : 0, price, money: save * price
    };
  };

  /* ---------- paquete de prescripción ---------- */
  X.prescriptionZip = function (S, o) {
    const items = X.prescription(S, o), sh = shapefile(items), nm = slug(o.field) + '_Rx', c = X.consumption(S, o), mode = X.MODES[o.mode] || X.MODES.apl, A = c.amb ? S.amb : null;
    const rows = [];
    if (A) A.rates.forEach((r, k) => rows.push('  Nivel ' + (k + 1) + ' (' + A.colors[k] + '): ' + (+r || 0).toFixed(1) + ' ' + c.unit));
    const txt = [
      'agro.dev · Mapa de prescripción para John Deere', '',
      'Lote: ' + (o.field || '-'), 'Equipo: ' + (o.machine || X.MACHINES[0].name), 'Operación: ' + mode.name, 'Unidad de la dosis (columna RATE): ' + c.unit,
      A ? 'Dosis por nivel de Ambientación (' + A.name + '):' : 'Dosis única en zona fértil: ' + c.dose + ' ' + c.unit, ...rows,
      'Infértil (' + S.meta.det.name + ')' + (S.meta.buf.on && S.meta.buf.inc ? ' y búfer' : '') + ': 0 ' + c.unit + (o.omitZero ? ' (sin polígono: no se aplica)' : ''),
      'Superficie a tratar: ' + c.treatHa.toFixed(1) + ' ha de ' + c.loteHa.toFixed(1) + ' ha · volumen ' + c.used.toFixed(0) + ' ' + c.unit.split('/')[0] + ' · ahorro ' + c.save.toFixed(0) + ' ' + c.unit.split('/')[0] + ' (' + c.savePct.toFixed(1) + ' %)',
      'Polígonos: ' + items.length, 'Sistema de coordenadas: WGS84 sin proyectar (EPSG:4326), como piden los displays GreenStar / Gen4 / Gen5.', '',
      'CÓMO CARGARLO (Gen4 y Gen5)',
      '1. Descomprimí este .zip en la RAÍZ de un pendrive (formato FAT32): tiene que quedar la carpeta "Rx" con ' + nm + '.shp / .shx / .dbf / .prj adentro.',
      '   La carpeta se llama exactamente Rx, sin otra carpeta alrededor.',
      '2. Insertá el pendrive en el display. Si aparece el aviso, tocá "Importar datos"; si no: Menú > Sistema (Administrador de archivos / Data Manager) > Importar desde USB.',
      '3. Elegí los archivos y en "Tipo de datos" seleccioná "Prescripción Rx". Importar.',
      '4. En Configuración de trabajo / Aplicaciones: confirmá Cliente, Establecimiento, Lote y Equipo. En el producto (líquido) tocá "Dosis objetivo / Rx" y elegí ' + nm + '.',
      '5. En "Columna de dosis" elegí RATE y en "Unidades de la columna" ' + c.unit + '. Completá "Dosis sin GPS" y la dosis fuera del mapa (se sugiere ' + (A ? 'la del nivel fértil de mayor superficie' : c.dose + ' ' + c.unit) + ') y el "Look-ahead" según tu pulverizador.',
      '6. En la pantalla de aplicación, cambiá el control de dosis de "Predefinida" a "Basada en mapa".',
      'Alternativa: subí el .shp (con sus .shx .dbf .prj) a John Deere Operations Center > Archivos y enviá la prescripción a la máquina por Wireless Data Transfer.', '',
      'IMPORTANTE: validá el mapa con una prueba de campo antes de aplicar (comprobá que la dosis del display cambia al cruzar cada zona y que las zonas con dosis 0 cortan las secciones).',
      'Respetá el rango de dosis de tus picos y la velocidad de trabajo: el controlador no puede entregar dosis fuera de ese rango.'
    ].join('\r\n');
    const bytes = X.zip([{ name: 'Rx/' + nm + '.shp', data: sh.shp }, { name: 'Rx/' + nm + '.shx', data: sh.shx }, { name: 'Rx/' + nm + '.dbf', data: dbf(items) }, { name: 'Rx/' + nm + '.prj', data: X.PRJ }, { name: 'LEEME_John_Deere.txt', data: txt }]);
    return { bytes, name: nm + '.zip', n: items.length };
  };

  X.geojson = function (S, o) {
    const items = X.prescription(S, o);
    return { type: 'FeatureCollection', features: items.map((it, k) => ({ type: 'Feature', properties: { ID: k + 1, CLASE: it.clase, NIVEL: it.nivel, RATE: it.rate, AREA_HA: +it.ha.toFixed(4) }, geometry: { type: 'Polygon', coordinates: it.rings } })) };
  };

  /* ---------- informe (HTML imprimible → "Guardar como PDF") ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n, d) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: d == null ? 1 : d, maximumFractionDigits: d == null ? 1 : d });
  X.reportHtml = function (S, o) {
    const c = X.consumption(S, o), st = c.st, mode = X.MODES[o.mode] || X.MODES.apl, det = S.meta.det.name, pi = st.lote ? st.inf / st.lote * 100 : 0, pf = 100 - pi, pb = st.lote ? st.buf / st.lote * 100 : 0;
    const row = (a, b, d) => '<tr><td>' + a + '</td><td class="n">' + b + '</td><td class="n">' + (d || '') + '</td></tr>';
    const layers = [row(esc(det) + ' (IA)', fmt(st.per.det) + ' ha', fmt(st.lote ? st.per.det / st.lote * 100 : 0) + ' %')];
    if (S.man) layers.push(row(esc(S.meta.man.name), fmt(st.per.man) + ' ha', ''));
    S.hl.forEach(l => layers.push(row(esc(l.name), fmt(st.per[l.id]) + ' ha', '')));
    const d = new Date().toLocaleDateString('es-AR');
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe ' + esc(o.field) + '</title><style>' +
      '@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:13px/1.45 "Articulat CF","Segoe UI",Arial,sans-serif;color:#111;margin:0}' +
      'h1{font-size:22px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #111;padding-bottom:4px;margin:22px 0 8px}' +
      '.h{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #111;padding-bottom:8px}.m{color:#555;font-size:12px}' +
      'table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:5px 6px;text-align:left}.n{text-align:right;font-variant-numeric:tabular-nums}' +
      '.k{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.k div{border:1px solid #111;padding:8px}.k b{display:block;font-size:20px}.k span{font-size:11px;color:#555;text-transform:uppercase}' +
      '.bar{display:flex;height:16px;border:1px solid #111;margin:8px 0}.bar i{display:block}img{max-width:100%;border:1px solid #111}.f{margin-top:24px;font-size:11px;color:#666}' +
      '</style></head><body><div class="h"><div><h1>agro.dev · Informe de zonificación</h1><div class="m">Lote: <b>' + esc(o.field) + '</b> · ' + d + '</div></div><div class="m">v' + esc(o.version || '') + '</div></div>' +
      '<h2>Resumen del lote</h2><div class="k"><div><span>Superficie relevada</span><b>' + fmt(st.tot) + ' ha</b></div><div><span>Lote delimitado</span><b>' + fmt(st.lote) + ' ha</b></div>' +
      '<div><span>Fértil</span><b>' + fmt(st.fer) + ' ha</b>' + fmt(pf) + ' %</div><div><span>Infértil (' + esc(det) + ')</span><b>' + fmt(st.inf) + ' ha</b>' + fmt(pi) + ' %</div></div>' +
      '<div class="bar"><i style="width:' + pf.toFixed(2) + '%;background:#009E73"></i><i style="width:' + pi.toFixed(2) + '%;background:' + esc(S.meta.det.color) + '"></i></div>' +
      (o.img ? '<h2>Mapa</h2><img src="' + o.img + '" alt="mapa">' : '') +
      '<h2>Capas de detección</h2><table><tr><th>Capa</th><th class="n">Superficie</th><th class="n">% del lote</th></tr>' + layers.join('') + '</table>' +
      '<h2>Promedios</h2><table><tr><th>Zona</th><th class="n">Superficie</th><th class="n">% del lote</th><th class="n">Índice medio (' + (st.idxKey === 'ndvi' ? 'NDVI' : 'ExG') + ')</th></tr>' +
      row('Fértil', fmt(st.fer) + ' ha', fmt(pf) + ' %').replace('</tr>', '<td class="n">' + fmt(st.avgFer, 3) + '</td></tr>') +
      row('Infértil', fmt(st.inf) + ' ha', fmt(pi) + ' %').replace('</tr>', '<td class="n">' + fmt(st.avgInf, 3) + '</td></tr>') +
      (S.meta.buf.on ? row('Buffer (' + fmt(S.meta.buf.m, 1) + ' m)', fmt(st.buf) + ' ha', fmt(pb) + ' %').replace('</tr>', '<td class="n">-</td></tr>') : '') + '</table>' +
      '<h2>Prescripción y consumo</h2><table>' +
      row('Máquina', esc(o.machine || X.MACHINES[0].name)) + row('Operación', mode.name) + row('Dosis', fmt(c.dose, 1) + ' ' + c.unit) +
      row('Superficie a tratar', fmt(c.treatHa) + ' ha') + row('Superficie omitida (infértil + buffer)', fmt(c.skipHa) + ' ha') +
      row('Consumo aplicando a todo el lote', fmt(c.base, 0) + ' ' + c.unit.split('/')[0]) + row('Consumo con prescripción', fmt(c.used, 0) + ' ' + c.unit.split('/')[0]) +
      row('<b>Ahorro</b>', '<b>' + fmt(c.save, 0) + ' ' + c.unit.split('/')[0] + '</b>', '<b>' + fmt(c.savePct) + ' %</b>') +
      row('Dosis media sobre el lote', fmt(c.avg, 2) + ' ' + c.unit) +
      (+o.yld ? row('Rinde potencial', fmt(+o.yld, 0) + ' kg/ha') + row('Pérdida estimada por ' + esc(det), '<b>' + fmt(st.inf * (+o.yld) / 1000, 1) + ' t</b>', fmt(pi) + ' %') : '') + (c.price ? row('Ahorro económico estimado', '$ ' + fmt(c.money, 0)) : '') + '</table>' +
      '<div class="f">Generado por agro.dev. Las superficies provienen de una grilla de ' + fmt(AZ.cellM(S), 2) + ' m; el resultado depende de la calidad del relevamiento y de los puntos de entrenamiento. Validar en campo antes de la aplicación.</div>' +
      '</body></html>';
  };
})(typeof window !== 'undefined' ? window : globalThis);
