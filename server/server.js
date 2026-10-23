/* agro.dev · servidor de referencia sin dependencias (Node >= 18).  Uso: node server/server.js  →  http://localhost:8080
   Sirve el sitio estático y el contrato de api/openapi.json. Usuarios en server/users.json (scrypt). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..'), PORT = process.env.PORT || 8080, SECRET = process.env.AGRO_SECRET || crypto.randomBytes(32).toString('hex');
const DATA = path.join(__dirname, 'data', 'projects.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const users = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verify = t => { try { const [b, s] = t.split('.'); const ok = crypto.timingSafeEqual(Buffer.from(s), Buffer.from(crypto.createHmac('sha256', SECRET).update(b).digest('base64url'))); const p = JSON.parse(Buffer.from(b, 'base64url')); return ok && p.exp > Date.now() ? p : null; } catch (e) { return null; } };
const send = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
const load = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return []; } };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') return send(res, 200, { ok: true });
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const { user, pass } = await body(req), u = users().find(x => x.user === String(user || '').toLowerCase());
    if (u) { const h = crypto.scryptSync(String(pass || ''), Buffer.from(u.salt, 'hex'), 32); if (crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) return send(res, 200, { user: u.user, token: sign({ user: u.user, exp: Date.now() + 12 * 36e5 }) }); }
    return send(res, 401, { error: 'invalid_credentials' });
  }
  if (url.pathname === '/api/projects') {
    const t = (req.headers.authorization || '').replace('Bearer ', ''), p = verify(t); if (!p) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') return send(res, 200, load().filter(x => x.owner === p.user));
    if (req.method === 'POST') { const b = await body(req), item = Object.assign({}, b, { id: 'p' + Date.now(), owner: p.user, savedAt: new Date().toISOString() }); const all = load(); all.push(item); fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(all.slice(-500))); return send(res, 200, item); }
  }
  let f = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!f.startsWith(ROOT) || f.startsWith(path.join(ROOT, 'server')) || f.endsWith('users.json') && f.includes('server')) { res.writeHead(403); return res.end('403'); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('404'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
}).listen(PORT, () => console.log('agro.dev en http://localhost:' + PORT));
