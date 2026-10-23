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
  engine = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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

function call(cmd, args) {
  if (!engine) startEngine();
  return new Promise(resolve => {
    const id = nextId++; pending.set(id, { resolve });
    // el id se envía a la web con el primer evento; para cancelar, la web usa el id que recibe en 'engine:event'
    engine.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    if (win && !win.isDestroyed()) win.webContents.send('engine:event', { id, type: 'started', cmd });
  });
}

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
ipcMain.handle('app:system', () => ({ platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model, ramGB: Math.round(os.totalmem() / 2 ** 30) }));
ipcMain.handle('dialog:folders', async () => { const r = await dialog.showOpenDialog(win, { title: 'Elegí una o varias carpetas del vuelo', properties: ['openDirectory', 'multiSelections'] }); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('dialog:files', async () => { const r = await dialog.showOpenDialog(win, { title: 'Elegí archivos', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff'] }] }); return r.canceled ? [] : r.filePaths; });
ipcMain.handle('engine:call', (_e, cmd, args) => call(cmd, args));
ipcMain.handle('engine:cancel', (_e, id) => call('cancel', { target: id }));
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit(); else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); startEngine(); });
  app.on('window-all-closed', () => { if (engine) engine.kill(); app.quit(); });
}
