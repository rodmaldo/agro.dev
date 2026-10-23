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
KX0 = 111320.0
KY = 110540.0


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
        return {'path': path, 'lat': lat, 'lon': lon, 'alt': alt, 'yaw': yaw, 'w': w, 'h': h, 'rtk': rtk,
                'g': (alt / foc * (5280.0 / w) if (foc and alt) else (alt or 100.0) * GSD_PER_M * (5280.0 / w))}


# ----------------------------------------------------------------------------------------------- geometría

class Frame:
    """Plano local ENU alrededor de (lat0, lon0)."""
    def __init__(self, photos):
        self.lat0 = sum(p['lat'] for p in photos) / len(photos)
        self.lon0 = sum(p['lon'] for p in photos) / len(photos)
        self.kx = KX0 * math.cos(math.radians(self.lat0))
        for p in photos:
            p['e'] = (p['lon'] - self.lon0) * self.kx
            p['n'] = (p['lat'] - self.lat0) * KY

    def to_latlon(self, e, n):
        return self.lat0 + n / KY, self.lon0 + e / self.kx


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


def vignette_profile(photos, nb=48):
    """Perfil radial medio (por canal) normalizado al centro, mediana entre todas las fotos. Devuelve (r_bins, perfil[nb,3])."""
    rows = []
    for p in photos:
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


def solve_gains(photos, frame, prof, rbins, g_out):
    """Ganancias por foto y canal para que las superposiciones coincidan (mínimos cuadrados sobre log-ratios)."""
    n = len(photos)
    th = []
    for p in photos:
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
    for (i, j) in sorted(pairs):
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
    m = len(rows_i)
    A = np.zeros((m + 1, n)); w = np.array(wts) / max(wts)
    for k in range(m):
        A[k, rows_i[k]] = w[k]; A[k, rows_j[k]] = -w[k]
    A[m, :] = 0.02                                             # ancla: la ganancia media queda en 1
    G = np.ones((n, 3), np.float32)
    for c in range(3):
        # g_i * mi = g_j * mj  ->  log g_i - log g_j = log(mj/mi)
        b = np.concatenate([np.array(vals[c]) * w, [0.0]])
        x = np.linalg.lstsq(A, b, rcond=None)[0]
        G[:, c] = np.exp(np.clip(x, -0.5, 0.5))
    return G


# ----------------------------------------------------------------------------------------------- franjas

def render_band(args):
    """Procesa una franja de filas de mosaicos y escribe los JPEG del nivel de resolución original."""
    band, ty0, ty1, photos, grid, prof, rbins, gains, out_dir, top, quality = args
    E0, N1, g, W, H = grid['E0'], grid['N1'], grid['g'], grid['W'], grid['H']
    r0, r1 = ty0 * T, min(H, ty1 * T); bh = r1 - r0
    acc = np.zeros((bh, W, 3), np.float32); wsum = np.zeros((bh, W), np.float32)
    used = 0
    for k, p in enumerate(photos):
        fp = footprint(p, 1.0)
        es = [(q[0] - E0) / g for q in fp]; ns = [(N1 - q[1]) / g for q in fp]
        c0, c1 = int(max(0, math.floor(min(es)))), int(min(W, math.ceil(max(es))))
        y0, y1 = int(max(r0, math.floor(min(ns)))), int(min(r1, math.ceil(max(ns))))
        if c1 <= c0 or y1 <= y0:
            continue
        used += 1
        with Image.open(p['path']) as im:
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
    img = np.zeros_like(acc)
    img[ok] = acc[ok] / wsum[ok, None]
    np.clip(img, 0, 255, out=img)
    arr = img.astype(np.uint8)
    for ty in range(ty0, ty1):
        for tx in range(nx):
            y_a, y_b = ty * T - r0, min(bh, (ty + 1) * T - r0)
            x_a, x_b = tx * T, min(W, (tx + 1) * T)
            if y_b <= y_a or not ok[y_a:y_b, x_a:x_b].any():
                continue
            tile = np.zeros((T, T, 3), np.uint8)
            tile[:y_b - y_a, :x_b - x_a] = arr[y_a:y_b, x_a:x_b]
            d = os.path.join(out_dir, 'tiles', str(top), str(tx)); os.makedirs(d, exist_ok=True)
            Image.fromarray(tile).save(os.path.join(d, '%d.jpg' % ty), 'JPEG', quality=quality, subsampling=0)
            n_tiles += 1
    return band, used, n_tiles


def build_pyramid(out_dir, top, nx, ny, progress=None):
    for z in range(top - 1, -1, -1):
        zx, zy = (nx + 2 ** (top - z) - 1) // 2 ** (top - z), (ny + 2 ** (top - z) - 1) // 2 ** (top - z)
        for ty in range(zy):
            for tx in range(zx):
                cv = Image.new('RGB', (2 * T, 2 * T), (0, 0, 0)); any_ = False
                for dy in range(2):
                    for dx in range(2):
                        f = os.path.join(out_dir, 'tiles', str(z + 1), str(2 * tx + dx), '%d.jpg' % (2 * ty + dy))
                        if os.path.exists(f):
                            cv.paste(Image.open(f), (dx * T, dy * T)); any_ = True
                if any_:
                    d = os.path.join(out_dir, 'tiles', str(z), str(tx)); os.makedirs(d, exist_ok=True)
                    cv.resize((T, T), Image.BOX).save(os.path.join(d, '%d.jpg' % ty), 'JPEG', quality=90)
        if progress:
            progress((top - z) / max(1, top))


# ----------------------------------------------------------------------------------------------- principal

def build_mosaic(files, out_dir, res_m=None, quality=92, workers=None, progress=None, cancel=None, max_photos=None):
    """files: rutas de fotos RGB. res_m: tamaño de píxel de salida en metros (None = el de las fotos)."""
    t0 = time.time()
    P = [q for q in (parse_photo(f) for f in files) if q]
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
    if progress: progress(0.02, 'Corrigiendo viñeteo (%d fotos)' % len(P))
    rb, prof = vignette_profile(P)
    if progress: progress(0.08, 'Igualando exposición entre fotos')
    gains = solve_gains(P, fr, prof, rb, g)
    shutil.rmtree(os.path.join(out_dir, 'tiles'), ignore_errors=True); os.makedirs(os.path.join(out_dir, 'tiles'), exist_ok=True)
    grid = {'E0': E0, 'N1': N1, 'g': g, 'W': W, 'H': H}
    bandh = 1 if W > 40000 else 2
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
    workers = workers or max(1, min(4, (os.cpu_count() or 2) - 0))
    done = 0; ntiles = 0
    if workers == 1:
        results = (render_band(j) for j in jobs)
        for r in results:
            done += 1; ntiles += r[2]
            if progress: progress(0.12 + 0.78 * done / len(jobs), 'Armando mosaico %d/%d' % (done, len(jobs)))
            if cancel and cancel(): raise RuntimeError('Cancelado')
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(render_band, j) for j in jobs]
            for f in as_completed(futs):
                r = f.result(); done += 1; ntiles += r[2]
                if progress: progress(0.12 + 0.78 * done / len(jobs), 'Armando mosaico %d/%d' % (done, len(jobs)))
                if cancel and cancel():
                    for x in futs: x.cancel()
                    raise RuntimeError('Cancelado')
    if progress: progress(0.92, 'Generando vistas reducidas')
    build_pyramid(out_dir, top, nx, ny, lambda f: progress and progress(0.92 + 0.07 * f, 'Generando vistas reducidas'))
    hl = hull(corners)
    poly = [[(c[0] - E0) / g, (N1 - c[1]) / g] for c in hull([c for q in P for c in footprint(q, 0.96)])]
    meta = {'w': W, 'h': H, 'tile': T, 'levels': levels, 'mpp': g, 'E0': E0, 'N1': N1, 'lat0': fr.lat0, 'lon0': fr.lon0, 'kx': fr.kx, 'ky': KY,
            'photos': len(P), 'tiles': ntiles, 'poly_px': poly, 'cover_ha': 0, 'seconds': round(time.time() - t0, 1),
            'rtk': sum(1 for q in P if q.get('rtk') == 50), 'alt': float(np.median([q['alt'] or 0 for q in P])), 'quality': quality,
            'vignette': [float(prof[0, 1]), float(prof[-1, 1])], 'gain_range': [float(gains.min()), float(gains.max())]}
    # superficie cubierta (unión aproximada: área de píxeles con peso) = tiles no vacíos × área de mosaico (cota superior); la exacta la da el motor de análisis
    meta['cover_ha'] = round(ntiles * (T * g) ** 2 / 1e4, 2)
    json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'))
    if progress: progress(1.0, 'Ortomosaico listo')
    return meta
