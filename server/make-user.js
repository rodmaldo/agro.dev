/* node server/make-user.js <usuario> <contraseña>  → agrega/actualiza el usuario en server/users.json (scrypt + sal) */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [u, p] = process.argv.slice(2); if (!u || !p) { console.log('Uso: node server/make-user.js <usuario> <contraseña>'); process.exit(1); }
const f = path.join(__dirname, 'users.json'); let all = []; try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { }
const salt = crypto.randomBytes(16); all = all.filter(x => x.user !== u.toLowerCase());
all.push({ user: u.toLowerCase(), salt: salt.toString('hex'), hash: crypto.scryptSync(p, salt, 32).toString('hex') });
fs.writeFileSync(f, JSON.stringify(all, null, 2)); console.log('Usuario guardado:', u);
