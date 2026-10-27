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
  engine.stderr.on('data', d => console.error('[engine]', String(d).trim()));
  engine.on('error', e => { for (const p of pending.values()) p.resolve({ error: 'No se pudo iniciar el motor: ' + e.message }); pending.clear(); engine = null; });
  engine.on('exit', code => { for (const p of pending.values()) p.resolve({ error: 'El motor se cerró (código ' + code + ')' }); pending.clear(); engine = null; });
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
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:workdir', () => workdir());
ipcMain.handle('app:logdir', () => logDir());
ipcMain.handle('app:openlogs', () => shell.openPath(logDir()));
ipcMain.handle('app:system', () => ({ platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, ramGB: Math.round(os.totalmem() / 2 ** 30) }));
ipcMain.handle('dialog:folders', async () => { const r = await dialog.showOpenDialog(win, { title: 'Elegí una o varias carpetas del vuelo', properties: ['openDirectory', 'multiSelections'] }); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('dialog:files', async () => { const r = await dialog.showOpenDialog(win, { title: 'Elegí archivos', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff'] }] }); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('engine:call', (_e, id, cmd, args) => call(id, cmd, args));
ipcMain.handle('engine:cancel', (_e, id) => call(--internalId, 'cancel', { target: id }));   // ids negativos: llamadas internas
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit(); else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); startEngine(); });
  app.on('window-all-closed', () => { if (engine) engine.kill(); app.quit(); });
}
