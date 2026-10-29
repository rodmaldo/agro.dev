/* agro.dev · dashboard principal: resultados (derecha), capas (abajo), herramientas (izquierda), exportación */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef, useReducer, useMemo } = React;
  const { html, Ic, Slider, Toggle, Seg, Menu, MapCanvas, Rail, baseUi, useSpace, useToast, f1 } = root.AZUI;

  const TOOLS = [['pan', 'move', 'Mover (V)'], ['brush', 'brush', 'Pincel (B)'], ['erase', 'eraser', 'Borrador (E)'], ['wand', 'wand', 'Selección smart (W) · Mayús suma'], ['poly', 'poly', 'Dibujar límite (L)'], ['edit', 'edit', 'Editar límite (M)']];
  const KEYS = { KeyV: 'pan', KeyB: 'brush', KeyE: 'erase', KeyW: 'wand', KeyL: 'poly', KeyM: 'edit' };
  const IDX = { exg: 'Verdor (ExG)', bri: 'Brillo', sat: 'Saturación', ndvi: 'Índice subido (NDVI)' };

  /* ---------- histograma con barras de umbral arrastrables ---------- */
  function Hist({ S, L, rev, onRange }) {
    const ref = useRef(), drag = useRef(null);
    const bins = useMemo(() => (S.idx[L.idx] ? AZ.histBins(S, L.idx, 64) : null), [S.mver, L.idx, S.ver === 0]);
    useEffect(() => {
      const c = ref.current; if (!c || !bins) return; const g = c.getContext('2d'), w = c.width, h = c.height; g.clearRect(0, 0, w, h);
      const B = 64; let mx = 1; for (let b = 0; b < B; b++) mx = Math.max(mx, bins.rest[b] + bins.det[b]);
      const bw = w / B, sc = v => Math.sqrt(v / mx) * (h - 28);
      for (let b = 0; b < B; b++) { const r = sc(bins.rest[b]), d = sc(bins.rest[b] + bins.det[b]); g.fillStyle = '#6f8576'; g.fillRect(b * bw, h - r - 18, bw - 1, r); g.fillStyle = S.meta.det.color; g.fillRect(b * bw, h - d - 18, bw - 1, d - r); }
      if (L.range) {
        const x0 = (L.range[0] - bins.lo) / (bins.hi - bins.lo) * w, x1 = (L.range[1] - bins.lo) / (bins.hi - bins.lo) * w;
        g.fillStyle = L.color + '55'; g.fillRect(x0, 0, Math.max(2, x1 - x0), h - 18);
        g.fillStyle = '#fff'; for (const x of [x0, Math.max(x0 + 2, x1)]) { g.fillRect(x - 1, 0, 2, h - 18); g.beginPath(); g.moveTo(x - 6, h - 4); g.lineTo(x + 6, h - 4); g.lineTo(x, h - 17); g.closePath(); g.fill(); }
      }
      g.fillStyle = '#7e8b83'; g.font = '10px monospace'; g.fillText(bins.lo.toFixed(2), 2, 10); g.fillText(bins.hi.toFixed(2), w - 34, 10);
    }, [bins, L.range, L.color, S.meta.det.color, rev]);
    const val = e => { const r = ref.current.getBoundingClientRect(); return bins.lo + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (bins.hi - bins.lo); };
    const down = e => {
      const v = val(e), px = (bins.hi - bins.lo) * 9 / ref.current.getBoundingClientRect().width;
      if (L.range && Math.abs(v - L.range[0]) < px) drag.current = { m: 'lo' };
      else if (L.range && Math.abs(v - L.range[1]) < px) drag.current = { m: 'hi' };
      else { drag.current = { m: 'new', a: v }; onRange(v, v); }
      ref.current.setPointerCapture(e.pointerId);
    };
    const move = e => {
      const d = drag.current; if (!d) return; const v = val(e);
      if (d.m === 'new') onRange(Math.min(d.a, v), Math.max(d.a, v));
      else if (d.m === 'lo') onRange(Math.min(v, L.range[1]), L.range[1]); else onRange(L.range[0], Math.max(v, L.range[0]));
    };
    if (!bins) return html`<div className="mu">Este índice no está disponible.</div>`;
    return html`<canvas ref=${ref} width="420" height="96" aria-label="Histograma" style=${{ width: '100%', height: 96, background: '#0a0d0b', cursor: 'ew-resize', touchAction: 'none' }}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${() => { drag.current = null; }}></canvas>`;
  }


  /* ---------- Ambientación: histograma con 4 umbrales arrastrables y tabla de 5 niveles (Lt/ha) ---------- */
  function AmbHist({ S, A, rev, onTh }) {
    const ref = useRef(), drag = useRef(null);
    const bins = useMemo(() => (S.idx[A.idx] ? AZ.histBins(S, A.idx, 64) : null), [S.mver, A.idx]);
    const span = bins ? bins.hi - bins.lo : 1, X = v => (v - bins.lo) / span;
    useEffect(() => {
      const c = ref.current; if (!c || !bins) return; const g = c.getContext('2d'), w = c.width, h = c.height; g.clearRect(0, 0, w, h);
      const B = 64; let mx = 1; for (let b = 0; b < B; b++) mx = Math.max(mx, bins.rest[b] + bins.det[b]);
      const bw = w / B, t = A.th;
      for (let b = 0; b < B; b++) {
        const v = bins.lo + (b + 0.5) / B * span, k = v < t[0] ? 0 : v < t[1] ? 1 : v < t[2] ? 2 : v < t[3] ? 3 : 4, hh = Math.sqrt((bins.rest[b] + bins.det[b]) / mx) * (h - 26);
        g.fillStyle = A.colors[k]; g.fillRect(b * bw, h - hh - 16, bw - 1, hh);
      }
      g.fillStyle = '#fff'; t.forEach(v => { const x = Math.max(1, Math.min(w - 1, X(v) * w)); g.fillRect(x - 1, 0, 2, h - 16); g.beginPath(); g.moveTo(x - 6, h - 3); g.lineTo(x + 6, h - 3); g.lineTo(x, h - 15); g.closePath(); g.fill(); });
      g.fillStyle = '#7e8b83'; g.font = '10px monospace'; g.fillText(bins.lo.toFixed(2), 2, 10); g.fillText(bins.hi.toFixed(2), w - 34, 10);
    }, [bins, A.th.join(), A.colors.join(), rev]);
    if (!bins) return html`<div className="mu">Este índice no está disponible.</div>`;
    const val = e => { const r = ref.current.getBoundingClientRect(); return bins.lo + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * span; };
    const down = e => { const v = val(e); let b = 0, d = 1e9; A.th.forEach((x, k) => { if (Math.abs(x - v) < d) { d = Math.abs(x - v); b = k; } }); drag.current = b; ref.current.setPointerCapture(e.pointerId); onTh(b, v); };
    return html`<canvas ref=${ref} width="420" height="96" aria-label="Histograma de la ambientación: arrastrá los 4 umbrales" style=${{ width: '100%', height: 96, background: '#0a0d0b', cursor: 'ew-resize', touchAction: 'none' }}
      onPointerDown=${down} onPointerMove=${e => { if (drag.current != null) onTh(drag.current, val(e)); }} onPointerUp=${() => { drag.current = null; }}></canvas>`;
  }

  function AmbPanel({ S, A, rev, bump, toast, refresh }) {
    const st = AZ.ambStats(S) || { ha: [0, 0, 0, 0, 0], tot: 0 }, unit = 'L/ha';
    const vol = A.rates.reduce((s, r, k) => s + (+r || 0) * st.ha[k], 0);
    return html`<div className="amb">
      <label className="fld"><span className="fl">Índice de color</span><select value=${A.idx} onChange=${e => { AZ.ambIdx(S, e.target.value); bump(); }}>${Object.keys(S.idx).map(k => html`<option key=${k} value=${k}>${IDX[k] || k}</option>`)}</select></label>
      <label className="fld"><span className="fl">Gama de colores</span><select value=${A.pal} onChange=${e => { AZ.ambPalette(S, e.target.value); bump(); }}>${Object.entries(AZ.AMB_PAL).map(([k, p]) => html`<option key=${k} value=${k}>${p.name}</option>`)}</select></label>
      <div className="amb-pal" aria-hidden="true">${A.colors.map(c => html`<i key=${c} style=${{ background: c }}></i>`)}</div>
      <${AmbHist} S=${S} A=${A} rev=${rev} onTh=${(k, v) => { AZ.ambSetTh(S, k, v); bump(); }}/>
      <div className="row"><button className=${'btn sm' + (A.mode === 'igual' ? ' pri' : '')} type="button" onClick=${() => { AZ.ambAuto(S, 'igual'); bump(); }}>Intervalos iguales</button><button className=${'btn sm' + (A.mode === 'perc' ? ' pri' : '')} type="button" onClick=${() => { AZ.ambAuto(S, 'perc'); bump(); }}>Igual superficie</button></div>
      <table className="amb-t"><thead><tr><th></th><th>Nivel</th><th>ha</th><th>%</th><th>${unit}</th></tr></thead><tbody>
        ${A.rates.map((r, k) => html`<tr key=${k}><td><i className="sw" style=${{ background: A.colors[k] }}></i></td><td>Nivel ${k + 1}</td><td className="n">${f1(st.ha[k], 1)}</td><td className="n">${f1(st.tot ? st.ha[k] / st.tot * 100 : 0, 1)}</td>
          <td><input type="number" min="0" step="0.5" value=${r} aria-label=${'Dosis del nivel ' + (k + 1) + ' en L/ha'} onInput=${e => { A.rates[k] = e.target.value === '' ? '' : Math.max(0, +e.target.value); S.ver++; bump(); }}/></td></tr>`)}
      </tbody></table>
      <div className="kv"><span>Volumen total</span><span>${f1(vol, 0)} L</span></div>
      <div className="mu">Dosis <b>0</b> = zona infértil: no se aplica. Ejemplo: dejá solo el nivel fértil en 40 L/ha y los demás en 0.</div>
      <label className="tog" title="Usar esta capa como mapa de dosis al exportar"><input type="checkbox" checked=${!!A.inc} onChange=${e => { A.inc = e.target.checked; S.ver++; bump(); }}/><i></i><span>Usar en la prescripción</span></label>
      <button className="btn sm" type="button" onClick=${() => { const n = AZ.ambToDet(S); refresh(); toast(n.toLocaleString('es-AR') + ' celdas con dosis 0 pasaron a Detección de zonas (infértil)'); }}>Convertir niveles con dosis 0 a Detección de zonas</button>
    </div>`;
  }

  /* Biblioteca de ejemplos: cuánto material tiene guardado el sistema para aprender (todavía no entrena nada) */
  function LearnBox({ rev }) {
    const [sum, setSum] = useState(null), L = root.AZLearn;
    useEffect(() => { if (!L || !L.available()) return; let dead = false; const h = setTimeout(() => L.summary().then(s => { if (!dead) setSum(s); }), 4500); return () => { dead = true; clearTimeout(h); }; }, [rev]);
    if (!L || !L.available()) return null;
    const t = (sum || []).reduce((a, x) => ({ pos: a.pos + x.n.pos, neg: a.neg + x.n.neg, user: a.user + x.n.user }), { pos: 0, neg: 0, user: 0 }), nl = (sum || []).length;
    return html`<div className="stat"><div className="k">Aprendizaje · ejemplos guardados</div>
      <div className="kv"><span>Lotes con ejemplos</span><span>${sum ? nl : '…'}</span></div>
      <div className="kv"><span>Celdas de salitre</span><span>${sum ? t.pos.toLocaleString('es-AR') : '…'}</span></div>
      <div className="kv"><span>Celdas sanas</span><span>${sum ? t.neg.toLocaleString('es-AR') : '…'}</span></div>
      <div className="kv"><span>Marcadas o corregidas por vos</span><span>${sum ? t.user.toLocaleString('es-AR') : '…'}</span></div>
      <div className="mu">Por ahora solo se juntan ejemplos: la detección todavía <b>no aprende</b>. Con 3 lotes o más bien delimitados se puede entrenar y medir el acierto.</div></div>`;
  }

  function Legend({ S }) {
    const [c, setC] = useState(null);
    useEffect(() => { const f = e => setC(e.detail); addEventListener('az-cursor', f); return () => removeEventListener('az-cursor', f); }, []);
    return html`<div className="pb">
      <div className="kv"><span>Longitud</span><span>${c ? f1(c.lon, 6) : 'N/D'}</span></div>
      <div className="kv"><span>Latitud</span><span>${c ? f1(c.lat, 6) : 'N/D'}</span></div>
      <div className="kv"><span>Posición</span><span>${S.geo.rtk ? 'RTK' : 'GPS'}</span></div>
      <div className="kv"><span>Píxel</span><span>${f1(S.mpp * 100, 1)} cm</span></div>
      <div className="kv"><span>Celda</span><span>${f1(AZ.cellM(S), 2)} m</span></div>
      <div className="kv"><span>Orientación</span><span>${f1(S.rot || 0, 1)}°</span></div>
    </div>`;
  }

  /* ---------- exportación ---------- */
  function ExportDialog({ S, field, ex, setEx, yld, onClose, toast }) {
    useEffect(() => { const k = e => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
    const o = { ...ex, field: field.name, version: AZSys.VERSION, machine: AZ.X.MACHINES.find(m => m.id === ex.machine).name, yld };
    const c = useMemo(() => AZ.X.consumption(S, o), [ex, S.mver, S.ver]);
    const set = p => setEx(e => ({ ...e, ...p }));
    const U = c.unit.split('/')[0], amb = !!c.amb, valid = amb || +ex.dose > 0;
    const okOnly = (fn) => { if (!valid) return toast('Ingresá una dosis mayor que 0'); try { fn(); } catch (e) { toast('No se pudo exportar: ' + e.message); } };
    const prescription = () => okOnly(() => { const z = AZ.X.prescriptionZip(S, o); AZFiles.download(z.name, z.bytes, 'application/zip'); toast('Prescripción exportada: ' + z.n.toLocaleString('es-AR') + ' polígonos'); });
    const geo = () => okOnly(() => AZFiles.download('agro-dev_' + field.name.replace(/\W+/g, '_') + '.geojson', JSON.stringify(AZ.X.geojson(S, o)), 'application/geo+json'));
    const report = () => okOnly(async () => {
      const w = 1400, z = w / S.W, cv = document.createElement('canvas'); cv.width = w; cv.height = Math.round(S.H * z);
      const po = { vis: { sat: 0, ortho: 1, grid: 0, lim: 1 }, orthOp: 100, satOp: 100, gridOp: 0, gridHeld: false, ba: false, baPos: 0.5, tool: 'pan', mouse: null, active: null, heat: 0, brushN: 1 };
      AZMap.paint(cv, S, { x: 0, y: 0, z }, po, false, () => { });
      if (S.tiled) for (let i = 0; i < 40 && AZMap.pending() > 0; i++) { await new Promise(r => setTimeout(r, 150)); AZMap.paint(cv, S, { x: 0, y: 0, z }, po, false, () => { }); }   // esperar los mosaicos del ortomosaico
      if (S.tiled) { await new Promise(r => setTimeout(r, 200)); AZMap.paint(cv, S, { x: 0, y: 0, z }, po, false, () => { }); }
      const base = AZ.X.reportHtml(S, { ...o, img: cv.toDataURL('image/jpeg', 0.85) }), nm = 'informe_' + field.name.replace(/\W+/g, '_');
      if (window.agroDesktop && window.agroDesktop.savePdf) {   // escritorio: PDF real
        try { const r = await window.agroDesktop.savePdf(base, nm + '.pdf'); toast(r && r.canceled ? 'Informe cancelado' : 'Informe PDF guardado'); }
        catch (e) { toast('No se pudo crear el PDF: ' + e.message); }
        return;
      }
      const h = base.replace('</body>', '<script>setTimeout(function(){print()},500)<\/script></body>');
      const url = URL.createObjectURL(new Blob([h], { type: 'text/html' })), win = window.open(url, '_blank');
      if (!win) { AZFiles.download('informe_' + field.name.replace(/\W+/g, '_') + '.html', h, 'text/html'); toast('El navegador bloqueó la ventana: se descargó el informe (abrilo e imprimí → Guardar como PDF)'); }
    });
    return html`<div className="veil" onPointerDown=${e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Exportar prescripción">
        <div className="mh"><span>Exportar · mapa de prescripción</span><button className="lnk" type="button" aria-label="Cerrar" onClick=${onClose}><${Ic} n="close" s=${14}/></button></div>
        <div className="mbody">
          <label className="fld"><span className="fl">Maquinaria</span><select value=${ex.machine} onChange=${e => set({ machine: e.target.value })}>${AZ.X.MACHINES.map(m => html`<option key=${m.id} value=${m.id}>${m.name}</option>`)}</select></label>
          <div className="mu">${AZ.X.MACHINES.find(m => m.id === ex.machine).note}</div>
          <div className="fld"><span className="fl">Operación</span><${Seg} value=${ex.mode} onChange=${v => set({ mode: v, unit: AZ.X.MODES[v].unit })} opts=${[['apl', 'Aplicación'], ['fer', 'Fertilización'], ['sie', 'Siembra']]}/></div>
          <div className="g2">
            <label className="fld"><span className="fl">${amb ? 'Dosis de referencia (para el ahorro)' : 'Dosis objetivo en zona fértil'}</span><div className="row"><input type="number" min="0" step="0.1" value=${ex.dose} onInput=${e => set({ dose: e.target.value })} aria-label="Dosis"/>
              ${ex.mode === 'fer' ? html`<select className="fx" value=${ex.unit} onChange=${e => set({ unit: e.target.value })}><option>L/ha</option><option>kg/ha</option></select>` : html`<span className="mu fx">${c.unit}</span>`}</div></label>
            <label className="fld"><span className="fl">Precio por ${U} (opcional)</span><input type="number" min="0" step="0.01" value=${ex.price} onInput=${e => set({ price: e.target.value })} aria-label="Precio"/></label>
          </div>
          ${amb && html`<div className="kv-box">${S.amb.rates.map((r, k) => html`<div className="kv" key=${k}><span><i className="sw" style=${{ background: S.amb.colors[k], display: 'inline-block', marginRight: 6 }}></i>Nivel ${k + 1}</span><span>${f1(+r || 0, 1)} ${c.unit}</span></div>`)}</div>
          <div className="mu">Las dosis de cada nivel se editan en la capa Ambientación (Capas → Propiedades).</div>`}
          <label className="tog"><input type="checkbox" checked=${!!ex.omitZero} onChange=${e => set({ omitZero: e.target.checked })}/><i></i><span>Omitir polígonos con dosis 0 (archivo más liviano)</span></label>
          ${!S.limUser && html`<div className="note w">Todavía no definiste el límite del lote: las hectáreas y la prescripción incluyen los márgenes que fotografió el dron. Definí el límite (dibujado o KML) antes de exportar.</div>`}
          <div className="kv-box">
            <div className="kv"><span>Lote</span><span>${f1(c.loteHa)} ha</span></div>
            <div className="kv"><span>A tratar (dosis > 0${S.meta.buf.on ? ', sin buffer' : ''})</span><span>${f1(c.treatHa)} ha</span></div>
            <div className="kv"><span>Sin aplicación (dosis 0${S.meta.buf.on ? ' + buffer' : ''})</span><span>${f1(c.skipHa)} ha</span></div>
            <div className="kv"><span>Consumo aplicando todo el lote</span><span>${f1(c.base, 0)} ${U}</span></div>
            <div className="kv"><span>Consumo con prescripción</span><span>${f1(c.used, 0)} ${U}</span></div>
            <div className="kv"><span><b>Ahorro</b></span><span><b className="sv">${f1(c.save, 0)} ${U} · ${f1(c.savePct)} %</b></span></div>
            <div className="kv"><span>Dosis media sobre el lote</span><span>${f1(c.avg, 2)} ${c.unit}</span></div>
            ${c.price > 0 && html`<div className="kv"><span>Ahorro económico</span><span>$ ${f1(c.money, 0)}</span></div>`}
          </div>
          <div className="note">Se combinan todas las capas incluidas. Mapa de prescripción: ${amb ? html`<b>cada nivel = su dosis</b>` : html`<b>fértil = dosis</b>`}, <b>infértil${S.meta.buf.on ? ' y buffer' : ''} = 0</b>. Se exporta un shapefile en la carpeta <b>Rx</b> (WGS84, columna RATE) para displays GEN4 / GEN5. Validá el archivo en el display con una prueba de campo antes de aplicar; no está verificado en equipos reales.</div>
        </div>
        <div className="mf"><button className="btn" type="button" onClick=${geo}>GeoJSON</button><button className="btn" type="button" onClick=${report}>Informe PDF</button><button className="btn pri" type="button" onClick=${prescription}>Prescripción (.zip)</button></div>
      </div></div>`;
  }

  /* ---------- exportar ortomosaico (.tif) ---------- */
  function TifDialog({ S, field, onClose, toast }) {
    const [plan, setPlan] = useState(null), [shift, setShift] = useState(2), [clip, setClip] = useState(true), [prog, setProg] = useState(null), cancel = useRef({ v: false });
    const T = S.tiled, poly = () => (clip && S.limUser ? AZ.polyNative(S) : null);
    useEffect(() => { const k = e => { if (e.key === 'Escape' && !prog) onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [prog]);
    useEffect(() => { let dead = false; AZDesktop.tifPlan(T.dir, poly()).then(p => { if (!dead) setPlan(p); }).catch(e => toast('No se pudo calcular el tamaño: ' + e.message)); return () => { dead = true; }; }, [clip]);
    const opt = plan && (plan.find(p => p.shift === shift) || plan[plan.length - 1]);
    const estMB = o => o ? Math.round(o.mpx * 0.55) : 0;           // ~0,5 MB por megapíxel (RGBA con deflate sobre imagen aérea)
    const go = async () => {
      const nm = 'ortomosaico_' + field.name.replace(/\W+/g, '_') + (clip && S.limUser ? '_delimitado' : '') + '.tif';
      const out = await AZDesktop.pickSave(nm, 'tif', 'GeoTIFF'); if (!out) return;
      cancel.current = { v: false }; setProg({ pct: 0, msg: 'Preparando…' });
      try { const r = await AZDesktop.tifExport(T.dir, out, poly(), shift, (p, m) => setProg({ pct: p, msg: m }), cancel.current); toast('Ortomosaico exportado: ' + r.w.toLocaleString('es-AR') + '×' + r.h.toLocaleString('es-AR') + ' px · ' + Math.round(r.bytes / 1048576) + ' MB'); if (window.agroDesktop.reveal) window.agroDesktop.reveal(out); onClose(); }
      catch (e) { setProg(null); toast(/cancelad/i.test(e.message) ? 'Exportación cancelada' : 'No se pudo exportar: ' + e.message); }
    };
    return html`<div className="veil" onPointerDown=${e => { if (e.target === e.currentTarget && !prog) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Exportar ortomosaico">
        <div className="mh"><span>Exportar · ortomosaico (.tif)</span>${!prog && html`<button className="lnk" type="button" aria-label="Cerrar" onClick=${onClose}><${Ic} n="close" s=${14}/></button>`}</div>
        <div className="mbody">
          <label className="tog"><input type="checkbox" checked=${clip && S.limUser} disabled=${!S.limUser || !!prog} onChange=${e => setClip(e.target.checked)}/><i></i><span>Recortar al límite del lote (fuera del límite queda transparente)</span></label>
          ${!S.limUser && html`<div className="note w">Todavía no definiste el límite del lote: se exporta todo lo fotografiado. Dibujalo o importá un KML para recortarlo.</div>`}
          <label className="fld"><span className="fl">Resolución</span><select value=${shift} disabled=${!!prog} onChange=${e => setShift(+e.target.value)}>
            ${(plan || []).map(p => html`<option key=${p.shift} value=${p.shift}>${f1(p.mpp * 100, 1)} cm/px · ${p.w.toLocaleString('es-AR')}×${p.h.toLocaleString('es-AR')} px · ~${estMB(p).toLocaleString('es-AR')} MB${p.shift === 0 ? ' (original)' : ''}${p.mpx > 600 ? ' · muy pesado' : ''}</option>`)}</select></label>
          ${opt && opt.mpx > 600 && html`<div className="note w">Esta resolución es muy pesada (más de 600 megapíxeles): puede tardar y superar el límite de 4 GB del formato. Para compartir una referencia conviene una resolución menor.</div>`}
          <div className="mu">GeoTIFF con georreferencia (WGS84, EPSG:4326): se abre en QGIS, Pix4D, John Deere Operations Center y similares. La imagen es idéntica al ortomosaico, sin recompresión con pérdida.</div>
          ${prog && html`<div className="kv-box"><div className="pbar"><div style=${{ width: Math.round(prog.pct * 100) + '%', background: 'var(--ac, #b8f04a)' }}></div></div><div className="mu">${prog.msg}</div></div>`}
        </div>
        <div className="mf">${prog ? html`<button className="btn" type="button" onClick=${() => { cancel.current.v = true; }}>Cancelar</button>` : html`<button className="btn" type="button" onClick=${onClose}>Cerrar</button><button className="btn pri" type="button" disabled=${!opt} onClick=${go}>Exportar .tif</button>`}</div>
      </div></div>`;
  }

  root.AZUI.Dashboard = function Dashboard({ user, field, S, cfg, job, onLogout, onHome, onReconfig }) {
    const [ask, confirmNode] = root.AZUI.useConfirm();
    /* miniatura + hectáreas del lote para la tarjeta del proyecto */
    const capture = async () => {
      try {
        const w = 420, z = w / S.W, cv = document.createElement('canvas'); cv.width = w; cv.height = Math.max(1, Math.round(S.H * z));
        const po = { vis: { sat: 0, ortho: 1, grid: 0, lim: 1 }, orthOp: 100, satOp: 100, gridOp: 0, gridHeld: false, ba: false, baPos: 0.5, tool: 'pan', mouse: null, active: null, heat: 0, brushN: 1 };
        const p = () => AZMap.paint(cv, S, { x: 0, y: 0, z }, po, false, () => { }); p();
        if (S.tiled) for (let i = 0; i < 20 && AZMap.pending() > 0; i++) { await new Promise(r => setTimeout(r, 150)); p(); }
        p(); const t = S.gw ? AZ.stats(S) : null;
        AZApi.fields.update(field.id, { thumb: cv.toDataURL('image/jpeg', 0.72), ha: +(t ? t.lote : AZ.coverHa(S)).toFixed(2), inf: t ? +t.inf.toFixed(2) : null, updated: new Date().toISOString() });
      } catch (e) { }
    };
    const captureR = useRef(capture); captureR.current = capture;
    const saveLot = () => (root.AZLot ? root.AZLot.save(S, { field, cfg, job, stage: 'dash', version: AZSys.VERSION }) : Promise.resolve(false));
    const saveLotR = useRef(saveLot); saveLotR.current = saveLot;
    useEffect(() => { const h = setTimeout(() => captureR.current(), 2500); return () => clearTimeout(h); }, []);
    const goHome = async () => { await saveLotR.current(); await captureR.current(); onHome(); };      // el lote queda guardado y se reabre al instante
    const reconfig = () => ask('Reconfigurar la grilla reinicia la detección y las capas.', 'Reconfigurar', '¿Reconfigurar la grilla?').then(ok => { if (ok) onReconfig(); });
    const [rev, bump] = useReducer(x => x + 1, 0);
    useEffect(() => { if (rev === 0) return; const h = setTimeout(() => saveLotR.current(), 3000); return () => clearTimeout(h); }, [rev]);   // autoguardado 3 s después del último cambio
    const [ui, setUi] = useState(() => ({ ...baseUi(), active: 'det', sel: ['det'], drag: null, menu: null, ctx: null, dockR: true, tabA: 'res', tabB: 'capas', add: null, shift: false, exportOpen: false, help: false, yld: 3000 }));
    const uiR = useRef(ui); uiR.current = ui;
    const set = p => setUi(u => ({ ...u, ...p }));
    const [toast, toastEl] = useToast();
    const held = useRef(false), mapApi = useRef({});
    const [ex, setEx] = useState({ machine: 'jd-gen5', mode: 'apl', unit: 'L/ha', dose: '80', price: '' });
    const M = S.meta;

    const refresh = () => { if (M.buf.on) AZ.calcBuf(S); bump(); };
    const setTool = t => { if (t !== 'poly') S.tmp = []; set({ tool: t, heat: t === 'wand' ? 1 : uiR.current.heat }); mapApi.current.redraw && mapApi.current.redraw(); };
    useEffect(() => { if (!S.det || S.det.length !== S.gw * S.gh) AZ.mergeDet(S); AZ.calcBuf(S); bump(); }, []);

    useSpace(held, mapApi, e => {
      if (KEYS[e.code]) setTool(KEYS[e.code]);
      else if (e.code === 'KeyI') set({ ba: !uiR.current.ba });
      else if (e.code === 'Escape') { S.tmp = []; set({ menu: null, ctx: null }); mapApi.current.redraw(); }
    });
    const combineR = useRef(null);
    useEffect(() => {
      const kd = e => {
        if (e.key === 'Shift' && !uiR.current.shift) set({ shift: true });
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyE') { e.preventDefault(); combineR.current && combineR.current(); }
      };
      const ku = e => { if (e.key === 'Shift') set({ shift: false }); };
      const bl = () => set({ shift: false });
      addEventListener('keydown', kd); addEventListener('keyup', ku); addEventListener('blur', bl);
      return () => { removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('blur', bl); };
    }, []);
    useEffect(() => {
      const pd = e => { if (!e.target.closest || (!e.target.closest('[data-menu]') && !e.target.closest('.ctxm') && !e.target.closest('.addm'))) setUi(u => (u.menu || u.ctx || u.add ? { ...u, menu: null, ctx: null, add: null } : u)); };
      addEventListener('pointerdown', pd); return () => removeEventListener('pointerdown', pd);
    }, []);

    /* ----- límite ----- */
    const polyChanged = () => { AZ.polyChanged(S); refresh(); };
    const closePoly = () => { if (S.tmp.length < 3) return toast('El límite necesita al menos 3 vértices'); S.poly = S.tmp; S.tmp = []; polyChanged(); setTool('edit'); };
    const resetPoly = () => { S.poly = [[0, 0], [S.W, 0], [S.W, S.H], [0, S.H]]; polyChanged(); S.limUser = false; refresh(); };

    /* ----- capas ----- */
    const addHistNamed = () => { const id = AZ.addHist(S, 'exg'); set({ active: id, sel: [id], tool: 'wand', heat: 1, ctx: null, add: null, tabB: 'props' }); refresh(); toast('Capa de histograma: fijá el rango en el histograma o usá la selección smart (Mayús suma zonas)'); };
    const addHist = addHistNamed;
    const addAmb = () => { if (S.amb) { set({ active: 'amb', sel: ['amb'], ctx: null, add: null, tabB: 'props' }); return toast('Ya existe la capa Ambientación'); } AZ.addAmb(S); set({ active: 'amb', sel: ['amb'], tool: 'pan', heat: 0, ctx: null, add: null, tabB: 'props' }); refresh(); toast('Ambientación creada: 5 niveles de color. Poné 0 L/ha en los infértiles y la dosis (ej. 40) en el fértil'); };
    const addNdvi = () => { const real = !!S.idx.ndvi, id = AZ.addHist(S, real ? 'ndvi' : 'exg', real ? 'NDVI' : 'NDVI (aprox. verdor)'); set({ active: id, sel: [id], tool: 'wand', heat: 1, ctx: null, add: null, tabB: 'props' }); refresh(); toast(real ? 'Capa NDVI creada: seleccioná zonas con la selección smart' : 'Este lote no tiene banda NIR cargada: la capa usa el verdor ExG como aproximación del NDVI'); };
    const addMan = () => { if (S.man) return toast('Ya existe una capa de detección manual'); AZ.addManual(S); set({ active: 'man', sel: ['man'], tool: 'brush', ctx: null, add: null }); refresh(); toast('Detección manual creada: pintá con el pincel'); };
    const addBuf = () => { if (M.buf.on) return; M.buf.on = true; M.buf.m = M.buf.m || 2; M.buf.vis = true; AZ.calcBuf(S); set({ active: 'buf', sel: ['buf'], ctx: null, add: null, tabB: 'props' }); bump(); };
    const removeLayer = id => {
      if (id === 'amb') { AZ.removeLayer(S, 'amb'); } else if (id === 'buf') { M.buf.on = false; AZ.calcBuf(S); } else if (id === 'det') { return toast('La capa de detección principal no se elimina: usá el borrador'); } else AZ.removeLayer(S, id);
      if (uiR.current.active === id) set({ active: 'det', sel: ['det'] }); else set({ sel: (uiR.current.sel || []).filter(x => x !== id) }); refresh();
    };
    const obj = id => id === 'amb' ? S.amb : id === 'det' ? M.det : id === 'man' ? M.man : id === 'buf' ? M.buf : S.hl.find(l => l.id === id);
    const rowOf = id => id === 'amb' ? { id, name: S.amb.name, kind: 'amb' } : id === 'det' ? { id, name: M.det.name, kind: 'det' } : id === 'man' ? { id, name: M.man.name, kind: 'man' } : id === 'buf' ? { id, name: 'Buffer · ' + f1(M.buf.m, 1) + ' m', kind: 'buf' } : { id, name: S.hl.find(l => l.id === id).name, kind: 'hist' };
    const rows = [
      ...AZ.layerIds(S).map(rowOf),
      { id: 'lim', name: 'Límites del lote', color: '#ffffff', kind: 'lim' },
      { id: 'ortho', name: 'Ortomosaico original', color: '#9aa39d', kind: 'img' },
      { id: 'sat', name: 'Imagen satelital (referencia)', color: '#7aa6c9', kind: 'img' }
    ];
    const sel = (ui.sel || []).filter(id => rows.some(r => r.id === id)), combinable = sel.filter(id => id === 'det' || id === 'man' || S.hl.some(l => l.id === id));
    const pick = (r, e) => {
      const heat = r.kind === 'hist' && ui.tool === 'wand' ? 1 : ui.heat;
      if (r.kind === 'lim' && !(e && (e.ctrlKey || e.metaKey))) { set({ sel: ['lim'], active: 'lim', tool: ui.tool === 'poly' ? 'poly' : 'edit', heat: 0 }); return; }
      if (e && (e.ctrlKey || e.metaKey)) { const has = sel.includes(r.id); set({ sel: has ? sel.filter(x => x !== r.id) : [...sel, r.id], active: has && ui.active === r.id ? (sel.filter(x => x !== r.id)[0] || 'det') : r.id, heat }); }
      else set({ sel: [r.id], active: r.id, heat });
    };
    const combine = () => {
      const withBuf = sel.includes('buf');
      if (withBuf) {
        if (!sel.includes('det')) return toast('El búfer se combina con la detección: seleccioná también "' + M.det.name + '" (Ctrl+clic)');
        const rest = combinable.filter(id => id !== 'det'); if (rest.length) AZ.combineLayers(S, combinable);
        const n = AZ.combineBuf(S); set({ active: 'det', sel: ['det'], ctx: null }); refresh(); return toast('Búfer combinado con "' + M.det.name + '" (+' + n.toLocaleString('es-AR') + ' celdas): ahora es una sola capa');
      }
      const r = AZ.combineLayers(S, combinable); if (!r) return toast('Seleccioná al menos 2 capas (Ctrl+clic) para combinar');
      set({ active: r.target, sel: [r.target], ctx: null }); refresh(); toast('Combinadas: ' + r.names.join(' + '));
    };
    combineR.current = combine;
    const toDet = id => {
      if (id === 'buf') { const n = AZ.combineBuf(S); set({ active: 'det', sel: ['det'], ctx: null }); refresh(); return toast('Búfer convertido a "' + M.det.name + '" (+' + n.toLocaleString('es-AR') + ' celdas)'); }
      const r = AZ.combineLayers(S, [id, 'det']); if (!r) return;
      set({ active: 'det', sel: ['det'], ctx: null }); refresh(); toast('Convertida en detección de zonas: ' + r.cells.toLocaleString('es-AR') + ' celdas · se actualizaron las hectáreas fértiles e infértiles');
    };
    const drop = (toId) => { const d = uiR.current.drag; set({ drag: null, over: null }); if (!d || d === toId) return; AZ.moveLayer(S, d, toId); refresh(); };
    const visOf = r => r.kind === 'img' || r.kind === 'lim' ? !!ui.vis[r.id === 'lim' ? 'lim' : r.id] : obj(r.id).vis;
    const toggleVis = r => { if (r.kind === 'img' || r.kind === 'lim') set({ vis: { ...ui.vis, [r.id]: ui.vis[r.id] ? 0 : 1 } }); else { obj(r.id).vis = !obj(r.id).vis; bump(); } };
    const act = rows.find(r => r.id === ui.active) || rows.find(r => r.id === 'det'), A = act.kind === 'img' || act.kind === 'lim' ? null : obj(act.id);
    const L = act.kind === 'hist' ? A : null;

    const st = useMemo(() => (S.gw ? AZ.stats(S) : null), [rev]);
    const pc = x => (st && st.lote ? x / st.lote * 100 : 0);

    /* ----- proyecto ----- */
    const saveProject = async () => {
      const nrm = a => a.map(p => [p[0] / S.W, p[1] / S.H]);
      const proj = { format: 'agro.dev/project', v: 1, name: field.name + ' · ' + new Date().toLocaleDateString('es-AR'), fieldId: field.id, savedAt: new Date().toISOString(), app: AZSys.VERSION,
        cfg: { kind: cfg.kind, gridM: cfg.gridM, rot: cfg.rot, detName: M.det.name, color: M.det.color, sens: cfg.sens, res: cfg.res, quality: cfg.quality, detail: cfg.detail, lat: S.geo.lat, lon: S.geo.lon, prec: cfg.prec },
        buf: { on: M.buf.on, m: M.buf.m, color: M.buf.color }, poly: nrm(S.poly), pts: S.pts.map(p => ({ u: p.x / S.W, v: p.y / S.H, s: p.v })), stats: st };
      AZFiles.download('agro-dev_' + field.name.replace(/\W+/g, '_') + '.json', JSON.stringify(proj, null, 1), 'application/json');
      try { await AZApi.saveProject(proj); } catch (e) { }
      const okLot = await saveLotR.current();
      captureR.current();
      toast(okLot ? 'Lote guardado completo: se abre al instante desde el proyecto, sin reprocesar (y copia .json de la configuración)' : 'Proyecto guardado (archivo .json y copia en este navegador)');
    };

    const items = {
      file: [{ t: 'Guardar proyecto', on: saveProject }, { t: 'Exportar prescripción / informe…', on: () => set({ exportOpen: true }) }, { t: 'Exportar ortomosaico (.tif)…', on: () => set({ tifOpen: true }), disabled: !(AZDesktop.available && S.tiled) }, { sep: 1 }, { t: 'Reconfigurar grilla y puntos…', on: reconfig }, { t: 'Volver al proyecto', on: goHome }],
      layers: [{ t: 'Combinar capas seleccionadas', on: combine, disabled: combinable.length < 2 && !sel.includes('buf'), k: 'Ctrl+E' }, { sep: 1 }, { t: 'Nueva capa · Histograma', on: addHist }, { t: 'Nueva capa · NDVI', on: addNdvi }, { t: 'Nueva capa · Ambientación', on: addAmb, disabled: !!S.amb }, { t: 'Nueva capa · Búfer', on: addBuf, disabled: M.buf.on }, { t: 'Detección manual', on: addMan, disabled: !!S.man }],
      view: [{ t: 'Imagen satelital', checked: ui.vis.sat, on: () => set({ vis: { ...ui.vis, sat: ui.vis.sat ? 0 : 1 } }) }, { t: 'Grilla', checked: ui.vis.grid, on: () => set({ vis: { ...ui.vis, grid: ui.vis.grid ? 0 : 1 } }), k: 'Espacio' },
        { t: 'Antes / después', checked: ui.ba, on: () => set({ ba: !ui.ba }), k: 'I' }, { t: 'Ajustar vista', on: () => mapApi.current.fit() }, { sep: 1 },
        { t: 'Panel lateral (capas y funciones)', checked: ui.dockR, on: () => set({ dockR: !ui.dockR }) }],
      help: [{ t: 'Atajos de teclado', on: () => set({ help: true }) }]
    };
    const setMenu = m => set({ menu: m });
    const api = { refresh, set, toast, closePoly, polyChanged, onPoint() { } };
    const layerCtx = e => { e.preventDefault(); set({ ctx: { x: Math.min(e.clientX, innerWidth - 250), y: Math.max(10, Math.min(e.clientY, innerHeight - 230)) } }); };

    const hint = { pan: 'Arrastrá para mover · rueda: zoom por pasos · Mayús+rueda: zoom suave · rueda presionada: mano', brush: 'Pintá celdas completas en la capa activa · Ctrl+rueda cambia el tamaño · clic derecho borra', erase: 'Borrá celdas de la capa activa',
      wand: 'Clic: selecciona zonas de color parecido · Mayús+clic (aparece +): suma otra zona · Alt+clic o clic derecho: quita', poly: 'Clic para cada vértice · doble clic o primer vértice para cerrar', edit: 'Arrastrá vértices · tocá un borde para agregar · Shift+clic quita' }[ui.tool];

    return html`<div className="app">
      ${confirmNode}
      <header className="top">
        <div className="brand">agro<i>.dev</i></div><button className="btn sm" type="button" onClick=${goHome} title="Volver a los lotes del proyecto (este lote queda guardado)"><${Ic} n="home" s=${13}/> Inicio</button><span className="crumb">${field.name}</span>
        <${Menu} id="file" label="Archivo" open=${ui.menu} setOpen=${setMenu} items=${items.file}/>
        <${Menu} id="layers" label="Capas" open=${ui.menu} setOpen=${setMenu} items=${items.layers}/>
        <${Menu} id="view" label="Vista" open=${ui.menu} setOpen=${setMenu} items=${items.view}/>
        <${Menu} id="help" label="Ayuda" open=${ui.menu} setOpen=${setMenu} items=${items.help}/>
        <span className="grow"></span><button className="btn pri sm" type="button" onClick=${() => set({ exportOpen: true })}><${Ic} n="download" s=${13}/> Exportar</button>
        <${root.AZUI.GearBtn}/><span className="usr">${user}</span>${root.AZUI.LOGIN && html`<button className="lnk" type="button" onClick=${onLogout}>Salir</button>`}
      </header>

      <div className=${'main' + (ui.dockR ? '' : ' nr')}>
        <div className="tcol"><${Rail} col=${true} tools=${TOOLS} tool=${ui.tool} onTool=${setTool} badge=${ui.shift && ui.tool === 'wand' ? { wand: '+' } : null}/></div>

        <${MapCanvas} S=${S} rev=${rev} ui=${ui} held=${held} api=${api} mapApi=${mapApi}>
          <div className="optbar"><b>${((TOOLS.find(t => t[0] === ui.tool) || [])[2] || '').replace(/ \(.\).*$/, '')}</b><span className="mu">${hint}</span>
            ${(ui.tool === 'brush' || ui.tool === 'erase') && html`<span className="opt">Tamaño ${ui.brushN} celdas · ${f1(ui.brushN * AZ.cellM(S), 1)} m</span>`}
            ${ui.tool === 'wand' && html`<span className="opt">Tolerancia ${ui.tol} %${ui.shift ? ' · modo SUMAR (+)' : ''}</span>`}</div>
          <div className="mapbadge">${st ? (S.limUser ? html`<b>${f1(st.fer)}</b> ha fértil · <b>${f1(st.inf)}</b> ha ${M.det.name}` : 'Definí el límite del lote para ver las hectáreas') : ''}</div>
        <//>

        <aside className="dock dr" aria-label="Panel de capas y funciones">
          <div className="tabs" role="tablist">${[['res', 'Resultados'], ['vista', 'Vista'], ['cur', 'Cursor']].map(([k, t]) => html`<button key=${k} type="button" role="tab" aria-selected=${ui.tabA === k} className=${ui.tabA === k ? 'on' : ''} onClick=${() => set({ tabA: k })}>${t}</button>`)}</div>
          <div className="tpane">
            ${ui.tabA === 'res' && st && html`
              ${S.limUser ? html`<div className="stat"><div className="k">Lote delimitado</div><div className="big">${f1(st.lote)}<small>ha</small></div></div>
              <div className="stat"><div className="k"><i style=${{ background: 'var(--fer)' }}></i>Hectáreas fértiles</div><div className="big">${f1(st.fer)}<small>ha · ${f1(pc(st.fer))} %</small></div><div className="pbar"><div style=${{ width: pc(st.fer) + '%', background: 'var(--fer)' }}></div></div></div>
              <div className="stat"><div className="k"><i style=${{ background: M.det.color }}></i>Hectáreas infértiles</div><div className="big">${f1(st.inf)}<small>ha · ${f1(pc(st.inf))} %</small></div><div className="pbar"><div style=${{ width: pc(st.inf) + '%', background: M.det.color }}></div></div></div>
              <div className="stat"><div className="k">Promedios (${st.idxKey === 'ndvi' ? 'NDVI' : 'verdor ExG'})</div>
                <div className="kv"><span>Fértil</span><span>${f1(st.avgFer, 3)}</span></div><div className="kv"><span>Infértil</span><span>${f1(st.avgInf, 3)}</span></div></div>
              <div className="stat"><div className="k">Por capa</div>
                <div className="kv"><span>${M.det.name} (IA)</span><span>${f1(st.per.det)} ha</span></div>
                ${S.man && html`<div className="kv"><span>${M.man.name}</span><span>${f1(st.per.man)} ha</span></div>`}
                ${S.hl.map(l => html`<div className="kv" key=${l.id}><span>${l.name}</span><span>${f1(st.per[l.id])} ha</span></div>`)}
                ${M.buf.on && html`<div className="kv"><span>Búfer ${f1(M.buf.m, 1)} m</span><span>${f1(st.buf)} ha</span></div>`}</div>
              <div className="stat"><label className="fld"><span className="fl">Rinde potencial (kg/ha)</span><input type="number" min="0" step="100" value=${ui.yld} onInput=${e => set({ yld: e.target.value })}/></label>
                <div className="kv"><span>Pérdida estimada</span><span>${f1(st.inf * (+ui.yld || 0) / 1000)} t</span></div></div>` : html`<div className="stat"><div className="k">Hectáreas del lote</div>
                <div className="mu">Todavía no se definió el límite del lote. Dibujalo o importá un KML/GeoJSON para ver las hectáreas fértiles e infértiles: sin el límite se contarían también los márgenes que fotografía el dron.</div>
                <div className="row"><button className="btn pri sm" type="button" onClick=${() => { set({ active: 'lim', sel: ['lim'], tabB: 'props', tool: 'poly' }); }}>Dibujar límite</button></div></div>`}
              <${LearnBox} rev=${rev}/>
              <div className="row"><button className="btn pri sm" type="button" onClick=${() => set({ exportOpen: true })}>Exportar…</button><button className="btn sm" type="button" onClick=${saveProject}>Guardar proyecto</button></div>
              <div className="stat extra"><div className="k">Dato adicional</div><div className="kv"><span>Superficie fotografiada por el dron</span><span>${f1(st.tot)} ha</span></div>
                <div className="mu">Incluye los márgenes de seguridad que deja el vuelo alrededor del lote: no es una medición del lote.</div></div>`}
            ${ui.tabA === 'vista' && html`<div className="pb">
              <${Slider} label="Opacidad ortomosaico" min=${10} max=${100} value=${ui.orthOp} unit=" %" onChange=${v => set({ orthOp: v })}/>
              <${Slider} label="Opacidad satélite" min=${0} max=${100} value=${ui.satOp} unit=" %" onChange=${v => set({ satOp: v })}/>
              <${Slider} label="Opacidad grilla" min=${0} max=${100} value=${ui.gridOp} unit=" %" onChange=${v => set({ gridOp: v })}/>
              <${Toggle} label="Grilla" checked=${ui.vis.grid} onChange=${v => set({ vis: { ...ui.vis, grid: v ? 1 : 0 } })}/>
              <${Toggle} label="Comparar antes / después (I)" checked=${ui.ba} onChange=${v => set({ ba: v })}/>
              <div className="mu">Mantené <kbd>Espacio</kbd> para ocultar todas las capas y ver solo el ortomosaico.</div></div>`}
            ${ui.tabA === 'cur' && html`<${Legend} S=${S}/>`}
          </div>

          <div className="tabs" role="tablist">${[['capas', 'Capas'], ['props', 'Propiedades']].map(([k, t]) => html`<button key=${k} type="button" role="tab" aria-selected=${ui.tabB === k} className=${ui.tabB === k ? 'on' : ''} onClick=${() => set({ tabB: k })}>${t}</button>`)}</div>
          <div className="lay" onContextMenu=${layerCtx}>
            ${ui.tabB === 'capas' && html`<div className="lrows">${rows.map(r => {
      const o = r.kind === 'img' || r.kind === 'lim' ? null : obj(r.id), color = o ? o.color : r.color, on = visOf(r);
      const mov = r.kind !== 'img' && r.kind !== 'lim';
      return html`<div key=${r.id} data-layer=${r.id} className=${'lrow2' + (ui.active === r.id ? ' act' : '') + (sel.includes(r.id) ? ' sel' : '') + (ui.over === r.id && ui.drag !== r.id ? ' over' : '')}
          draggable=${mov} onDragStart=${e => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', r.id); } catch (x) { } set({ drag: r.id }); }}
          onDragOver=${e => { if (uiR.current.drag) { e.preventDefault(); if (uiR.current.over !== r.id) set({ over: r.id }); } }} onDrop=${e => { e.preventDefault(); drop(mov ? r.id : null); }} onDragEnd=${() => set({ drag: null, over: null })}
          onClick=${e => pick(r, e)} onDoubleClick=${() => { if (r.kind !== 'img') set({ tabB: 'props' }); }} onContextMenu=${() => { if (!sel.includes(r.id)) set({ sel: [r.id], active: r.id }); }}>
          ${mov ? html`<span className="grip" aria-hidden="true" title="Arrastrá para cambiar el orden">⋮⋮</span>` : html`<span className="grip"></span>`}
          ${o && r.kind !== 'amb' ? html`<input type="color" className="sw" value=${color} aria-label=${'Color de ' + r.name} onClick=${e => e.stopPropagation()} onInput=${e => { o.color = e.target.value; S.ver++; bump(); }}/>` : html`<i className="sw" style=${{ background: color }}></i>`}
          <span className="nm">${r.name}</span>
          <button type="button" className=${'ic eye' + (on ? '' : ' off')} aria-label=${on ? 'Ocultar ' + r.name : 'Mostrar ' + r.name} aria-pressed=${on} onClick=${e => { e.stopPropagation(); toggleVis(r); }}><${Ic} n=${on ? 'eye' : 'eyeoff'} s=${15}/></button>
        </div>`;
    })}</div>
            <div className="mu lhint">Ctrl+clic: varias capas · Ctrl+E: combinar · clic derecho: más opciones · arrastrá para ordenar</div>`}
            ${ui.tabB === 'props' && html`<div className="capr"><div className="ph"><span>${act.name}</span><span className="mu">${act.kind === 'det' ? 'Detección IA' : act.kind === 'man' ? 'Detección manual' : act.kind === 'hist' ? 'Histograma / NDVI' : act.kind === 'amb' ? 'Ambientación · 5 niveles' : act.kind === 'buf' ? 'Búfer' : act.kind === 'lim' ? 'Límites' : 'Imagen'}</span></div>
              <div className="pb">
              ${act.kind === 'amb' && html`<${AmbPanel} S=${S} A=${S.amb} rev=${rev} bump=${bump} toast=${toast} refresh=${refresh}/>`}
              ${(act.kind === 'det' || act.kind === 'man' || act.kind === 'hist') && html`<label className="fld"><span className="fl">Nombre</span><input type="text" maxLength="40" value=${A.name} onInput=${e => { A.name = e.target.value; bump(); }}/></label>
                <label className="tog" title="Incluir al combinar y exportar"><input type="checkbox" checked=${!!A.inc} onChange=${e => { A.inc = e.target.checked; AZ.mchange(S); refresh(); }}/><i></i><span>Incluir en el resultado y la exportación</span></label>`}
              ${(ui.tool === 'brush' || ui.tool === 'erase') && html`<${Slider} label="Tamaño del pincel" min=${1} max=${40} value=${ui.brushN} fmt=${v => v + ' celdas'} unit=${' · ' + f1(ui.brushN * AZ.cellM(S), 1) + ' m'} onChange=${v => set({ brushN: v })}/>
                <div className="mu">Con el pincel, <kbd>Ctrl</kbd>+rueda hacia arriba agranda y hacia abajo achica.</div>`}
              ${ui.tool === 'wand' && html`<${Slider} label="Tolerancia de color" min=${1} max=${40} value=${ui.tol} unit=" %" onChange=${v => set({ tol: v })}/>`}
              ${act.id === 'ortho' && html`<${Slider} label="Opacidad" min=${10} max=${100} value=${ui.orthOp} unit=" %" onChange=${v => set({ orthOp: v })}/>`}
              ${act.id === 'sat' && html`<${Slider} label="Opacidad" min=${0} max=${100} value=${ui.satOp} unit=" %" onChange=${v => set({ satOp: v })}/><div className="mu">Imagen satelital de referencia para verificar la ubicación del vuelo.</div>`}
              ${act.kind === 'lim' && html`<div className="kv"><span>Dentro del límite</span><span>${f1(st ? st.lote : 0)} ha</span></div><div className="kv"><span>Vértices</span><span>${S.poly.length}</span></div>
                <div className="row"><button className=${'btn sm' + (ui.tool === 'poly' ? ' pri' : '')} type="button" onClick=${() => setTool('poly')}>Dibujar (L)</button><button className=${'btn sm' + (ui.tool === 'edit' ? ' pri' : '')} type="button" onClick=${() => setTool('edit')}>Editar vértices (M)</button></div>
                <button className="btn sm" type="button" onClick=${resetPoly}>Restablecer (imagen completa)</button>
                <div className="mu">Arrastrá un vértice para moverlo, tocá un borde para agregar uno, Mayús+clic lo quita. Al cambiar el límite se recalculan las hectáreas.</div>`}
              ${act.kind === 'det' && html`<div className="mu">Resultado de la IA a partir de tus puntos (+)/(−) más lo que agregues con pincel y borrador.</div>
                <div className="row"><button className="btn sm" type="button" onClick=${() => setTool('brush')}>Pincel (B)</button><button className="btn sm" type="button" onClick=${() => setTool('erase')}>Borrador (E)</button></div>`}
              ${act.kind === 'man' && html`<div className="mu">Capa separada para marcar a mano. Cuando estés conforme, convertila en detección.</div>
                <div className="row"><button className="btn sm" type="button" onClick=${() => setTool('brush')}>Pincel (B)</button><button className="btn pri sm" type="button" onClick=${() => toDet('man')}>Convertir a Detección de zonas</button></div>`}
              ${act.kind === 'buf' && html`<${Slider} label="Distancia del búfer" min=${0.5} max=${10} step=${0.5} value=${M.buf.m} unit=" m" fmt=${v => f1(v, 1)} onChange=${() => { }} onCommit=${v => { M.buf.m = v; AZ.calcBuf(S); bump(); }}/>
                <div className="mu">Margen alrededor de lo detectado, de 0,5 a 10 m (se redondea a celdas enteras: mínimo 1 celda = ${f1(AZ.cellM(S), 2)} m). Se exporta como zona sin aplicación, sin necesidad de combinarlo.</div>
                <button className="btn pri sm" type="button" onClick=${() => toDet('buf')}>Combinar con "${M.det.name}" (opcional)</button>
                <div className="mu">Al combinar, la zona afectada crece con el búfer y queda una sola capa.</div>`}
              ${L && html`<label className="fld"><span className="fl">Índice de color</span><select value=${L.idx} onChange=${e => { AZ.histIdx(S, L, e.target.value); bump(); }}>${Object.keys(S.idx).map(k => html`<option key=${k} value=${k}>${IDX[k] || k}</option>`)}</select></label>
                <${Hist} S=${S} L=${L} rev=${rev} onRange=${(a, b) => { AZ.histRange(S, L, a, b); bump(); }}/>
                <div className="mu">Arrastrá en el histograma para fijar un rango (vista previa blanca en el mapa) o usá la <b>selección smart (W)</b>: clic en una zona de color parecido; con <kbd>Mayús</kbd> apretada (aparece +) sumás más zonas a la misma capa.</div>
                <div className="row"><button className="btn sm" type="button" disabled=${!L.prev} onClick=${() => { const n = AZ.selectRange(S, L); refresh(); toast(n.toLocaleString('es-AR') + ' celdas seleccionadas'); }}>Seleccionar rango</button><button className="btn sm" type="button" onClick=${() => { AZ.clearLayer(S, L); refresh(); }}>Limpiar</button></div>
                <button className=${'btn sm' + (ui.tool === 'wand' ? ' pri' : '')} type="button" onClick=${() => setTool('wand')}>Selección smart (W)</button>
                <button className="btn pri sm" type="button" onClick=${() => toDet('' + L.id)}>Convertir a Detección de zonas</button>`}
              </div></div>`}
          </div>
          <div className="ltool">
            <button type="button" className="ic" aria-label="Nueva capa" title="Nueva capa" onClick=${e => { const r = e.currentTarget.getBoundingClientRect(); set({ add: { x: r.left, y: r.top } }); }}><${Ic} n="plus" s=${16}/></button>
            <button type="button" className="ic" aria-label="Combinar capas seleccionadas (Ctrl+E)" title="Combinar capas seleccionadas (Ctrl+E)" disabled=${combinable.length < 2 && !sel.includes('buf')} onClick=${combine}><${Ic} n="layers" s=${16}/></button>
            <span className="grow"></span>
            <button type="button" className="ic" aria-label="Eliminar capa" title="Eliminar capa" disabled=${act.kind === 'img' || act.kind === 'det' || act.kind === 'lim'} onClick=${() => removeLayer(act.id)}><${Ic} n="trash" s=${16}/></button>
          </div>
        </aside>
      </div>
      ${ui.add && html`<div className="md addm" role="menu" style=${{ position: 'fixed', left: Math.min(ui.add.x, innerWidth - 230), top: ui.add.y - 150 }}>
        <button type="button" className="mi" role="menuitem" disabled=${M.buf.on} onClick=${addBuf}><span className="ck"></span><span>Búfer</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" onClick=${addHist}><span className="ck"></span><span>Histograma</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" onClick=${addNdvi}><span className="ck"></span><span>NDVI</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" disabled=${!!S.amb} onClick=${addAmb}><span className="ck"></span><span>Ambientación (5 niveles)</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" disabled=${!!S.man} onClick=${addMan}><span className="ck"></span><span>Detección manual</span><kbd></kbd></button></div>`}

      ${ui.ctx && html`<div className="md ctxm" role="menu" style=${{ position: 'fixed', left: ui.ctx.x, top: ui.ctx.y }}>
        ${(combinable.length >= 2 || (sel.includes('buf') && sel.includes('det'))) && html`<button type="button" className="mi" role="menuitem" onClick=${combine}><span className="ck"></span><span><b>Combinar capas seleccionadas</b></span><kbd>Ctrl+E</kbd></button>`}
        ${(act.kind === 'hist' || act.kind === 'man' || act.kind === 'buf') && html`<button type="button" className="mi" role="menuitem" onClick=${() => toDet(act.id)}><span className="ck"></span><span><b>Convertir a Detección de zonas</b></span><kbd></kbd></button>`}
        ${act.kind !== 'img' && act.kind !== 'det' && act.kind !== 'lim' && html`<button type="button" className="mi" role="menuitem" onClick=${() => removeLayer(act.id)}><span className="ck"></span><span>Eliminar capa</span><kbd></kbd></button>`}
        <button type="button" className="mi" role="menuitem" disabled=${M.buf.on} onClick=${addBuf}><span className="ck"></span><span>Nueva capa · Búfer</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" onClick=${addHist}><span className="ck"></span><span>Nueva capa · Histograma</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" onClick=${addNdvi}><span className="ck"></span><span>Nueva capa · NDVI</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" disabled=${!!S.amb} onClick=${addAmb}><span className="ck"></span><span>Nueva capa · Ambientación</span><kbd></kbd></button></div>`}
      ${ui.tifOpen && html`<${TifDialog} S=${S} field=${field} onClose=${() => set({ tifOpen: false })} toast=${toast}/>`}
      ${ui.exportOpen && html`<${ExportDialog} S=${S} field=${field} ex=${ex} setEx=${setEx} yld=${ui.yld} onClose=${() => set({ exportOpen: false })} toast=${toast}/>`}
      ${ui.help && html`<div className="veil" onPointerDown=${e => { if (e.target === e.currentTarget) set({ help: false }); }}><div className="login" style=${{ width: 420 }} role="dialog" aria-label="Atajos"><h2>Atajos de teclado</h2>
        <div className="kv"><span>Mover</span><kbd>V</kbd></div><div className="kv"><span>Pincel / Borrador</span><kbd>B / E</kbd></div><div className="kv"><span>Selección smart (Mayús suma)</span><kbd>W</kbd></div>
        <div className="kv"><span>Dibujar / editar límite</span><kbd>L / M</kbd></div><div className="kv"><span>Ocultar todas las capas (mantener)</span><kbd>Espacio</kbd></div><div className="kv"><span>Combinar capas</span><kbd>Ctrl+E</kbd></div><div className="kv"><span>Zoom por pasos / suave</span><kbd>Rueda / Mayús+rueda</kbd></div><div className="kv"><span>Mano (sin zoom)</span><kbd>Rueda presionada</kbd></div><div className="kv"><span>Tamaño del pincel</span><kbd>Ctrl+rueda</kbd></div>
        <div className="kv"><span>Comparar antes / después</span><kbd>I</kbd></div><div className="kv"><span>Selección smart: sumar / quitar</span><kbd>Mayús+clic / Alt+clic</kbd></div><div className="kv"><span>Capas: seleccionar varias</span><kbd>Ctrl+clic</kbd></div>
        <button className="btn" type="button" onClick=${() => set({ help: false })}>Cerrar</button></div></div>`}
      ${toastEl}
    </div>`;
  };
})(window);
