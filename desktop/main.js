// agro.dev · proceso principal de Electron: ventana, diálogos nativos y motor Python (JSON por stdin/stdout)
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), readline = require('readline');

let win = null, engine = null, nextId = 1; const pending = new Map();

function enginePath() {
  // empaquetado: resources/engine/agro_engine.exe (PyInstaller) · desarrollo: python ../engine/agro_engine.py
  if (app.isPackaged) { const exe = path.join(process.resourcesPath, 'engine', 'agro_engine.exe'); return { cmd: exe, args: [] }; }
  return { cmd: process.env.AGRO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), args: [path.join(__dirname, '..', 'engine', 'agro_engine.py')] };
}

function startEngine() {
  const { cmd, args } = enginePath();
  // PYTHONUTF8/PYTHONIOENCODING: el motor lee y escribe en UTF-8 (en Windows el valor por defecto es cp1252: acentos rotos, rutas con ñ ilegibles)
  engine = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', AGRO_LOG_DIR: logDir(), AGRO_VERSION: app.getVersion() }) });
  readline.createInterface({ input: engine.stdout }).on('line', line => {
    let m; try { m = JSON.parse(line); } catch (e) { return; }
    const p = pending.get(m.id);
    if (m.type === 'result' && p) { pending.delete(m.id); p.resolve({ id: m.id, result: m.data }); }
    else if (m.type === 'error' && p) { pending.delete(m.id); p.resolve({ id: m.id, error: m.error }); }
    else if (win && !win.isDestroyed()) win.webContents.send('engine:event', m);
  });
  const toLog = msg => { if (win && !win.isDestroyed()) win.webContents.send('engine:event', { type: 'log', msg, t: Date.now() / 1000 }); };
  readline.createInterface({ input: engine.stderr }).on('line', l => { if (l.trim()) { console.error('[engine]', l); toLog('[motor/stderr] ' + l); } });
  engine.on('error', e => { for (const p of pending.values()) p.resolve({ error: 'No se pudo iniciar el motor: ' + e.message }); pending.clear(); engine = null; });
  engine.on('exit', code => { toLog('El motor se cerró (código ' + code + ')'); for (const p of pending.values()) p.resolve({ error: 'El motor se cerró (código ' + code + ')' }); pending.clear(); engine = null; });
}

let internalId = 0;
function call(id, cmd, args) {
  if (!engine) startEngine();
  return new Promise(resolve => {
    pending.set(id, { resolve });
    // solo ASCII en el tubo (\uXXXX): no depende de la página de códigos del motor
    engine.stdin.write(JSON.stringify({ id, cmd, args }).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4)) + '\n');
  });
}

function logDir() { const d = path.join(app.getPath('userData'), 'logs'); try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} return d; }

function workdir() { const d = path.join(app.getPath('documents'), 'agro.dev'); fs.mkdirSync(d, { recursive: true }); return d; }

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, backgroundColor: '#0b0f0c', title: 'agro.dev', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const web = app.isPackaged ? path.join(__dirname, 'web', 'index.html') : (fs.existsSync(path.join(__dirname, 'web', 'index.html')) ? path.join(__dirname, 'web', 'index.html') : path.join(__dirname, '..', 'index.html'));
  win.loadFile(web);
  win.on('focus', () => { try { win.webContents.focus(); } catch (e) { } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

/* ---- actualizaciones automáticas (electron-updater + GitHub Releases) ---- */
let autoUpdater = null, lastUpdate = { state: 'idle' };
function sendUpdate(st) { lastUpdate = st; if (win && !win.isDestroyed()) win.webContents.send('update:status', st); }
function checkUpdates() { if (autoUpdater) autoUpdater.checkForUpdates().catch(e => sendUpdate({ state: 'error', msg: String(e && e.message || e).split('\n')[0] })); }
function setupUpdates() {
  if (!app.isPackaged) return;                                   // solo en la app instalada
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', i => sendUpdate({ state: 'downloading', version: i.version, pct: 0 }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('download-progress', p => sendUpdate({ state: 'downloading', version: (lastUpdate && lastUpdate.version) || '', pct: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', e => sendUpdate({ state: 'error', msg: String(e && e.message || e).split('\n')[0] }));
  setTimeout(checkUpdates, 8000); setInterval(checkUpdates, 4 * 3600 * 1000);
}
ipcMain.handle('update:state', () => lastUpdate);
ipcMain.handle('update:check', () => { checkUpdates(); });
ipcMain.handle('update:install', () => { if (autoUpdater && lastUpdate.state === 'ready') autoUpdater.quitAndInstall(false, true); });

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:workdir', () => workdir());
ipcMain.handle('app:logdir', () => logDir());
ipcMain.handle('app:openlogs', () => shell.openPath(logDir()));
ipcMain.handle('app:system', () => ({ platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, ramGB: Math.round(os.totalmem() / 2 ** 30) }));
/* En Windows, tras un diálogo nativo la página puede quedar sin foco de teclado (los campos de texto no dejan escribir). Se lo devolvemos. */
function refocus() { if (win && !win.isDestroyed()) { win.focus(); win.webContents.focus(); } }
ipcMain.handle('dialog:folders', async () => { const r = await dialog.showOpenDialog(win, { title: 'Elegí una o varias carpetas del vuelo', properties: ['openDirectory', 'multiSelections'] }); setTimeout(refocus, 50); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('dialog:files', async () => { const r = await dialog.showOpenDialog(win, { title: 'Elegí archivos', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff'] }] }); setTimeout(refocus, 50); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('engine:call', (_e, id, cmd, args) => call(id, cmd, args));
ipcMain.handle('engine:cancel', (_e, id) => call(--internalId, 'cancel', { target: id }));   // ids negativos: llamadas internas
/* Informe PDF real: imprime el HTML en una ventana oculta y guarda el archivo que elija el usuario */
ipcMain.handle('report:pdf', async (_e, htmlText, name) => {
  const safe = String(name || 'informe').replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]+/g, '_');
  const r = await dialog.showSaveDialog(win, { title: 'Guardar informe en PDF', defaultPath: path.join(app.getPath('documents'), safe.replace(/\.pdf$/i, '') + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  const tmp = path.join(app.getPath('temp'), 'agro-informe-' + Date.now() + '.html');
  fs.writeFileSync(tmp, htmlText, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadFile(tmp);
    await new Promise(r => setTimeout(r, 400));
    const buf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    fs.writeFileSync(r.filePath, buf);
    shell.showItemInFolder(r.filePath);
    return { path: r.filePath };
  } finally { w.destroy(); try { fs.unlinkSync(tmp); } catch (e) { } }
});
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit(); else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); startEngine(); setupUpdates(); });
  app.on('window-all-closed', () => { if (engine) engine.kill(); app.quit(); });
}
