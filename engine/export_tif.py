"""agro.dev · exporta el ortomosaico como GeoTIFF (RGBA, deflate), recortado al límite del lote.

Se escribe por franjas de filas (memoria constante, sirve para lotes de cientos de hectáreas) leyendo la pirámide de mosaicos ya generada:
el nivel z de la pirámide es el ortomosaico reducido 2^(top−z) veces, así que la resolución se elige entre original, 1/2, 1/4, 1/8…
Fuera del límite el píxel es transparente (alfa 0). Georreferencia: EPSG:4326 con las esquinas calculadas sobre el elipsoide WGS84 (el error
de tratar la imagen como una grilla de grados es de pocos cm en un lote de varios km).
"""
import math, os, struct, zlib
import numpy as np
from PIL import Image, ImageDraw
from cells import TileReader
import mosaic_gps

T = 512
ROWS = 64


def plan(meta, poly, shift):
    """Caja (en píxeles del nivel) y tamaño que tendría la exportación. poly: [[x,y]…] en píxeles nativos o None."""
    s = 2 ** shift
    if poly and len(poly) >= 3:
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    else:
        x0, y0, x1, y1 = 0, 0, meta['w'], meta['h']
    x0, y0 = max(0, int(math.floor(x0 / s))), max(0, int(math.floor(y0 / s)))
    x1, y1 = min(int(math.ceil(meta['w'] / s)), int(math.ceil(x1 / s))), min(int(math.ceil(meta['h'] / s)), int(math.ceil(y1 / s)))
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    return {'x0': x0, 'y0': y0, 'w': w, 'h': h, 'mpp': meta['mpp'] * s, 'mpx': w * h / 1e6}


def _entry(tag, typ, count, val):
    return struct.pack('<HHI', tag, typ, count) + val


def write(meta, d, out_path, poly=None, shift=0, progress=None, cancel=None, max_bytes=3.9e9):
    top = meta['levels'] - 1; z = top - shift
    if z < 0:
        raise RuntimeError('la pirámide no tiene ese nivel de reducción')
    pl = plan(meta, poly, shift); x0, y0, W, H = pl['x0'], pl['y0'], pl['w'], pl['h']; s = 2 ** shift
    rd = TileReader(d, cap=400)
    pts = None
    if poly and len(poly) >= 3:
        pts = [((p[0] / s) - x0, (p[1] / s) - y0) for p in poly]
    nstrips = (H + ROWS - 1) // ROWS; offs, cnts = [], []
    tmp = out_path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(b'II*\x00\x00\x00\x00\x00')                       # el desplazamiento al IFD se completa al final
        for k in range(nstrips):
            if cancel and cancel():
                raise RuntimeError('Exportación cancelada')
            ya, yb = k * ROWS, min(H, (k + 1) * ROWS)
            a = rd.crop(z, x0, y0 + ya, x0 + W, y0 + yb)
            if pts is not None:
                m = Image.new('L', (W, yb - ya), 0)
                ImageDraw.Draw(m).polygon([(x, y - ya) for x, y in pts], fill=255)
                a[..., 3] = np.minimum(a[..., 3], np.asarray(m))
            a[a[..., 3] == 0] = 0
            hd = a.astype(np.int16); hd[:, 1:] -= a[:, :-1].astype(np.int16)    # predictor horizontal (TIFF 2): comprime mucho mejor
            raw = (hd.astype(np.uint8)).tobytes()
            c = zlib.compress(raw, 6)
            offs.append(f.tell()); cnts.append(len(c)); f.write(c)
            if f.tell() > max_bytes:
                raise RuntimeError('El archivo superaría los 4 GB (límite del formato TIFF clásico). Elegí una resolución menor.')
            if progress and k % 8 == 0:
                progress(k / nstrips, 'Escribiendo imagen %d%%' % int(100 * k / nstrips))
        if f.tell() % 2: f.write(b'\x00')
        # georreferencia: esquinas exactas sobre WGS84
        fr = mosaic_gps.Frame.from_origin(meta['lat0'], meta['lon0']); g = meta['mpp']
        def ll(px, py): return fr.to_latlon(meta['E0'] + g * px, meta['N1'] - g * py)
        ulat, ulon = ll(x0 * s, y0 * s); llat, llon = ll((x0 + W) * s, (y0 + H) * s)
        dx, dy = (llon - ulon) / W, (ulat - llat) / H
        data = {}
        def blob(b):
            if f.tell() % 2: f.write(b'\x00')
            o = f.tell(); f.write(b); return o
        o_bits = blob(struct.pack('<4H', 8, 8, 8, 8)); o_off = blob(struct.pack('<%dI' % nstrips, *offs)); o_cnt = blob(struct.pack('<%dI' % nstrips, *cnts))
        o_sc = blob(struct.pack('<3d', dx, dy, 0.0)); o_tp = blob(struct.pack('<6d', 0, 0, 0, ulon, ulat, 0))
        keys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
        o_gk = blob(struct.pack('<%dH' % len(keys), *keys))
        asc = b'agro.dev\x00'; o_asc = blob(asc)
        L = lambda v: struct.pack('<I', v); S = lambda v: struct.pack('<HH', v, 0)
        ents = [(256, 4, 1, L(W)), (257, 4, 1, L(H)), (258, 3, 4, L(o_bits)), (259, 3, 1, S(8)), (262, 3, 1, S(2)),
                (273, 4, nstrips, L(o_off) if nstrips > 1 else L(offs[0])), (277, 3, 1, S(4)), (278, 4, 1, L(ROWS)),
                (279, 4, nstrips, L(o_cnt) if nstrips > 1 else L(cnts[0])), (284, 3, 1, S(1)), (317, 3, 1, S(2)), (338, 3, 1, S(2)),
                (33550, 12, 3, L(o_sc)), (33922, 12, 6, L(o_tp)), (34735, 3, len(keys), L(o_gk)), (34737, 2, len(asc), L(o_asc))]
        ents.sort(key=lambda e: e[0])
        if f.tell() % 2: f.write(b'\x00')
        ifd = f.tell(); f.write(struct.pack('<H', len(ents)))
        for t, ty, n, v in ents: f.write(_entry(t, ty, n, v))
        f.write(struct.pack('<I', 0)); f.seek(4); f.write(struct.pack('<I', ifd))
    os.replace(tmp, out_path)
    if progress: progress(1.0, 'Listo')
    return {'path': out_path, 'w': W, 'h': H, 'mpp': pl['mpp'], 'bytes': os.path.getsize(out_path), 'ul': [ulat, ulon], 'lr': [llat, llon]}
