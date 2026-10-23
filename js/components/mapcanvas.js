/* agro.dev · lienzo del mapa: zoom/desplazamiento, puntos (+)/(−) en celdas, pincel/borrador, varita, límite y divisor antes/después */
(function (root) {
  'use strict';
  const { useEffect, useRef } = React;
  const { html, Ic } = root.AZUI;
  const HOVER = { padd: 1, pneg: 1, brush: 1, erase: 1 };

  root.AZUI.MapCanvas = function MapCanvas({ S, rev, ui, held, api, mapApi, children }) {
    const wrap = useRef(), cv = useRef(), view = useRef({ x: 0, y: 0, z: 1 }), drag = useRef(null), rf = useRef(0), mouse = useRef(null);
    const L = useRef({}); const uiR = useRef(ui); uiR.current = ui;
    const dpr = () => window.devicePixelRatio || 1;
    const opts = () => { const u = uiR.current; return { vis: u.vis, orthOp: u.orthOp, satOp: u.satOp, gridOp: u.gridOp, gridHeld: held.current, ba: u.ba, baPos: u.baPos, tool: u.tool, mouse: mouse.current, active: u.active, heat: u.heat, brushN: u.brushN }; };
    const draw = () => { const c = cv.current; if (!c) return; const k = dpr(), v = view.current; AZMap.paint(c, S, { x: v.x * k, y: v.y * k, z: v.z * k }, opts(), true, redraw); };
    const redraw = () => { cancelAnimationFrame(rf.current); rf.current = requestAnimationFrame(draw); };
    const fit = () => { const w = wrap.current; view.current = AZMap.fit(S, w.clientWidth, w.clientHeight); redraw(); };
    L.current = { redraw, fit };
    mapApi.current = { fit, redraw, view: () => view.current, canvas: () => cv.current };
    useEffect(redraw);

    useEffect(() => {
      const c = cv.current, w = wrap.current;
      const size = () => { const k = dpr(); c.width = Math.round(w.clientWidth * k); c.height = Math.round(w.clientHeight * k); L.current.redraw(); };
      const ro = new ResizeObserver(size); ro.observe(w); size(); L.current.fit();
      const wheel = e => {
        e.preventDefault(); const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, v = view.current;
        const z = Math.max(0.02, Math.min(80, v.z * (e.deltaY < 0 ? 1.18 : 1 / 1.18))), k = z / v.z;
        v.x = x - (x - v.x) * k; v.y = y - (y - v.y) * k; v.z = z; L.current.redraw();
      };
      c.addEventListener('wheel', wheel, { passive: false });
      return () => { ro.disconnect(); c.removeEventListener('wheel', wheel); };
    }, []);

    const pos = e => { const r = cv.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const toImg = p => [(p[0] - view.current.x) / view.current.z, (p[1] - view.current.y) / view.current.z];
    const cellOf = w => AZ.cellAt(S, w[0], w[1]);
    const activeId = () => { const u = uiR.current; return u.active === 'ortho' || u.active === 'buf' || u.active === 'sat' ? null : u.active; };

    /* trazo del pincel entre dos celdas (sin huecos al mover rápido) */
    const stroke = (a, b, val) => {
      const id = activeId(); if (!id || !AZ.maskOf(S, id)) return false;
      const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
      for (let k = 0; k <= n; k++) AZ.brush(S, id, Math.round(a[0] + (b[0] - a[0]) * k / n), Math.round(a[1] + (b[1] - a[1]) * k / n), uiR.current.brushN, val);
      return true;
    };

    const down = e => {
      const u = uiR.current, p = pos(e), w = toImg(p), r = 10 / view.current.z, t = u.tool;
      if (e.button === 1 || t === 'pan' || !(S.orth || S.tiled)) { drag.current = { t: 'pan', sx: p[0], sy: p[1], vx: view.current.x, vy: view.current.y }; cv.current.setPointerCapture(e.pointerId); return; }
      if (!S.gw && t !== 'poly' && t !== 'edit') return;
      if (t === 'padd' || t === 'pneg') {
        if (e.button === 2) return;
        const [ci, cj] = cellOf(w);
        if (!S.inside[cj * S.gw + ci]) return api.toast('Los puntos solo se agregan dentro de las celdas de la grilla del lote');
        api.onPoint(ci, cj, t === 'padd' ? 1 : -1); return;
      }
      if (t === 'brush' || t === 'erase') {
        if (!activeId()) return api.toast('Elegí una capa de detección en el panel de capas');
        const val = (t === 'brush') !== (e.button === 2), c0 = cellOf(w);
        drag.current = { t: 'brush', val, last: c0 }; cv.current.setPointerCapture(e.pointerId); stroke(c0, c0, val); redraw(); return;
      }
      if (t === 'wand') {
        const L = S.hl.find(l => l.id === uiR.current.active);
        if (!L) return api.toast('Elegí una capa de histograma para usar la varita');
        const [ci, cj] = cellOf(w), msg = e.button === 2 ? AZ.wandErase(S, L, ci, cj) : AZ.wandSel(S, L, ci, cj, e.ctrlKey || e.metaKey, u.tol);
        if (msg) api.toast(msg); api.refresh(); return;
      }
      if (e.button === 2) return;
      if (t === 'poly') {
        if (S.tmp.length >= 3 && Math.hypot(S.tmp[0][0] - w[0], S.tmp[0][1] - w[1]) < r) api.closePoly(); else { S.tmp.push(w); redraw(); }
        return;
      }
      if (t === 'edit') {
        const P = S.poly; let k = P.findIndex(q => Math.hypot(q[0] - w[0], q[1] - w[1]) < r);
        if (k >= 0 && e.shiftKey && P.length > 3) { P.splice(k, 1); api.polyChanged(); return; }
        if (k < 0) for (let i = 0; i < P.length; i++) {
          const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1];
          const q = Math.max(0, Math.min(1, ((w[0] - a[0]) * dx + (w[1] - a[1]) * dy) / (dx * dx + dy * dy + 1e-9)));
          if (Math.hypot(a[0] + q * dx - w[0], a[1] + q * dy - w[1]) < r) { P.splice(i + 1, 0, [a[0] + q * dx, a[1] + q * dy]); k = i + 1; break; }
        }
        if (k >= 0) { drag.current = { t: 'vtx', k }; cv.current.setPointerCapture(e.pointerId); redraw(); }
      }
    };
    const move = e => {
      const p = pos(e), w = toImg(p); mouse.current = w;
      const d = drag.current;
      if (d) {
        if (d.t === 'pan') { view.current.x = d.vx + p[0] - d.sx; view.current.y = d.vy + p[1] - d.sy; }
        else if (d.t === 'brush') { const c1 = cellOf(w); stroke(d.last, c1, d.val); d.last = c1; }
        else S.poly[d.k] = w;
        redraw();
      } else if ((uiR.current.tool === 'poly' && S.tmp.length) || HOVER[uiR.current.tool]) redraw();
      const ll = AZ.pxToGeo(S, w[0], w[1]);
      window.dispatchEvent(new CustomEvent('az-cursor', { detail: { lat: ll.lat, lon: ll.lon, x: w[0] * S.mpp, y: w[1] * S.mpp } }));
    };
    const up = () => {
      const d = drag.current; drag.current = null;
      if (d && d.t === 'vtx') api.polyChanged(); else if (d && d.t === 'brush') api.refresh();
    };
    const leave = () => { mouse.current = null; if (HOVER[uiR.current.tool]) redraw(); };

    /* divisor antes/después */
    const bd = useRef(false);
    const bdown = e => { bd.current = true; e.currentTarget.setPointerCapture(e.pointerId); e.stopPropagation(); };
    const bmove = e => { if (!bd.current) return; const r = wrap.current.getBoundingClientRect(); api.set({ baPos: Math.max(0.03, Math.min(0.97, (e.clientX - r.left) / r.width)) }); };
    const cur = ui.tool === 'pan' ? 'grab' : ui.tool === 'wand' ? 'copy' : 'crosshair';

    return html`<div className="stage" ref=${wrap} style=${{ gridArea: 's' }}>
      <canvas ref=${cv} aria-label="Mapa del lote" style=${{ cursor: cur }} onContextMenu=${e => e.preventDefault()}
        onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerLeave=${leave} onDoubleClick=${() => { if (ui.tool === 'poly' && S.tmp.length >= 4) { S.tmp.pop(); api.closePoly(); } }}></canvas>
      ${ui.ba && (S.orth || S.tiled) && html`<div className="ba" style=${{ left: ui.baPos * 100 + '%' }}>
        <span className="ba-l l">ANTES · ORTOMOSAICO</span><span className="ba-l r">DESPUÉS · DETECCIÓN</span>
        <div className="ba-hit" role="slider" aria-label="Divisor antes y después" aria-valuemin="3" aria-valuemax="97" aria-valuenow=${Math.round(ui.baPos * 100)} tabIndex="0"
          onPointerDown=${bdown} onPointerMove=${bmove} onPointerUp=${() => { bd.current = false; }}
          onKeyDown=${e => { if (e.key === 'ArrowLeft') api.set({ baPos: Math.max(0.03, ui.baPos - 0.02) }); if (e.key === 'ArrowRight') api.set({ baPos: Math.min(0.97, ui.baPos + 0.02) }); }}>
          <div className="ba-h"><${Ic} n="split" s=${16}/></div></div></div>`}
      ${ui.vis.sat && html`<div className="attr">${AZGeo.ATTRIBUTION}</div>`}
      ${children}
    </div>`;
  };
})(window);
