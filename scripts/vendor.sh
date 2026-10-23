#!/bin/sh
# Descarga React y htm para trabajar sin CDN. Luego cambiá las 3 etiquetas <script> de index.html por vendor/...
mkdir -p vendor && cd vendor
curl -sSLO https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js
curl -sSLO https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js
curl -sSLO https://cdn.jsdelivr.net/npm/htm@3.1.1/dist/htm.umd.js
ls -la
