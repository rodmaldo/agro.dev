# agro.dev

Zonificación **fértil / no fértil** de lotes a partir de relevamientos con dron (DJI Mavic 3 Multispectral).
React + UI/UX en el cliente, **sin paso de compilación**: son archivos estáticos que se publican tal cual.

## Probar en local

```bash
node server/server.js        # http://localhost:8080   (Node >= 18, sin dependencias)
# o cualquier servidor estático:  npx serve .   /   python3 -m http.server 8080
```

Ingreso de demostración: usuario `rodma` · contraseña `rmaldonado`.

## Flujo de ventanas (v0.2.0)

1. **Inicio** – crear el *Terreno / Proyecto* con su nombre (o abrir uno existente). Abajo a la derecha, la versión; abajo a la izquierda, las especificaciones del equipo que el navegador permite leer.
2. **Campo** – *Importar proyecto* (guardado en este navegador o archivo `.json`) y *Subir carpeta / archivos* del vuelo (cada selección se suma).
3. **Tipo de imagen** – RGB, Multiespectral o RGB + Multiespectral, forma de armar el mapa y parámetros avanzados.
4. **Grilla** – celda de 0,50 a 20 m y orientación en grados (se alinea girando la imagen; opción "usar rumbo del vuelo").
5. **Detección de zonas** – nombre de la detección (p. ej. *Salitre*), mínimo 5 puntos positivos (+) y 5 negativos (−), que **solo se agregan dentro de las celdas de la grilla**; la IA (clasificador de tonalidad por celdas) delimita en tiempo real.
6. **Dashboard** – derecha: ha fértiles / infértiles con %, promedios, ha por capa. Abajo: **Capas** (ortomosaico, detección, detección manual, histogramas, buffer, satélite) con color, visibilidad e inclusión editables; clic derecho o **+ Capa** para agregar. Pincel y borrador pintan celdas completas con tamaño ajustable; la *detección manual* se puede **combinar** con la IA; la capa de *histograma* tiene barras de umbral y **varita mágica** (clic = zona, Ctrl+clic = suma, clic derecho = borra); *buffer* de 0,5 a 10 m con color propio.
7. **Exportar** – maquinaria (John Deere GEN5), operación (aplicación / fertilización / siembra), dosis (L/ha) y precio opcional → mapa de prescripción (shapefile `.zip`: fértil = dosis, infértil + buffer = 0), informe imprimible a PDF con ha, promedios, consumo y ahorro, y GeoJSON. Al exportar se combinan todas las capas incluidas.

Atajos: `V` mover · `B` pincel · `E` borrador · `W` varita · `L`/`M` límite · `I` antes/después · **Espacio** (mantener) oculta la grilla.

Ingreso de demostración: usuario `rodma` · contraseña `rmaldonado`.

## Estructura

```
index.html                 entrada (React + htm por CDN)
css/styles.css             estilo minimalista: bordes finos, esquinas rectas, scrollbars interactivas
js/engine.js               núcleo: grilla, rasterización por celdas, clasificador por puntos (+/−), coordenadas y rotación
js/layers.js               capas: detección, manual, histograma + varita, pincel/borrador, buffer, estadísticas
js/exporter.js             prescripción (shapefile + zip), consumos y ahorro, informe, GeoJSON
js/files.js                lectura de carpetas, análisis del vuelo, mosaico base y rotación de la grilla
js/sys.js                  versión y especificaciones del equipo
js/geo.js                  EXIF/GPS/rumbo de las fotos DJI y mosaico de teselas satelitales
js/mosaic.js               arma UNA sola imagen del vuelo a partir de las fotos RGB geoetiquetadas
js/stitch.js               alineación entre fotos (correlación de fase + ajuste global), igualación de color y mezcla de bordes
js/map.js                  dibujo del mapa (satélite → ortomosaico → capas → límite) y divisor antes/después
js/api.js                  cliente de API (modo local o remoto)
js/components/             React: splash/login, home (Inicio y Campo), wizard (3 pasos), mapcanvas, dashboard, shared, common
api/config.json            mode: "local" | "remote"
api/users.json             usuarios del modo local (hash SHA-256)
api/openapi.json           contrato de la API remota
api/samples/               ejemplo de proyecto
server/server.js           servidor de referencia (estático + API) · server/make-user.js crea usuarios
scripts/vendor.sh          baja React/htm para trabajar sin CDN
```

## Publicar online

Es un sitio estático: **GitHub Pages** (Settings → Pages → rama `main`, carpeta raíz), **Netlify**, **Vercel** o **Cloudflare Pages** (sin build, directorio de salida `/`).
Debe servirse por **https** (la verificación de contraseña usa `crypto.subtle`).

## Seguridad (leer antes de publicar)

- En modo `local` el usuario y el hash están en archivos públicos: **es solo una puerta de cortesía, no seguridad real**. Cualquiera puede leer `api/users.json`.
- Para acceso real: usá `server/server.js` (o tu backend) con `"mode": "remote"` en `api/config.json`; allí las credenciales viven en el servidor con scrypt y sal.
- Cambiá la contraseña de demostración antes de publicar:
  - servidor: `node server/make-user.js <usuario> <nueva_clave>`
  - modo local: `printf 'usuario:clave' | sha256sum` y pegá el hash en `api/users.json`.
- Definí `AGRO_SECRET` (variable de entorno) en el servidor para que los tokens sobrevivan a reinicios.

## Qué hace y qué no hace esta versión

Hace: todo lo descrito en el flujo de ventanas, más lectura de posición desde EXIF, satélite de fondo y antes/después arrastrable.

Subida de vuelos: cada carpeta o archivo que agregues **se suma** a lo anterior (un vuelo grande genera varias carpetas, p. ej. 100MEDIA, 101MEDIA…) y también se pueden arrastrar carpetas completas. "Vuelo completo (fotos GPS)" ubica cada foto `_D.JPG` por su GPS y rumbo y arma el lote entero a la resolución elegida en *Calidad*.

No hace todavía:
- **Ortomosaico**: las fotos se ubican por GPS/rumbo/altura, se refina la posición de cada una comparando el contenido de las fotos vecinas (correlación de fase + mínimos cuadrados global), se igualan brillo y color entre fotos y se mezclan los bordes en una única imagen. **No es fotogrametría completa**: asume terreno plano y cámara vertical, sin corrección de relieve ni de lente; en lotes sin textura (suelo desnudo uniforme) o con surcos muy repetitivos la alineación puede caer al GPS. Para la entrega final usá un ortomosaico real (DJI Terra, ODM, Pix4D) exportado a JPG/PNG, que la app también acepta. Tampoco lee GeoTIFF ni las bandas `_MS_*.TIF`.
- La "IA" es un clasificador local por ejemplos (color, brillo, saturación, textura, índice subido). Mejora con más puntos, pero no es un modelo entrenado.
- La ubicación sobre el satélite asume mosaico norte-arriba centrado en la latitud/longitud indicada; el GeoJSON exportado usa la misma aproximación. No es georreferenciación rigurosa (para eso hace falta leer el GeoTIFF).
- La prescripción se exporta como **shapefile** (campo `RATE`, WGS84). **No está verificada en un display GEN5 real**: probala primero con una prueba de campo. ISOXML y el envío directo a John Deere Operations Center requieren backend (ver hoja de ruta).
- Multiespectral: el navegador no decodifica las bandas `_MS_*.TIF`; se puede subir un índice NDVI/NDRE ya calculado como imagen en grises. La lectura nativa de bandas es parte de la versión de escritorio.
- Con grilla de 0,50 m en un lote muy grande se supera el máximo de 4 millones de celdas y la grilla efectiva queda más gruesa (la app lo avisa).
- Las especificaciones del equipo son las que expone el navegador (hilos de CPU, RAM acotada a ≥ 8 GB, nombre de GPU); no puede leer el modelo exacto del procesador.
- El satélite usa teselas de Esri (sin clave). No garantiza que sea "la más reciente" ni su fecha: para eso conviene Sentinel Hub / Mapbox / Planet con clave. Revisá los términos del proveedor para uso comercial (`AZGeo.TILE_URL` en `js/geo.js`).

## Hoja de ruta sugerida

1. Backend Python (FastAPI) con GDAL/rasterio: lectura de GeoTIFF y georreferenciación real, NDVI/NDRE desde las bandas del Mavic 3M, ODM para armar el mosaico.
2. Prescripciones: ISOXML y envío a John Deere Operations Center (el shapefile ya está).
3. Modelo entrenado (random forest / U-Net) a partir de los puntos y polígonos que se vayan validando en campo.
4. Empaquetado de escritorio (Tauri o Electron) para procesar vuelos grandes en la PC.
