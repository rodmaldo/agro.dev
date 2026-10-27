#!/usr/bin/env python3
"""agro.dev · motor de procesado (Python).

Se comunica con la ventana de escritorio (Electron) por líneas JSON:
  entrada  (stdin) : {"id": 1, "cmd": "scan", "args": {...}}
  salida   (stdout): {"id": 1, "type": "progress", "pct": 0.4, "msg": "..."}
                     {"id": 1, "type": "result",   "data": {...}}
                     {"id": 1, "type": "error",    "error": "..."}

Comandos: ping, scan, ortho, cancel, open_ortho (abre un ortomosaico y lo sirve por HTTP local, por mosaicos
bajo demanda, a la resolución original), close_ortho.

Diseño:
  * Las fotos NO se cargan en memoria: scan lee solo el EXIF.
  * El ortomosaico lo arma ODM (OpenDroneMap) dentro de Docker. Un lote de 400+ ha a 3 cm/px tiene decenas de miles de
    millones de píxeles: no se puede tener en un canvas ni en RAM, por eso se lee por ventanas (rasterio) y se sirve
    en mosaicos de 512 px. Los niveles de zoom salen de las vistas reducidas (overviews) del GeoTIFF.
"""
import json, os, re, shutil, subprocess, sys, threading, time, uuid, io, math

# BLAS en un solo hilo ANTES de importar numpy (los procesos de render heredan el entorno): evita bloqueos de OpenBLAS en el .exe de Windows
for _k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_k, '1')
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from collections import OrderedDict

import numpy as np
from PIL import Image, ExifTags

Image.MAX_IMAGE_PIXELS = None
RGB_EXT = {'.jpg', '.jpeg'}
MS_RE = re.compile(r'_MS_(G|R|RE|NIR)\.TIF$', re.I)
TILE = 512
M3_GSD_PER_M = 0.02685      # cm/px por metro de altura (Mavic 3M RGB, 5280 px de ancho)

# ----------------------------------------------------------------------------------------------- salida

_out_lock = threading.Lock()

# En Windows Python lee/escribe con la página de códigos local (cp1252) y Electron espera UTF-8: acentos rotos y rutas con ñ ilegibles.
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def emit(obj):
    # ensure_ascii=True: el JSON viaja solo con ASCII (\uXXXX) y no depende de la codificación del tubo
    line = json.dumps(obj) + '\n'
    with _out_lock:
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
        except Exception:
            pass


# ----------------------------------------------------------------------------------------------- registro (log)

_log_lock = threading.Lock()
_log_path = None


def log_path():
    global _log_path
    if _log_path is None:
        d = os.environ.get('AGRO_LOG_DIR') or os.path.join(os.path.expanduser('~'), 'agro.dev', 'logs')
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            d = os.getcwd()
        _log_path = os.path.join(d, 'motor.log')
        try:                                            # rotación simple: máximo ~5 MB
            if os.path.exists(_log_path) and os.path.getsize(_log_path) > 5 * 2 ** 20:
                os.replace(_log_path, _log_path + '.1')
        except Exception:
            pass
    return _log_path


def log(msg):
    """Una línea con fecha y hora en motor.log (siempre se escribe aunque la ventana no esté mirando)."""
    line = time.strftime('%Y-%m-%d %H:%M:%S') + ' [%d] ' % os.getpid() + str(msg)
    with _log_lock:
        try:
            with open(log_path(), 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except Exception:
            pass


# ----------------------------------------------------------------------------------------------- scan

def _rat(v):
    try:
        return float(v)
    except Exception:
        return float(v[0]) / float(v[1]) if v[1] else 0.0


def _dms(t, ref):
    d = _rat(t[0]) + _rat(t[1]) / 60 + _rat(t[2]) / 3600
    return -d if ref in ('S', 'W') else d


def read_meta(path):
    """EXIF mínimo de una foto: lat, lon, altura relativa (si existe), ancho/alto, modelo."""
    with Image.open(path) as im:
        w, h = im.size
        ex = im.getexif()
        gps = ex.get_ifd(0x8825) if ex else {}
        exif = ex.get_ifd(0x8769) if ex else {}
        m = {'path': path, 'w': w, 'h': h, 'model': str(ex.get(0x0110, '')).strip(), 'lat': None, 'lon': None, 'alt': None}
        if gps.get(2) and gps.get(4):
            m['lat'] = _dms(gps[2], gps.get(1, 'N'))
            m['lon'] = _dms(gps[4], gps.get(3, 'E'))
        if gps.get(6) is not None:
            m['alt'] = _rat(gps[6])
        # DJI guarda la altura relativa de vuelo en el XMP
        try:
            xmp = im.info.get('xmp') or b''
            if isinstance(xmp, str):
                xmp = xmp.encode('utf8', 'ignore')
            mm = re.search(rb'RelativeAltitude="?([+-]?[0-9.]+)', xmp)
            if mm:
                m['rel_alt'] = float(mm.group(1))
        except Exception:
            pass
        return m


def walk_images(folders):
    rgb, ms, other = [], [], 0
    seen = set()
    for f in folders:
        for root, _, files in os.walk(f):
            for n in files:
                p = os.path.join(root, n)
                if p in seen:
                    continue
                seen.add(p)
                ext = os.path.splitext(n)[1].lower()
                if ext in RGB_EXT:
                    rgb.append(p)
                elif MS_RE.search(n):
                    ms.append(p)
                else:
                    other += 1
    return sorted(rgb), sorted(ms), other


def cmd_scan(args, job):
    """Recorre carpetas (sin cargar imágenes): cantidad de fotos RGB/MS, GPS, altura, rumbo, RTK, tamaño del píxel y superficie aprox."""
    import mosaic_gps
    folders = args['folders']
    rgb, ms, other = walk_images(folders)
    by_dir = {}
    for p in rgb: by_dir.setdefault(os.path.dirname(p), {'rgb': 0, 'ms': 0, 'otros': 0})['rgb'] += 1
    for p in ms: by_dir.setdefault(os.path.dirname(p), {'rgb': 0, 'ms': 0, 'otros': 0})['ms'] += 1
    nbytes = 0
    for p in rgb + ms:
        try: nbytes += os.path.getsize(p)
        except OSError: pass
    metas, bad = [], 0
    for i, p in enumerate(rgb):
        try:
            m = mosaic_gps.parse_photo(p)
            if m: metas.append(m)
        except Exception:
            bad += 1
        if i % 50 == 0:
            job.progress(i / max(1, len(rgb)), 'Leyendo %d/%d fotos' % (i, len(rgb)))
    out = {'files': rgb, 'rgb': len(rgb), 'ms': len(ms), 'ignored': other, 'unreadable': bad, 'geotagged': len(metas), 'folders': folders,
           'by_dir': by_dir, 'bytes': nbytes}
    if metas:
        fr = mosaic_gps.Frame(metas)
        xs = [m['e'] for m in metas]; ys = [m['n'] for m in metas]
        alts = [m['alt'] for m in metas if m['alt']]
        gsd = float(sum(m['g'] for m in metas) / len(metas)) * 100          # cm/px
        w0, h0 = metas[0]['w'], metas[0]['h']
        fw = w0 * gsd / 100
        # rumbo medio módulo 90° (las pasadas de ida y vuelta difieren 180°)
        sx = sum(math.cos(math.radians(m['yaw'] * 4)) for m in metas); sy = sum(math.sin(math.radians(m['yaw'] * 4)) for m in metas)
        yaw90 = (math.degrees(math.atan2(sy, sx)) / 4 + 360) % 90
        out.update({'lat': fr.lat0, 'lon': fr.lon0, 'alt': (sum(alts) / len(alts)) if alts else None, 'gsd_cm': gsd, 'model': metas[0]['model'],
                    'size': [w0, h0], 'yaw90': yaw90, 'rtk': 50 if all(m.get('rtk') == 50 for m in metas) else (0 if any(m.get('rtk') is not None for m in metas) else None),
                    'extent_m': [max(xs) - min(xs) + fw, max(ys) - min(ys) + fw]})
        out['area_ha'] = out['extent_m'][0] * out['extent_m'][1] / 1e4 * 0.75   # aprox. (el recorrido no es un rectángulo lleno)
    return out


# ----------------------------------------------------------------------------------------------- ODM

# Fracción aproximada del proceso al terminar cada etapa de ODM
ODM_STAGES = [('dataset', .02), ('split', .04), ('merge', .05), ('opensfm', .45), ('openmvs', .55), ('odm_filterpoints', .58),
              ('odm_meshing', .62), ('mvs_texturing', .70), ('odm_georeferencing', .74), ('odm_dem', .82), ('odm_orthophoto', .96),
              ('odm_report', .98), ('odm_postprocess', 1.0)]

# Perfiles. Para lotes agrícolas planos alcanza con el modo "fast-orthophoto" (no arma el modelo 3D completo).
QUALITY = {
    'fast':     {'feature-quality': 'low',    'res_mult': 2.0, 'neighbors': 8},
    'balanced': {'feature-quality': 'medium', 'res_mult': 1.0, 'neighbors': 12},
    'max':      {'feature-quality': 'high',   'res_mult': 1.0, 'neighbors': 16},
}


def odm_args(quality, gsd_cm, n_photos, cpu=None, split_after=800):
    q = QUALITY.get(quality, QUALITY['balanced'])
    a = ['--fast-orthophoto', '--feature-quality', q['feature-quality'], '--matcher-neighbors', str(q['neighbors']),
         '--orthophoto-resolution', '%.2f' % max(1.0, (gsd_cm or 3.0) * q['res_mult']),
         '--cog', '--orthophoto-compression', 'DEFLATE', '--build-overviews', '--skip-report']
    if n_photos > split_after:                 # lotes grandes: ODM los parte en bloques y los une al final
        a += ['--split', str(max(300, n_photos // 4)), '--split-overlap', '60']
    if cpu:
        a += ['--max-concurrency', str(int(cpu))]
    return a


def link_or_copy(src, dst):
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


class Job:
    def __init__(self, mid):
        self.mid = mid
        self.cancel = threading.Event()
        self.proc = None
        self.container = None

    def progress(self, pct, msg=''):
        # 't' = hora del motor (epoch): la ventana la usa para el tiempo transcurrido y para detectar un motor sin señales
        emit({'id': self.mid, 'type': 'progress', 'pct': round(float(pct), 4), 'msg': msg, 't': round(time.time(), 2)})


JOBS = {}


def docker_ok():
    try:
        r = subprocess.run(['docker', 'info'], capture_output=True, timeout=20)
        return r.returncode == 0
    except Exception as e:
        return False


def cmd_ortho(args, job):
    """Arma el ortomosaico RGB con ODM (Docker). args: folders, out, quality, gsd_cm, gpu, cpu"""
    if not docker_ok():
        raise RuntimeError('Docker no está disponible. Instalá Docker Desktop (con WSL2), abrilo y volvé a intentar.')
    rgb, _, _ = walk_images(args['folders'])
    if len(rgb) < 3:
        raise RuntimeError('Hacen falta al menos 3 fotos RGB (.JPG). Encontradas: %d' % len(rgb))
    out = os.path.abspath(args['out'])
    proj = os.path.join(out, 'odm')
    imgs = os.path.join(proj, 'images')
    os.makedirs(imgs, exist_ok=True)
    job.progress(0.0, 'Preparando %d fotos' % len(rgb))
    names = set()
    for i, p in enumerate(rgb):
        n = os.path.basename(p)
        if n in names:                          # carpetas distintas con el mismo nombre de archivo
            n = '%d_%s' % (i, n)
        names.add(n)
        d = os.path.join(imgs, n)
        if not os.path.exists(d):
            link_or_copy(p, d)
        if job.cancel.is_set():
            raise RuntimeError('Cancelado')
    flags = odm_args(args.get('quality', 'balanced'), args.get('gsd_cm'), len(rgb), args.get('cpu'))
    image = 'opendronemap/odm:gpu' if args.get('gpu') else 'opendronemap/odm'
    job.container = 'agro-odm-' + uuid.uuid4().hex[:8]
    cmd = ['docker', 'run', '--rm', '--name', job.container, '-v', '%s:/datasets/code' % proj.replace('\\', '/')]
    if args.get('gpu'):
        cmd += ['--gpus', 'all']
    cmd += [image, '--project-path', '/datasets', 'code'] + flags
    emit({'id': job.mid, 'type': 'log', 'msg': ' '.join(cmd)})
    job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    last = 0.0
    tail = []
    for line in job.proc.stdout:
        line = line.rstrip()
        tail = (tail + [line])[-30:]
        m = re.search(r'Running (\w+) stage', line)
        if m:
            for k, (nm, f) in enumerate(ODM_STAGES):
                if nm == m.group(1):
                    last = ODM_STAGES[k - 1][1] if k else 0.0
                    job.progress(last, 'ODM: ' + nm)
        elif line.strip():
            emit({'id': job.mid, 'type': 'log', 'msg': line[:300]})
        if job.cancel.is_set():
            break
    rc = job.proc.wait()
    if job.cancel.is_set():
        raise RuntimeError('Cancelado')
    tif = os.path.join(proj, 'odm_orthophoto', 'odm_orthophoto.tif')
    if rc != 0 or not os.path.exists(tif):
        raise RuntimeError('ODM terminó con error (%s). Últimas líneas:\n%s' % (rc, '\n'.join(tail[-8:])))
    job.progress(1.0, 'Ortomosaico listo')
    return {'orthophoto': tif, 'photos': len(rgb), 'flags': flags}


def cmd_cancel(args, job):
    j = JOBS.get(args['target'])
    if not j:
        return {'cancelled': False}
    j.cancel.set()
    if j.container:
        subprocess.run(['docker', 'stop', j.container], capture_output=True, timeout=60)
    return {'cancelled': True}


# ----------------------------------------------------------------------------------------------- lectura por mosaicos

class ArraySource:
    """Fuente en memoria (imágenes comunes PNG/JPG y pruebas)."""
    def __init__(self, arr):
        self.arr = arr
        self.h, self.w = arr.shape[:2]
        self.levels = max(1, int(math.ceil(math.log2(max(self.w, self.h) / TILE))) + 1)
        self.mpp = None
        self.bounds = None

    def read(self, x, y, w, h, out_w, out_h):
        """Lee el rectángulo (x,y,w,h) en píxeles nativos y lo devuelve como RGB uint8 de out_h × out_w."""
        x0, y0, x1, y1 = max(0, x), max(0, y), min(self.w, x + w), min(self.h, y + h)
        if x1 <= x0 or y1 <= y0:
            return None
        crop = Image.fromarray(self.arr[y0:y1, x0:x1, :3])
        ow, oh = max(1, round(out_w * (x1 - x0) / w)), max(1, round(out_h * (y1 - y0) / h))
        crop = crop.resize((ow, oh), Image.LANCZOS if ow < (x1 - x0) else Image.BILINEAR)
        canvas = Image.new('RGB', (out_w, out_h), (0, 0, 0))
        canvas.paste(crop, (round(out_w * (x0 - x) / w), round(out_h * (y0 - y) / h)))
        return canvas


class RasterSource:
    """GeoTIFF grande: lee por ventanas con rasterio (usa las vistas reducidas internas, no carga la imagen entera)."""
    def __init__(self, path):
        import rasterio
        self.rio = rasterio
        self.ds = rasterio.open(path)
        self.w, self.h = self.ds.width, self.ds.height
        self.levels = max(1, int(math.ceil(math.log2(max(self.w, self.h) / TILE))) + 1)
        t = self.ds.transform
        self.mpp = abs(t.a) if self.ds.crs and self.ds.crs.is_projected else None
        self.bounds = list(self.ds.bounds)
        self.crs = str(self.ds.crs) if self.ds.crs else None
        self.lock = threading.Lock()
        self.bands = [1, 2, 3] if self.ds.count >= 3 else [1, 1, 1]
        self.alpha = 4 if self.ds.count >= 4 else None

    def read(self, x, y, w, h, out_w, out_h):
        from rasterio.windows import Window
        win = Window(x, y, w, h)
        with self.lock:
            d = self.ds.read(self.bands, window=win, out_shape=(3, out_h, out_w), boundless=True, fill_value=0, resampling=self.rio.enums.Resampling.average)
        return Image.fromarray(np.moveaxis(d, 0, -1).astype(np.uint8))


def open_source(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.tif', '.tiff'):
        try:
            return RasterSource(path)
        except ImportError:
            pass                                 # sin rasterio: intenta con PIL (solo sirve para TIFF chicos)
    with Image.open(path) as im:
        arr = np.asarray(im.convert('RGB'))
    return ArraySource(arr)


class TileCache:
    def __init__(self, n=512):
        self.n, self.d, self.l = n, OrderedDict(), threading.Lock()

    def get(self, k):
        with self.l:
            v = self.d.get(k)
            if v is not None:
                self.d.move_to_end(k)
            return v

    def put(self, k, v):
        with self.l:
            self.d[k] = v
            while len(self.d) > self.n:
                self.d.popitem(last=False)


def tile_bytes(src, z, tx, ty, cache=None, fmt='JPEG'):
    """z = 0 es la vista más reducida; z = levels-1 es la resolución original (1 píxel de mosaico = 1 píxel del ortomosaico)."""
    key = (z, tx, ty, fmt)
    if cache:
        v = cache.get(key)
        if v is not None:
            return v
    scale = 2 ** (src.levels - 1 - z)           # píxeles nativos por píxel del nivel
    span = TILE * scale
    img = src.read(tx * span, ty * span, span, span, TILE, TILE)
    if img is None:
        return None
    buf = io.BytesIO()
    if fmt == 'PNG':
        img.save(buf, 'PNG')
    else:
        img.save(buf, 'JPEG', quality=92, subsampling=0)
    v = buf.getvalue()
    if cache:
        cache.put(key, v)
    return v


class TileServer:
    def __init__(self, src):
        self.src, self.cache = src, TileCache()
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, ctype='application/octet-stream'):
                self.send_response(code)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'max-age=3600')
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                p = self.path.split('?')[0]
                if p == '/meta':
                    s = outer.src
                    md = {'w': s.w, 'h': s.h, 'tile': TILE, 'levels': s.levels, 'mpp': s.mpp, 'bounds': s.bounds}
                    if isinstance(s, DirSource): md.update({k: v for k, v in s.meta.items() if k != 'poly_px'})
                    return self._send(200, json.dumps(md).encode(), 'application/json')
                mc = re.match(r'^/cells/(\w+)$', p)
                if mc:
                    b = CELLS.get(mc.group(1))
                    return self._send(200, b, 'application/octet-stream') if b else self._send(404, b'no')
                m = re.match(r'^/tile/(\d+)/(\d+)/(\d+)\.(jpg|png)$', p)
                if not m:
                    return self._send(404, b'no')
                z, x, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if z >= outer.src.levels:
                    return self._send(404, b'z')
                if isinstance(outer.src, DirSource):
                    f = outer.src.tile_file(z, x, y)
                    if not f:
                        return self._send(404, b'vacio')
                    with open(f, 'rb') as fh:
                        return self._send(200, fh.read(), 'image/png' if f.endswith('.png') else 'image/jpeg')
                b = tile_bytes(outer.src, z, x, y, outer.cache, 'PNG' if m.group(4) == 'png' else 'JPEG')
                if b is None:
                    return self._send(404, b'vacio')
                self._send(200, b, 'image/png' if m.group(4) == 'png' else 'image/jpeg')

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


SERVERS = {}
CELLS = {}


def cmd_open_ortho(args, job):
    src = open_source(args['path'])
    ts = TileServer(src)
    sid = uuid.uuid4().hex[:8]
    SERVERS[sid] = ts
    return {'server': sid, 'url': 'http://127.0.0.1:%d' % ts.port, 'w': src.w, 'h': src.h, 'levels': src.levels, 'tile': TILE, 'mpp': src.mpp, 'bounds': src.bounds}


def cmd_close_ortho(args, job):
    ts = SERVERS.pop(args['server'], None)
    if ts:
        ts.close()
    return {'closed': bool(ts)}


# ----------------------------------------------------------------------------------------------- ortomosaico por posición (RTK)

def cmd_mosaic(args, job):
    """Ortomosaico a resolución original por posición GPS/RTK (sin Docker). args: folders|files, out, res_cm (opcional), quality, workers"""
    import mosaic_gps
    files = args.get('files')
    if not files:
        files, _, _ = walk_images(args['folders'])
    if len(files) < 2:
        raise RuntimeError('Hacen falta al menos 2 fotos RGB (.JPG)')
    out = os.path.abspath(args['out'])
    os.makedirs(out, exist_ok=True)
    res = (args['res_cm'] / 100.0) if args.get('res_cm') else None
    t0 = time.time()
    log('mosaico: inicio · %d fotos · salida %s · res_cm=%s · cpus=%s' % (len(files), out, args.get('res_cm'), os.cpu_count()))
    try:
        meta = mosaic_gps.build_mosaic(files, out, res_m=res, quality=int(args.get('quality', 92)), workers=args.get('workers'),
                                       progress=job.progress, cancel=job.cancel.is_set, log=log)
    except Exception as e:
        import traceback
        log('mosaico: ERROR %s\n%s' % (e, traceback.format_exc()))
        raise
    meta['dir'] = out
    meta['started'] = round(t0, 2); meta['finished'] = round(time.time(), 2); meta['seconds'] = round(meta['finished'] - t0, 1)
    meta['log'] = log_path()
    log('mosaico: listo en %.1f s · %d mosaicos' % (meta['seconds'], meta.get('tiles', 0)))
    return meta


class DirSource:
    """Pirámide de mosaicos ya generada (out/tiles/z/x/y.jpg + meta.json)."""
    def __init__(self, d):
        self.dir = d
        self.meta = json.load(open(os.path.join(d, 'meta.json')))
        self.w, self.h, self.levels = self.meta['w'], self.meta['h'], self.meta['levels']
        self.mpp, self.bounds = self.meta.get('mpp'), None

    def tile_file(self, z, x, y):
        b = os.path.join(self.dir, 'tiles', str(z), str(x), str(y))
        for e in ('.jpg', '.png'):
            if os.path.exists(b + e):
                return b + e
        return None


def cmd_open_tiles(args, job):
    src = DirSource(args['dir'])
    ts = TileServer(src)
    sid = uuid.uuid4().hex[:8]
    SERVERS[sid] = ts
    m = dict(src.meta); m.pop('poly_px', None)
    return dict(m, server=sid, url='http://127.0.0.1:%d' % ts.port, poly_px=src.meta.get('poly_px'))


def cmd_cells(args, job):
    """Características por celda sobre el ortomosaico a resolución original. args: server, spec{cs,W,H,mpp_v,theta,gw,gh}"""
    import cells
    ts = SERVERS.get(args['server'])
    if not ts or not isinstance(ts.src, DirSource):
        raise RuntimeError('Ortomosaico no abierto')
    res = cells.compute(ts.src.dir, ts.src.meta, args['spec'], progress=job.progress, cancel=job.cancel.is_set)
    cid = uuid.uuid4().hex[:8]
    for k in list(CELLS)[:-1]:                   # solo se guarda el último (cada recálculo reemplaza al anterior)
        CELLS.pop(k, None)
    CELLS[cid] = cells.pack(res)
    return {'id': cid, 'gw': res['gw'], 'gh': res['gh'], 'cover_ha': res['cover_ha'], 'level': res['level'], 'samples': res['samples']}


# ----------------------------------------------------------------------------------------------- bucle principal

COMMANDS = {'ping': lambda a, j: {'pong': True, 'python': sys.version.split()[0], 'docker': docker_ok(), 'rasterio': _has('rasterio')},
            'scan': cmd_scan, 'ortho': cmd_ortho, 'cancel': cmd_cancel, 'open_ortho': cmd_open_ortho, 'close_ortho': cmd_close_ortho, 'mosaic': cmd_mosaic, 'open_tiles': cmd_open_tiles, 'cells': cmd_cells}


def _has(mod):
    try:
        __import__(mod)
        return True
    except ImportError:
        return False


def run(mid, cmd, args):
    job = Job(mid)
    JOBS[mid] = job
    try:
        fn = COMMANDS.get(cmd)
        if cmd != 'ping':
            log('comando %s (id %s)' % (cmd, mid))
        if not fn:
            raise RuntimeError('Comando desconocido: ' + str(cmd))
        emit({'id': mid, 'type': 'result', 'data': fn(args or {}, job)})
    except Exception as e:
        log('comando %s: error %s' % (cmd, e))
        emit({'id': mid, 'type': 'error', 'error': str(e)})
    finally:
        JOBS.pop(mid, None)


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue
        threading.Thread(target=run, args=(m.get('id'), m.get('cmd'), m.get('args')), daemon=True).start()


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    log('motor iniciado · python %s · log %s' % (sys.version.split()[0], log_path()))
    serve()
