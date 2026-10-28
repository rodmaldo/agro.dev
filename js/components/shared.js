/* agro.dev · piezas compartidas por el asistente y el dashboard */
(function (root) {
  'use strict';
  const { useEffect, useState, useRef } = React;
  const U = root.AZUI, { html, Ic } = U;

  U.baseUi = () => ({ tool: 'pan', vis: { sat: 1, ortho: 1, grid: 1, lim: 1 }, orthOp: 100, satOp: 100, gridOp: 55, ba: false, baPos: 0.5, active: null, heat: 0, brushN: 3, tol: 8 });

  const typing = t => t && (/TEXTAREA|SELECT/.test(t.tagName) || (t.tagName === 'INPUT' && !/range|checkbox|radio|color/.test(t.type)));
  /* Mantener Espacio apretado oculta la grilla; al soltar vuelve */
  U.useSpace = function (held, mapApi, extra) {
    const ex = useRef(extra); ex.current = extra;   /* siempre la versión más reciente (evita cierres viejos) */
    useEffect(() => {
      const kd = e => {
        if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.code === 'Space') { e.preventDefault(); if (e.target.tagName === 'BUTTON') e.target.blur(); if (!held.current) { held.current = true; mapApi.current.redraw && mapApi.current.redraw(); } return; }
        ex.current && ex.current(e);
      };
      const ku = e => { if (e.code === 'Space') { held.current = false; mapApi.current.redraw && mapApi.current.redraw(); } };
      const bl = () => { held.current = false; mapApi.current.redraw && mapApi.current.redraw(); };
      addEventListener('keydown', kd); addEventListener('keyup', ku); addEventListener('blur', bl);
      return () => { removeEventListener('keydown', kd); removeEventListener('keyup', ku); removeEventListener('blur', bl); };
    }, []);
  };

  U.useToast = function () {
    const [t, setT] = useState(null), h = useRef(0);
    const toast = m => { setT({ m, k: Date.now() }); clearTimeout(h.current); h.current = setTimeout(() => setT(null), 4200); };
    return [toast, t ? html`<div className="toast" role="status" key=${t.k}>${t.m}</div>` : null];
  };

  /* barra de herramientas vertical */
  U.Rail = function Rail({ tools, tool, onTool, badge, col }) {
    return html`<div className=${'rail' + (col ? ' col' : '')} role="toolbar" aria-label="Herramientas">${tools.map(t => html`<button key=${t[0]} type="button" data-tip=${t[2]} aria-label=${t[2]} aria-pressed=${tool === t[0]} className=${tool === t[0] ? 'on' : ''} onClick=${() => onTool(t[0])}><${Ic} n=${t[1]} s=${18}/>${badge && badge[t[0]] && html`<i className="bdg">${badge[t[0]]}</i>`}</button>`)}</div>`;
  };

  /* pasos del asistente */
  U.StepBar = function StepBar({ steps, cur, onGo }) {
    return html`<ol className="steps">${steps.map((s, i) => html`<li key=${i} className=${i === cur ? 'on' : i < cur ? 'done' : ''}>
      <button type="button" disabled=${i >= cur || !onGo} onClick=${() => onGo && onGo(i)}><b>${i < cur ? '✓' : i + 1}</b><span>${s}</span></button></li>`)}</ol>`;
  };

  /* Confirmación propia: confirm() nativo en Electron/Windows deja la ventana sin foco de teclado (no se puede escribir después) */
  U.useConfirm = function () {
    const [st, setSt] = useState(null);
    const ask = (msg, ok, title) => new Promise(res => setSt({ msg, ok: ok || 'Continuar', title: title || 'Confirmar', res }));
    const close = v => { if (st) st.res(v); setSt(null); };
    useEffect(() => { if (!st) return; const f = e => { if (e.key === 'Escape') close(false); }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); });
    const node = st && html`<div className="veil" onClick=${e => { if (e.target === e.currentTarget) close(false); }}><div className="login" style=${{ width: 380 }} role="alertdialog" aria-modal="true" aria-label=${st.title}>
      <h2>${st.title}</h2><div className="mu">${st.msg}</div>
      <div className="row" style=${{ justifyContent: 'flex-end', gap: 10 }}><button className="btn" type="button" autoFocus onClick=${() => close(false)}>Cancelar</button><button className="btn pri" type="button" onClick=${() => close(true)}>${st.ok}</button></div></div></div>`;
    return [ask, node];
  };

  /* pie común: versión a la derecha, equipo a la izquierda */
  U.Foot = function Foot() {
    const [sp] = useState(() => AZSys.detect());
    const [ver, setVer] = useState(AZSys.VERSION); const [showLog, setShowLog] = useState(false); const [showPerf, setShowPerf] = useState(false);
    const [up, setUp] = useState({ state: 'idle' });
    useEffect(() => {
      const d = root.agroDesktop; if (!d || !d.updates) return;
      let last = '';
      const on = st => { setUp(st); const k = st.state + (st.version || '') + (st.state === 'error' ? st.msg : ''); if (k !== last && st.state !== 'checking' && root.AZDesktop) { last = k; root.AZDesktop.addLog({ none: 'estás en la última versión', downloading: 'descargando versión ' + st.version, ready: 'versión ' + st.version + ' lista: reiniciá para actualizar', error: 'no se pudo buscar actualizaciones (' + st.msg + ')' }[st.state] || st.state, 'Actualizador'); } };
      d.updates.state().then(on, () => {}); return d.updates.onStatus(on);
    }, []);
    useEffect(() => { const d = root.agroDesktop; if (d && d.version) d.version().then(v => v && setVer(v + ' · escritorio'), () => {}); }, []);
    return html`<footer className="foot"><span className="specs" title="Especificaciones detectadas por el navegador (el nombre exacto del procesador no está disponible)">${sp.map(x => html`<span key=${x[0]}>${x[0]} <b>${x[1]}</b></span>`)}</span><span className="ver">${up.state === 'downloading' && html`<span className="upd">Descargando actualización ${up.version || ''} ${up.pct || 0} % · </span>`}${up.state === 'ready' && html`<button className="lnk upd" type="button" onClick=${() => root.agroDesktop.updates.install()} title="Cierra la app, instala la versión nueva y la vuelve a abrir">Actualizar a v${up.version} (reiniciar)</button> · `}${root.AZDesktop && root.AZDesktop.available && html`<button className="lnk" type="button" onClick=${() => setShowPerf(true)} title="Cuánto de tu PC usa el procesado (no cambia la calidad)">Rendimiento</button> · <button className="lnk" type="button" onClick=${() => setShowLog(true)}>Registro</button> · `}agro.dev v${ver}</span>${showLog && html`<${U.LogModal} onClose=${() => setShowLog(false)}/>`}${showPerf && html`<${U.PerfModal} onClose=${() => setShowPerf(false)}/>`}</footer>`;
  };
})(window);
