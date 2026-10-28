/* agro.dev · puente con la versión de escritorio (Electron + motor Python). En el navegador AZDesktop.available es false. */
(function (root) {
  'use strict';
  const D = root.AZDesktop = { available: !!root.agroDesktop };
  const api = () => root.agroDesktop;

  /* Ejecuta un comando del motor. onProgress(pct, msg); cancel: {v:boolean} (se revisa al llegar cada aviso y con un temporizador) */
  D.call = function (cmd, args, onProgress, cancel) {
    return new Promise((resolve, reject) => {
      const h = api().engine(cmd, args, m => { if (m.type === 'progress' && onProgress) onProgress(m.pct, m.msg); });
      let t = null;
      if (cancel) t = setInterval(() => { if (cancel.v) { clearInterval(t); api().cancel(h.id); } }, 400);
      h.done.then(r => { clearInterval(t); if (r && r.error) reject(new Error(r.error)); else resolve(r.result); }, e => { clearInterval(t); reject(e); });
    });
  };

  /* ---- Registro: todo lo que informa el motor (y la interfaz) queda en D.logs; la sección "Registro" lo muestra en vivo ---- */
  D.logs = []; const subs = new Set();
  D.onLog = f => { subs.add(f); return () => subs.delete(f); };
  D.addLog = (msg, src, t) => {
    const l = { t: t || Date.now() / 1000, msg: (src ? src + ': ' : '') + String(msg) };
    D.logs.push(l); if (D.logs.length > 3000) D.logs.splice(0, D.logs.length - 2500);
    subs.forEach(f => { try { f(l); } catch (e) { } });
  };
  if (D.available && api().onLog) api().onLog(m => D.addLog(m.msg, '', m.t));
  D.pickFolders = () => api().pickFolders();

  /* Revisa carpetas y devuelve un "info" con la misma forma que AZFiles.analyze (más native:true) */
  D.scan = async function (folders, onProgress) {
    const r = await D.call('scan', { folders }, onProgress);
    const byDir = Object.entries(r.by_dir || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, c]) => [d, c]);
    return {
      native: true, folderPaths: folders, n: r.rgb + r.ms + r.ignored, mb: (r.bytes || 0) / 1048576, folders: byDir, raw: r.files, ms: r.ms, tif: 0, other: r.ignored, ortho: null,
      gps: r.lat != null ? { lat: r.lat, lon: r.lon } : null, rtk: r.rtk != null ? r.rtk : null, alt: r.alt, yaw: r.yaw90 != null ? r.yaw90 : null, pw: r.size ? r.size[0] : null,
      geoPhotos: r.geotagged, gsdCm: r.gsd_cm, areaHa: r.area_ha, model: r.model, unreadable: r.unreadable
    };
  };

  /* Arma el ortomosaico a resolución original (por mosaicos) y lo deja abierto. o: {files, outRes (cm/px o null), rtk} */
  D.buildBase = async function (o, onProgress, cancel) {
    const out = (await api().workdir()) + '/' + 'ortomosaicos/' + o.name.replace(/[^\w\-]+/g, '_') + '_' + Date.now();
    const meta = await D.call('mosaic', { files: o.files, out, res_cm: o.outRes || null, quality: 92 }, (p, m) => onProgress && onProgress(p * 0.9, m), cancel);
    const timing = { start: Math.round(meta.started * 1000), end: Math.round(meta.finished * 1000), seconds: meta.seconds, log: meta.log, fallback: !!meta.single_process_fallback, workers: meta.workers, stages: meta.timings };
    onProgress && onProgress(0.92, 'Abriendo ortomosaico…');
    const T = await D.call('open_tiles', { dir: meta.dir });
    const g = T.mpp, k = AZ.mPerDeg(T.lat0);
    const cE = T.E0 + T.w * g / 2, cN = T.N1 - T.h * g / 2;
    const mppV = Math.max(g, Math.min(g * 8, 0.25));
    return {
      tiled: { url: T.url, server: T.server, levels: T.levels, tile: T.tile, w0: T.w, h0: T.h, g, mppV, dir: meta.dir, photos: T.photos, seconds: T.seconds },
      polyNative: T.poly_px, mpp: mppV, geo: { lat: T.lat0 + cN / T.ky, lon: T.lon0 + cE / T.kx, rtk: o.rtk },
      note: T.photos + ' fotos · ' + (g * 100).toFixed(1) + ' cm/px · ' + T.w.toLocaleString('es-AR') + '×' + T.h.toLocaleString('es-AR') + ' px · ' + T.seconds + ' s', canvas: null, timing
    };
  };

  /* Celdas de la grilla calculadas por el motor sobre los píxeles originales. Devuelve el ArrayBuffer binario. */
  D.cells = async function (T, spec, onProgress, cancel) {
    const r = await D.call('cells', { server: T.server, spec }, onProgress, cancel);
    const res = await fetch(T.url + '/cells/' + r.id); if (!res.ok) throw new Error('no se pudo leer el resultado del motor');
    return res.arrayBuffer();
  };
})(window);
