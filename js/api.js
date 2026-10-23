/* agro.dev · cliente de API.
   mode "local"  (api/config.json): sitio 100 % estático; usuarios en api/users.json (hash SHA-256) y proyectos en localStorage.
   mode "remote": usa el backend de server/server.js (o el tuyo) siguiendo api/openapi.json. */
(function (root) {
  'use strict';
  const FALLBACK_USERS = [{ user: 'rodma', sha256: '31d5fe2ef8254a577afe2231023e458f5303a47c1b00f5f3edcb1d3f7efb634c' }];
  let cfg = null;

  async function getJson(path, fb) {
    try { const r = await fetch(path, { cache: 'no-store' }); if (!r.ok) throw 0; return await r.json(); } catch (e) { return fb; }
  }
  async function config() { if (!cfg) cfg = await getJson('api/config.json', { mode: 'local', baseUrl: '' }); return cfg; }
  async function sha256(s) {
    if (!(root.crypto && root.crypto.subtle)) throw new Error('Abrí la app desde https:// o localhost');
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem('agro.session') || 'null'); } catch (e) { return null; } },
    set(j) { try { sessionStorage.setItem('agro.session', JSON.stringify(j)); } catch (e) { } },
    clear() { try { sessionStorage.removeItem('agro.session'); } catch (e) { } }
  };

  root.AZApi = {
    session: () => store.get(),
    logout: () => store.clear(),

    async login(user, pass) {
      const c = await config();
      if (c.mode === 'remote') {
        const r = await fetch(c.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, pass }) });
        if (!r.ok) throw new Error('Usuario o contraseña incorrectos');
        const j = await r.json(); store.set(j); return j;
      }
      const users = await getJson('api/users.json', FALLBACK_USERS);
      const h = await sha256(user.toLowerCase() + ':' + pass);
      if (!users.some(u => u.user === user.toLowerCase() && u.sha256 === h)) throw new Error('Usuario o contraseña incorrectos');
      const j = { user: user.toLowerCase(), token: 'local' }; store.set(j); return j;
    },

    /* Terrenos / proyectos (campos): se guardan en este navegador */
    fields: {
      list() { try { return JSON.parse(localStorage.getItem('agro.fields') || '[]'); } catch (e) { return []; } },
      create(name) {
        const f = { id: 'f' + Date.now().toString(36), name: name.trim(), created: new Date().toISOString() };
        const l = this.list(); l.push(f); try { localStorage.setItem('agro.fields', JSON.stringify(l)); } catch (e) { } return f;
      },
      remove(id) { try { localStorage.setItem('agro.fields', JSON.stringify(this.list().filter(f => f.id !== id))); } catch (e) { } }
    },

    async saveProject(p) {
      const c = await config(), s = store.get();
      if (c.mode === 'remote') {
        const r = await fetch(c.baseUrl + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s && s.token) }, body: JSON.stringify(p) });
        if (!r.ok) throw new Error('No se pudo guardar'); return r.json();
      }
      const list = JSON.parse(localStorage.getItem('agro.projects') || '[]');
      const item = Object.assign({ id: 'p' + Date.now(), savedAt: new Date().toISOString() }, p);
      list.push(item); localStorage.setItem('agro.projects', JSON.stringify(list.slice(-30))); return item;
    },

    async listProjects() {
      const c = await config(), s = store.get();
      if (c.mode === 'remote') { const r = await fetch(c.baseUrl + '/api/projects', { headers: { Authorization: 'Bearer ' + (s && s.token) } }); return r.ok ? r.json() : []; }
      return JSON.parse(localStorage.getItem('agro.projects') || '[]');
    }
  };
})(window);
