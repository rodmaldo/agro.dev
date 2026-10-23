/* agro.dev · exportación: mapa de prescripción (shapefile para John Deere GEN5 / Operations Center),
   GeoJSON, cálculo de consumos y ahorro, e informe imprimible (PDF). Sin DOM; solo bytes y texto. */
(function (root) {
  'use strict';
  const AZ = root.AZ, X = {};
  AZ.X = X;

  X.MACHINES = [
    { id: 'jd-gen5', name: 'John Deere · Display GEN5 (Command Center / 4600)', note: 'Shapefile (.shp/.shx/.dbf/.prj). Importar con USB o desde Operations Center.' }
  ];
  X.MODES = {
    apl: { name: 'Aplicación (pulverizadora)', unit: 'L/ha', prod: 'Producto', field: 'RATE' },
    fer: { name: 'Fertilización', unit: 'kg/ha', prod: 'Fertilizante', field: 'RATE' },
    sie: { name: 'Siembra', unit: 'semillas/ha', prod: 'Semilla', field: 'RATE' }
  };

  /* clases del mapa de prescripción: FERTIL recibe la dosis; INFERTIL y BUFFER = 0 */
  X.classMasks = function (S) {
    const n = S.gw * S.gh, U = AZ.union(S), b = S.meta.buf, fer = new Uint8Array(n), inf = new Uint8Array(n), buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!S.inside[i]) continue;
      if (U[i]) inf[i] = 1;
      else if (b.on && b.inc && S.buf[i]) buf[i] = 1;
      else fer[i] = 1;
    }
    return { fer, inf, buf };
  };

  /* rectángulos [i0,j0,i1,j1) (celdas): corridas por fila fusionadas verticalmente */
  X.rects = function (m, gw, gh) {
    const out = []; let open = new Map();
    for (let j = 0; j <= gh; j++) {
      const cur = new Map();
      if (j < gh) for (let i = 0; i < gw;) {
        if (!m[j * gw + i]) { i++; continue; }
        let e = i; while (e < gw && m[j * gw + e]) e++;
        const key = i + ':' + e, r = open.get(key);
        if (r) { r[3] = j + 1; cur.set(key, r); open.delete(key); }
        else { const nr = [i, j, e, j + 1]; out.push(nr); cur.set(key, nr); }
        i = e;
      }
      open = cur;
    }
    return out;
  };

  /* esquinas (sentido horario, Este-Norte) de un rectángulo de celdas */
  X.corners = function (S, r) {
    const cs = S.cs, p = (i, j) => { const g = AZ.pxToGeo(S, i * cs, j * cs); return [g.lon, g.lat]; };
    const a = p(r[0], r[1]), b = p(r[2], r[1]), c = p(r[2], r[3]), d = p(r[0], r[3]);
    return [a, b, c, d, a];
  };

  X.prescription = function (S, o) {
    const cm = X.classMasks(S), ch = AZ.cellHa(S), dose = +o.dose || 0, items = [];
    const add = (mask, clase, rate) => X.rects(mask, S.gw, S.gh).forEach(r => items.push({ ring: X.corners(S, r), clase, rate, ha: (r[2] - r[0]) * (r[3] - r[1]) * ch }));
    add(cm.fer, 'FERTIL', dose);
    add(cm.inf, 'INFERTIL', 0);
    if (S.meta.buf.on && S.meta.buf.inc) add(cm.buf, 'BUFFER', 0);
    return items;
  };

  /* ---------- Shapefile ---------- */
  const enc = s => new TextEncoder().encode(s);
  function shapefile(items) {
    const nrec = items.length, recLen = 8 + 128, shpLen = 100 + nrec * recLen, shxLen = 100 + nrec * 8;
    const shp = new DataView(new ArrayBuffer(shpLen)), shx = new DataView(new ArrayBuffer(shxLen));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    items.forEach(it => it.ring.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }));
    if (!nrec) { x0 = y0 = x1 = y1 = 0; }
    const head = (v, len) => {
      v.setInt32(0, 9994); v.setInt32(24, len / 2); v.setInt32(28, 1000, true); v.setInt32(32, 5, true);
      [x0, y0, x1, y1].forEach((q, k) => v.setFloat64(36 + k * 8, q, true));
    };
    head(shp, shpLen); head(shx, shxLen);
    items.forEach((it, k) => {
      const o = 100 + k * recLen, xs = it.ring.map(p => p[0]), ys = it.ring.map(p => p[1]);
      shp.setInt32(o, k + 1); shp.setInt32(o + 4, 64);
      shp.setInt32(o + 8, 5, true);
      [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((q, m) => shp.setFloat64(o + 12 + m * 8, q, true));
      shp.setInt32(o + 44, 1, true); shp.setInt32(o + 48, 5, true); shp.setInt32(o + 52, 0, true);
      it.ring.forEach((p, m) => { shp.setFloat64(o + 56 + m * 16, p[0], true); shp.setFloat64(o + 64 + m * 16, p[1], true); });
      shx.setInt32(100 + k * 8, o / 2); shx.setInt32(104 + k * 8, 64);
    });
    return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer) };
  }
  X._shapefile = shapefile;

  /* dBASE III: ID(N10) CLASE(C12) RATE(N12.3) AREA_HA(N12.4) */
  function dbf(items) {
    const F = [['ID', 'N', 10, 0], ['CLASE', 'C', 12, 0], ['RATE', 'N', 12, 3], ['AREA_HA', 'N', 12, 4]];
    const rl = 1 + F.reduce((a, f) => a + f[2], 0), hl = 32 + F.length * 32 + 1, buf = new Uint8Array(hl + items.length * rl + 1), v = new DataView(buf.buffer);
    const d = new Date(); buf[0] = 3; buf[1] = d.getFullYear() - 1900; buf[2] = d.getMonth() + 1; buf[3] = d.getDate();
    v.setUint32(4, items.length, true); v.setUint16(8, hl, true); v.setUint16(10, rl, true);
    F.forEach((f, k) => {
      const o = 32 + k * 32; buf.set(enc(f[0]), o); buf[o + 11] = f[1].charCodeAt(0); buf[o + 16] = f[2]; buf[o + 17] = f[3];
    });
    buf[32 + F.length * 32] = 13;
    const put = (o, s, w, right) => { s = String(s).slice(0, w); const pad = ' '.repeat(w - s.length); buf.set(enc(right ? pad + s : s + pad), o); };
    items.forEach((it, k) => {
      let o = hl + k * rl; buf[o++] = 32;
      put(o, k + 1, 10, true); o += 10;
      put(o, it.clase, 12, false); o += 12;
      put(o, it.rate.toFixed(3), 12, true); o += 12;
      put(o, it.ha.toFixed(4), 12, true);
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
    const st = AZ.stats(S), dose = +o.dose || 0, price = +o.price || 0, base = st.lote * dose, used = st.treat * dose, save = base - used;
    return {
      st, dose, unit: o.unit || (X.MODES[o.mode] || X.MODES.apl).unit, loteHa: st.lote, treatHa: st.treat, skipHa: st.lote - st.treat,
      base, used, save, savePct: base ? save / base * 100 : 0, avg: st.lote ? used / st.lote : 0, price, money: save * price
    };
  };

  /* ---------- paquete de prescripción ---------- */
  X.prescriptionZip = function (S, o) {
    const items = X.prescription(S, o), sh = shapefile(items), nm = slug(o.field) + '_Rx', c = X.consumption(S, o), mode = X.MODES[o.mode] || X.MODES.apl;
    const txt = [
      'agro.dev · Mapa de prescripción', 'Lote: ' + (o.field || '-'), 'Máquina: ' + (o.machine || X.MACHINES[0].name), 'Tipo: ' + mode.name + ' · dosis ' + c.dose + ' ' + c.unit,
      'Capas: FERTIL = dosis · INFERTIL = 0 · BUFFER = 0', 'Sistema de coordenadas: WGS84 (EPSG:4326)', '',
      'Importación en John Deere: copiar los archivos a una memoria USB (carpeta Rx de la unidad) o cargar el .zip en Operations Center > Archivos,',
      'luego en el display GEN5 elegir el producto y asignar el atributo RATE como dosis objetivo.',
      'IMPORTANTE: validar el mapa en el display con una prueba de campo antes de la aplicación.'
    ].join('\r\n');
    const bytes = X.zip([{ name: nm + '.shp', data: sh.shp }, { name: nm + '.shx', data: sh.shx }, { name: nm + '.dbf', data: dbf(items) }, { name: nm + '.prj', data: X.PRJ }, { name: 'LEEME.txt', data: txt }]);
    return { bytes, name: nm + '.zip', n: items.length };
  };

  X.geojson = function (S, o) {
    const items = X.prescription(S, o);
    return { type: 'FeatureCollection', features: items.map((it, k) => ({ type: 'Feature', properties: { ID: k + 1, CLASE: it.clase, RATE: it.rate, AREA_HA: +it.ha.toFixed(4) }, geometry: { type: 'Polygon', coordinates: [it.ring] } })) };
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
      '@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:13px/1.45 "Space Grotesk",Arial,sans-serif;color:#111;margin:0}' +
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
