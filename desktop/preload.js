// Puente seguro entre la interfaz (web) y el proceso principal. La web solo ve window.agroDesktop.
const { contextBridge, ipcRenderer } = require('electron');
let seq = 0; const cbs = new Map(); const logCbs = new Set();
ipcRenderer.on('engine:event', (_e, m) => {
  if (m.type === 'log') { logCbs.forEach(f => { try { f(m); } catch (x) { } }); return; }      // el registro llega a todos los suscriptores
  const f = cbs.get(m.id); if (f) { try { f(m); } catch (x) { } }
});
contextBridge.exposeInMainWorld('agroDesktop', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('app:version'),
  system: () => ipcRenderer.invoke('app:system'),
  pickFolders: () => ipcRenderer.invoke('dialog:folders'),       // selección múltiple de carpetas
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  pickSave: (name, ext, label) => ipcRenderer.invoke('dialog:save', name, ext, label),
  // Ejecuta un comando del motor. onEvent recibe {type:'progress'|'log', pct, msg}. Devuelve {id, done}: done se resuelve con {result} o {error}.
  engine: (cmd, args, onEvent) => {
    const id = ++seq; if (onEvent) cbs.set(id, onEvent);
    const done = ipcRenderer.invoke('engine:call', id, cmd, args || {}).finally(() => cbs.delete(id));
    return { id, done };
  },
  cancel: id => ipcRenderer.invoke('engine:cancel', id),
  savePdf: (html, name) => ipcRenderer.invoke('report:pdf', html, name),
  reveal: p => ipcRenderer.invoke('shell:reveal', p),
  workdir: () => ipcRenderer.invoke('app:workdir'),
  examples: { save: (id, json) => ipcRenderer.invoke('ex:save', id, json), summary: () => ipcRenderer.invoke('ex:summary') },
  lots: { save: (id, json, cells) => ipcRenderer.invoke('lot:save', id, json, cells), load: id => ipcRenderer.invoke('lot:load', id), has: id => ipcRenderer.invoke('lot:has', id), find: name => ipcRenderer.invoke('lot:find', name), remove: id => ipcRenderer.invoke('lot:remove', id) },
  onLog: cb => { logCbs.add(cb); return () => logCbs.delete(cb); },
  updates: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: cb => { const f = (_e, st) => { try { cb(st); } catch (x) { } }; ipcRenderer.on('update:status', f); return () => ipcRenderer.removeListener('update:status', f); }
  },
  logdir: () => ipcRenderer.invoke('app:logdir'),
  openLogs: () => ipcRenderer.invoke('app:openlogs')
});
