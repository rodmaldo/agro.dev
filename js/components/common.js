/* agro.dev · componentes React compartidos (React + htm, sin paso de compilación) */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef } = React;
  const html = htm.bind(React.createElement);
  const U = root.AZUI = root.AZUI || {};
  U.html = html;
  U.f1 = (n, d = 1) => (+n).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });

  const ICONS = {
    gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM10.3 3h3.4l.5 2.4 1.7.7 2.1-1.3 2.4 2.4-1.3 2.1.7 1.7 2.4.5v3.4l-2.4.5-.7 1.7 1.3 2.1-2.4 2.4-2.1-1.3-1.7.7-.5 2.4h-3.4l-.5-2.4-1.7-.7-2.1 1.3-2.4-2.4 1.3-2.1-.7-1.7L3 13.7v-3.4l2.4-.5.7-1.7-1.3-2.1 2.4-2.4 2.1 1.3 1.7-.7z',
    move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
    plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
    poly: 'M4 6l8-3 8 5-3 11-11 1z', edit: 'M4 20h4L19 9l-4-4L4 16z',
    wand: 'M3 21L15 9M15 3v4M13 5h4M20 10v4M18 12h4', folder: 'M3 6h6l2 2h10v11H3z',
    files: 'M6 3h8l4 4v14H6zM14 3v4h4', close: 'M6 6l12 12M18 6L6 18', chev: 'M6 9l6 6 6-6',
    split: 'M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4', grid: 'M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18',
    enter: 'M5 12h14M13 6l6 6-6 6', undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
    eyeoff: 'M3 3l18 18M10 5.2A9 9 0 0112 5c6 0 10 7 10 7a17 17 0 01-3 3.6M6.4 7A16 16 0 002 12s4 7 10 7a9 9 0 004-1', download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
    hist: 'M4 20V10M9 20V4M14 20v-8M19 20V8',
    brush: 'M4 20c0-3 2-4 4-4l1 1c0 2-1 3-5 3zM9 16L19 6l-1-1L8 15', eraser: 'M3 17l9-9 7 7-5 5H8zM8 12l7 7', layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5', trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13', back: 'M19 12H5M11 6l-6 6 6 6', check: 'M5 12l5 5 9-10', box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10', sat: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'
  };
  U.Ic = function Ic({ n, s = 16 }) {
    return html`<svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d=${ICONS[n] || ''}/></svg>`;
  };

  /* Slider: con onCommit solo dispara al soltar (para cálculos pesados) */
  U.Slider = function Slider({ label, min, max, step = 1, value, unit = '', onChange, onCommit, fmt }) {
    const [v, setV] = useState(value); const drag = useRef(false);
    useEffect(() => { if (!drag.current) setV(value); }, [value]);
    const done = () => { if (!drag.current) return; drag.current = false; onCommit && onCommit(+v); };
    const p = ((v - min) / (max - min)) * 100;
    return html`<label className="fld"><span className="fl">${label}<b>${fmt ? fmt(v) : v}${unit}</b></span>
      <input type="range" min=${min} max=${max} step=${step} value=${v} style=${{ '--p': p + '%' }}
        onInput=${e => { drag.current = true; const n = +e.target.value; setV(n); onChange && onChange(n); if (!onCommit) drag.current = false; }}
        onPointerUp=${done} onKeyUp=${done} onBlur=${done}/></label>`;
  };

  U.Toggle = function Toggle({ label, checked, onChange }) {
    return html`<label className="tog"><input type="checkbox" checked=${!!checked} onChange=${e => onChange(e.target.checked)}/><i></i><span>${label}</span></label>`;
  };

  U.Seg = function Seg({ value, opts, onChange }) {
    return html`<div className="seg" role="group">${opts.map(o => html`<button key=${o[0]} type="button" className=${value === o[0] ? 'on' : ''} onClick=${() => onChange(o[0])}>${o[1]}</button>`)}</div>`;
  };

  /* Ventana flotante arrastrable */
  U.Win = function Win({ id, title, x, y, w, z, onFocus, onClose, children }) {
    const [pos, setPos] = useState({ x, y }); const [min, setMin] = useState(false); const d = useRef(null);
    const down = e => { if (e.target.closest('button')) return; onFocus && onFocus(id); d.current = { sx: e.clientX, sy: e.clientY, x: pos.x, y: pos.y }; e.currentTarget.setPointerCapture(e.pointerId); };
    const move = e => { if (d.current) setPos({ x: d.current.x + e.clientX - d.current.sx, y: Math.max(0, d.current.y + e.clientY - d.current.sy) }); };
    return html`<section className="win" role="dialog" aria-label=${title} style=${{ left: pos.x, top: pos.y, width: w, zIndex: 20 + (z || 0) }} onPointerDown=${() => onFocus && onFocus(id)}>
      <header className="wh" onPointerDown=${down} onPointerMove=${move} onPointerUp=${() => { d.current = null; }}>
        <span>${title}</span>
        <span className="wb"><button type="button" aria-label=${min ? 'Expandir' : 'Minimizar'} onClick=${() => setMin(!min)}>${min ? '+' : '–'}</button><button type="button" aria-label="Cerrar" onClick=${onClose}><${U.Ic} n="close" s=${12}/></button></span>
      </header>
      ${!min && html`<div className="wc">${children}</div>`}</section>`;
  };

  /* Menú desplegable de la barra superior */
  U.Menu = function Menu({ id, label, open, setOpen, items }) {
    return html`<div className=${'menu' + (open === id ? ' on' : '')} data-menu="1">
      <button type="button" className="mb" aria-haspopup="menu" aria-expanded=${open === id} onClick=${() => setOpen(open === id ? null : id)} onPointerEnter=${() => { if (open && open !== id) setOpen(id); }}>${label}</button>
      ${open === id && html`<div className="md" role="menu">${items.map((it, i) => it.sep ? html`<hr key=${i}/>` :
        html`<button type="button" key=${i} role="menuitem" className="mi" disabled=${it.disabled} onClick=${() => { setOpen(null); it.on && it.on(); }}><span className="ck">${it.checked ? '■' : ''}</span><span>${it.t}</span><kbd>${it.k || ''}</kbd></button>`)}</div>`}
    </div>`;
  };
})(window);
