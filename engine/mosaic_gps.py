"""agro.dev · ortomosaico por posición (GPS/RTK + rumbo + altura) a resolución original, fuera de memoria.

Pensado para vuelos con RTK sobre terreno plano (lotes agrícolas): cada foto se ubica con su posición, su rumbo y su altura
(tamaño del píxel en el terreno = altura / distancia focal), se corrige el viñeteo, se igualan las exposiciones entre fotos y se
mezclan los bordes. Se procesa por franjas horizontales (en paralelo) y se escribe una pirámide de mosaicos JPEG de 512 px:

    <out>/tiles/<z>/<x>/<y>.jpg     z = niveles-1 es la resolución original (z=0 una sola vista general)
    <out>/meta.json                 georreferencia (ENU local + lat/lon de origen), tamaño, polígono del vuelo

No corrige relieve ni distorsión de lente (para eso está el modo ODM). Con terreno plano y cámara vertical no hace falta.
"""
import json, math, os, re, shutil, sys, time
import numpy as np
from PIL import Image
from concurrent.futures import ProcessPoolExecutor, as_completed

Image.MAX_IMAGE_PIXELS = None
T = 512
GSD_PER_M = 0.02685 / 100          # m/px por metro de altura (Mavic 3M, 5280 px de ancho)
CROP = 0.04                        # margen descartado de cada borde (fracción del lado corto)
FEATHER = 0.14                     # ancho de la zona de mezcla


def m_per_deg(lat):
    """Metros por grado de latitud y de longitud (series WGS84). Con valores de ecuador el error llega a 0,2 % (2 m por km)."""
    p = math.radians(lat)
    ky = 111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p) - 0.0023 * math.cos(6 * p)
    kx = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p)
    return kx, ky


# ----------------------------------------------------------------------------------------------- metadatos

def parse_photo(path):
    """lat, lon, altura relativa, rumbo de la imagen, foco en px, tamaño. Devuelve None si no tiene GPS."""
    with Image.open(path) as im:
        w, h = im.size
        ex = im.getexif()
        gps = ex.get_ifd(0x8825) if ex else {}
        if not (gps.get(2) and gps.get(4)):
            return None
        r = lambda v: float(v) if not isinstance(v, tuple) else float(v[0]) / float(v[1])
        dms = lambda t, ref: (lambda d: -d if ref in ('S', 'W') else d)(r(t[0]) + r(t[1]) / 60 + r(t[2]) / 3600)
        lat, lon = dms(gps[2], gps.get(1, 'N')), dms(gps[4], gps.get(3, 'E'))
        xmp = im.info.get('xmp') or b''
        xmp = xmp.decode('utf8', 'ignore') if isinstance(xmp, bytes) else xmp
        def num(k):
            m = re.search(k + r'="?([+\-]?[0-9.]+)', xmp)
            return float(m.group(1)) if m else None
        alt = num('RelativeAltitude')
        if alt is None or alt < 5:
            alt = r(gps[6]) if gps.get(6) is not None else None
        gy, fy = num('GimbalYawDegree'), num('FlightYawDegree')
        yaw = gy if gy is not None else (fy if fy is not None else 0.0)
        foc = num('CalibratedFocalLength')
        rtk = num('RtkFlag')
        return {'path': path, 'model': str(ex.get(0x0110, '')).strip(), 'lat': lat, 'lon': lon, 'alt': alt, 'yaw': yaw, 'w': w, 'h': h, 'rtk': rtk,
                'g': (alt / foc * (5280.0 / w) if (foc and alt) else (alt or 100.0) * GSD_PER_M * (5280.0 / w))}


# ----------------------------------------------------------------------------------------------- geometría

class Frame:
    """Plano local ENU alrededor de (lat0, lon0)."""
    def __init__(self, photos):
        self.lat0 = sum(p['lat'] for p in photos) / len(photos)
        self.lon0 = sum(p['lon'] for p in photos) / len(photos)
        self.kx, self.ky = m_per_deg(self.lat0)
        for p in photos:
            p['e'] = (p['lon'] - self.lon0) * self.kx
            p['n'] = (p['lat'] - self.lat0) * self.ky

    def to_latlon(self, e, n):
        return self.lat0 + n / self.ky, self.lon0 + e / self.kx


def photo_matrix(p, E0, N1, g):
    """Coeficientes (a,b,c,d,e,f) de PIL: píxel de salida (u,v) [índices; PIL suma 0.5] -> coordenadas continuas de la foto."""
    ps = math.radians(p['yaw']); cs, sn = math.cos(ps), math.sin(ps)
    gi = p['g']; w, h = p['w'], p['h']
    # salida: E = E0 + g*(x+.5), N = N1 - g*(y+.5)
    # derecha = cs*dE - sn*dN ; arriba = sn*dE + cs*dN ; xi = w/2 + derecha/gi ; yi = h/2 - arriba/gi
    ax, bx = g * cs / gi, g * sn / gi            # d(xi)/d(u), d(xi)/d(v)
    ay, by = -g * sn / gi, g * cs / gi           # d(yi)/d(u), d(yi)/d(v)
    dE0, dN0 = E0 - p['e'], N1 - p['n']
    cx = w / 2 + (cs * dE0 - sn * dN0) / gi
    cy = h / 2 - (sn * dE0 + cs * dN0) / gi
    # PIL evalúa en (x+.5, y+.5): las constantes ya incluyen el origen del bloque; se aplica el centro de píxel con a*(x+.5)
    return (ax, bx, cx, ay, by, cy)


def footprint(p, K=1.0):
    """Esquinas (E,N) del recorte útil de la foto."""
    ps = math.radians(p['yaw']); cs, sn = math.cos(ps), math.sin(ps)
    hw, hh = p['w'] / 2 * p['g'] * K, p['h'] / 2 * p['g'] * K
    pts = []
    for sx, sy in ((-1, 1), (1, 1), (1, -1), (-1, -1)):          # x derecha, y arriba
        r, u = sx * hw, sy * hh
        pts.append((p['e'] + r * cs + u * sn, p['n'] - r * sn + u * cs))
    return pts


def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts
    cr = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for q in pts:
        while len(lo) >= 2 and cr(lo[-2], lo[-1], q) <= 0: lo.pop()
        lo.append(q)
    for q in reversed(pts):
        while len(up) >= 2 and cr(up[-2], up[-1], q) <= 0: up.pop()
        up.append(q)
    return lo[:-1] + up[:-1]


# ----------------------------------------------------------------------------------------------- viñeteo y exposición

_TH = {}


def thumb(path, div=16):
    """Miniatura RGB (float32) y tamaño original. Decodificación JPEG reducida; se guarda en caché como uint8."""
    if path not in _TH:
        with Image.open(path) as im:
            size = im.size
            im.draft('RGB', (im.width // div, im.height // div))
            t = im.convert('RGB')
            t = t.resize((max(8, size[0] // div), max(8, size[1] // div)), Image.BOX)
            _TH[path] = (np.asarray(t, np.uint8), size)
    a, size = _TH[path]
    return a.astype(np.float32), size


def vignette_profile(photos, nb=48, tick=None):
    """Perfil radial medio (por canal) normalizado al centro, mediana entre todas las fotos. Devuelve (r_bins, perfil[nb,3])."""
    rows = []
    for n_, p in enumerate(photos):
        if tick: tick(n_, len(photos))
        a, _ = thumb(p['path'])
        h, w = a.shape[:2]
        yy, xx = np.mgrid[0:h, 0:w]
        r = np.hypot((xx + .5 - w / 2) / (w / 2), (yy + .5 - h / 2) / (h / 2)) / math.sqrt(2)
        idx = np.minimum(nb - 1, (r * nb).astype(int))
        cen = a[r < 0.25].mean(0) + 1e-6
        prof = np.stack([np.bincount(idx.ravel(), a[..., c].ravel(), nb) / np.maximum(1, np.bincount(idx.ravel(), None, nb)) for c in range(3)], 1) / cen
        rows.append(prof)
    prof = np.median(np.stack(rows), 0)
    k = np.array([.25, .5, .25])
    for c in range(3):                                        # suavizado
        prof[:, c] = np.convolve(np.pad(prof[:, c], 1, mode='edge'), k, 'valid')
    prof = np.clip(prof, 0.35, 1.5)
    return (np.arange(nb) + .5) / nb, prof


def vignette_gain(r, prof, rbins):
    """Factor multiplicativo por canal (…,3) para radio normalizado r (0..1 en la esquina)."""
    return np.stack([1.0 / np.interp(r, rbins, prof[:, c]) for c in range(3)], -1)


def solve_gains(photos, frame, prof, rbins, g_out, tick=None):
    """Ganancias por foto y canal para que las superposiciones coincidan (mínimos cuadrados sobre log-ratios).
    tick(etapa, i, n) avisa el avance (para la barra de progreso y para saber que el motor sigue vivo)."""
    n = len(photos)
    th = []
    for i_, p in enumerate(photos):
        if tick and i_ % 20 == 0: tick('miniaturas', i_, n)
        a, (w, h) = thumb(p['path'])
        hh, ww = a.shape[:2]
        yy, xx = np.mgrid[0:hh, 0:ww]
        r = np.hypot((xx + .5 - ww / 2) / (ww / 2), (yy + .5 - hh / 2) / (hh / 2)) / math.sqrt(2)
        th.append((a * vignette_gain(r, prof, rbins), ww, hh))
    pos = np.array([[p['e'], p['n']] for p in photos])
    rows_i, rows_j, vals, wts = [], [], [[], [], []], []
    pairs = set()
    for i in range(n):
        d = np.hypot(pos[:, 0] - pos[i, 0], pos[:, 1] - pos[i, 1])
        lim = 0.8 * min(photos[i]['w'], photos[i]['h']) * photos[i]['g']
        for j in np.argsort(d)[1:9]:                      # 8 vecinos más cercanos
            if 1.0 < d[j] < lim:
                pairs.add((min(i, int(j)), max(i, int(j))))
    for k_, (i, j) in enumerate(sorted(pairs)):
        if tick and k_ % 100 == 0: tick('pares', k_, len(pairs))
        if True:
            P, Q = photos[i], photos[j]
            ai, wi, hi = th[i]; aj, wj, hj = th[j]
            # píxeles del miniatura i -> coordenadas de miniatura j (vía el terreno)
            s_i, s_j = P['w'] / wi, Q['w'] / wj
            ps_i, ps_j = math.radians(P['yaw']), math.radians(Q['yaw'])
            ys, xs = np.mgrid[0:hi, 0:wi]
            X = (xs + .5) * s_i - P['w'] / 2; Y = (ys + .5) * s_i - P['h'] / 2
            right, up = X * P['g'], -Y * P['g']
            dE = right * math.cos(ps_i) + up * math.sin(ps_i) + P['e'] - Q['e']
            dN = -right * math.sin(ps_i) + up * math.cos(ps_i) + P['n'] - Q['n']
            xj = (dE * math.cos(ps_j) - dN * math.sin(ps_j)) / Q['g'] + Q['w'] / 2
            yj = -(dE * math.sin(ps_j) + dN * math.cos(ps_j)) / Q['g'] + Q['h'] / 2
            cj, rj = (xj / s_j).astype(int), (yj / s_j).astype(int)
            ok = (cj >= 2) & (cj < wj - 2) & (rj >= 2) & (rj < hj - 2)
            # solo centro de las dos fotos (donde el viñeteo está bien corregido)
            ok &= (np.hypot((xs + .5 - wi / 2) / (wi / 2), (ys + .5 - hi / 2) / (hi / 2)) < 0.8)
            ok &= (np.hypot((cj + .5 - wj / 2) / (wj / 2), (rj + .5 - hj / 2) / (hj / 2)) < 0.8)
            if ok.sum() < 200:
                continue
            mi = ai[ok].mean(0); mj = aj[rj[ok], cj[ok]].mean(0)
            if (mi < 8).any() or (mj < 8).any():
                continue
            rows_i.append(i); rows_j.append(j); wts.append(math.sqrt(ok.sum()))
            for c in range(3): vals[c].append(math.log(mj[c] / mi[c]))        # log g_i - log g_j = log(mj/mi)·(-1)… ver abajo
    if not rows_i:
        return np.ones((n, 3), np.float32)
    if tick: tick('resolver', 0, 1)
    m = len(rows_i)
    w = np.array(wts) / max(wts)
    # Ecuaciones normales (AᵀA x = Aᵀb), construidas directamente sin la matriz densa m×n: con 1200 fotos la SVD de lstsq
    # sobre ~9000×1200 era lenta y gastaba memoria; AᵀA es n×n, ralo y se arma en milisegundos.
    ri, rj = np.array(rows_i), np.array(rows_j)
    AtA = np.zeros((n, n))
    np.add.at(AtA, (ri, ri), w * w); np.add.at(AtA, (rj, rj), w * w)
    np.add.at(AtA, (ri, rj), -w * w); np.add.at(AtA, (rj, ri), -w * w)
    AtA += 0.02 ** 2                                           # ancla: la ganancia media queda en 1 (fila 0.02·[1…1])
    AtA += np.eye(n) * 1e-9
    G = np.ones((n, 3), np.float32)
    # g_i * mi = g_j * mj  ->  log g_i - log g_j = log(mj/mi)
    B = np.zeros((n, 3))
    for c in range(3):
        wb = np.array(vals[c]) * w * w
        np.add.at(B[:, c], ri, wb); np.add.at(B[:, c], rj, -wb)
    X = np.linalg.solve(AtA, B)
    G[:] = np.exp(np.clip(X, -0.5, 0.5))
    return G


# ----------------------------------------------------------------------------------------------- franjas

_PROG = None          # callable(franja, foto, total): avance dentro de una franja (lo fija el proceso principal o el inicializador del trabajador)


def _worker_init(q):
    """Inicializador de cada proceso trabajador: el avance por foto viaja por una cola hasta el proceso principal."""
    global _PROG
    last = [0.0]

    def f(band, k, n):
        t = time.time()
        if k == 0 or k >= n or t - last[0] >= 0.5:
            last[0] = t
            try:
                q.put((band, k, n))
            except Exception:
                pass
    _PROG = f


def render_band(args):
    """Procesa una franja de filas de mosaicos y escribe los JPEG del nivel de resolución original."""
    band, ty0, ty1, photos, grid, prof, rbins, gains, out_dir, top, quality = args
    E0, N1, g, W, H = grid['E0'], grid['N1'], grid['g'], grid['W'], grid['H']
    r0, r1 = ty0 * T, min(H, ty1 * T); bh = r1 - r0
    acc = np.zeros((bh, W, 3), np.float32); wsum = np.zeros((bh, W), np.float32)
    used = 0
    for k, p in enumerate(photos):
        if _PROG: _PROG(band, k, len(photos))
        fp = footprint(p, 1.0)
        es = [(q[0] - E0) / g for q in fp]; ns = [(N1 - q[1]) / g for q in fp]
        c0, c1 = int(max(0, math.floor(min(es)))), int(min(W, math.ceil(max(es))))
        y0, y1 = int(max(r0, math.floor(min(ns)))), int(min(r1, math.ceil(max(ns))))
        if c1 <= c0 or y1 <= y0:
            continue
        used += 1
        with Image.open(p['path']) as im:
            if im.mode != 'RGB':                      # un JPEG RGB ya lo es: convert() copiaba 60 MB por foto para nada
                im = im.convert('RGB')
            sw, sh = c1 - c0, y1 - y0
            a, b, c, d, e, f = photo_matrix(p, E0 + c0 * g, N1 - y0 * g, g)
            blk = im.transform((sw, sh), Image.AFFINE, (a, b, c, d, e, f), Image.BICUBIC)
        pix = np.asarray(blk, np.float32)
        # coordenadas de foto de cada píxel (para viñeteo y pesos)
        uu = np.arange(sw, dtype=np.float32)[None, :] + .5; vv = np.arange(sh, dtype=np.float32)[:, None] + .5
        xi = a * uu + b * vv + c; yi = d * uu + e * vv + f
        w_, h_ = p['w'], p['h']
        r = np.hypot((xi - w_ / 2) / (w_ / 2), (yi - h_ / 2) / (h_ / 2)) / math.sqrt(2)
        pix *= vignette_gain(np.clip(r, 0, 1), prof, rbins) * gains[k]
        # peso: bordes (recorte + mezcla) y esquinas oscuras de la lente
        dmin = np.minimum(np.minimum(xi, w_ - xi), np.minimum(yi, h_ - yi)) / min(w_, h_)
        wt = np.clip((dmin - CROP) / FEATHER, 0, 1)
        wt = wt * np.clip((0.93 - r) / 0.15, 0, 1)
        wt = wt ** 3
        wt[(xi < 0) | (xi >= w_) | (yi < 0) | (yi >= h_)] = 0
        sl = (slice(y0 - r0, y1 - r0), slice(c0, c1))
        acc[sl] += pix * wt[..., None]; wsum[sl] += wt
    n_tiles = 0
    nx = (W + T - 1) // T
    ok = wsum > 1e-4
    acc /= np.maximum(wsum, 1e-6)[..., None]              # en el lugar: sin una segunda copia float32 de la franja
    acc[~ok] = 0
    np.clip(acc, 0, 255, out=acc)
    arr = acc.astype(np.uint8)
    del acc
    if _PROG: _PROG(band, len(photos), len(photos))
    for ty in range(ty0, ty1):
        for tx in range(nx):
            y_a, y_b = ty * T - r0, min(bh, (ty + 1) * T - r0)
            x_a, x_b = tx * T, min(W, (tx + 1) * T)
            if y_b <= y_a or not ok[y_a:y_b, x_a:x_b].any():
                continue
            d = os.path.join(out_dir, 'tiles', str(top), str(tx)); os.makedirs(d, exist_ok=True)
            okt = np.zeros((T, T), bool); okt[:y_b - y_a, :x_b - x_a] = ok[y_a:y_b, x_a:x_b]
            if okt.all():
                tile = arr[y_a:y_b, x_a:x_b]
                Image.fromarray(tile).save(os.path.join(d, '%d.jpg' % ty), 'JPEG', quality=quality, subsampling=0)
            else:                                   # borde del vuelo: PNG con transparencia (el satélite se ve por debajo)
                tile = np.zeros((T, T, 4), np.uint8)
                tile[:y_b - y_a, :x_b - x_a, :3] = arr[y_a:y_b, x_a:x_b]
                tile[..., 3] = np.where(okt, 255, 0)
                Image.fromarray(tile, 'RGBA').save(os.path.join(d, '%d.png' % ty), 'PNG', compress_level=3)
            n_tiles += 1
    return band, used, n_tiles


def tile_path(out_dir, z, x, y):
    b = os.path.join(out_dir, 'tiles', str(z), str(x), str(y))
    for e in ('.jpg', '.png'):
        if os.path.exists(b + e):
            return b + e
    return None


def build_pyramid(out_dir, top, nx, ny, progress=None):
    for z in range(top - 1, -1, -1):
        zx, zy = (nx + 2 ** (top - z) - 1) // 2 ** (top - z), (ny + 2 ** (top - z) - 1) // 2 ** (top - z)
        for ty in range(zy):
            if progress:
                progress(((top - 1 - z) + ty / max(1, zy)) / max(1, top))
            for tx in range(zx):
                cv = Image.new('RGBA', (2 * T, 2 * T), (0, 0, 0, 0)); any_ = False
                for dy in range(2):
                    for dx in range(2):
                        f = tile_path(out_dir, z + 1, 2 * tx + dx, 2 * ty + dy)
                        if f:
                            cv.paste(Image.open(f).convert('RGBA'), (dx * T, dy * T)); any_ = True
                if any_:
                    # promedio ponderado por transparencia (sin halos oscuros en los bordes)
                    a = np.asarray(cv, np.float32); al = a[..., 3:4] / 255.0
                    pm = np.concatenate([a[..., :3] * al, a[..., 3:4]], -1)
                    pm = pm.reshape(T, 2, T, 2, 4).mean((1, 3))
                    alpha = pm[..., 3:4]
                    rgb = np.where(alpha > 1e-3, pm[..., :3] / np.maximum(alpha / 255.0, 1e-6), 0)
                    out = np.concatenate([np.clip(rgb, 0, 255), alpha], -1).astype(np.uint8)
                    d = os.path.join(out_dir, 'tiles', str(z), str(tx)); os.makedirs(d, exist_ok=True)
                    if (out[..., 3] > 250).all():
                        Image.fromarray(out[..., :3]).save(os.path.join(d, '%d.jpg' % ty), 'JPEG', quality=90)
                    else:
                        Image.fromarray(out, 'RGBA').save(os.path.join(d, '%d.png' % ty), 'PNG', compress_level=3)
        if progress:
            progress((top - z) / max(1, top))


# ----------------------------------------------------------------------------------------------- principal

def total_ram():
    """Memoria disponible en bytes (en Windows la libre; en otros sistemas la total). Si no se puede leer, 8 GB."""
    try:
        if os.name == 'nt':
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong), ('ullTotalPhys', ctypes.c_ulonglong),
                            ('ullAvailPhys', ctypes.c_ulonglong), ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                            ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong), ('sullAvailExtendedVirtual', ctypes.c_ulonglong)]
            s = MS(); s.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))
            return int(s.ullAvailPhys)
        return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    except Exception:
        return 8 * 2 ** 30


class Stalled(Exception):
    pass


def build_mosaic(files, out_dir, res_m=None, quality=92, workers=None, progress=None, cancel=None, max_photos=None, log=None, stall_s=None):
    """files: rutas de fotos RGB. res_m: tamaño de píxel de salida en metros (None = el de las fotos).
    progress(pct, msg) se llama seguido (por foto); log(msg) deja constancia con hora; si los trabajadores no dan señales durante
    stall_s segundos (300 por defecto) se descartan y la franja se termina en un solo proceso."""
    import queue as _queue
    from concurrent.futures import wait, FIRST_COMPLETED
    global _PROG
    t0 = time.time()
    L = log or (lambda m: None)
    stall_s = float(stall_s or os.environ.get('AGRO_STALL_S') or 300)
    last_emit = [0.0]

    def prog(p, m, force=False):
        t = time.time()
        if progress and (force or t - last_emit[0] >= 0.4):
            last_emit[0] = t
            progress(p, m)

    def chk():
        if cancel and cancel():
            raise RuntimeError('Cancelado')

    tm = {}
    n_files = len(files)
    P = []
    for i, f in enumerate(files):
        if i % 20 == 0:
            chk(); prog(0.02 * i / max(1, n_files), 'Leyendo posición de las fotos %d/%d' % (i, n_files))
        q_ = parse_photo(f)
        if q_:
            P.append(q_)
    if max_photos:
        P = P[:max_photos]
    if len(P) < 2:
        raise RuntimeError('Hacen falta al menos 2 fotos con GPS')
    P.sort(key=lambda q: q['path'])
    fr = Frame(P)
    g = res_m or float(np.median([q['g'] for q in P]))
    corners = [c for q in P for c in footprint(q, 1.0)]
    E0 = min(c[0] for c in corners); Emax = max(c[0] for c in corners)
    N1 = max(c[1] for c in corners); Nmin = min(c[1] for c in corners)
    W, H = int(math.ceil((Emax - E0) / g)), int(math.ceil((N1 - Nmin) / g))
    nx, ny = (W + T - 1) // T, (H + T - 1) // T
    top = max(0, int(math.ceil(math.log2(max(1, max(nx, ny))))))
    levels = top + 1
    tm['lectura'] = round(time.time() - t0, 1)
    L('mosaico: %d fotos con GPS · %d×%d px a %.2f cm/px · %d×%d mosaicos · %d niveles' % (len(P), W, H, g * 100, nx, ny, levels))

    # --- viñeteo
    ts = time.time()
    def vtick(i, n):
        chk()
        if i % 10 == 0:
            prog(0.02 + 0.06 * i / n, 'Corrigiendo viñeteo · foto %d/%d' % (i, n))
    rb, prof = vignette_profile(P, tick=vtick)
    tm['viñeteo'] = round(time.time() - ts, 1); L('mosaico: viñeteo listo en %.1f s' % tm['viñeteo'])

    # --- exposición entre fotos
    ts = time.time()
    def gtick(stage, i, n):
        chk()
        fr_ = {'miniaturas': 0.0 + 0.5 * i / n, 'pares': 0.5 + 0.45 * i / n, 'resolver': 0.95}[stage]
        txt = {'miniaturas': 'miniaturas %d/%d' % (i, n), 'pares': 'comparando fotos vecinas %d/%d' % (i, n), 'resolver': 'resolviendo ganancias'}[stage]
        prog(0.08 + 0.04 * fr_, 'Igualando exposición entre fotos · ' + txt)
    gains = solve_gains(P, fr, prof, rb, g, tick=gtick)
    tm['exposición'] = round(time.time() - ts, 1); L('mosaico: exposición lista en %.1f s' % tm['exposición'])

    shutil.rmtree(os.path.join(out_dir, 'tiles'), ignore_errors=True); os.makedirs(os.path.join(out_dir, 'tiles'), exist_ok=True)
    grid = {'E0': E0, 'N1': N1, 'g': g, 'W': W, 'H': H}

    # --- franjas: tamaño según el ancho (memoria por trabajador ≈ franja × ancho × 19 bytes) y cantidad de trabajadores según la RAM libre
    budget = float(os.environ.get('AGRO_BAND_BYTES') or 1.6e9)
    bandh = int(max(1, min(8, budget // (max(1, W) * 19.0 * T))))
    per_worker = bandh * T * W * 19.0 + 0.7e9
    cpu = os.cpu_count() or 2
    cap = 1 if cpu <= 1 else min(8, max(2, cpu - 1))
    ram_cap = max(1, int(0.65 * total_ram() // per_worker))
    nw = int(workers) if workers else max(1, min(cap, ram_cap))
    bands = [(k, ty, min(ny, ty + bandh)) for k, ty in enumerate(range(0, ny, bandh))]
    ps = [(p, i) for i, p in enumerate(P)]
    jobs = []
    for k, ty0, ty1 in bands:
        rect = (E0 - 1, N1 - ty1 * T * g - 1, Emax + 1, N1 - ty0 * T * g + 1)      # (Emin, Nmin, Emax, Nmax) de la franja
        sel = []; sg = []
        for (p, i) in ps:
            fp = footprint(p, 1.0)
            if max(c[1] for c in fp) < rect[1] or min(c[1] for c in fp) > rect[3]:
                continue
            sel.append(p); sg.append(gains[i])
        if sel:
            jobs.append((k, ty0, ty1, sel, grid, prof, rb, sg, out_dir, top, quality))
    L('mosaico: %d franjas de %d fila(s) de mosaicos · %d trabajador(es) · %.1f GB por trabajador' % (len(jobs), bandh, nw, per_worker / 1e9))

    weight = {j[0]: len(j[3]) * 1.15 for j in jobs}          # fotos + escritura de mosaicos
    total_w = max(1.0, sum(weight.values()))
    state = {}                                               # franja -> (foto, total) en curso
    finished = {}                                            # franja -> (usadas, mosaicos)
    ts = time.time()

    def report(mode='', force=False):
        w = sum(weight[b] for b in finished) + sum(min(k, n) for b, (k, n) in state.items() if b not in finished)
        frac = min(1.0, w / total_w)
        prog(0.12 + 0.78 * frac, 'Armando mosaico · %d/%d franjas · %d%%%s' % (len(finished), len(jobs), int(frac * 100), mode), force)

    def run_seq(todo, mode):
        global _PROG
        def f(b, k, n):
            state[b] = (k, n); chk(); report(mode)
        _PROG = f
        try:
            for j in todo:
                r = render_band(j); finished[r[0]] = (r[1], r[2]); report(mode, True)
        finally:
            _PROG = None

    def run_pool(todo):
        import multiprocessing
        ctx = multiprocessing.get_context('spawn')           # el motor tiene hilos y 'fork' puede trabarse; 'spawn' es lo único que existe en Windows
        q = ctx.Queue()
        ex = ProcessPoolExecutor(max_workers=nw, mp_context=ctx, initializer=_worker_init, initargs=(q,))
        pend = {ex.submit(render_band, j) for j in todo}
        last = time.time(); ok = False
        try:
            while pend:
                news = False
                try:
                    while True:
                        b, k, n = q.get_nowait(); state[b] = (k, n); news = True
                except _queue.Empty:
                    pass
                done, pend = wait(pend, timeout=1.0, return_when=FIRST_COMPLETED)
                for f in done:
                    r = f.result(); finished[r[0]] = (r[1], r[2]); news = True
                if news:
                    last = time.time(); report()
                elif time.time() - last > stall_s:
                    raise Stalled('sin señales de los trabajadores hace %d s' % int(time.time() - last))
                chk()
            ok = True
        finally:
            if not ok:                                       # cancelar, atasco o error: matar a los trabajadores, no esperar a nadie
                for p_ in list(getattr(ex, '_processes', {}).values()):
                    try: p_.kill()
                    except Exception: pass
            ex.shutdown(wait=ok, cancel_futures=True)

    mode = ''
    if nw <= 1:
        run_seq(jobs, ' · 1 proceso')
    else:
        try:
            run_pool(jobs)
        except Stalled as e:
            L('mosaico: %s -> se termina en un solo proceso' % e); mode = ' · 1 proceso (reintento)'
        except RuntimeError as e:
            if str(e) == 'Cancelado': raise
            L('mosaico: fallo del grupo de procesos (%s) -> se termina en un solo proceso' % e); mode = ' · 1 proceso (reintento)'
        except Exception as e:                               # BrokenProcessPool (un trabajador murió, p. ej. por falta de memoria), etc.
            L('mosaico: fallo del grupo de procesos (%s: %s) -> se termina en un solo proceso' % (type(e).__name__, e)); mode = ' · 1 proceso (reintento)'
        if mode:
            for b in list(state):
                if b not in finished: state.pop(b)
            run_seq([j for j in jobs if j[0] not in finished], mode)
    ntiles = sum(v[1] for v in finished.values())
    tm['franjas'] = round(time.time() - ts, 1); L('mosaico: franjas listas en %.1f s (%d mosaicos)' % (tm['franjas'], ntiles))

    # --- pirámide de vistas reducidas
    ts = time.time()
    prog(0.92, 'Generando vistas reducidas', True)
    def ptick(f):
        chk(); prog(0.92 + 0.07 * f, 'Generando vistas reducidas · %d%%' % int(f * 100))
    build_pyramid(out_dir, top, nx, ny, ptick)
    tm['vistas'] = round(time.time() - ts, 1); L('mosaico: vistas reducidas listas en %.1f s' % tm['vistas'])
    hl = hull(corners)
    poly = [[(c[0] - E0) / g, (N1 - c[1]) / g] for c in hull([c for q in P for c in footprint(q, 0.96)])]
    meta = {'w': W, 'h': H, 'tile': T, 'levels': levels, 'mpp': g, 'E0': E0, 'N1': N1, 'lat0': fr.lat0, 'lon0': fr.lon0, 'kx': fr.kx, 'ky': fr.ky,
            'photos': len(P), 'tiles': ntiles, 'poly_px': poly, 'cover_ha': 0, 'seconds': round(time.time() - t0, 1),
            'rtk': sum(1 for q in P if q.get('rtk') == 50), 'alt': float(np.median([q['alt'] or 0 for q in P])), 'quality': quality,
            'vignette': [float(prof[0, 1]), float(prof[-1, 1])], 'gain_range': [float(gains.min()), float(gains.max())],
            'workers': nw, 'bands': len(jobs), 'timings': tm, 'single_process_fallback': bool(mode)}
    # superficie cubierta (unión aproximada: área de píxeles con peso) = tiles no vacíos × área de mosaico (cota superior); la exacta la da el motor de análisis
    meta['cover_ha'] = round(ntiles * (T * g) ** 2 / 1e4, 2)
    json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'))
    prog(1.0, 'Ortomosaico listo', True)
    return meta
