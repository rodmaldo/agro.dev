/* agro.dev · cuadro "Procesando": barra animada, etapa, hora de inicio, tiempo transcurrido y aviso si el motor deja de dar señales */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef } = React;
  const { html } = root.AZUI;

  const pad = n => String(n).padStart(2, '0');
  /* 01:05:09 */
  const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60); };
  /* hora del día; con fecha si cae en otro día que `ref` (un proceso que cruza la medianoche) */
  const fmtClock = (t, ref) => {
    const d = new Date(t), h = d.toLocaleTimeString('es-AR', { hour12: false });
    return ref != null && new Date(ref).toDateString() !== d.toDateString() ? d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' + h : h;
  };
  const STALL_MS = 90000;           // el motor avisa varias veces por segundo mientras trabaja: 90 s sin nada no es normal


  /* ---- Registro: lo que hace el programa, en vivo (motor + interfaz). Sirve para adjuntar una captura cuando algo falla ---- */
  const lvl = m => /error|fall[óo]|no avanza|se cerr[óo]|traceback|exception|no se pudo/i.test(m) ? 'er' : /sin memoria|reintento|advert|cancel/i.test(m) ? 'wa' : '';
  root.AZUI.LogPanel = function LogPanel({ rows, full }) {
    const D = root.AZDesktop, [, bump] = useState(0), ref = useRef(null), stick = useRef(true), [copied, setCopied] = useState(false);
    useEffect(() => { let q = 0; const off = D.onLog(() => { if (!q) q = setTimeout(() => { q = 0; bump(x => x + 1); }, 120); }); return () => { off(); clearTimeout(q); }; }, []);
    useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; });
    const lines = D.logs.slice(-(full ? 1500 : 250)), desk = root.agroDesktop;
    const text = () => lines.map(l => fmtClock(l.t * 1000) + '  ' + l.msg).join('\n');
    const copy = async () => { try { await navigator.clipboard.writeText(text()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { } };
    return html`<div className="logwrap">
      <div className="logbox" ref=${ref} style=${{ height: full ? '60vh' : (rows || 8) * 17 + 12 }} onScroll=${e => { const el = e.target; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }} role="log" aria-live="off">
        ${lines.length ? lines.map((l, i) => html`<div key=${i} className=${'ln ' + lvl(l.msg)}><span>${fmtClock(l.t * 1000)}</span>${l.msg}</div>`) : html`<div className="ln"><span></span>Todavía no hay registro. Aparece acá apenas empieza un proceso.</div>`}
      </div>
      <div className="row logbar"><button className="lnk" type="button" onClick=${copy}>${copied ? 'Copiado' : 'Copiar'}</button>
        ${desk && desk.openLogs && html`<button className="lnk" type="button" onClick=${() => desk.openLogs()}>Abrir carpeta de registros</button>`}</div></div>`;
  };
  root.AZUI.LogModal = function LogModal({ onClose }) {
    return html`<div className="veil" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}><div className="login pdlg logmodal" role="dialog" aria-label="Registro">
      <h2>Registro</h2><${root.AZUI.LogPanel} full=${true}/><button className="btn" type="button" onClick=${onClose}>Cerrar</button></div></div>`;
  };

  /* prog: {pct 0..1, msg, t0 (ms, inicio), last (ms, último aviso del motor)} */
  root.AZUI.ProcessDialog = function ProcessDialog({ prog, onCancel, title }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
    const el = now - prog.t0, quiet = now - prog.last, stale = prog.watch !== false && quiet > STALL_MS, pct = Math.round(prog.pct * 100);
    const eta = prog.pct > 0.14 && prog.pct < 0.95 ? el * (1 - prog.pct) / prog.pct : null;
    const desk = root.agroDesktop, [showLog, setShowLog] = useState(true);
    return html`<div className="veil"><div className=${'login pdlg' + (showLog && root.AZDesktop && root.AZDesktop.available ? ' wide' : '')} role="status" aria-live="polite">
      <h2>${title || 'Procesando'}</h2>
      <div className="pstage"><span className="mu">${prog.msg}</span><b>${pct} %</b></div>
      <div className="pbar2" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}><div className=${'fill' + (stale ? ' stale' : '')} style=${{ width: Math.max(1.5, prog.pct * 100) + '%' }}></div></div>
      <div className="kv-box">
        <div className="kv"><span>Inicio</span><span>${fmtClock(prog.t0)}</span></div>
        <div className="kv"><span>Transcurrido</span><span>${fmtDur(el)}</span></div>
        ${eta != null && html`<div className="kv"><span>Restante (aprox.)</span><span>${fmtDur(eta)}</span></div>`}
      </div>
      ${stale && html`<div className="note w">El motor no dio señales hace ${fmtDur(quiet)}. En pasos largos puede ser normal si el procesador está ocupado; si no, cancelá y reintentá.
        ${desk && desk.openLogs && html` <button className="lnk" type="button" onClick=${() => desk.openLogs()}>Abrir registro</button>`}</div>`}
      ${root.AZDesktop && root.AZDesktop.available && html`<div className="logsec"><button className="lnk" type="button" onClick=${() => setShowLog(v => !v)} aria-expanded=${showLog}>${showLog ? '▾' : '▸'} Registro</button>
        ${showLog && html`<${root.AZUI.LogPanel} rows=${8}/>`}</div>`}
      <button className="btn" type="button" onClick=${onCancel}>Cancelar</button></div></div>`;
  };
  root.AZUI.fmtDur = fmtDur; root.AZUI.fmtClock = fmtClock;
})(window);
