# agro.dev · versión de escritorio (Windows)

Tres piezas:

| Carpeta | Qué es |
|---|---|
| `index.html`, `js/`, `css/` | La interfaz (React). Es la misma de la web. |
| `desktop/` | Ventana de escritorio (Electron): diálogos nativos de carpetas, empaquetado `setup.exe` + portable. |
| `engine/` | Motor en Python: lee las fotos, arma el ortomosaico con ODM y sirve el resultado por mosaicos a resolución original. |

## Obtener el .exe (sin instalar nada en tu PC)
Cada `push` a `main` ejecuta `.github/workflows/windows.yml`, que arma el instalador y el portable.
En GitHub: pestaña **Actions** → la última ejecución → **Artifacts** → `agro.dev-windows`.

## Para procesar ortomosaicos
Instalá **Docker Desktop** (con WSL2) y dejalo abierto. El motor ejecuta `opendronemap/odm` por vos.
Perfiles (`engine/agro_engine.py`, `QUALITY`): `fast`, `balanced`, `max`. Más de 800 fotos → ODM parte el lote en bloques (`--split`) y los une.

## Desarrollo local
```
cd desktop && npm install && npm start          # abre la app (usa python del sistema para el motor)
python engine/test_engine.py [carpeta_fotos] [ortomosaico.png]
```

## Estado
- Probado: protocolo del motor, lectura de EXIF, servidor de mosaicos (coincide píxel a píxel con la imagen original), armado de parámetros de ODM, errores claros sin Docker.
- **Sin probar** (no se puede ejecutar en el entorno de desarrollo): ventana Electron, empaquetado `.exe`, ODM real, lectura de GeoTIFF con rasterio. Se validan con el primer build y fotos reales.
- Falta (fase 2): que la interfaz use el motor (hoy la ventana muestra la misma interfaz web): elegir carpetas con el diálogo nativo → ODM → visor por mosaicos → grilla y detección calculadas sobre los píxeles originales.
