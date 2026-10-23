/* agro.dev · pantalla de inicio con logo pixelado + ingreso */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef } = React;
  const { html, Ic } = root.AZUI;

  const SPROUT = ['###.....###', '####...####', '.####.####.', '..#######..', '....###....', '....###....', '....###....', '....###....'];
  const LW = 112, LH = 40;

  root.AZUI.Splash = function Splash({ phase, onEnter, children }) {
    const ref = useRef(null); const [ready, setReady] = useState(false);
    useEffect(() => {
      let raf = 0, dead = false;
      (async () => {
        try { await Promise.race([document.fonts.load('700 18px "JetBrains Mono"'), new Promise(r => setTimeout(r, 700))]); } catch (e) { }
        if (dead) return;
        const cv = ref.current; if (!cv) return;
        const B = Math.max(3, Math.min(9, Math.floor(Math.min(innerWidth * 0.8, 900) / LW)));
        cv.width = LW * B; cv.height = LH * B; const g = cv.getContext('2d');
        const mask = (txt, x0) => {
          const o = document.createElement('canvas'); o.width = LW; o.height = 20; const c = o.getContext('2d');
          c.fillStyle = '#fff'; c.font = '700 17px "JetBrains Mono",monospace'; c.textBaseline = 'middle'; c.fillText(txt, x0, 10);
          const d = c.getImageData(0, 0, LW, 20).data, out = [];
          for (let y = 0; y < 20; y++) for (let x = 0; x < LW; x++) if (d[(y * LW + x) * 4 + 3] > 140) out.push([x, y + 17]);
          return out;
        };
        const m = document.createElement('canvas').getContext('2d'); m.font = '700 17px "JetBrains Mono",monospace';
        const w1 = m.measureText('agro').width, w2 = m.measureText('.dev').width, x0 = Math.round((LW - (w1 + w2)) / 2);
        const P = [];
        const add = (pts, col) => pts.forEach(([tx, ty]) => P.push({ tx, ty, col, sx: Math.random() * LW * 1.5 - LW * 0.25, sy: Math.random() * LH * 2 - LH * 0.5, dl: (tx / LW) * 500 + Math.random() * 350 }));
        add(mask('agro', x0), '#e7ece8'); add(mask('.dev', x0 + Math.round(w1)), '#b8f04a');
        const sp = []; SPROUT.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') sp.push([x + Math.round((LW - 11) / 2), y + 3]); })); add(sp, '#b8f04a');
        const t0 = performance.now(); let fired = false;
        const loop = now => {
          const t = now - t0; g.clearRect(0, 0, cv.width, cv.height);
          for (const p of P) {
            const k = Math.max(0, Math.min(1, (t - p.dl) / 1100)), e = 1 - Math.pow(1 - k, 3);
            let a = k; if (k >= 1 && Math.random() < 0.004) a = 0.35;
            g.globalAlpha = a; g.fillStyle = p.col; g.fillRect((p.sx + (p.tx - p.sx) * e) * B, (p.sy + (p.ty - p.sy) * e) * B, B - 1, B - 1);
          }
          g.globalAlpha = 1;
          if (!fired && t > 2000) { fired = true; setReady(true); }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      })();
      return () => { dead = true; cancelAnimationFrame(raf); };
    }, []);
    return html`<div className="splash">
      <canvas ref=${ref} role="img" aria-label="agro.dev"></canvas>
      ${ready && phase === 'splash' && html`<button className="enter" type="button" onClick=${onEnter} aria-label="Ingresar"><${Ic} n="enter" s=${24}/></button><span className="enter-cap">ingresar</span>`}
      ${children}
    </div>`;
  };

  root.AZUI.Login = function Login({ onOk, onCancel }) {
    const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [sh, setSh] = useState(0);
    useEffect(() => { const k = e => { if (e.key === 'Escape') onCancel(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
    const submit = async e => {
      e.preventDefault(); setBusy(true); setErr('');
      try { const r = await AZApi.login(u.trim(), p); onOk(r); }
      catch (x) { setErr(x.message || 'Error'); setSh(n => n + 1); }
      setBusy(false);
    };
    return html`<div className="veil" onPointerDown=${e => { if (e.target === e.currentTarget) onCancel(); }}>
      <form key=${sh} className=${'login' + (sh ? ' shake' : '')} onSubmit=${submit} aria-label="Ingreso">
        <h2>agro<i>.dev</i> · ingreso</h2>
        <label className="fld"><span className="fl">Usuario</span><input type="text" autoFocus autoComplete="username" value=${u} onInput=${e => setU(e.target.value)}/></label>
        <label className="fld"><span className="fl">Contraseña</span><input type="password" autoComplete="current-password" value=${p} onInput=${e => setP(e.target.value)}/></label>
        <div className="err" role="alert">${err}</div>
        <button className="btn pri" type="submit" disabled=${busy || !u || !p}>${busy ? 'Verificando…' : 'Ingresar'}</button>
      </form></div>`;
  };
})(window);
