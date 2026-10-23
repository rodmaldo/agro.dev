// Copia la interfaz web (../index.html, js, css, assets, api) a desktop/web para empaquetarla dentro del .exe
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), dst = path.join(__dirname, '..', 'web');
fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(dst, { recursive: true });
for (const f of ['index.html', 'js', 'css', 'assets', 'api']) {
  const s = path.join(root, f); if (!fs.existsSync(s)) continue;
  fs.cpSync(s, path.join(dst, f), { recursive: true, filter: p => !/users\.json$/.test(p) });   // sin usuarios locales
}
console.log('web copiada a', dst);
