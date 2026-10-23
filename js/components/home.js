/* agro.dev · pantallas "Inicio" (crear terreno / proyecto) y "Campo" (importar proyecto + subir carpeta o archivos) */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef } = React;
  const { html, Ic, f1, Foot, Brand } = root.AZUI;

  const Head = ({ user, onLogout, back, title }) => html`<header className="top">
    ${back && html`<button className="lnk" type="button" onClick=${back} aria-label="Volver"><${Ic} n="back" s=${16}/></button>`}
    <div className="brand">agro<i>.dev</i></div>${title && html`<span className="crumb">${title}</span>`}
    <span className="grow"></span><span className="usr">${user}</span>${onLogout && html`<button className="lnk" type="button" onClick=${onLogout}>Salir</button>`}</header>`;

  /* ---------- 1 · INICIO ---------- */
  root.AZUI.Home = function Home({ user, onOpen, onLogout }) {
    const [name, setName] = useState(''); const [list, setList] = useState(() => AZApi.fields.list()); const [err, setErr] = useState('');
    const create = e => {
      e.preventDefault(); const n = name.trim();
      if (n.length < 2) return setErr('Escribí un nombre para el terreno o proyecto');
      if (list.some(f => f.name.toLowerCase() === n.toLowerCase())) return setErr('Ya existe un terreno con ese nombre');
      const f = AZApi.fields.create(n); setList(AZApi.fields.list()); setName(''); onOpen(f);
    };
    return html`<div className="screen">
      <${Head} user=${user} onLogout=${onLogout}/>
      <main className="home">
        <section className="hcard">
          <h1>Nuevo terreno o proyecto</h1>
          <p className="mu">Dale un nombre al lote que vas a zonificar. Después vas a poder importar proyectos y subir las imágenes del vuelo.</p>
          <form onSubmit=${create} className="row" style=${{ alignItems: 'stretch' }}>
            <input type="text" autoFocus placeholder="Ej.: Lote Norte · Campaña 25/26" aria-label="Nombre del terreno o proyecto" maxLength="60" value=${name} onInput=${e => { setName(e.target.value); setErr(''); }}/>
            <button className="btn pri fx" type="submit"><${Ic} n="plus" s=${14}/> Crear</button>
          </form>
          <div className="err" role="alert">${err}</div>
        </section>
        <section className="hcard">
          <h2>Terrenos <span className="mu">${list.length}</span></h2>
          ${!list.length && html`<div className="mu">Todavía no creaste ninguno.</div>`}
          <ul className="flds">${list.slice().reverse().map(f => html`<li key=${f.id}>
            <button type="button" className="fopen" onClick=${() => onOpen(f)}><b>${f.name}</b><span className="mu">${new Date(f.created).toLocaleDateString('es-AR')}</span></button>
            <button type="button" className="lnk" aria-label=${'Eliminar ' + f.name} onClick=${() => { if (confirm('¿Eliminar "' + f.name + '"?')) { AZApi.fields.remove(f.id); setList(AZApi.fields.list()); } }}><${Ic} n="trash" s=${14}/></button></li>`)}</ul>
        </section>
      </main>
      <${Foot}/></div>`;
  };

  /* ---------- 2 · CAMPO ---------- */
  root.AZUI.Field = function Field({ user, field, job, setJob, onBack, onNext, onLogout }) {
    const [busy, setBusy] = useState(false); const [over, setOver] = useState(false); const [projs, setProjs] = useState([]); const [msg, setMsg] = useState('');
    const dirR = useRef(), filR = useRef(), jsR = useRef(), seq = useRef(0);
    useEffect(() => { AZApi.listProjects().then(l => setProjs((l || []).filter(p => p.fieldId === field.id))).catch(() => { }); }, [field.id]);

    /* Cada selección SE SUMA a las anteriores (un vuelo grande genera varias carpetas) */
    const take = async (added, replace) => {
      if (!added.length && !replace) { setBusy(false); return; } setBusy(true);
      const mine = ++seq.current, seen = new Set(replace ? [] : job.items.map(AZFiles.keyOf)), merged = replace ? [] : job.items.slice();
      for (const it of added) { const k = AZFiles.keyOf(it); if (!seen.has(k)) { seen.add(k); merged.push(it); } }
      if (!merged.length) { setJob({ ...job, items: [], info: null }); setBusy(false); return; }
      const info = await AZFiles.analyze(merged); if (mine !== seq.current) return;
      setJob(j => ({ ...j, items: merged, info })); setBusy(false);
    };
    const fromInput = e => { const arr = Array.from(e.target.files).map(f => ({ f, path: f.webkitRelativePath || f.name })); e.target.value = ''; take(arr); };
    const importPreset = p => { setJob(j => ({ ...j, preset: p })); setMsg('Proyecto "' + (p.name || field.name) + '" importado: se aplican su configuración, límite y puntos. Falta cargar las imágenes del vuelo (el proyecto no las contiene).'); };
    const fromFile = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try { const j = JSON.parse(await f.text()); if (!j || j.format !== 'agro.dev/project') throw 0; importPreset(j); } catch (x) { setMsg('Ese archivo no es un proyecto de agro.dev.'); }
    };
    const info = job.info, ok = info && (info.raw.length > 0 || info.ortho);
    const native = AZDesktop.available;
    /* escritorio: las carpetas se eligen con el diálogo del sistema y se leen desde el disco (sin subir nada, sin límite de memoria) */
    const [scanMsg, setScanMsg] = useState('');
    const scanNative = async folders => {
      if (!folders.length) { setJob(j => ({ ...j, folders: [], info: null })); return; }
      setBusy(true); setMsg('');
      try { const inf = await AZDesktop.scan(folders, (p, m) => setScanMsg(m)); setJob(j => ({ ...j, folders, items: [], info: inf })); }
      catch (e) { setMsg('No se pudieron leer las carpetas: ' + e.message); }
      setBusy(false); setScanMsg('');
    };
    const addFolders = async () => { const f = await AZDesktop.pickFolders(); if (f && f.length) scanNative([...new Set([...(job.folders || []), ...f])]); };

    return html`<div className="screen">
      <${Head} user=${user} onLogout=${onLogout} back=${onBack} title=${field.name}/>
      <main className="campo">
        <section className="hcard">
          <h2>Importar proyecto</h2>
          <p className="mu">Recuperá la configuración, el límite y los puntos de un proyecto guardado. Las imágenes se vuelven a subir abajo.</p>
          ${projs.length > 0 && html`<ul className="flds">${projs.slice().reverse().map(p => html`<li key=${p.id}><button type="button" className="fopen" onClick=${() => importPreset(p)}><b>${p.name || 'Proyecto'}</b><span className="mu">${p.savedAt ? new Date(p.savedAt).toLocaleString('es-AR') : ''}</span></button></li>`)}</ul>`}
          ${!projs.length && html`<div className="mu">No hay proyectos guardados para este terreno.</div>`}
          <div className="row"><button className="btn" type="button" onClick=${() => jsR.current.click()}><${Ic} n="files" s=${14}/> Importar desde archivo (.json)</button>
            ${job.preset && html`<button className="btn fx sm" type="button" onClick=${() => { setJob(j => ({ ...j, preset: null })); setMsg(''); }}>Descartar</button>`}</div>
          <input ref=${jsR} type="file" accept=".json,application/json" hidden onChange=${fromFile}/>
          ${msg && html`<div className=${'note' + (job.preset ? '' : ' w')} role="status">${msg}</div>`}
        </section>

        <section className="hcard grow2">
          <h2>Imágenes del vuelo</h2>
          ${native && html`<div className="drop">
            <div className="row"><button className="btn pri" type="button" onClick=${addFolders} disabled=${busy}><${Ic} n="folder" s=${14}/> ${(job.folders || []).length ? 'Agregar otra carpeta' : 'Elegir carpetas del vuelo'}</button>
              ${(job.folders || []).length > 0 && html`<button className="btn fx" type="button" onClick=${() => scanNative([])}>Vaciar</button>`}</div>
            <span className="mu">${busy ? (scanMsg || 'Leyendo carpetas…') : 'Elegí una o varias carpetas (podés seleccionar varias a la vez). Las fotos se leen directamente desde tu disco, con su calidad original; no se suben a ningún lado.'}</span>
            ${(job.folders || []).length > 0 && html`<ul className="flds">${job.folders.map(f => html`<li key=${f}><span className="fopen"><b>${f.split(/[\\/]/).filter(Boolean).pop()}</b><span className="mu">${f}</span></span>
              <button type="button" className="lnk" aria-label="Quitar carpeta" onClick=${() => scanNative(job.folders.filter(x => x !== f))}><${Ic} n="trash" s=${14}/></button></li>`)}</ul>`}
          </div>`}
          ${!native && html`<div className=${'drop' + (over ? ' over' : '')} onDragOver=${e => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
            onDrop=${async e => { e.preventDefault(); setOver(false); setBusy(true); const arr = await AZFiles.readDrop(e.dataTransfer); take(arr); }}>
            <div className="row"><button className="btn pri" type="button" onClick=${() => dirR.current.click()}><${Ic} n="folder" s=${14}/> ${job.items.length ? 'Agregar otra carpeta' : 'Subir carpeta'}</button>
              <button className="btn" type="button" onClick=${() => filR.current.click()}><${Ic} n="files" s=${14}/> Subir archivos</button>
              ${job.items.length > 0 && html`<button className="btn fx" type="button" onClick=${() => take([], true)}>Vaciar</button>`}</div>
            <span className="mu">${busy ? 'Leyendo archivos…' : 'Cada selección se suma a la anterior: agregá todas las carpetas del vuelo (100MEDIA, 101MEDIA…) o la carpeta madre. También podés arrastrarlas acá.'}</span>
            <input ref=${dirR} type="file" webkitdirectory="" directory="" multiple hidden onChange=${fromInput}/>
            <input ref=${filR} type="file" multiple accept="image/*,.tif,.tiff" hidden onChange=${fromInput}/>
          </div>`}
          ${info && html`<div className="kv-box">
            <div className="kv"><span>Archivos cargados</span><span>${info.n} · ${f1(info.mb, 0)} MB · ${info.folders.length} carpeta(s)</span></div>
            ${info.native && info.gsdCm && html`<div className="kv"><span>Resolución original</span><span>${f1(info.gsdCm, 2)} cm/px · ${info.model || ''}${info.rtk === 50 ? ' · RTK' : ''}</span></div>
            <div className="kv"><span>Superficie aproximada</span><span>${f1(info.areaHa, 0)} ha</span></div>`}
            <div className="kv"><span>Fotos RGB (_D.JPG)</span><span><b>${info.raw.length}</b></span></div>
            <div className="kv"><span>Bandas multiespectrales (_MS_*.TIF)</span><span>${info.ms}</span></div>
            <div className="kv"><span>Ortomosaico JPG/PNG</span><span>${info.ortho ? info.ortho.f.name : '—'}</span></div>
            ${info.gps && html`<div className="kv"><span>Posición del vuelo (GPS)</span><span>${f1(info.gps.lat, 5)}, ${f1(info.gps.lon, 5)}</span></div>`}
            ${info.alt != null && html`<div className="kv"><span>Altura de vuelo</span><span>${f1(info.alt, 0)} m</span></div>`}
            <div className="flist">${info.folders.slice(0, 8).map(([d, c]) => html`<div className="kv" key=${d}><span>${d}</span><span>${c.rgb} RGB${c.ms ? ' · ' + c.ms + ' MS' : ''}</span></div>`)}${info.folders.length > 8 && html`<div className="mu">…y ${info.folders.length - 8} carpetas más</div>`}</div>
          </div>`}
          ${info && !ok && html`<div className="note w">No encontré fotos _D.JPG ni un ortomosaico JPG/PNG. ${info.tif > 0 || info.ms > 0 ? 'El navegador no abre GeoTIFF: exportá el ortomosaico como JPG/PNG o agregá las fotos RGB.' : ''}</div>`}
        </section>
      </main>
      <div className="bar"><button className="btn" type="button" onClick=${onBack}>Atrás</button><span className="grow"></span><button className="btn pri" type="button" disabled=${!ok || busy} onClick=${onNext}>Siguiente</button></div>
      <${Foot}/></div>`;
  };
})(window);
