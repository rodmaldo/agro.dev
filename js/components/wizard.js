/* agro.dev · asistente tras "Campo": Tipo de imagen → Grilla → Límites → Detección de zonas */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef, useReducer } = React;
  const { html, Ic, Slider, Seg, Toggle, MapCanvas, StepBar, Rail, Foot, baseUi, useSpace, useToast, f1, ProcessDialog, fmtDur, fmtClock } = root.AZUI;

  /* colores sugeridos por factor (paleta apta para daltonismo, Okabe-Ito) */
  const PAL = { salitre: '#E69F00', salinidad: '#E69F00', maleza: '#CC79A7', malezas: '#CC79A7', plaga: '#D55E00', plagas: '#D55E00', anegamiento: '#56B4E9', encharcamiento: '#56B4E9', sequia: '#F0E442' };
  root.AZUI.PAL = PAL;
  const norm = s => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const STEPS = ['Campo', 'Tipo de imagen', 'Grilla', 'Límites', 'Detección de zonas'];
  const AI_NAME = 'agro-tono · clasificador de tonalidad por celdas';
  const MIN = 5;

  root.AZUI.Wizard = function Wizard({ user, field, job, S, cfg, setCfg, initStep, onBack, onDone, onLogout, onHome }) {
    const [step, setStep] = useState(initStep || 0);
    const [rev, bump] = useReducer(x => x + 1, 0);
    const [ui, setUi] = useState(baseUi); const uiR = useRef(ui); uiR.current = ui;
    const [prog, setProg] = useState(null); const [calc, setCalc] = useState(false);
    const [toast, toastEl] = useToast();
    const held = useRef(false), mapApi = useRef({}), cancel = useRef({ v: false }), tm = useRef(0), sensR = useRef(cfg.sens);
    const [ai, setAi] = useState({ st: 'wait', n: 0 });
    const info = job.info, set = p => setUi(u => ({ ...u, ...p })), up = p => setCfg(c => ({ ...c, ...p }));
    const pc = AZ.pointCounts(S);
    const [gm, setGm] = useState(cfg.gridM); useEffect(() => { setGm(cfg.gridM); }, [cfg.gridM]);
    const gmOk = isFinite(+gm) && +gm >= 0.5 && +gm <= 20;

    useSpace(held, mapApi, e => {
      if (step === 3) { const m = { KeyV: 'pan', KeyA: 'padd', KeyN: 'pneg', KeyL: 'poly', KeyM: 'edit' }[e.code]; if (m) setTool(m); }
      else if (step === 2) { const m = { KeyV: 'pan', KeyL: 'poly', KeyM: 'edit' }[e.code]; if (m) setTool(m); }
    });

    /* ---------- paso 1: procesar imágenes ---------- */
    const sampleFile = () => info.raw.slice().sort((a, b) => b.f.size - a.f.size)[0].f;
    const process = async () => {
      cancel.current = { v: false }; const T0 = Date.now(); job.timing = null;
      const upd = (pct, msg) => setProg({ pct, msg, t0: T0, last: Date.now(), watch: !!info.native });
      upd(0, 'Leyendo posiciones GPS…');
      const dlog = m => { if (info.native && root.AZDesktop) root.AZDesktop.addLog(m, 'Interfaz'); };
      dlog('procesar: ' + info.raw.length + ' fotos · salida ' + (cfg.outRes === 'orig' ? 'resolución original' : cfg.outRes + ' cm/px') + ' · grilla ' + cfg.gridM + ' m');
      try {
        if (info.native) {                       // escritorio: ortomosaico a resolución original + celdas calculadas por el motor
          const base = await AZDesktop.buildBase({ files: info.raw, name: field.name, outRes: cfg.outRes === 'orig' ? null : +cfg.outRes, rtk: cfg.prec === 'rtk' }, upd, cancel.current);
          job.base = base; job.note = base.note; job.timing = base.timing;
          dlog('ortomosaico listo · ' + base.note);
          await AZFiles.applyTiled(S, base, cfg.gridM, cfg.rot, cfg.detail === 'det', (p, m) => upd(0.92 + 0.08 * p, m), cancel.current);
          try { AZApi.fields.update(field.id, { ha: +AZ.coverHa(S).toFixed(2), updated: new Date().toISOString() }); } catch (e) { }
          setProg(null); setStep(1); bump(); setTimeout(() => mapApi.current.fit && mapApi.current.fit(), 60);
          if (root.AZLot) root.AZLot.save(S, { field, cfg, job, stage: 'wizard', version: root.AZSys && root.AZSys.VERSION });   // queda guardado: se puede cerrar y abrir después sin reprocesar
          return;
        }
        const o = { source: cfg.source, items: info.raw, file: cfg.source === 'ortho' ? info.ortho.f : cfg.source === 'sample' ? sampleFile() : null, ndvi: cfg.kind !== 'rgb' && cfg.source !== 'mosaic' ? cfg.ndvi : null, res: +cfg.res, quality: cfg.quality, lat: +cfg.lat, lon: +cfg.lon, rtk: cfg.prec === 'rtk' };
        const base = await AZFiles.buildBase(o, upd, cancel.current);
        job.base = base; job.note = base.note;
        upd(0.95, 'Calculando grilla…'); await new Promise(r => setTimeout(r, 30));
        AZFiles.apply(S, base, cfg.gridM, cfg.rot, cfg.detail === 'det');
        setProg(null); setStep(1); bump(); setTimeout(() => mapApi.current.fit && mapApi.current.fit(), 60);
      } catch (e) { dlog('ERROR: ' + e.message); setProg(null); toast(/cancelad/i.test(e.message) ? 'Proceso cancelado' : 'No se pudo procesar: ' + e.message); }
    };
    const canProcess = info && (info.native ? info.raw.length >= 2 && info.geoPhotos > 0 : cfg.source === 'mosaic' ? info.raw.length >= 2 && info.geoPhotos > 0 : cfg.source === 'ortho' ? !!info.ortho : info.raw.length > 0) && !(cfg.kind === 'ms' && cfg.source === 'mosaic' && !info.raw.length)
      && (info.native || (isFinite(+cfg.lat) && isFinite(+cfg.lon) && Math.abs(+cfg.lat) <= 90 && Math.abs(+cfg.lon) <= 180 && +cfg.res > 0));
    const needIdx = cfg.kind === 'ms' && !cfg.ndvi;

    /* ---------- paso 2: grilla y orientación ---------- */
    const reapply = (gridM, rot, fit) => {
      setCalc(true);
      setTimeout(async () => {
        try { if (job.base.tiled) await AZFiles.applyTiled(S, job.base, gridM, rot, cfg.detail === 'det'); else AZFiles.apply(S, job.base, gridM, rot, cfg.detail === 'det'); }
        catch (e) { toast('No se pudo recalcular: ' + e.message); }
        setCalc(false); bump(); if (fit) mapApi.current.fit();
      }, 30);
    };
    const onGrid = v => { v = Math.max(0.5, Math.min(20, Math.round((+v || 0) * 100) / 100)); setGm(v); up({ gridM: v }); reapply(v, cfg.rot, false); };
    const onRot = v => { v = Math.max(-90, Math.min(90, +v || 0)); up({ rot: v }); reapply(cfg.gridM, v, true); };

    /* ---------- paso 3: detección en tiempo real ---------- */
    const entered = useRef(false);
    useEffect(() => {
      if (step !== 3 || entered.current) return; entered.current = true;
      S.meta.det.name = cfg.detName; S.meta.det.color = cfg.color;
      const p = job.preset;
      if (p && !job.presetDone) {   /* proyecto importado: límite y puntos (en coordenadas relativas) */
        job.presetDone = true;
        if (Array.isArray(p.poly) && p.poly.length >= 3) { S.poly = p.poly.map(q => [q[0] * S.W, q[1] * S.H]); AZ.polyChanged(S); }
        (p.pts || []).forEach(q => { const [ci, cj] = AZ.cellAt(S, q.u * S.W, q.v * S.H); if (S.inside[cj * S.gw + ci]) AZ.togglePoint(S, ci, cj, q.s); });
        schedule(0);
      }
    }, [step]);
    const runDetect = () => {
      const c = AZ.pointCounts(S);
      if (!c.pos) { S.auto = new Uint8Array(S.gw * S.gh); AZ.mergeDet(S); S.hasDet = false; setAi({ st: 'wait', n: 0 }); bump(); return; }
      setAi(a => ({ ...a, st: 'run' }));
      setTimeout(() => { const n = AZ.detect(S, sensR.current, true); setAi({ st: 'ok', n: Math.max(0, n) }); bump(); }, 20);
    };
    const schedule = ms => { clearTimeout(tm.current); tm.current = setTimeout(runDetect, ms == null ? 140 : ms); };
    useEffect(() => () => clearTimeout(tm.current), []);
    const onPoint = (ci, cj, sign) => { AZ.togglePoint(S, ci, cj, sign); bump(); schedule(); };
    const undo = () => { if (S.pts.length) { S.pts.pop(); S.ver++; bump(); schedule(); } };
    const clear = () => { S.pts = []; S.ver++; bump(); schedule(0); };
    const onName = v => { const c = PAL[norm(v)]; S.meta.det.name = v; up({ detName: v, ...(c ? { color: c } : {}) }); if (c) S.meta.det.color = c; S.ver++; };
    const ready = pc.pos >= MIN && pc.neg >= MIN && ai.st === 'ok' && ai.n > 0 && cfg.detName.trim().length > 0;
    const finish = () => { S.meta.det.name = cfg.detName.trim(); S.meta.det.color = cfg.color; AZ.mergeDet(S); if (root.AZLot) root.AZLot.save(S, { field, cfg, job, stage: 'dash', version: root.AZSys && root.AZSys.VERSION }); onDone(); };
    const st = step === 3 && S.gw && S.det.length ? AZ.stats(S) : null;
    const setTool = t => { if (t !== 'poly') S.tmp = []; set({ tool: t }); mapApi.current.redraw && mapApi.current.redraw(); };
    const polyChanged = () => { AZ.polyChanged(S); bump(); if (step === 3 && AZ.pointCounts(S).pos) schedule(0); };
    const closePoly = () => { if (S.tmp.length < 3) return toast('El límite necesita al menos 3 vértices'); S.poly = S.tmp; S.tmp = []; polyChanged(); setTool('edit'); };
    const resetPoly = () => { S.poly = [[0, 0], [S.W, 0], [S.W, S.H], [0, S.H]]; S.tmp = []; polyChanged(); };
    const polyHa = () => { const P = S.poly || []; let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2 * S.mpp * S.mpp / 1e4; };
    const fileR = useRef();
    const importLimit = async file => {
      if (!file) return;
      if (/\.(kmz|shp|zip|dbf)$/i.test(file.name)) return toast('Formato no admitido. Exportá el límite como KML o GeoJSON desde el monitor.');
      if (!S.geo) return toast('Este lote no tiene coordenadas: dibujá el límite en el mapa.');
      let rings; try { rings = AZ.X.parseBoundary(await file.text()); } catch (e) { rings = []; }
      if (!rings.length) return toast('No encontré ningún polígono en ' + file.name + '. Probá con un KML o GeoJSON.');
      const areaOf = r => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a); };
      rings.sort((a, b) => areaOf(b) - areaOf(a));
      S.poly = rings[0].map(p => AZ.geoToPx(S, p[1], p[0])); S.tmp = [];
      const out = S.poly.every(p => p[0] < 0 || p[0] > S.W || p[1] < 0 || p[1] > S.H);
      polyChanged(); set({ tool: 'edit' });
      toast(out ? 'El límite cae fuera del mapa: revisá que corresponda a este lote' : 'Límite cargado' + (rings.length > 1 ? ' (el polígono más grande de ' + rings.length + ')' : '') + ': ' + f1(polyHa(), 1) + ' ha');
    };
    const api = { refresh: bump, set, toast, onPoint, closePoly, polyChanged };

    const goInicio = async () => { if (root.AZLot && S.gw && S.tiled) { try { await root.AZLot.save(S, { field, cfg, job, stage: 'wizard', version: root.AZSys && root.AZSys.VERSION }); } catch (e) { } } onHome(); };
    const goStep = i => { if (i === 0) return onBack(); const t = i - 1; if (t < step) { entered.current = false; setStep(t); } };
    const next = () => { if (step === 0) process(); else if (step === 1 || step === 2) setStep(step + 1); };
    const stepIdx = step + 1;   // la barra incluye "Campo" como paso 0 ya hecho

    const stage = (tools) => html`<${MapCanvas} S=${S} rev=${rev} ui=${ui} held=${held} api=${api} mapApi=${mapApi}>
      <${Rail} tools=${tools} tool=${ui.tool} onTool=${t => set({ tool: t })}/>
      <div className="mapbadge">${S.gw ? 'Grilla ' + f1(AZ.cellM(S), 2) + ' m · ' + S.gw + '×' + S.gh : ''}</div>
      ${calc && html`<div className="hint"><b>Recalculando grilla…</b></div>`}
    <//>`;

    return html`<div className="screen">
      <header className="top"><button className="lnk" type="button" onClick=${onBack} aria-label="Volver a Campo"><${Ic} n="back" s=${16}/></button><div className="brand"><img src="assets/brand/logo-negativo.png" alt="agro.dev"/></div><span className="crumb">${field.name}</span>
        <button className="btn sm" type="button" onClick=${goInicio} title="Volver a los lotes del proyecto (el lote queda guardado)"><${Ic} n="home" s=${13}/> Inicio</button>
        <span className="grow"></span><${root.AZUI.GearBtn}/><span className="usr">${user}</span>${root.AZUI.LOGIN && html`<button className="lnk" type="button" onClick=${onLogout}>Salir</button>`}</header>
      <${StepBar} steps=${STEPS} cur=${stepIdx} onGo=${goStep}/>

      ${step === 0 && html`<main className="wbody one"><div className="wscroll">
        <section className="hcard">
          <h2>Tipo de imágenes</h2>
          <${Seg} value=${cfg.kind} onChange=${v => up({ kind: v })} opts=${[['rgb', 'RGB'], ['ms', 'Multiespectral'], ['both', 'RGB + Multiespectral']]}/>
          ${cfg.kind === 'rgb' && html`<div className="note">Se analiza el color visible (índice de verdor ExG, brillo y saturación).</div>`}
          ${cfg.kind !== 'rgb' && html`<div className="fld"><span className="fl">Índice multiespectral (NDVI / NDRE en escala de grises)</span>
            <${NdviPick} cfg=${cfg} up=${up}/>
            <span className="mu">El navegador no abre las bandas .TIF (G, R, RE, NIR) del Mavic 3M. Subí el índice ya calculado como imagen en grises (exportado desde DJI Terra o Pix4D). La lectura nativa de bandas queda para la versión de escritorio. Solo se usa con un ortomosaico, no con el vuelo armado por GPS.</span></div>`}
          ${needIdx && html`<div className="note w">Para "Multiespectral" solo, subí el índice. Si no lo tenés, elegí "RGB + Multiespectral" y se usará el color RGB.</div>`}
        </section>
        <section className="hcard">
          <h2>Cómo armar el mapa</h2>
          ${info && info.native && html`<div className="note">Se arma el ortomosaico del lote completo a partir de las ${info.raw.length} fotos (${info.geoPhotos} con GPS), en el motor de escritorio, a la resolución original (${f1(info.gsdCm, 2)} cm/px) o a la que elijas abajo. Se corrige el viñeteo de la lente, se igualan las exposiciones y se mezclan los bordes. Las fotos se ubican por su posición ${cfg.prec === 'rtk' ? 'RTK (centímetros)' : 'GPS'}, rumbo y altura: sirve para terreno plano.</div>`}
          ${info && !info.native && html`<${Seg} value=${cfg.source} onChange=${v => up({ source: v })} opts=${[...(info.ortho ? [['ortho', 'Ortomosaico']] : []), ['mosaic', 'Vuelo completo (fotos GPS)'], ['sample', 'Una foto']]}/>
            ${cfg.source === 'mosaic' && html`<div className="note">Se arma el lote completo ubicando cada foto por su GPS y rumbo (${info.raw.length} fotos, ${info.geoPhotos ? 'con GPS' : 'sin GPS detectado'}). Es una composición aproximada, no fotogrametría: sirve para ver, delimitar y zonificar. Para la entrega final usá un ortomosaico real.</div>`}
            ${cfg.source === 'sample' && html`<div className="note w">Carga solo la foto RGB más grande: es una vista parcial del vuelo, no el lote completo.</div>`}
            ${cfg.source === 'ortho' && html`<div className="note">Se usa el ortomosaico exportado: ${info.ortho && info.ortho.f.name}.</div>`}
            ${cfg.source === 'mosaic' && info.raw.length < 2 && html`<div className="note w">Necesito al menos 2 fotos _D.JPG con GPS. Volvé a Campo y agregá las demás carpetas del vuelo.</div>`}
            ${cfg.source === 'mosaic' && info.raw.length >= 2 && !info.geoPhotos && html`<div className="note w">Las fotos no traen coordenadas GPS legibles. Subí un ortomosaico JPG/PNG.</div>`}`}
        </section>
        <section className="hcard adv">
          <h2>Parámetros avanzados</h2>
          <div className="g2">
            ${info && info.native && html`<label className="fld"><span className="fl">Resolución del ortomosaico</span><select value=${cfg.outRes} onChange=${e => up({ outRes: e.target.value })}>
              <option value="orig">Original · ${f1(info.gsdCm, 2)} cm/px (máxima calidad)</option><option value="5">5 cm/px</option><option value="10">10 cm/px (rápido)</option></select>
              <span className="mu">La grilla y la detección se calculan siempre sobre los píxeles del ortomosaico. Con "Original" no se pierde detalle.</span></label>`}
            ${!(info && info.native) && html`<label className="fld"><span className="fl">Resolución del píxel (cm/px)<b>${f1((+cfg.res) * (+cfg.res), 1)} cm²/px</b></span><input type="number" min="0.5" step="0.01" value=${cfg.res} onInput=${e => up({ res: e.target.value })}/>${info && info.alt != null && info.pw === 5280 ? html`<span className="mu">Estimada por la altura de vuelo (${f1(info.alt, 0)} m): ${f1(info.alt * 0.02685, 2)} cm/px. Si el tamaño de las fotos no coincide, ajustalo.</span>` : null}</label>`}
            ${!(info && info.native) && html`<label className="fld"><span className="fl">Calidad de relevamiento</span><select value=${cfg.quality} onChange=${e => up({ quality: e.target.value })}><option value="baja">Baja · hasta 1600 px</option><option value="media">Media · hasta 3200 px</option><option value="alta">Alta · hasta 6000 px</option></select></label>`}
            <div className="fld"><span className="fl">Procesado</span><${Seg} value=${cfg.detail} onChange=${v => up({ detail: v })} opts=${[['norm', 'Normal'], ['det', 'Detallado']]}/></div>
            <div className="fld"><span className="fl">Posicionamiento</span><${Seg} value=${cfg.prec} onChange=${v => up({ prec: v })} opts=${[['gps', 'GPS'], ['rtk', 'RTK']]}/></div>
            ${!(info && info.native) && html`<label className="fld"><span className="fl">Latitud del centro</span><input type="number" step="0.000001" value=${cfg.lat} onInput=${e => up({ lat: e.target.value })}/></label>
            <label className="fld"><span className="fl">Longitud del centro</span><input type="number" step="0.000001" value=${cfg.lon} onInput=${e => up({ lon: e.target.value })}/></label>`}
          </div>
          <span className="mu">Detallado agrega textura del suelo al análisis. Precisión esperada: ${cfg.prec === 'rtk' ? '±2–5 cm (RTK fijo)' : '±1–3 m (GPS estándar)'}. Con "Vuelo completo" el centro se calcula solo desde las fotos.</span>
        </section></div></main>`}

      ${step === 1 && html`<main className="wbody">
        <aside className="wpanel">
          <h2>Configurar grilla</h2>
          <label className="fld"><span className="fl">Tamaño de celda (metros)<b>actual: ${f1(cfg.gridM, 2)} m</b></span>
            <div className="row"><input type="number" min="0.5" max="20" step="0.5" value=${gm} onInput=${e => setGm(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && gmOk) onGrid(gm); }} aria-label="Tamaño de celda en metros"/><span className="mu fx">m</span>
              <button className="btn sm pri" type="button" disabled=${!gmOk || calc || +gm === cfg.gridM} onClick=${() => onGrid(gm)}>Aplicar</button></div></label>
          <${Slider} label="" min=${0.5} max=${20} step=${0.5} value=${gmOk ? +gm : cfg.gridM} unit=" m" fmt=${v => f1(v, 1)} onChange=${v => setGm(v)}/>
          <div className="mu">Escribí los metros o mové la barra y tocá <b>Aplicar</b> para recalcular. Mínimo 0,50 m · máximo 20 m. Celdas chicas = más detalle y más cálculo.</div>
          ${!gmOk && html`<div className="note w">Ingresá un valor entre 0,5 y 20 m.</div>`}
          <label className="fld"><span className="fl">Orientación de la grilla<b>${f1(cfg.rot, 1)}°</b></span>
            <div className="row"><input type="number" min="-90" max="90" step="0.5" value=${cfg.rot} onChange=${e => onRot(e.target.value)} aria-label="Orientación en grados"/><span className="mu fx">grados</span></div></label>
          <${Slider} label="" min=${-90} max=${90} step=${0.5} value=${cfg.rot} unit="°" fmt=${v => f1(v, 1)} onChange=${() => { }} onCommit=${onRot}/>
          <div className="row">${info && info.yaw != null && html`<button className="btn sm" type="button" onClick=${() => onRot(info.yaw > 45 ? info.yaw - 90 : info.yaw)}>Usar rumbo del vuelo (${f1(info.yaw > 45 ? info.yaw - 90 : info.yaw, 1)}°)</button>`}<button className="btn sm" type="button" onClick=${() => onRot(0)}>Norte (0°)</button></div>
          <div className="mu">La grilla se alinea girando la imagen. Alinearla con las pasadas del dron o con los surcos reduce celdas mezcladas.</div>
          <div className="kv-box">
            <div className="kv"><span>Celdas</span><span>${S.gw}×${S.gh} (${(S.gw * S.gh).toLocaleString('es-AR')})</span></div>
            <div className="kv"><span>Celda efectiva</span><span>${f1(AZ.cellM(S), 2)} m</span></div>
            <div className="kv"><span>Superficie relevada</span><span>${f1(AZ.coverHa(S), 1)} ha</span></div>
            ${job.note && html`<div className="kv"><span>Fotos usadas</span><span>${job.note}</span></div>`}
            ${job.timing && html`<div className="kv"><span>Ortomosaico: inicio</span><span>${fmtClock(job.timing.start)}</span></div>
            <div className="kv"><span>Ortomosaico: fin</span><span>${fmtClock(job.timing.end, job.timing.start)}</span></div>
            <div className="kv"><span>Tiempo total</span><span>${fmtDur(job.timing.seconds * 1000)}</span></div>`}</div>
          ${S.capped && html`<div className="note w">A esta resolución el lote supera el máximo de 4 millones de celdas; la celda efectiva es de ${f1(AZ.cellM(S), 2)} m en lugar de ${f1(cfg.gridM, 2)} m.</div>`}
          <${Slider} label="Opacidad de la grilla" min=${0} max=${100} value=${ui.gridOp} unit=" %" onChange=${v => set({ gridOp: v })}/>
          <div className="mu">Mantené <kbd>Espacio</kbd> para ocultar la grilla.</div>
        </aside>
        ${stage([['pan', 'move', 'Mover (V)']])}</main>`}

      ${step === 2 && html`<main className="wbody">
        <aside className="wpanel">
          <h2>Límites del lote</h2>
          <div className="note">Delimitá el lote para que solo se analice y se mida lo que está adentro. Podés dibujarlo en el mapa o cargar el límite que grabó el monitor del pulverizador, tractor o sembradora.</div>
          <div className="row"><button className="btn sm" type="button" onClick=${() => fileR.current.click()}>Importar KML / GeoJSON…</button>
            <input ref=${fileR} type="file" accept=".kml,.geojson,.json,application/vnd.google-earth.kml+xml,application/geo+json,application/json" hidden onChange=${e => { importLimit(e.target.files[0]); e.target.value = ''; }}/></div>
          <div className="row"><button className=${'btn sm' + (ui.tool === 'poly' ? ' pri' : '')} type="button" onClick=${() => setTool('poly')}>Dibujar límite (L)</button><button className=${'btn sm' + (ui.tool === 'edit' ? ' pri' : '')} type="button" onClick=${() => setTool('edit')}>Editar vértices (M)</button></div>
          <button className="btn sm" type="button" onClick=${resetPoly}>Restablecer (imagen completa)</button>
          <div className="mu">Dibujar: clic en cada esquina y cerrá tocando el primer punto (o doble clic). Editar: arrastrá un vértice; Shift + clic lo borra.</div>
          <div className="kv-box">
            <div className="kv"><span>Superficie del mapa</span><span>${f1(AZ.coverHa(S), 1)} ha</span></div>
            <div className="kv"><span>Dentro del límite</span><span>${f1(polyHa(), 1)} ha</span></div>
            <div className="kv"><span>Vértices</span><span>${(S.poly || []).length}</span></div></div>
          <div className="mu">Si no cargás un límite se usa la imagen completa. Después de detectar podrás seguir editándolo.</div>
          <${Slider} label="Opacidad de la grilla" min=${0} max=${100} value=${ui.gridOp} unit=" %" onChange=${v => set({ gridOp: v })}/>
        </aside>
        ${stage([['pan', 'move', 'Mover (V)'], ['poly', 'poly', 'Dibujar límite (L)'], ['edit', 'edit', 'Editar límite (M)']])}</main>`}

      ${step === 3 && html`<main className="wbody">
        <aside className="wpanel">
          <h2>Detección de zonas</h2>
          <label className="fld"><span className="fl">Nombre de la detección</span>
            <div className="row"><input type="text" maxLength="40" placeholder="Ej.: Salitre" value=${cfg.detName} onInput=${e => onName(e.target.value)} aria-label="Nombre de la detección"/>
              <input className="fx" type="color" value=${cfg.color} aria-label="Color de la detección" onInput=${e => { up({ color: e.target.value }); S.meta.det.color = e.target.value; S.ver++; bump(); }}/></div></label>
          <div className="cnt">
            <div><span className="pos">+</span> Positivos <b>${pc.pos}</b>/${MIN}<div className="pbar"><div style=${{ width: Math.min(100, pc.pos / MIN * 100) + '%', background: '#D55E00' }}></div></div></div>
            <div><span className="neg">−</span> Negativos <b>${pc.neg}</b>/${MIN}<div className="pbar"><div style=${{ width: Math.min(100, pc.neg / MIN * 100) + '%', background: '#0072B2' }}></div></div></div>
          </div>
          <div className=${'note' + (pc.pos >= MIN && pc.neg >= MIN ? '' : ' w')} role="status">${pc.pos >= MIN && pc.neg >= MIN
            ? 'Mínimo alcanzado. Seguí sumando puntos si ves zonas mal clasificadas: cuantos más, más precisa la detección.'
            : 'Marcá al menos ' + MIN + ' puntos positivos (+) sobre la zona afectada y ' + MIN + ' negativos (−) sobre zona sana. Los puntos solo se pueden agregar dentro de las celdas de la grilla.'}</div>
          <div className="ai">
            <span className="fl">Procesamiento por IA</span>
            <div className="aiv"><i className=${'led ' + ai.st}></i><b>${AI_NAME}</b></div>
            <div className="mu">${ai.st === 'run' ? 'Analizando tonalidades…' : ai.st === 'ok' ? 'Delimitó ' + (st ? f1(st.inf) + ' ha' + (S.limUser ? ' (' + f1(st.lote ? st.inf / st.lote * 100 : 0) + ' % del lote)' : ' · definí el límite del lote para ver el porcentaje') : '') : 'Esperando el primer punto positivo.'}</div>
            <div className="mu">Compara la tonalidad (color, brillo, saturación, verdor) de cada celda con la de tus puntos y revalida en tiempo real.</div>
          </div>
          <${Slider} label="Sensibilidad" min=${0} max=${100} value=${cfg.sens} unit=" %" onChange=${() => { }} onCommit=${v => { sensR.current = v; up({ sens: v }); schedule(0); }}/>
          ${(ui.tool === 'poly' || ui.tool === 'edit') && html`<div className="note">Editando el límite del lote (${f1(polyHa(), 1)} ha). Al cambiarlo se recalcula la detección. <button className="btn sm" type="button" onClick=${resetPoly}>Restablecer</button></div>`}
          <div className="row"><button className="btn sm" type="button" onClick=${undo} disabled=${!S.pts.length}><${Ic} n="undo" s=${13}/> Deshacer</button><button className="btn sm" type="button" onClick=${clear} disabled=${!S.pts.length}>Borrar puntos</button></div>
          <${Slider} label="Opacidad de la grilla" min=${0} max=${100} value=${ui.gridOp} unit=" %" onChange=${v => set({ gridOp: v })}/>
        </aside>
        ${stage([['pan', 'move', 'Mover (V)'], ['padd', 'plus', 'Punto positivo + (A)'], ['pneg', 'minus', 'Punto negativo − (N)'], ['poly', 'poly', 'Dibujar límite (L)'], ['edit', 'edit', 'Editar límite (M)']])}</main>`}

      <div className="bar">
        <button className="btn" type="button" onClick=${() => (step === 0 ? onBack() : goStep(step))}>Atrás</button><span className="grow"></span>
        ${step < 3 && html`<button className="btn pri" type="button" disabled=${step === 0 ? (!canProcess || needIdx || !!prog) : calc} onClick=${next}>Siguiente</button>`}
        ${step === 3 && html`<button className="btn pri" type="button" disabled=${!ready} onClick=${finish} title=${ready ? '' : 'Faltan puntos o la detección todavía no terminó'}>Finalizar detección</button>`}
      </div>
      <${Foot}/>
      ${prog && html`<${ProcessDialog} prog=${prog} onCancel=${() => { cancel.current.v = true; }}/>`}
      ${toastEl}</div>`;
  };

  function NdviPick({ cfg, up }) {
    const r = useRef();
    return html`<div className="row"><button className="btn" type="button" onClick=${() => r.current.click()}>${cfg.ndvi ? cfg.ndvi.name : 'Elegir imagen NDVI / NDRE en gris'}</button>${cfg.ndvi && html`<button className="btn fx sm" type="button" onClick=${() => up({ ndvi: null })}>Quitar</button>`}
      <input ref=${r} type="file" accept="image/png,image/jpeg" hidden onChange=${e => { up({ ndvi: e.target.files[0] || null }); e.target.value = ''; }}/></div>`;
  }
})(window);
