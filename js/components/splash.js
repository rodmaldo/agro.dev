/* agro.dev · pantalla de inicio con logo pixelado + ingreso */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef } = React;
  const { html, Ic } = root.AZUI;

  /* Ingreso con usuario y contraseña: desactivado por ahora (solo se muestra el logo). Para volver a pedirlo: LOGIN = true. */
  root.AZUI.LOGIN = false;

  root.AZUI.Splash = function Splash({ phase, onEnter, children }) {
    const [ready, setReady] = useState(false);
    useEffect(() => { const h = setTimeout(() => setReady(true), 1600); return () => clearTimeout(h); }, []);
    useEffect(() => { if (!root.AZUI.LOGIN && ready && phase === 'splash') { const h = setTimeout(onEnter, 500); return () => clearTimeout(h); } }, [ready, phase]);
    return html`<div className="splash">
      <img className="logo-big" src="assets/brand/logo-negativo.png" alt="agro.dev"/>
      ${ready && phase === 'splash' && root.AZUI.LOGIN && html`<button className="enter" type="button" onClick=${onEnter} aria-label="Ingresar"><${Ic} n="enter" s=${24}/></button><span className="enter-cap">ingresar</span>`}
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
