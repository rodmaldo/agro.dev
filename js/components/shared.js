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
  U.Rail = function Rail({ tools, tool, onTool }) {
    return html`<div className="rail" role="toolbar" aria-label="Herramientas">${tools.map(t => html`<button key=${t[0]} type="button" data-tip=${t[2]} aria-label=${t[2]} aria-pressed=${tool === t[0]} className=${tool === t[0] ? 'on' : ''} onClick=${() => onTool(t[0])}><${Ic} n=${t[1]} s=${18}/></button>`)}</div>`;
  };

  /* pasos del asistente */
  U.StepBar = function StepBar({ steps, cur, onGo }) {
    return html`<ol className="steps">${steps.map((s, i) => html`<li key=${i} className=${i === cur ? 'on' : i < cur ? 'done' : ''}>
      <button type="button" disabled=${i >= cur || !onGo} onClick=${() => onGo && onGo(i)}><b>${i < cur ? '✓' : i + 1}</b><span>${s}</span></button></li>`)}</ol>`;
  };

  /* pie común: versión a la derecha, equipo a la izquierda */
  U.Foot = function Foot() {
    const [sp] = useState(() => AZSys.detect());
    const [ver, setVer] = useState(AZSys.VERSION); const [showLog, setShowLog] = useState(false);
    useEffect(() => { const d = root.agroDesktop; if (d && d.version) d.version().then(v => v && setVer(v + ' · escritorio'), () => {}); }, []);
    return html`<footer className="foot"><span className="specs" title="Especificaciones detectadas por el navegador (el nombre exacto del procesador no está disponible)">${sp.map(x => html`<span key=${x[0]}>${x[0]} <b>${x[1]}</b></span>`)}</span><span className="ver">${root.AZDesktop && root.AZDesktop.available && html`<button className="lnk" type="button" onClick=${() => setShowLog(true)}>Registro</button> · `}agro.dev v${ver}</span>${showLog && html`<${U.LogModal} onClose=${() => setShowLog(false)}/>`}</footer>`;
  };
})(window);
