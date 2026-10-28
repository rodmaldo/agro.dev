/* agro.dev · pantallas "Inicio" (crear terreno / proyecto) y "Campo" (importar proyecto + subir carpeta o archivos) */
(function (root) {
  'use strict';
  const { useState, useEffect, useRef } = React;
  const { html, Ic, f1, Foot, Brand } = root.AZUI;

  const Head = ({ user, onLogout, back, title }) => html`<header className="top">
    ${back && html`<button className="lnk" type="button" onClick=${back} aria-label="Volver"><${Ic} n="back" s=${16}/></button>`}
    <div className="brand">agro<i>.dev</i></div>${title && html`<span className="crumb">${title}</span>`}
    <span className="grow"></span><${root.AZUI.GearBtn}/><span className="usr">${user}</span>${onLogout && html`<button className="lnk" type="button" onClick=${onLogout}>Salir</button>`}</header>`;

  const fmtHa = n => n ? f1(n, 1) + ' ha' : '— ha';
  const Thumb = ({ src, label }) => src ? html`<img className="thumb" src=${src} alt=${'Vista del último guardado de ' + label}/>` : html`<div className="thumb empty"><${Ic} n="grid" s=${26}/><span>Sin imagen todavía</span></div>`;

  /* ---------- 1 · INICIO: proyectos (p. ej. una estancia) ---------- */
  root.AZUI.Home = function Home({ user, onOpenFarm, onLogout }) {
    const [name, setName] = useState(''); const [err, setErr] = useState(''); const [open, setOpen] = useState(false);
    const [list, setList] = useState(() => { AZApi.fields.list(null); return AZApi.farms.list(); });
    const [ask, confirmNode] = root.AZUI.useConfirm();
    const info = f => { const lots = AZApi.fields.list(f.id), last = lots.filter(l => l.thumb).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))[0]; return { n: lots.length, ha: lots.reduce((a, l) => a + (+l.ha || 0), 0), thumb: last && last.thumb }; };
    const create = e => {
      e.preventDefault(); const n = name.trim();
      if (n.length < 2) return setErr('Escribí un nombre para el proyecto');
      if (list.some(f => f.name.toLowerCase() === n.toLowerCase())) return setErr('Ya existe un proyecto con ese nombre');
      const f = AZApi.farms.create(n); setList(AZApi.farms.list()); setName(''); setOpen(false); onOpenFarm(f);
    };
    return html`<div className="screen">
      <${Head} user=${user} onLogout=${onLogout}/>
      <main className="proj">
        <div className="phead"><h1>Proyectos <span className="mu">${list.length}</span></h1>
          <button className="btn pri" type="button" onClick=${() => setOpen(o => !o)}><${Ic} n="plus" s=${14}/> Nuevo proyecto</button></div>
        ${open && html`<section className="hcard"><h2>Nuevo proyecto</h2>
          <p className="mu">Un proyecto agrupa varios lotes, por ejemplo una estancia. Primero ponele un nombre; después cargás las carpetas o archivos del vuelo de cada lote.</p>
          <form onSubmit=${create} className="row" style=${{ alignItems: 'stretch' }}>
            <input type="text" autoFocus placeholder="Ej.: Estancia La Esperanza" aria-label="Nombre del proyecto" maxLength="60" value=${name} onInput=${e => { setName(e.target.value); setErr(''); }}/>
            <button className="btn pri fx" type="submit">Crear proyecto</button></form>
          <div className="err" role="alert">${err}</div></section>`}
        ${!list.length && !open && html`<section className="hcard"><h2>Todavía no tenés proyectos</h2><p className="mu">Creá el primero con <b>Nuevo proyecto</b>. Adentro vas a poder cargar todos los lotes del mismo establecimiento.</p></section>`}
        <div className="cards">${list.slice().reverse().map(f => { const i = info(f); return html`<article key=${f.id} className="card">
          <button type="button" className="cbody" onClick=${() => onOpenFarm(f)} aria-label=${'Abrir proyecto ' + f.name}><${Thumb} src=${i.thumb} label=${f.name}/>
            <div className="ctxt"><b>${f.name}</b><span className="mu">${i.n} ${i.n === 1 ? 'lote' : 'lotes'} · ${fmtHa(i.ha)}</span></div></button>
          <button type="button" className="lnk cdel" aria-label=${'Eliminar ' + f.name} onClick=${() => ask('Se elimina el proyecto "' + f.name + '" y sus lotes de la lista. Los archivos de las fotos no se borran.', 'Eliminar', '¿Eliminar proyecto?').then(ok => { if (ok) { AZApi.farms.remove(f.id); setList(AZApi.farms.list()); } })}><${Ic} n="trash" s=${14}/></button></article>`; })}</div>
      </main>
      ${confirmNode}
      <${Foot}/></div>`;
  };

  /* ---------- 1b · PROYECTO: lotes con su miniatura, hectáreas y cantidad ---------- */
  root.AZUI.Project = function Project({ user, farm, onOpen, onBack, onLogout }) {
    const [name, setName] = useState(''); const [err, setErr] = useState(''); const [open, setOpen] = useState(false);
    const [list, setList] = useState(() => AZApi.fields.list(farm.id));
    const [ask, confirmNode] = root.AZUI.useConfirm();
    const create = e => {
      e.preventDefault(); const n = name.trim();
      if (n.length < 2) return setErr('Escribí un nombre para el lote');
      if (list.some(f => f.name.toLowerCase() === n.toLowerCase())) return setErr('Ya hay un lote con ese nombre en este proyecto');
      const f = AZApi.fields.create(n, farm.id); setList(AZApi.fields.list(farm.id)); setName(''); setOpen(false); onOpen(f);
    };
    const totalHa = list.reduce((a, l) => a + (+l.ha || 0), 0);
    return html`<div className="screen">
      <${Head} user=${user} onLogout=${onLogout} back=${onBack} title=${farm.name}/>
      <main className="proj">
        <div className="phead"><div><h1>${farm.name}</h1><span className="mu">${list.length} ${list.length === 1 ? 'lote' : 'lotes'} · ${fmtHa(totalHa)}</span></div>
          <button className="btn pri" type="button" onClick=${() => setOpen(o => !o)}><${Ic} n="plus" s=${14}/> Nuevo lote</button></div>
        ${open && html`<section className="hcard"><h2>Nuevo lote</h2>
          <p className="mu">Ponele nombre al lote. En el paso siguiente importás las carpetas o archivos del vuelo.</p>
          <form onSubmit=${create} className="row" style=${{ alignItems: 'stretch' }}>
            <input type="text" autoFocus placeholder="Ej.: Lote 5" aria-label="Nombre del lote" maxLength="60" value=${name} onInput=${e => { setName(e.target.value); setErr(''); }}/>
            <button className="btn pri fx" type="submit">Crear lote</button></form>
          <div className="err" role="alert">${err}</div></section>`}
        ${!list.length && !open && html`<section className="hcard"><h2>Este proyecto no tiene lotes</h2><p className="mu">Agregá el primero con <b>Nuevo lote</b>.</p></section>`}
        <div className="cards">${list.slice().reverse().map(f => html`<article key=${f.id} className="card">
          <button type="button" className="cbody" onClick=${() => onOpen(f)} aria-label=${'Abrir lote ' + f.name}><${Thumb} src=${f.thumb} label=${f.name}/>
            <div className="ctxt"><b>${f.name}</b><span className="mu">${fmtHa(f.ha)}${f.inf != null ? ' · infértil ' + f1(f.inf, 1) + ' ha' : ''}</span>
              <span className="mu">${f.updated ? 'Guardado ' + new Date(f.updated).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : 'Creado ' + new Date(f.created).toLocaleDateString('es-AR')}</span></div></button>
          <button type="button" className="lnk cdel" aria-label=${'Eliminar ' + f.name} onClick=${() => ask('Se elimina el lote "' + f.name + '" del proyecto. Los archivos de las fotos no se borran.', 'Eliminar', '¿Eliminar lote?').then(ok => { if (ok) { AZApi.fields.remove(f.id); setList(AZApi.fields.list(farm.id)); } })}><${Ic} n="trash" s=${14}/></button></article>`)}</div>
      </main>
      ${confirmNode}
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
