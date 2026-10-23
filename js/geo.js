/* agro.dev · geolocalización: lectura de EXIF/GPS de las fotos DJI y mosaico de teselas satelitales.
   El ortomosaico se ubica por su centro (lat/lon) asumiendo orientación norte-arriba. */
(function (root) {
  'use strict';
  const AZGeo = {};
  root.AZGeo = AZGeo;

  /* Proveedor de teselas. Imagen © Esri, Maxar, Earthstar Geographics.
     Para uso comercial revisá los términos o cambiá TILE_URL por Mapbox / MapTiler / Sentinel Hub (con tu clave). */
  AZGeo.TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  AZGeo.ATTRIBUTION = 'Imagen satelital © Esri, Maxar, Earthstar Geographics';

  /* ---------- EXIF GPS (JPEG) ---------- */
  function parseGps(v, t) {
    const le = v.getUint16(t) === 0x4949;
    const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
    const ifd0 = t + u32(t + 4); let gps = 0;
    const n = u16(ifd0);
    for (let i = 0; i < n; i++) { const e = ifd0 + 2 + i * 12; if (u16(e) === 0x8825) gps = t + u32(e + 8); }
    if (!gps) return null;
    const g = {}, m = u16(gps);
    for (let i = 0; i < m; i++) {
      const e = gps + 2 + i * 12, tag = u16(e);
      if (tag === 1 || tag === 3) g[tag] = String.fromCharCode(v.getUint8(e + 8));
      else if (tag === 2 || tag === 4) { const off = t + u32(e + 8); g[tag] = [0, 1, 2].map(k => u32(off + k * 8) / u32(off + k * 8 + 4)); }
    }
    if (!g[2] || !g[4]) return null;
    let lat = g[2][0] + g[2][1] / 60 + g[2][2] / 3600, lon = g[4][0] + g[4][1] / 60 + g[4][2] / 3600;
    if (g[1] === 'S') lat = -lat; if (g[3] === 'W') lon = -lon;
    return { lat, lon };
  }
  /* Lee posición GPS, orientación (yaw), altura relativa, bandera RTK y tamaño en píxeles de una foto JPEG de DJI */
  AZGeo.exif = async function (file) {
    try {
      const buf = await file.slice(0, 262144).arrayBuffer(), v = new DataView(buf);
      if (v.getUint16(0) !== 0xFFD8) return null;
      let o = 2, out = null, w = 0, h = 0;
      while (o < v.byteLength - 9) {
        const m = v.getUint16(o);
        if (m === 0xFFE1) {
          const len = v.getUint16(o + 2);
          if (v.getUint32(o + 4) === 0x45786966 && !out) out = parseGps(v, o + 10);
          o += 2 + len;
        } else if (m >= 0xFFC0 && m <= 0xFFCF && m !== 0xFFC4 && m !== 0xFFC8 && m !== 0xFFCC) {
          h = v.getUint16(o + 5); w = v.getUint16(o + 7); break;
        } else if ((m & 0xFF00) === 0xFF00) o += 2 + v.getUint16(o + 2);
        else break;
      }
      if (!out) return null;
      const txt = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 131072)));
      const num = re => { const r = re.exec(txt); return r ? parseFloat(r[1]) : null; };
      out.rtk = num(/RtkFlag="?(\d+)/);                       // 50 = RTK fijo (mejor esfuerzo)
      const gy = num(/GimbalYawDegree="?([-+0-9.]+)/), fy = num(/FlightYawDegree="?([-+0-9.]+)/);
      out.yaw = gy != null ? gy : fy;                           // rumbo de la cámara en grados (horario desde el norte)
      out.relAlt = num(/RelativeAltitude="?([-+0-9.]+)/);
      out.w = w; out.h = h;
      return out;
    } catch (e) { return null; }
  };

  /* ---------- teselas ---------- */
  const cache = new Map();
  function loaded(z, x, y) { const t = cache.get(z + '/' + x + '/' + y); return t && t.ok ? t.img : null; }
  function tile(z, x, y, cb) {
    const k = z + '/' + x + '/' + y; let t = cache.get(k);
    if (t) return t.ok ? t.img : null;
    const img = new Image(); t = { img, ok: false };
    img.onload = () => { t.ok = true; cb && cb(); };
    img.onerror = () => { t.err = true; };
    img.src = AZGeo.TILE_URL(z, x, y); cache.set(k, t);
    if (cache.size > 700) { const first = cache.keys().next().value; cache.delete(first); }
    return null;
  }
  const MPP0 = 156543.03392;
  /* g: contexto con transformación de vista aplicada (unidades = píxeles del ortomosaico) */
  AZGeo.drawTiles = function (g, S, v, cw, ch, redraw) {
    const { lat, lon } = S.geo; if (!isFinite(lat) || !isFinite(lon)) return;
    const rad = lat * Math.PI / 180, cosl = Math.cos(rad), mppS = S.mpp / v.z;
    let z = Math.round(Math.log2(MPP0 * cosl / mppS)); z = Math.max(2, Math.min(19, z));
    let vx0 = -v.x / v.z, vy0 = -v.y / v.z, vx1 = (cw - v.x) / v.z, vy1 = (ch - v.y) / v.z;
    const th = (S.rot || 0) * Math.PI / 180;
    if (th) {   /* la imagen está girada: los teselas (norte-arriba) se dibujan girados -th; el área visible en su marco es el cuadro envolvente */
      const c = Math.cos(th), sn = Math.sin(th), xs = [], ys = [];
      [[vx0, vy0], [vx1, vy0], [vx1, vy1], [vx0, vy1]].forEach(([x, y]) => { const dx = x - S.W / 2, dy = y - S.H / 2; xs.push(S.W / 2 + dx * c - dy * sn); ys.push(S.H / 2 + dx * sn + dy * c); });
      vx0 = Math.min(...xs); vx1 = Math.max(...xs); vy0 = Math.min(...ys); vy1 = Math.max(...ys);
      g.save(); g.translate(S.W / 2, S.H / 2); g.rotate(-th); g.translate(-S.W / 2, -S.H / 2);
    }
    for (let tries = 0; tries < 8; tries++) {
      const n = Math.pow(2, z), s = MPP0 * cosl / n / S.mpp;
      const cx = (lon + 180) / 360 * 256 * n, cy = (1 - Math.log(Math.tan(rad) + 1 / cosl) / Math.PI) / 2 * 256 * n;
      const tx0 = Math.max(0, Math.floor((cx + (vx0 - S.W / 2) / s) / 256)), tx1 = Math.min(n - 1, Math.floor((cx + (vx1 - S.W / 2) / s) / 256));
      const ty0 = Math.max(0, Math.floor((cy + (vy0 - S.H / 2) / s) / 256)), ty1 = Math.min(n - 1, Math.floor((cy + (vy1 - S.H / 2) / s) / 256));
      if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 90 && z > 2) { z--; continue; }
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const X = S.W / 2 + (tx * 256 - cx) * s, Y = S.H / 2 + (ty * 256 - cy) * s, w = 256 * s + 0.6;
        const img = tile(z, tx, ty, redraw);
        if (img) g.drawImage(img, X, Y, w, w);
        else { const par = z > 2 ? loaded(z - 1, tx >> 1, ty >> 1) : null; if (par) g.drawImage(par, (tx & 1) * 128, (ty & 1) * 128, 128, 128, X, Y, w, w); }
      }
      break;
    }
    if (th) g.restore();
  };

  /* pixel del ortomosaico -> lat/lon aproximados */
  AZGeo.pxToLatLon = (S, x, y) => AZ.pxToGeo(S, x, y);
})(window);
