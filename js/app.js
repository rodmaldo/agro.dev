/* agro.dev · raíz: splash → login → Inicio → Campo → asistente (tipo de imagen, grilla, detección) → dashboard */
(function () {
  'use strict';
  const { useState, useRef } = React;
  const { html, Splash, Login, Home, Project, Field, Wizard, Dashboard } = AZUI;

  const newJob = () => ({ items: [], info: null, preset: null, base: null, note: '', presetDone: false });
  function initCfg(info, preset) {
    const c = {
      kind: info.ms ? 'both' : 'rgb', source: info.native ? 'mosaic' : info.ortho ? 'ortho' : (info.raw.length >= 2 ? 'mosaic' : 'sample'), ndvi: null, res: info.gsdCm ? info.gsdCm.toFixed(2) : (info.alt && info.pw === 5280) ? (info.alt * 0.02685).toFixed(2) : '3', quality: 'media', detail: 'norm',
      prec: info.rtk === 50 ? 'rtk' : 'gps', lat: info.gps ? +info.gps.lat.toFixed(6) : -33, lon: info.gps ? +info.gps.lon.toFixed(6) : -61,
      outRes: 'orig', gridM: 5, rot: 0, detName: 'Salitre', color: '#E69F00', sens: 50
    };
    const p = preset && preset.cfg;
    if (p) ['kind', 'gridM', 'rot', 'detName', 'color', 'sens', 'res', 'quality', 'detail', 'prec', 'outRes'].forEach(k => { if (p[k] != null) c[k] = p[k]; });
    return c;
  }

  function App() {
    const [stage, setStage] = useState('splash');
    const [user, setUser] = useState(null);
    const [farm, setFarm] = useState(null);
    const [field, setField] = useState(null);
    const [job, setJobS] = useState(newJob);
    const [cfg, setCfg] = useState(null);
    const [wkey, setWkey] = useState(0);
    const S = useRef(null); if (!S.current) S.current = AZ.newState();
    const jobR = useRef(job); jobR.current = job;
    const setJob = f => setJobS(j => { const n = typeof f === 'function' ? f(j) : f; jobR.current = n; return n; });

    const enter = () => { const s = AZApi.session(); if (!AZUI.LOGIN) { setUser(''); setStage('home'); } else if (s) { setUser(s.user); setStage('home'); } else setStage('login'); };
    const logout = () => { AZApi.logout(); setUser(null); setFarm(null); setField(null); setJob(newJob()); S.current = AZ.newState(); setStage('splash'); };
    const openFarm = f => { setFarm(f); setStage('proj'); };
    const [openErr, setOpenErr] = useState('');
    /* Abrir un lote: si ya fue procesado y guardado, se restaura al instante (sin volver a procesar); si no, va a importar las fotos.
       fresh = true fuerza empezar de nuevo (reprocesar). */
    const openField = async (f, fresh) => {
      S.current = AZ.newState(); setJob(newJob()); setField(f); setCfg(null); setOpenErr('');
      if (!fresh && window.AZLot && await window.AZLot.has(f.id)) {
        setStage('opening');
        try {
          const r = await window.AZLot.open(S.current, f, window.AZDesktop.openBase);
          if (r) { setJob({ ...newJob(), ...r.job }); setCfg(r.cfg); setWkey(k => k + 1); setStage(r.stage === 'wizard' ? 'wizard' : 'dash'); return; }
        } catch (e) { S.current = AZ.newState(); setOpenErr('No se pudo abrir el lote guardado (' + e.message + '). Cargá las fotos de nuevo para reprocesarlo.'); if (window.AZDesktop) window.AZDesktop.addLog('abrir lote guardado: ERROR ' + e.message, 'Interfaz'); }
      }
      setStage('field');
    };

    if (stage === 'opening') return html`<div className="screen"><main className="proj"><section className="hcard"><h2>Abriendo "${field && field.name}"…</h2><p className="mu">Recuperando el lote guardado: no hace falta procesar de nuevo.</p></section></main></div>`;
    if (stage === 'home') return html`<${Home} user=${user} onOpenFarm=${openFarm} onLogout=${logout}/>`;
    if (stage === 'proj' && farm) return html`<${Project} user=${user} farm=${farm} onOpen=${openField} onBack=${() => setStage('home')} onLogout=${logout}/>`;
    if (stage === 'field') return html`<${Field} user=${user} field=${field} job=${job} setJob=${setJob} onBack=${() => setStage('proj')} openErr=${openErr} onNext=${() => { setCfg(initCfg(job.info, job.preset)); setWkey(k => k + 1); setStage('wizard'); }} onLogout=${logout}/>`;
    if (stage === 'wizard' && cfg) return html`<${Wizard} key=${wkey} user=${user} field=${field} job=${job} S=${S.current} cfg=${cfg} setCfg=${setCfg} initStep=${job.base ? 1 : 0}
      onBack=${() => setStage('field')} onDone=${() => setStage('dash')} onLogout=${logout}/>`;
    if (stage === 'dash') return html`<${Dashboard} user=${user} field=${field} S=${S.current} cfg=${cfg} job=${job} onLogout=${logout} onHome=${() => setStage('proj')}
      onReconfig=${() => { setWkey(k => k + 1); setStage('wizard'); }}/>`;
    return html`<${Splash} phase=${stage} onEnter=${enter}>
      ${stage === 'login' && html`<${Login} onOk=${r => { setUser(r.user); setStage('home'); }} onCancel=${() => setStage('splash')}/>`}
    <//>`;
  }
  ReactDOM.createRoot(document.getElementById('root')).render(html`<${App}/>`);
})();
