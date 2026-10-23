/* agro.dev · dashboard principal: resultados (derecha), capas (abajo), herramientas (izquierda), exportación */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef, useReducer, useMemo } = React;
  const { html, Ic, Slider, Toggle, Seg, Menu, MapCanvas, Rail, baseUi, useSpace, useToast, f1 } = root.AZUI;

  const TOOLS = [['pan', 'move', 'Mover (V)'], ['brush', 'brush', 'Pincel (B)'], ['erase', 'eraser', 'Borrador (E)'], ['wand', 'wand', 'Varita mágica (W)'], ['poly', 'poly', 'Dibujar límite (L)'], ['edit', 'edit', 'Editar límite (M)']];
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
    const U = c.unit.split('/')[0], valid = +ex.dose > 0;
    const okOnly = (fn) => { if (!valid) return toast('Ingresá una dosis mayor que 0'); try { fn(); } catch (e) { toast('No se pudo exportar: ' + e.message); } };
    const prescription = () => okOnly(() => { const z = AZ.X.prescriptionZip(S, o); AZFiles.download(z.name, z.bytes, 'application/zip'); toast('Prescripción exportada: ' + z.n.toLocaleString('es-AR') + ' polígonos'); });
    const geo = () => okOnly(() => AZFiles.download('agro-dev_' + field.name.replace(/\W+/g, '_') + '.geojson', JSON.stringify(AZ.X.geojson(S, o)), 'application/geo+json'));
    const report = () => okOnly(() => {
      const w = 1400, z = w / S.W, cv = document.createElement('canvas'); cv.width = w; cv.height = Math.round(S.H * z);
      AZMap.paint(cv, S, { x: 0, y: 0, z }, { vis: { sat: 0, ortho: 1, grid: 0, lim: 1 }, orthOp: 100, satOp: 100, gridOp: 0, gridHeld: false, ba: false, baPos: 0.5, tool: 'pan', mouse: null, active: null, heat: 0, brushN: 1 }, false, () => { });
      const h = AZ.X.reportHtml(S, { ...o, img: cv.toDataURL('image/jpeg', 0.85) }).replace('</body>', '<script>setTimeout(function(){print()},500)<\/script></body>');
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
            <label className="fld"><span className="fl">Dosis objetivo en zona fértil</span><div className="row"><input type="number" min="0" step="0.1" value=${ex.dose} onInput=${e => set({ dose: e.target.value })} aria-label="Dosis"/>
              ${ex.mode === 'fer' ? html`<select className="fx" value=${ex.unit} onChange=${e => set({ unit: e.target.value })}><option>L/ha</option><option>kg/ha</option></select>` : html`<span className="mu fx">${c.unit}</span>`}</div></label>
            <label className="fld"><span className="fl">Precio por ${U} (opcional)</span><input type="number" min="0" step="0.01" value=${ex.price} onInput=${e => set({ price: e.target.value })} aria-label="Precio"/></label>
          </div>
          <div className="kv-box">
            <div className="kv"><span>Lote</span><span>${f1(c.loteHa)} ha</span></div>
            <div className="kv"><span>A tratar (fértil${S.meta.buf.on ? ', sin buffer' : ''})</span><span>${f1(c.treatHa)} ha</span></div>
            <div className="kv"><span>Omitido (infértil${S.meta.buf.on ? ' + buffer' : ''})</span><span>${f1(c.skipHa)} ha</span></div>
            <div className="kv"><span>Consumo aplicando todo el lote</span><span>${f1(c.base, 0)} ${U}</span></div>
            <div className="kv"><span>Consumo con prescripción</span><span>${f1(c.used, 0)} ${U}</span></div>
            <div className="kv"><span><b>Ahorro</b></span><span><b className="sv">${f1(c.save, 0)} ${U} · ${f1(c.savePct)} %</b></span></div>
            <div className="kv"><span>Dosis media sobre el lote</span><span>${f1(c.avg, 2)} ${c.unit}</span></div>
            ${c.price > 0 && html`<div className="kv"><span>Ahorro económico</span><span>$ ${f1(c.money, 0)}</span></div>`}
          </div>
          <div className="note">Se combinan todas las capas incluidas. Mapa de prescripción: <b>fértil = dosis</b>, <b>infértil${S.meta.buf.on ? ' y buffer' : ''} = 0</b>. Validá el archivo en el display GEN5 con una prueba de campo antes de aplicar; no está verificado en equipos reales.</div>
        </div>
        <div className="mf"><button className="btn" type="button" onClick=${geo}>GeoJSON</button><button className="btn" type="button" onClick=${report}>Informe PDF</button><button className="btn pri" type="button" onClick=${prescription}>Prescripción (.zip)</button></div>
      </div></div>`;
  }

  root.AZUI.Dashboard = function Dashboard({ user, field, S, cfg, job, onLogout, onHome, onReconfig }) {
    const [rev, bump] = useReducer(x => x + 1, 0);
    const [ui, setUi] = useState(() => ({ ...baseUi(), active: 'det', menu: null, ctx: null, dockL: true, dockR: true, exportOpen: false, help: false, yld: 3000 }));
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
    useEffect(() => {
      const pd = e => { if (!e.target.closest || (!e.target.closest('[data-menu]') && !e.target.closest('.ctxm'))) setUi(u => (u.menu || u.ctx ? { ...u, menu: null, ctx: null } : u)); };
      addEventListener('pointerdown', pd); return () => removeEventListener('pointerdown', pd);
    }, []);

    /* ----- límite ----- */
    const polyChanged = () => { AZ.polyChanged(S); refresh(); };
    const closePoly = () => { if (S.tmp.length < 3) return toast('El límite necesita al menos 3 vértices'); S.poly = S.tmp; S.tmp = []; polyChanged(); setTool('edit'); };
    const resetPoly = () => { S.poly = [[0, 0], [S.W, 0], [S.W, S.H], [0, S.H]]; polyChanged(); };

    /* ----- capas ----- */
    const addHist = () => { const id = AZ.addHist(S); set({ active: id, tool: 'wand', heat: 1, ctx: null }); refresh(); toast('Capa de histograma: arrastrá las barras de umbral y usá la varita (Ctrl+clic suma, clic derecho borra)'); };
    const addMan = () => { if (S.man) return toast('Ya existe una capa de detección manual'); AZ.addManual(S); set({ active: 'man', tool: 'brush', ctx: null }); refresh(); toast('Detección manual creada: pintá con el pincel'); };
    const addBuf = () => { if (M.buf.on) return; M.buf.on = true; M.buf.m = M.buf.m || 2; M.buf.vis = true; AZ.calcBuf(S); set({ active: 'buf', ctx: null }); bump(); };
    const removeLayer = id => {
      if (id === 'buf') { M.buf.on = false; AZ.calcBuf(S); } else if (id === 'det') { return toast('La capa de detección principal no se elimina: usá el borrador'); } else AZ.removeLayer(S, id);
      if (uiR.current.active === id) set({ active: 'det' }); refresh();
    };
    const obj = id => id === 'det' ? M.det : id === 'man' ? M.man : id === 'buf' ? M.buf : S.hl.find(l => l.id === id);
    const rows = [
      { id: 'ortho', name: 'Ortomosaico original', color: '#9aa39d', kind: 'img' },
      { id: 'det', name: M.det.name, kind: 'det' }, ...(S.man ? [{ id: 'man', name: M.man.name, kind: 'man' }] : []),
      ...S.hl.map(l => ({ id: l.id, name: l.name, kind: 'hist' })), ...(M.buf.on ? [{ id: 'buf', name: 'Buffer · ' + f1(M.buf.m, 1) + ' m', kind: 'buf' }] : []),
      { id: 'sat', name: 'Imagen satelital (referencia)', color: '#7aa6c9', kind: 'img' }
    ];
    const visOf = r => r.kind === 'img' ? !!ui.vis[r.id] : obj(r.id).vis;
    const toggleVis = r => { if (r.kind === 'img') set({ vis: { ...ui.vis, [r.id]: ui.vis[r.id] ? 0 : 1 } }); else { obj(r.id).vis = !obj(r.id).vis; bump(); } };
    const act = rows.find(r => r.id === ui.active) || rows[1], A = act.kind === 'img' ? null : obj(act.id);
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
      toast('Proyecto guardado (archivo .json y copia en este navegador)');
    };

    const items = {
      file: [{ t: 'Guardar proyecto', on: saveProject }, { t: 'Exportar prescripción / informe…', on: () => set({ exportOpen: true }) }, { sep: 1 }, { t: 'Reconfigurar grilla y puntos…', on: onReconfig }, { t: 'Cambiar de terreno', on: onHome }],
      layers: [{ t: 'Capa de histograma', on: addHist }, { t: 'Detección manual', on: addMan, disabled: !!S.man }, { t: 'Buffer', on: addBuf, disabled: M.buf.on }],
      view: [{ t: 'Imagen satelital', checked: ui.vis.sat, on: () => set({ vis: { ...ui.vis, sat: ui.vis.sat ? 0 : 1 } }) }, { t: 'Grilla', checked: ui.vis.grid, on: () => set({ vis: { ...ui.vis, grid: ui.vis.grid ? 0 : 1 } }), k: 'Espacio' },
        { t: 'Antes / después', checked: ui.ba, on: () => set({ ba: !ui.ba }), k: 'I' }, { t: 'Ajustar vista', on: () => mapApi.current.fit() }, { sep: 1 },
        { t: 'Panel de herramientas', checked: ui.dockL, on: () => set({ dockL: !ui.dockL }) }, { t: 'Panel de resultados', checked: ui.dockR, on: () => set({ dockR: !ui.dockR }) }],
      help: [{ t: 'Atajos de teclado', on: () => set({ help: true }) }]
    };
    const setMenu = m => set({ menu: m });
    const api = { refresh, set, toast, closePoly, polyChanged, onPoint() { } };
    const layerCtx = e => { e.preventDefault(); set({ ctx: { x: Math.min(e.clientX, innerWidth - 230), y: Math.max(10, Math.min(e.clientY, innerHeight - 140)) } }); };

    const hint = { pan: 'Arrastrá para mover · rueda para zoom', brush: 'Pintá celdas completas en la capa activa · clic derecho borra', erase: 'Borrá celdas de la capa activa',
      wand: 'Clic: seleccionar zona · Ctrl+clic: sumar · clic derecho: borrar zona', poly: 'Clic para cada vértice · doble clic o primer vértice para cerrar', edit: 'Arrastrá vértices · tocá un borde para agregar · Shift+clic quita' }[ui.tool];

    return html`<div className="app">
      <header className="top">
        <div className="brand">agro<i>.dev</i></div><span className="crumb">${field.name}</span>
        <${Menu} id="file" label="Archivo" open=${ui.menu} setOpen=${setMenu} items=${items.file}/>
        <${Menu} id="layers" label="Capas" open=${ui.menu} setOpen=${setMenu} items=${items.layers}/>
        <${Menu} id="view" label="Vista" open=${ui.menu} setOpen=${setMenu} items=${items.view}/>
        <${Menu} id="help" label="Ayuda" open=${ui.menu} setOpen=${setMenu} items=${items.help}/>
        <span className="grow"></span><button className="btn pri sm" type="button" onClick=${() => set({ exportOpen: true })}><${Ic} n="download" s=${13}/> Exportar</button>
        <span className="usr">${user}</span><button className="lnk" type="button" onClick=${onLogout}>Salir</button>
      </header>

      <div className=${'main' + (ui.dockL ? '' : ' nl') + (ui.dockR ? '' : ' nr')}>
        <aside className="dock dl" aria-label="Herramientas">
          <div className="ph"><span>Herramienta</span><span className="mu">${((TOOLS.find(t => t[0] === ui.tool) || [])[2] || '').replace(/ \(.\)$/, '')}</span></div>
          <div className="pb"><div className="mu">${hint}</div>
            ${(ui.tool === 'brush' || ui.tool === 'erase') && html`<${Slider} label="Tamaño del pincel" min=${1} max=${40} value=${ui.brushN} fmt=${v => v + ' celdas'} unit=${' · ' + f1(ui.brushN * AZ.cellM(S), 1) + ' m'} onChange=${v => set({ brushN: v })}/>
              <div className="mu">Pinta celdas completas de la grilla (${f1(AZ.cellM(S), 2)} m). Capa activa: <b>${act.name}</b>.</div>`}
            ${ui.tool === 'wand' && html`<${Slider} label="Tolerancia" min=${1} max=${40} value=${ui.tol} unit=" %" onChange=${v => set({ tol: v })}/>
              ${!L && html`<div className="note w">Elegí una capa de histograma en el panel inferior.</div>`}`}
            ${(ui.tool === 'poly' || ui.tool === 'edit') && html`<button className="btn sm" type="button" onClick=${resetPoly}>Restablecer límite (imagen completa)</button>`}
          </div>
          <div className="ph"><span>Vista</span></div>
          <div className="pb">
            <${Slider} label="Opacidad ortomosaico" min=${10} max=${100} value=${ui.orthOp} unit=" %" onChange=${v => set({ orthOp: v })}/>
            <${Slider} label="Opacidad satélite" min=${0} max=${100} value=${ui.satOp} unit=" %" onChange=${v => set({ satOp: v })}/>
            <${Slider} label="Opacidad grilla" min=${0} max=${100} value=${ui.gridOp} unit=" %" onChange=${v => set({ gridOp: v })}/>
            <${Toggle} label="Grilla (mantené Espacio para ocultar)" checked=${ui.vis.grid} onChange=${v => set({ vis: { ...ui.vis, grid: v ? 1 : 0 } })}/>
            <${Toggle} label="Comparar antes / después (I)" checked=${ui.ba} onChange=${v => set({ ba: v })}/>
          </div>
          <div className="ph"><span>Cursor</span></div><${Legend} S=${S}/>
        </aside>

        <${MapCanvas} S=${S} rev=${rev} ui=${ui} held=${held} api=${api} mapApi=${mapApi}>
          <${Rail} tools=${TOOLS} tool=${ui.tool} onTool=${setTool}/>
          <div className="mapbadge">${st ? html`<b>${f1(st.fer)}</b> ha fértil · <b>${f1(st.inf)}</b> ha ${M.det.name}` : ''}</div>
        <//>

        <aside className="dock dr" aria-label="Resultados">
          <div className="ph"><span>Resultados</span></div>
          ${st && html`<div className="stat"><div className="k">Superficie relevada</div><div className="big">${f1(st.tot)}<small>ha</small></div><div className="mu">Lote delimitado: ${f1(st.lote)} ha</div></div>
            <div className="stat"><div className="k"><i style=${{ background: 'var(--fer)' }}></i>Hectáreas fértiles</div><div className="big">${f1(st.fer)}<small>ha · ${f1(pc(st.fer))} %</small></div><div className="pbar"><div style=${{ width: pc(st.fer) + '%', background: 'var(--fer)' }}></div></div></div>
            <div className="stat"><div className="k"><i style=${{ background: M.det.color }}></i>Hectáreas infértiles</div><div className="big">${f1(st.inf)}<small>ha · ${f1(pc(st.inf))} %</small></div><div className="pbar"><div style=${{ width: pc(st.inf) + '%', background: M.det.color }}></div></div></div>
            <div className="stat"><div className="k">Promedios (${st.idxKey === 'ndvi' ? 'NDVI' : 'verdor ExG'})</div>
              <div className="kv"><span>Fértil</span><span>${f1(st.avgFer, 3)}</span></div><div className="kv"><span>Infértil</span><span>${f1(st.avgInf, 3)}</span></div>
              <div className="kv"><span>Diferencia</span><span>${f1(st.avgFer - st.avgInf, 3)}</span></div></div>
            <div className="stat"><div className="k">Por capa</div>
              <div className="kv"><span>${M.det.name} (IA)</span><span>${f1(st.per.det)} ha</span></div>
              ${S.man && html`<div className="kv"><span>${M.man.name}</span><span>${f1(st.per.man)} ha</span></div>`}
              ${S.hl.map(l => html`<div className="kv" key=${l.id}><span>${l.name}</span><span>${f1(st.per[l.id])} ha</span></div>`)}
              ${M.buf.on && html`<div className="kv"><span>Buffer ${f1(M.buf.m, 1)} m</span><span>${f1(st.buf)} ha</span></div>`}</div>
            <div className="stat"><label className="fld"><span className="fl">Rinde potencial (kg/ha)</span><input type="number" min="0" step="100" value=${ui.yld} onInput=${e => set({ yld: e.target.value })}/></label>
              <div className="kv"><span>Pérdida estimada</span><span>${f1(st.inf * (+ui.yld || 0) / 1000)} t</span></div></div>`}
          <div className="pb" style=${{ paddingTop: 12 }}><button className="btn pri" type="button" onClick=${() => set({ exportOpen: true })}>Exportar prescripción…</button><button className="btn" type="button" onClick=${saveProject}>Guardar proyecto</button></div>
        </aside>

        <section className="dock db caps" aria-label="Capas" onContextMenu=${layerCtx}>
          <div className="capl">
            <div className="ph"><span>Capas</span><button className="btn sm" type="button" aria-label="Agregar capa" onClick=${e => { const r = e.currentTarget.getBoundingClientRect(); set({ ctx: { x: r.left, y: r.top - 118 } }); }}><${Ic} n="plus" s=${13}/> Capa</button></div>
            <div className="lrows">${rows.map(r => {
      const o = r.kind === 'img' ? null : obj(r.id), color = o ? o.color : r.color, on = visOf(r);
      return html`<div key=${r.id} className=${'lrow2' + (ui.active === r.id ? ' act' : '')} onClick=${() => set({ active: r.id, heat: r.kind === 'hist' && ui.tool === 'wand' ? 1 : ui.heat })}>
          <button type="button" className="ic" aria-label=${on ? 'Ocultar' : 'Mostrar'} aria-pressed=${on} onClick=${e => { e.stopPropagation(); toggleVis(r); }}><${Ic} n=${on ? 'eye' : 'eyeoff'} s=${14}/></button>
          ${o ? html`<input type="color" className="sw" value=${color} aria-label=${'Color de ' + r.name} onClick=${e => e.stopPropagation()} onInput=${e => { o.color = e.target.value; S.ver++; bump(); }}/>` : html`<i className="sw" style=${{ background: color }}></i>`}
          ${ui.active === r.id && (r.kind === 'det' || r.kind === 'man' || r.kind === 'hist') ? html`<input type="text" className="nm" value=${o.name} maxLength="40" aria-label="Nombre de la capa" onClick=${e => e.stopPropagation()} onInput=${e => { o.name = e.target.value; bump(); }}/>` : html`<span className="nm">${r.name}</span>`}
          ${o && r.kind !== 'buf' ? html`<label className="inc" title="Incluir al combinar y exportar" onClick=${e => e.stopPropagation()}><input type="checkbox" checked=${!!o.inc} onChange=${e => { o.inc = e.target.checked; AZ.mchange(S); refresh(); }}/><span>incl.</span></label>` : null}
          ${o && r.kind === 'buf' ? html`<label className="inc" onClick=${e => e.stopPropagation()}><input type="checkbox" checked=${!!o.inc} onChange=${e => { o.inc = e.target.checked; bump(); }}/><span>excl.</span></label>` : null}
          ${r.kind !== 'img' && r.kind !== 'det' ? html`<button type="button" className="ic" aria-label=${'Eliminar ' + r.name} onClick=${e => { e.stopPropagation(); removeLayer(r.id); }}><${Ic} n="trash" s=${13}/></button>` : html`<span className="ic"></span>`}
        </div>`;
    })}</div>
          </div>
          <div className="capr">
            <div className="ph"><span>${act.name}</span><span className="mu">${act.kind === 'det' ? 'Detección IA' : act.kind === 'man' ? 'Detección manual' : act.kind === 'hist' ? 'Capa de histograma' : act.kind === 'buf' ? 'Buffer' : 'Imagen'}</span></div>
            <div className="pb">
              ${act.id === 'ortho' && html`<${Slider} label="Opacidad" min=${10} max=${100} value=${ui.orthOp} unit=" %" onChange=${v => set({ orthOp: v })}/>`}
              ${act.id === 'sat' && html`<${Slider} label="Opacidad" min=${0} max=${100} value=${ui.satOp} unit=" %" onChange=${v => set({ satOp: v })}/><div className="mu">Imagen satelital de referencia para verificar la ubicación del vuelo.</div>`}
              ${act.kind === 'det' && html`<div className="mu">Resultado de la IA a partir de tus puntos (+)/(−), más lo que agregues con pincel y borrador. Elegí <b>Pincel</b> (B) o <b>Borrador</b> (E) para editarla celda por celda.</div>
                <div className="row"><button className="btn sm" type="button" onClick=${() => setTool('brush')}>Pincel</button><button className="btn sm" type="button" onClick=${() => setTool('erase')}>Borrador</button><button className="btn sm" type="button" onClick=${addMan}>Nueva detección manual</button></div>`}
              ${act.kind === 'man' && html`<div className="mu">Capa separada para marcar a mano sin tocar la detección IA. Cuando estés conforme, combinala con la detección.</div>
                <div className="row"><button className="btn sm" type="button" onClick=${() => setTool('brush')}>Pincel</button><button className="btn pri sm" type="button" onClick=${() => { const n = AZ.combineManual(S); set({ active: 'det' }); refresh(); toast('Combinadas ' + n.toLocaleString('es-AR') + ' celdas con "' + M.det.name + '"'); }}>Combinar con ${M.det.name}</button></div>`}
              ${act.kind === 'buf' && html`<${Slider} label="Distancia del buffer" min=${0.5} max=${10} step=${0.5} value=${M.buf.m} unit=" m" fmt=${v => f1(v, 1)} onChange=${() => { }} onCommit=${v => { M.buf.m = v; AZ.calcBuf(S); bump(); }}/>
                <div className="mu">Margen de seguridad alrededor de lo detectado (se redondea a celdas enteras: mínimo 1 celda = ${f1(AZ.cellM(S), 2)} m). En la prescripción se trata como zona sin aplicación.</div>`}
              ${L && html`<div className="g2h"><div>
                <label className="fld"><span className="fl">Índice de color</span><select value=${L.idx} onChange=${e => { AZ.histIdx(S, L, e.target.value); bump(); }}>${Object.keys(S.idx).map(k => html`<option key=${k} value=${k}>${IDX[k] || k}</option>`)}</select></label>
                <${Hist} S=${S} L=${L} rev=${rev} onRange=${(a, b) => { AZ.histRange(S, L, a, b); bump(); }}/></div>
                <div className="col">
                  <div className="mu">Arrastrá en el histograma para fijar el rango (barras de umbral); la vista previa blanca aparece en el mapa. Después:</div>
                  <div className="row"><button className="btn sm" type="button" disabled=${!L.prev} onClick=${() => { const n = AZ.selectRange(S, L); refresh(); toast(n.toLocaleString('es-AR') + ' celdas seleccionadas'); }}>Seleccionar rango</button><button className="btn sm" type="button" onClick=${() => { AZ.clearLayer(S, L); refresh(); }}>Limpiar</button></div>
                  <div className="mu"><b>Varita (W)</b>: clic = selecciona la zona · <kbd>Ctrl</kbd>+clic = suma · clic derecho = borra la zona.</div>
                  <button className="btn sm" type="button" onClick=${() => setTool('wand')}>Usar varita mágica</button>
                </div></div>`}
            </div>
          </div>
        </section>
      </div>

      ${ui.ctx && html`<div className="md ctxm" role="menu" style=${{ position: 'fixed', left: ui.ctx.x, top: ui.ctx.y }}>
        <button type="button" className="mi" role="menuitem" onClick=${addHist}><span className="ck"></span><span>Agregar capa de histograma</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" disabled=${!!S.man} onClick=${addMan}><span className="ck"></span><span>Agregar detección manual</span><kbd></kbd></button>
        <button type="button" className="mi" role="menuitem" disabled=${M.buf.on} onClick=${addBuf}><span className="ck"></span><span>Agregar buffer</span><kbd></kbd></button></div>`}
      ${ui.exportOpen && html`<${ExportDialog} S=${S} field=${field} ex=${ex} setEx=${setEx} yld=${ui.yld} onClose=${() => set({ exportOpen: false })} toast=${toast}/>`}
      ${ui.help && html`<div className="veil" onPointerDown=${e => { if (e.target === e.currentTarget) set({ help: false }); }}><div className="login" style=${{ width: 420 }} role="dialog" aria-label="Atajos"><h2>Atajos de teclado</h2>
        <div className="kv"><span>Mover</span><kbd>V</kbd></div><div className="kv"><span>Pincel / Borrador</span><kbd>B / E</kbd></div><div className="kv"><span>Varita mágica</span><kbd>W</kbd></div>
        <div className="kv"><span>Dibujar / editar límite</span><kbd>L / M</kbd></div><div className="kv"><span>Ocultar grilla mientras se mantiene</span><kbd>Espacio</kbd></div>
        <div className="kv"><span>Comparar antes / después</span><kbd>I</kbd></div><div className="kv"><span>Varita: sumar / borrar zona</span><kbd>Ctrl+clic / clic derecho</kbd></div>
        <button className="btn" type="button" onClick=${() => set({ help: false })}>Cerrar</button></div></div>`}
      ${toastEl}
    </div>`;
  };
})(window);
