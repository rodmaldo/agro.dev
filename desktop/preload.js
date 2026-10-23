// Puente seguro entre la interfaz (web) y el proceso principal. La web solo ve window.agroDesktop.
const { contextBridge, ipcRenderer } = require('electron');
const subs = new Set();
ipcRenderer.on('engine:event', (_e, m) => subs.forEach(f => { try { f(m); } catch (x) { } }));
contextBridge.exposeInMainWorld('agroDesktop', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('app:version'),
  system: () => ipcRenderer.invoke('app:system'),
  pickFolders: () => ipcRenderer.invoke('dialog:folders'),       // selección múltiple de carpetas
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  engine: (cmd, args) => ipcRenderer.invoke('engine:call', cmd, args || {}),     // devuelve {id, result} al terminar
  cancel: id => ipcRenderer.invoke('engine:cancel', id),
  onEvent: f => { subs.add(f); return () => subs.delete(f); },      // progreso y logs de los trabajos largos
  reveal: p => ipcRenderer.invoke('shell:reveal', p),
  workdir: () => ipcRenderer.invoke('app:workdir')
});
