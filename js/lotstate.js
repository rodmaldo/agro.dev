/* agro.dev · guardado y apertura inmediata de un lote ya procesado (escritorio).
   Qué se guarda por lote (carpeta Documentos/agro.dev/lotes/<id>/):
     estado.json  configuración, ubicación del ortomosaico en disco, grilla, límite, puntos, detección, capas, búfer y ambientación (máscaras comprimidas)
     celdas.bin   las características por celda que calculó el motor (lo más lento de rehacer)
   El ortomosaico en sí ya está en disco (carpeta "ortomosaicos"): al abrir solo se reconecta, no se vuelve a procesar nada. */
(function (root) {
  'use strict';
  const AZ = root.AZ || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const L = (typeof module !== 'undefined' && module.exports) ? module.exports : (root.AZLot = {});
  const VERSION = 1;
  L.available = () => !!(root.agroDesktop && root.agroDesktop.lots);

  /* ---- máscaras: Uint8Array -> gzip -> base64 (y al revés) ---- */
  async function pipe(u8, stream) {
    const w = stream.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  }
  L.pack = async function (m) {
    if (!m) return null; const z = await pipe(m, new CompressionStream('gzip')); let s = '';
    for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode.apply(null, z.subarray(i, i + 0x8000));
    return btoa(s);
  };
  L.unpack = async function (b64, n) {
    if (!b64) return null; const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const o = await pipe(u, new DecompressionStream('gzip'));
    if (n != null && o.length !== n) throw new Error('máscara de tamaño distinto al de la grilla');
    return o;
  };

  /* ---- instantánea del estado ---- */
  L.snapshot = async function (S, ctx) {
    const { field, cfg, job, stage } = ctx, T = S.tiled; if (!T || !T.dir) throw new Error('este lote no tiene ortomosaico en disco');
    const N = S.gw * S.gh;
    const lay = [];
    for (const l of S.hl) { const { mask, prev, ...rest } = l; lay.push({ ...rest, mask: await L.pack(mask) }); }
    const amb = S.amb ? (({ cls, ...r }) => r)(S.amb) : null;
    return {
      format: 'agro.dev/lote', v: VERSION, app: ctx.version || '', savedAt: new Date().toISOString(), fieldId: field.id, name: field.name, stage: stage || 'dash',
      cfg, note: job.note || '', timing: job.timing || null, folders: job.folders || [],
      base: { dir: T.dir, rtk: cfg && cfg.prec === 'rtk', detailed: !!S.detailed },
      grid: { cs: S.cs, gw: S.gw, gh: S.gh, W: S.W, H: S.H, rot: S.rot || 0, mpp: S.mpp, capped: !!S.capped },
      poly: S.poly, pts: S.pts, meta: S.meta, idxName: S.idxName, seq: S.seq, zord: S.zord || null, hasDet: !!S.hasDet,
      masks: { auto: await L.pack(S.auto), badd: await L.pack(S.badd), berase: await L.pack(S.berase), man: await L.pack(S.man) }, hl: lay, amb, n: N
    };
  };

  /* Guarda el lote en disco (serializa las llamadas: si llega otra mientras se guarda, se guarda otra vez al terminar). */
  let busy = null, again = null;
  L.save = function (S, ctx) {
    if (!L.available() || !S.gw || !S.tiled) return Promise.resolve(false);
    if (busy) { again = [S, ctx]; return busy; }
    busy = (async () => {
      try {
        const snap = await L.snapshot(S, ctx);
        const fresh = S.cellsBuf && S.cellsBuf !== S._cellsWritten, cells = fresh ? new Uint8Array(S.cellsBuf) : null;     // las celdas solo se reescriben si se recalcularon (pueden pesar decenas de MB)
        await root.agroDesktop.lots.save(ctx.field.id, JSON.stringify(snap), cells);
        if (fresh) S._cellsWritten = S.cellsBuf;
        if (root.AZLearn) root.AZLearn.record(S, { id: ctx.field.id, name: ctx.field.name, cfg: ctx.cfg, version: ctx.version });   // biblioteca de ejemplos (no bloquea el guardado)
        try { root.AZApi.fields.update(ctx.field.id, { saved: snap.savedAt, stage: snap.stage }); } catch (e) { }
        return true;
      } catch (e) { if (root.AZDesktop) root.AZDesktop.addLog('no se pudo guardar el lote: ' + e.message, 'Interfaz'); return false; }
      finally { busy = null; if (again) { const a = again; again = null; L.save(a[0], a[1]); } }
    })();
    return busy;
  };
  L.has = async id => { try { return L.available() && await root.agroDesktop.lots.has(id); } catch (e) { return false; } };
  L.remove = async id => { try { if (L.available()) await root.agroDesktop.lots.remove(id); } catch (e) { } };

  /* Reconstruye S desde la instantánea. openBase(dir, rtk) reabre el ortomosaico (en pruebas se reemplaza). */
  L.restore = async function (S, snap, cellsBuf, openBase) {
    if (!snap || snap.format !== 'agro.dev/lote') throw new Error('archivo de lote inválido');
    if (snap.v > VERSION) throw new Error('el lote fue guardado con una versión más nueva de agro.dev');
    if (!cellsBuf) throw new Error('faltan los datos de la grilla del lote');
    const base = await openBase(snap.base.dir, snap.base.rtk), g = snap.grid;
    AZ.setTiled(S, base.tiled, null, { detailed: snap.base.detailed });
    AZ.tiledFrame(S, g.rot);
    if (S.W !== g.W || S.H !== g.H) throw new Error('el ortomosaico no coincide con el guardado (' + S.W + '×' + S.H + ' vs ' + g.W + '×' + g.H + ')');
    S.poly = snap.poly; S.geo = base.geo; S.cs = g.cs; S.gw = g.gw; S.gh = g.gh; S.capped = !!g.capped;
    const keepMeta = snap.meta; S.meta = keepMeta;
    AZ.applyCells(S, cellsBuf.buffer ? cellsBuf.buffer.slice(cellsBuf.byteOffset, cellsBuf.byteOffset + cellsBuf.byteLength) : cellsBuf, snap.base.detailed);
    S.cellsBuf = cellsBuf.buffer ? cellsBuf.buffer.slice(cellsBuf.byteOffset, cellsBuf.byteOffset + cellsBuf.byteLength) : cellsBuf;
    S._cellsWritten = S.cellsBuf;
    const N = S.gw * S.gh, M = snap.masks;
    S.pts = snap.pts || []; S.idxName = snap.idxName || 'exg'; S.seq = snap.seq || 0; S.zord = snap.zord || null;
    S.auto = await L.unpack(M.auto, N); S.badd = await L.unpack(M.badd, N); S.berase = await L.unpack(M.berase, N); S.man = await L.unpack(M.man, N);
    S.hl = [];
    for (const l of snap.hl || []) { const { mask, ...r } = l; S.hl.push({ ...r, mask: (await L.unpack(mask, N)) || new Uint8Array(N), prev: null }); }
    S.amb = null;
    if (snap.amb) { S.amb = { ...snap.amb, cls: null }; AZ.ambClassify(S); }
    if (S.auto || S.badd || S.berase) AZ.mergeDet(S); else S.det = new Uint8Array(N);
    S.hasDet = !!snap.hasDet; AZ.calcBuf(S); S.mver++; S.ver++;
    return { base, cfg: snap.cfg, stage: snap.stage, job: { note: snap.note || base.note, timing: snap.timing || null, folders: snap.folders || [], base, info: null, preset: null, presetDone: true } };
  };

  /* Abre el lote guardado de un campo. Devuelve null si no hay nada guardado; lanza si está dañado o falta el ortomosaico. */
  L.open = async function (S, field, openBase) {
    if (!(await L.has(field.id))) return null;
    const r = await root.agroDesktop.lots.load(field.id); if (!r) return null;
    return L.restore(S, JSON.parse(r.json), r.cells, openBase);
  };
})(typeof window !== 'undefined' ? window : globalThis);
