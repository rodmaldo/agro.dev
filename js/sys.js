/* agro.dev · versión y especificaciones del equipo (lo que el navegador permite leer) */
(function (root) {
  'use strict';
  const AZSys = root.AZSys = { VERSION: '0.2.0' };

  function gpu() {
    try {
      const c = document.createElement('canvas'), g = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!g) return null;
      const e = g.getExtension('WEBGL_debug_renderer_info'); let r = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
      const m = /ANGLE \([^,]*,\s*([^,(]+)/.exec(r); if (m) r = m[1];
      return String(r).replace(/\s*Direct3D.*$/i, '').replace(/\s+\d+GB$/i, '').trim();
    } catch (e) { return null; }
  }
  /* devuelve [[etiqueta, valor], …] */
  AZSys.detect = function () {
    const n = navigator, ua = (n.userAgentData && n.userAgentData.platform) || n.platform || '';
    const os = /win/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : (ua || 'N/D');
    const mem = n.deviceMemory ? (n.deviceMemory >= 8 ? '≥ 8 GB' : n.deviceMemory + ' GB') : 'N/D';
    const sc = root.screen ? Math.round(screen.width * (devicePixelRatio || 1)) + '×' + Math.round(screen.height * (devicePixelRatio || 1)) : 'N/D';
    return [['SO', os], ['CPU', (n.hardwareConcurrency || '?') + ' hilos'], ['RAM', mem], ['GPU', gpu() || 'N/D'], ['Pantalla', sc]];
  };
})(window);
