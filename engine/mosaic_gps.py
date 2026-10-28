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
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
T = 512
GSD_PER_M = 0.02685 / 100          # m/px por metro de altura (Mavic 3M, 5280 px de ancho)
RMAX = 0.88                        # radio útil de cada foto (1 = esquina): más afuera las esquinas oscuras de la lente se amplificaban y el borde del lote salía quemado
CROP = 0.04                        # margen descartado de cada borde (fracción del lado corto)
CENTER_POW = float(os.environ.get('AGRO_CENTER_POW') or 6)   # cuánto gana la foto más centrada (1 = promedio suave)
FEATHER = 0.07                    # ancho de la zona de mezcla (angosta: con las fotos alineadas, mezclar menos = más nitidez)


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
        # Con el gimbal casi vertical el DJI a veces reporta yaw+180° con roll=±180° (misma orientación real): sin esto esas fotos se pegan giradas 180°
        groll = num('GimbalRollDegree')
        if gy is not None and groll is not None and abs(groll) > 90:
            yaw += 180.0
        foc = num('CalibratedFocalLength')
        rtk = num('RtkFlag')
        return {'path': path, 'model': str(ex.get(0x0110, '')).strip(), 'lat': lat, 'lon': lon, 'alt': alt, 'yaw': yaw, 'w': w, 'h': h, 'rtk': rtk,
                'g': (alt / foc * (5280.0 / w) if (foc and alt) else (alt or 100.0) * GSD_PER_M * (5280.0 / w))}


# ----------------------------------------------------------------------------------------------- geometría

_WA, _WF = 6378137.0, 1 / 298.257223563
_WE2 = _WF * (2 - _WF)


def _ecef(lat, lon):
    p, l = math.radians(lat), math.radians(lon); sp = math.sin(p); N = _WA / math.sqrt(1 - _WE2 * sp * sp)
    return N * math.cos(p) * math.cos(l), N * math.cos(p) * math.sin(l), N * (1 - _WE2) * sp


def _geodetic(x, y, z):
    lon = math.atan2(y, x); p = math.hypot(x, y); lat = math.atan2(z, p * (1 - _WE2))
    for _ in range(6):
        sp = math.sin(lat); N = _WA / math.sqrt(1 - _WE2 * sp * sp); lat = math.atan2(z + _WE2 * N * sp, p)
    return math.degrees(lat), math.degrees(lon)


class Frame:
    """Plano tangente local ENU (metros reales, WGS84 exacto) alrededor de (lat0, lon0). Reemplaza la aproximación de grados-metro
    constantes: con ella el error llegaba a ~15 cm a 1 km del centro (la longitud de un grado cambia con la latitud y los meridianos convergen)."""
    def __init__(self, photos):
        self.lat0 = sum(p['lat'] for p in photos) / len(photos)
        self.lon0 = sum(p['lon'] for p in photos) / len(photos)
        self.kx, self.ky = m_per_deg(self.lat0)
        p0, l0 = math.radians(self.lat0), math.radians(self.lon0)
        self.o = _ecef(self.lat0, self.lon0)
        self.ux = (-math.sin(l0), math.cos(l0), 0.0)
        self.uy = (-math.sin(p0) * math.cos(l0), -math.sin(p0) * math.sin(l0), math.cos(p0))
        self.uz = (math.cos(p0) * math.cos(l0), math.cos(p0) * math.sin(l0), math.sin(p0))
        for p in photos:
            p['e'], p['n'] = self.to_enu(p['lat'], p['lon'])

    def to_enu(self, lat, lon):
        x, y, z = _ecef(lat, lon); d = (x - self.o[0], y - self.o[1], z - self.o[2])
        return (d[0] * self.ux[0] + d[1] * self.ux[1] + d[2] * self.ux[2], d[0] * self.uy[0] + d[1] * self.uy[1] + d[2] * self.uy[2])

    def to_latlon(self, e, n):
        u = -(e * e + n * n) / (2 * 6371000.0)          # el plano tangente queda "arriba" del elipsoide: se baja a la superficie
        x = self.o[0] + e * self.ux[0] + n * self.uy[0] + u * self.uz[0]
        y = self.o[1] + e * self.ux[1] + n * self.uy[1] + u * self.uz[1]
        z = self.o[2] + e * self.ux[2] + n * self.uy[2] + u * self.uz[2]
        return _geodetic(x, y, z)


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
    prof = np.clip(prof, 0.85, 1.25)                           # la corrección nunca amplifica más de ~18 %: lo demás sería ruido de las esquinas de la lente
    return (np.arange(nb) + .5) / nb, prof


def vignette_gain(r, prof, rbins):
    """Factor multiplicativo por canal (…,3) para radio normalizado r (0..1 en la esquina)."""
    return np.stack([1.0 / np.interp(r, rbins, prof[:, c]) for c in range(3)], -1)


def _solve_small(A, b):
    """Gauss con pivoteo para sistemas chicos (6×6), solo numpy: sin LAPACK."""
    n = len(b); M_ = np.concatenate([A.astype(float), b.reshape(n, -1).astype(float)], 1)
    for c in range(n):
        p = c + int(np.argmax(np.abs(M_[c:, c]))); M_[[c, p]] = M_[[p, c]]
        M_[c] /= M_[c, c] if abs(M_[c, c]) > 1e-18 else 1e-18
        for r in range(n):
            if r != c:
                M_[r] -= M_[r, c] * M_[c]
    return M_[:, n:]


def detrend_gains(lg, pos, comps, log=None):
    """Quita de log-ganancia la tendencia suave con la posición (plano + curvatura) en cada grupo de fotos conectado.
    Por qué: el brillo de cada foto cambia de un lado al otro del cuadro (el rastrojo refleja distinto según el ángulo de visión). Al comparar
    fotos vecinas eso parece un cambio de exposición, y al encadenar miles de fotos se acumula en un degradado enorme. La exposición real de la
    cámara no cambia de forma suave en kilómetros: lo que queda (saltos entre fotos vecinas) sí se conserva."""
    out = lg.copy(); info = []
    for idx in comps:
        if len(idx) < 12:
            continue
        idx = np.array(idx); xy = pos[idx]; c0 = xy.mean(0); sc = max(1.0, float(np.abs(xy - c0).max()))
        x, y = (xy[:, 0] - c0[0]) / sc, (xy[:, 1] - c0[1]) / sc
        F = np.stack([np.ones_like(x), x, y, x * x, x * y, y * y], 1)
        A = F.T @ F + 1e-6 * len(idx) * np.diag([0, 1, 1, 1, 1, 1])
        coef = _solve_small(A, F.T @ lg[idx])
        trend = F @ coef; trend -= trend.mean(0)
        out[idx] = lg[idx] - trend
        info.append((len(idx), float(np.exp(trend.max()) - np.exp(trend.min()))))
    if log and info:
        log('exposición: tendencia suave quitada de las ganancias (%s)' % ' · '.join('%d fotos: %.0f %% de variación' % (n_, 100 * v) for n_, v in info))
    return out


FIELD_SC = 50.0      # m: escala de las coordenadas del campo de brillo


def field_feats(dE, dN):
    """Características (…,5) del desplazamiento (m, este/norte) del punto respecto del centro de la foto: x, y, x², xy, y²."""
    x, y = np.asarray(dE, np.float32) / FIELD_SC, np.asarray(dN, np.float32) / FIELD_SC
    return np.stack([x, y, x * x, x * y, y * y], -1)


def field_gain(theta, dE, dN):
    """Factor multiplicativo (…,3) del brillo según el ángulo de visión (desplazamiento respecto del centro de la foto)."""
    f = field_feats(dE, dN)
    return np.exp(np.clip(np.tensordot(f, theta, axes=([-1], [0])), -0.5, 0.5)).astype(np.float32)


def _cg_joint(ri, rj, w2, y, dphi, n, prior=1e-3, anchor=0.02 ** 2, tol=1e-9, max_it=20000):
    """Ganancia por foto (n) y coeficientes del campo de brillo (5) a la vez, por gradiente conjugado con bincount (sin LAPACK).
    Ecuación de cada par:  lG_i - lG_j + theta·(phi_i - phi_j) = y. El prior chico sobre lG manda cualquier tendencia suave al campo de brillo."""
    k = dphi.shape[1]
    X = np.zeros((n + k, y.shape[1]))
    dg = np.concatenate([np.bincount(ri, w2, n) + np.bincount(rj, w2, n) + anchor + prior + 1e-12, (dphi * dphi * w2[:, None]).sum(0) + 1e-9])
    def mv(v):
        u, t = v[:n], v[n:]
        rp = w2 * (u[ri] - u[rj] + dphi @ t)
        out_u = np.bincount(ri, rp, n) - np.bincount(rj, rp, n) + (anchor + prior) * u + anchor * (u.sum() - u)
        return np.concatenate([out_u, dphi.T @ rp + 1e-9 * t])
    for c in range(y.shape[1]):
        wy = w2 * y[:, c]
        b = np.concatenate([np.bincount(ri, wy, n) - np.bincount(rj, wy, n), dphi.T @ wy])
        x = np.zeros(n + k); r = b.copy(); z = r / dg; pv = z.copy(); rz = float(r @ z); nb = math.sqrt(float(b @ b)) + 1e-30
        for _ in range(max_it):
            if math.sqrt(float(r @ r)) / nb < tol:
                break
            Ap = mv(pv); al = rz / max(float(pv @ Ap), 1e-300)
            x += al * pv; r -= al * Ap; z = r / dg
            rz2 = float(r @ z); pv = z + (rz2 / max(rz, 1e-300)) * pv; rz = rz2
        X[:, c] = x
    return X[:n], X[n:]


def solve_gains(photos, frame, prof, rbins, g_out, tick=None, log=None):
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
    rows_i, rows_j, vals, wts, dphis = [], [], [[], [], []], [], []
    pairs = set()
    for i in range(n):
        d = np.hypot(pos[:, 0] - pos[i, 0], pos[:, 1] - pos[i, 1])
        lim = 0.8 * min(photos[i]['w'], photos[i]['h']) * photos[i]['g']
        # Vecinos repartidos por dirección (8 sectores, los 3 más cercanos de cada uno). Con "los N más cercanos" casi todos caen en la MISMA
        # pasada y entre pasadas quedan pocos enlaces: cada franja flota con su propio brillo y aparecen escalones diagonales. Así hay enlaces
        # a las pasadas de ambos lados (y de otros vuelos) y el sistema se cierra en lazos que frenan la deriva de exposición.
        cand = [int(j) for j in np.argsort(d)[1:] if 1.0 < d[j] < lim][:200]
        cnt = {}
        for j in cand:
            sec = int(((math.atan2(pos[j, 0] - pos[i, 0], pos[j, 1] - pos[i, 1]) + math.pi) / (2 * math.pi) * 8)) % 8
            if cnt.get(sec, 0) < 3:
                cnt[sec] = cnt.get(sec, 0) + 1; pairs.add((min(i, j), max(i, j)))
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
            vi_, vj_ = ai[ok], aj[rj[ok], cj[ok]]
            good = (vi_.max(1) < 240) & (vj_.max(1) < 240) & (vi_.min(1) > 6) & (vj_.min(1) > 6)     # sin píxeles quemados ni negros
            if good.sum() < 150:
                continue
            mi = vi_[good].mean(0); mj = vj_[good].mean(0)
            oiE = (right * math.cos(ps_i) + up * math.sin(ps_i))[ok][good]; oiN = (-right * math.sin(ps_i) + up * math.cos(ps_i))[ok][good]
            dphis.append(field_feats(oiE, oiN).mean(0) - field_feats(oiE + P['e'] - Q['e'], oiN + P['n'] - Q['n']).mean(0))
            if (mi < 8).any() or (mj < 8).any():
                continue
            rows_i.append(i); rows_j.append(j); wts.append(math.sqrt(good.sum()))
            for c in range(3): vals[c].append(math.log(mj[c] / mi[c]))        # log g_i - log g_j = log(mj/mi)·(-1)… ver abajo
    solve_gains.theta = np.zeros((5, 3), np.float32)
    if not rows_i:
        return np.ones((n, 3), np.float32)
    if tick: tick('resolver', 0, 1)
    m = len(rows_i)
    w = np.array(wts) / max(wts)
    # Ecuaciones normales (AᵀA x = Aᵀb) sin matriz densa. Se resuelven con gradiente conjugado usando solo sumas de numpy
    # (bincount): NO pasa por BLAS/LAPACK. En el .exe de Windows la primera llamada a LAPACK (lstsq / solve) se colgaba sin error.
    ri, rj = np.array(rows_i), np.array(rows_j)
    w2 = w * w
    G = np.ones((n, 3), np.float32)
    # g_i * mi = g_j * mj  ->  log g_i - log g_j = log(mj/mi)
    B = np.zeros((n, 3))
    for c in range(3):
        wb = np.array(vals[c]) * w2
        B[:, c] = np.bincount(ri, wb, n) - np.bincount(rj, wb, n)
    if os.environ.get('AGRO_FIELD', '0') == '1' and m >= 30:
        yv = np.stack([np.array(vals[c]) for c in range(3)], 1)
        lg, theta = _cg_joint(ri, rj, w2, yv, np.array(dphis, float), n)
        solve_gains.theta = theta.astype(np.float32)
        try:                                             # salto de brillo que queda entre fotos vecinas (lo que se ve como recuadro): sin y con el campo
            lg0 = _cg_laplacian(ri, rj, w2, B, n)
            e0 = np.abs(yv - (lg0[ri] - lg0[rj])); e1 = np.abs(yv - (lg[ri] - lg[rj] + np.array(dphis) @ theta))
            solve_gains.seam = (float(np.median(e0)), float(np.median(e1)), float(np.percentile(e0, 90)), float(np.percentile(e1, 90)))
            if log:
                log('exposición: salto de brillo entre fotos vecinas (mediana / p90): sin corregir %.1f %% / %.1f %% -> corregido %.1f %% / %.1f %%'
                    % (100 * solve_gains.seam[0], 100 * solve_gains.seam[2], 100 * solve_gains.seam[1], 100 * solve_gains.seam[3]))
        except Exception:
            pass
        if log:
            log('exposición: campo de brillo por ángulo de visión (G): ' + ' '.join('%+.3f' % v for v in theta[:, 1]))
    else:
        lg = _cg_laplacian(ri, rj, w2, B, n)
        solve_gains.theta = np.zeros((5, 3), np.float32)
    # diagnóstico: ¿el grafo de fotos está conectado? (si no, cada grupo queda normalizado por su cuenta y aparecen saltos de brillo entre vuelos)
    par = list(range(n))
    def fd(x):
        while par[x] != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    for a_, b_ in zip(ri, rj):
        par[fd(int(a_))] = fd(int(b_))
    comp = {}
    for i_ in range(n):
        comp.setdefault(fd(i_), []).append(i_)
    if os.environ.get('AGRO_GAIN_DETREND', '1') != '0':
        lg = detrend_gains(lg, pos, list(comp.values()), log)
    G[:] = np.exp(np.clip(lg, -0.9, 0.9))
    solve_gains.diag = {'pares': m, 'componentes': len(comp), 'tam_componentes': sorted((len(v) for v in comp.values()), reverse=True)[:6],
                        'rango': [float(G.min()), float(G.max())], 'saturadas': int((np.abs(lg) > 0.9).any(1).sum())}
    return G


def _cg_laplacian(ri, rj, w2, B, n, anchor=0.02 ** 2, tol=1e-9, max_it=20000):
    """Resuelve (L + anchor·11ᵀ + 1e-9·I) X = B, con L el laplaciano del grafo de pares de fotos (pesos w2). Gradiente conjugado con
    precondicionador de Jacobi; el ancla deja la ganancia media en 1. Devuelve X (n×k)."""
    def mv(x):
        d = w2 * (x[ri] - x[rj])
        return np.bincount(ri, d, n) - np.bincount(rj, d, n) + anchor * x.sum() + 1e-9 * x
    dg = np.bincount(ri, w2, n) + np.bincount(rj, w2, n) + anchor + 1e-9
    X = np.zeros_like(B)
    for c in range(B.shape[1]):
        b = B[:, c]; x = np.zeros(n); r = b.copy(); z = r / dg; pv = z.copy(); rz = (r * z).sum(); nb = np.sqrt((b * b).sum()) + 1e-30
        for _ in range(max_it):
            if np.sqrt((r * r).sum()) / nb < tol:
                break
            Ap = mv(pv); al = rz / max((pv * Ap).sum(), 1e-300)
            x += al * pv; r -= al * Ap; z = r / dg
            rz2 = (r * z).sum(); pv = z + (rz2 / max(rz, 1e-300)) * pv; rz = rz2
        X[:, c] = x
    return X


# ----------------------------------------------------------------------------------------------- franjas

_PROG = None          # callable(franja, foto, total): avance dentro de una franja (lo fija el proceso principal o el inicializador del trabajador)


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
        wt = wt * np.clip((RMAX - r) / 0.06, 0, 1)
        # "el ganador se lleva casi todo": peso fuerte hacia el centro de cada foto (menos deformación y menos promedio de fotos desplazadas)
        wt = wt * (np.clip(1.0 - r / 0.95, 0.0, 1.0) ** CENTER_POW) + 1e-6 * (wt > 0)
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


def _make_tile(out_dir, z, tx, ty):
    cv = Image.new('RGBA', (2 * T, 2 * T), (0, 0, 0, 0)); any_ = False
    for dy in range(2):
        for dx in range(2):
            f = tile_path(out_dir, z + 1, 2 * tx + dx, 2 * ty + dy)
            if f:
                with Image.open(f) as im:
                    cv.paste(im.convert('RGBA'), (dx * T, dy * T))
                any_ = True
    if not any_:
        return
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


def build_pyramid(out_dir, top, nx, ny, progress=None, threads=1):
    """Niveles reducidos (cada mosaico = 4 del nivel inferior). Los mosaicos de un nivel son independientes: se reparten en hilos."""
    from concurrent.futures import ThreadPoolExecutor
    ex = ThreadPoolExecutor(max_workers=max(1, threads)) if threads > 1 else None
    try:
        for z in range(top - 1, -1, -1):
            zx, zy = (nx + 2 ** (top - z) - 1) // 2 ** (top - z), (ny + 2 ** (top - z) - 1) // 2 ** (top - z)
            for ty in range(zy):
                if progress:
                    progress(((top - 1 - z) + ty / max(1, zy)) / max(1, top))
                if ex:
                    list(ex.map(lambda tx: _make_tile(out_dir, z, tx, ty), range(zx)))
                else:
                    for tx in range(zx):
                        _make_tile(out_dir, z, tx, ty)
            if progress:
                progress((top - z) / max(1, top))
    finally:
        if ex:
            ex.shutdown(wait=True)



# ----------------------------------------------------------------------------------------------- armado por celdas
# Cada foto dibuja SOLO su zona (los píxeles que están más cerca de su centro que del de cualquier vecina) más un borde angosto de mezcla.
# Se decodifica una vez y se deforma una fracción de su superficie (con solape 80/70 % es ~6-10 %), en vez de recorrerla una vez por franja.
CELL = 16            # la zona de cada foto se calcula en una grilla 16 veces más gruesa (suave: no hace falta a 3 cm)
CELL_FW = 0.03       # semiancho de la mezcla entre zonas, en unidades de radio normalizado (~3 m a 3 cm/px): con las fotos alineadas (0,2 m) no hay fantasmas y se suaviza cualquier resto de brillo
STRIPE = 2048        # filas por cerrojo del lienzo
LEVEL_FW = 0.10      # semiancho (radio normalizado, ~10 m) de la mezcla ANCHA solo de tonos: nivela el brillo suave entre fotos sin mezclar el detalle
LOW_SIGMA = 6        # suavizado (px de miniatura = 16 px de foto, ~3 m) que separa el tono suave del detalle


def _rmap(p, E0, N1, g, c0, y0, nxc, nyc):
    """Radio normalizado (0 centro .. 1 esquina) de la foto p en una grilla gruesa de nyc×nxc celdas de CELL px, esquina (c0, y0) px de salida.
    Devuelve (r, ok): ok marca lo que la foto puede aportar (dentro del recorte y fuera de las esquinas oscuras)."""
    ps = math.radians(p['yaw']); cs, sn = math.cos(ps), math.sin(ps)
    gi = p['g']; w, h = p['w'], p['h']
    u = (np.arange(nxc, dtype=np.float32) + .5) * CELL + c0; v = (np.arange(nyc, dtype=np.float32) + .5) * CELL + y0
    dE = (E0 - p['e']) + g * u[None, :]; dN = (N1 - p['n']) - g * v[:, None]
    xi = w / 2 + (cs * dE - sn * dN) / gi; yi = h / 2 - (sn * dE + cs * dN) / gi
    r = np.hypot((xi - w / 2) / (w / 2), (yi - h / 2) / (h / 2)) * (1 / math.sqrt(2))
    dmin = np.minimum(np.minimum(xi, w - xi), np.minimum(yi, h - yi)) / min(w, h)
    ok = (dmin > CROP) & (r < RMAX)
    return r.astype(np.float32), ok, xi.astype(np.float32), yi.astype(np.float32)


def _up(a, sw, sh):
    """Amplía un mapa float32 grueso a sw×sh px (los centros de celda coinciden con los de píxel)."""
    return np.asarray(Image.fromarray(np.ascontiguousarray(a, np.float32), 'F').resize((sw, sh), Image.BILINEAR), np.float32)


def _low_log(p, gain, prof, rbins):
    """Log del tono suave de la foto (miniatura corregida por viñeteo y ganancia, suavizada ~3 m)."""
    a, _ = thumb(p['path'])
    hh, ww = a.shape[:2]
    yy, xx = np.mgrid[0:hh, 0:ww]
    r = np.hypot((xx + .5 - ww / 2) / (ww / 2), (yy + .5 - hh / 2) / (hh / 2)) / math.sqrt(2)
    a = a * vignette_gain(np.clip(r, 0, 1), prof, rbins) * gain
    inside = r < RMAX
    a[~inside] = a[inside].mean(0)                                           # las esquinas oscuras no contaminan el suavizado
    sm = np.asarray(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(LOW_SIGMA)), np.float32)
    return np.log(np.maximum(sm, 4.0))


def _bilin(a, x, y):
    h, w = a.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001); y = np.clip(y - 0.5, 0, h - 1.001)
    x0, y0 = x.astype(np.int32), y.astype(np.int32); fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    return a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy) + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy


def render_cells(P, gains, grid, prof, rbins, out_dir, top, quality, nx, ny, nthreads, prog, chk, L, stall_s, theta=None):
    """Arma el mosaico a resolución original en un lienzo en disco y lo corta en mosaicos. Devuelve la cantidad de mosaicos escritos.
    Fase 1: cada foto calcula su zona y su tono suave; se arma un mosaico de tonos (grueso, mezcla ancha).
    Fase 2: cada foto dibuja su zona con el tono llevado a ese mosaico de tonos (sin recuadros) y su detalle original."""
    import threading
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
    E0, N1, g, W, H = grid['E0'], grid['N1'], grid['g'], grid['W'], grid['H']
    need = 4.0 * W * H
    free = shutil.disk_usage(out_dir).free
    if free < need * 1.15 + 2e9:
        raise OSError('Falta espacio en disco para el lienzo de trabajo: hacen falta %.1f GB y hay %.1f GB libres' % (need / 1e9, free / 1e9))
    cpath, apath = os.path.join(out_dir, 'lienzo.bin'), os.path.join(out_dir, 'lienzo_a.bin')
    C = np.memmap(cpath, np.uint8, 'w+', shape=(H, W, 3)); A = np.memmap(apath, np.uint8, 'w+', shape=(H, W))
    n = len(P)
    pos = np.array([[p['e'], p['n']] for p in P])
    reach = np.array([math.hypot(p['w'], p['h']) / 2 * p['g'] for p in P])
    locks = [threading.Lock() for _ in range((H + STRIPE - 1) // STRIPE)]
    stop = threading.Event()
    done = [0]; last_news = [time.time()]; dl = threading.Lock()
    tacc = {'zona': 0.0, 'lectura': 0.0, 'mezcla': 0.0, 'espera': 0.0, 'mosaicos': 0.0, 'mp': 0.0}
    Hc, Wc = H // CELL + 3, W // CELL + 3
    tone = np.zeros((Hc, Wc, 3), np.float32); tw = np.zeros((Hc, Wc), np.float32); tlock = threading.Lock()
    info = [None] * n

    def neighbors(i):
        d = np.hypot(pos[:, 0] - pos[i, 0], pos[:, 1] - pos[i, 1])
        idx = [j for j in np.argsort(d)[1:25] if d[j] < reach[i] + reach[j]]
        return idx[:14]

    def prep(i):
        """Fase 1: zona de la foto (peso fino), peso ancho para el tono y tono suave de la foto sobre la grilla gruesa común."""
        if stop.is_set():
            raise RuntimeError('Cancelado')
        t_a = time.perf_counter()
        p = P[i]
        fp = footprint(p, 1.0)
        es = [(q[0] - E0) / g for q in fp]; ns = [(N1 - q[1]) / g for q in fp]
        c0, c1 = int(max(0, math.floor(min(es)))), int(min(W, math.ceil(max(es))))
        y0, y1 = int(max(0, math.floor(min(ns)))), int(min(H, math.ceil(max(ns))))
        if c1 <= c0 or y1 <= y0:
            return
        c0, y0 = (c0 // CELL) * CELL, (y0 // CELL) * CELL                   # alineado a la grilla gruesa común
        nxc, nyc = (c1 - c0 + CELL - 1) // CELL, (y1 - y0 + CELL - 1) // CELL
        r_i, ok_i, xi_, yi_ = _rmap(p, E0, N1, g, c0, y0, nxc, nyc)
        rmin = np.full(r_i.shape, 9.0, np.float32)
        for j in neighbors(i):
            rj, okj, _, _ = _rmap(P[j], E0, N1, g, c0, y0, nxc, nyc)
            np.minimum(rmin, np.where(okj, rj, 9.0), out=rmin)
        dlt = rmin - r_i
        w = np.clip(0.5 + dlt / (2 * CELL_FW), 0.0, 1.0) * ok_i
        wl = np.clip(0.5 + dlt / (2 * LEVEL_FW), 0.0, 1.0) * ok_i
        ys, xs = np.where(wl > 0.002)
        if len(ys) == 0:
            return
        ia, ib = max(0, ys.min() - 1), min(nyc, ys.max() + 2)
        ja, jb = max(0, xs.min() - 1), min(nxc, xs.max() + 2)
        sl = (slice(ia, ib), slice(ja, jb))
        wl_s = wl[sl]; w_s = w[sl]; rr = np.clip(r_i[sl], 0, 1)
        lowt = _low_log(p, gains[i], prof, rbins)
        sx, sy = p['w'] / lowt.shape[1], p['h'] / lowt.shape[0]
        low = _bilin(lowt, xi_[sl] / sx, yi_[sl] / sy).astype(np.float32)
        gy0, gx0 = y0 // CELL + ia, c0 // CELL + ja
        with tlock:
            tone[gy0:gy0 + (ib - ia), gx0:gx0 + (jb - ja)] += low * wl_s[..., None]
            tw[gy0:gy0 + (ib - ia), gx0:gx0 + (jb - ja)] += wl_s
        info[i] = (gy0, gx0, c0 + ja * CELL, y0 + ia * CELL, w_s, rr, low)
        with dl:
            tacc['zona'] += time.perf_counter() - t_a

    def paint(i):
        """Fase 2: deforma la foto una vez y la escribe en su zona con el tono nivelado."""
        if stop.is_set():
            raise RuntimeError('Cancelado')
        if info[i] is None:
            return
        t_a = time.perf_counter()
        p = P[i]
        gy0, gx0, cf, yf, w, rr, low = info[i]
        info[i] = None
        h_, w_ = w.shape
        den = tw[gy0:gy0 + h_, gx0:gx0 + w_]
        delta = np.where((den[..., None] > 1e-3) & (os.environ.get('AGRO_LEVEL', '1') != '0'), tone[gy0:gy0 + h_, gx0:gx0 + w_] / np.maximum(den, 1e-6)[..., None] - low, 0.0)
        with dl:
            tacc['d'] = tacc.get('d', 0.0) + float(np.abs(delta[w > 0.5]).mean()) if (w > 0.5).any() else tacc.get('d', 0.0)
        gv = vignette_gain(rr, prof, rbins) * gains[i] * np.exp(np.clip(delta, -0.2, 0.2))      # (filas, cols, 3) en la grilla gruesa
        sw, sh = w_ * CELL, h_ * CELL
        wup = _up(w, sw, sh)
        BL = 512                                                             # se procesan solo los bloques donde la foto aporta
        blocks = []
        for by in range(0, sh, BL):
            for bx in range(0, sw, BL):
                if wup[by:by + BL, bx:bx + BL].max() > 0.004:
                    blocks.append((by, bx))
        if not blocks:
            return
        t_b = time.perf_counter()
        res = []
        with Image.open(p['path']) as im:
            if im.mode != 'RGB':
                im = im.convert('RGB')
            im.load()
            for by, bx in blocks:
                bh, bw = min(BL, sh - by), min(BL, sw - bx)
                a, b, c, d, e, f = photo_matrix(p, E0 + (cf + bx) * g, N1 - (yf + by) * g, g)
                blk = np.asarray(im.transform((bw, bh), Image.AFFINE, (a, b, c, d, e, f), Image.BICUBIC), np.float32)
                i0, j0 = by // CELL, bx // CELL                              # ganancia por canal: ventana gruesa con 1 celda de margen
                ia_, ja_ = max(0, i0 - 1), max(0, j0 - 1); ib_, jb_ = min(gv.shape[0], i0 + bh // CELL + 2), min(gv.shape[1], j0 + bw // CELL + 2)
                for ch in range(3):
                    up = _up(gv[ia_:ib_, ja_:jb_, ch], (jb_ - ja_) * CELL, (ib_ - ia_) * CELL)
                    blk[..., ch] *= up[(i0 - ia_) * CELL:(i0 - ia_) * CELL + bh, (j0 - ja_) * CELL:(j0 - ja_) * CELL + bw]
                np.clip(blk, 0, 255, out=blk); blk += 0.5
                res.append((by, bx, bh, bw, blk.astype(np.uint8)))
        t_c = time.perf_counter()
        with dl:
            tacc['mp'] += sum(r_[2] * r_[3] for r_ in res) / 1e6
        spans = []
        for by, bx, bh, bw, _ in res:
            ya_, yb_ = max(0, yf + by), min(H, yf + by + bh)
            if yb_ > ya_:
                spans.append((ya_ // STRIPE, (yb_ - 1) // STRIPE))
        if not spans:
            return
        s0, s1 = min(x[0] for x in spans), max(x[1] for x in spans)
        t_d = time.perf_counter()
        for s_ in range(s0, s1 + 1):
            locks[s_].acquire()
        t_e = time.perf_counter()
        try:
            for by, bx, bh, bw, new in res:
                xa, xb, ya, yb = max(0, cf + bx), min(W, cf + bx + bw), max(0, yf + by), min(H, yf + by + bh)
                if xb <= xa or yb <= ya:
                    continue
                ox, oy = xa - (cf + bx), ya - (yf + by)
                new = new[oy:oy + yb - ya, ox:ox + xb - xa]
                wv = wup[by + oy:by + oy + yb - ya, bx + ox:bx + ox + xb - xa]
                Cv, Av = C[ya:yb, xa:xb], A[ya:yb, xa:xb]
                m = wv > 0.004
                fresh = m & (Av == 0)
                if fresh.any():
                    Cv[fresh] = new[fresh]; Av[fresh] = (wv[fresh] * 255 + 0.5).astype(np.uint8)
                mix = m & ~fresh
                if mix.any():                                                # borde entre zonas: promedio corrido ponderado
                    wa = Av[mix].astype(np.float32) / 255.0; ww = wv[mix]; tot = wa + ww
                    old = Cv[mix].astype(np.float32)
                    Cv[mix] = (old + (new[mix].astype(np.float32) - old) * (ww / tot)[:, None] + 0.5).astype(np.uint8)
                    Av[mix] = (np.minimum(1.0, tot) * 255 + 0.5).astype(np.uint8)
        finally:
            for s_ in range(s1, s0 - 1, -1):
                locks[s_].release()
        t_f = time.perf_counter()
        with dl:
            tacc['lectura'] += t_c - t_b; tacc['espera'] += t_e - t_d; tacc['mezcla'] += t_f - t_e; tacc['zona'] += t_b - t_a

    def run_phase(fn, p0, p1, label):
        done[0] = 0; last_news[0] = time.time()
        def task(i):
            fn(i)
            with dl:
                done[0] += 1; last_news[0] = time.time()
        ex = ThreadPoolExecutor(max_workers=nthreads)
        try:
            pend = set(ex.submit(task, i) for i in range(n)); marks = 0
            while pend:
                dn, pend = wait(pend, timeout=0.5, return_when=FIRST_COMPLETED)
                for f_ in dn:
                    f_.result()
                prog(p0 + (p1 - p0) * done[0] / n, '%s · foto %d/%d · %d hilos' % (label, done[0], n, nthreads))
                if done[0] * 4 // n != marks:
                    marks = done[0] * 4 // n; L('mosaico: %s %d de %d fotos' % (label, done[0], n))
                if time.time() - last_news[0] > stall_s:
                    raise RuntimeError('El armado del mosaico no avanza hace %d s (%d de %d fotos). Mirá el registro (motor.log).' % (int(time.time() - last_news[0]), done[0], n))
                chk()
        except BaseException:
            stop.set(); raise
        finally:
            ex.shutdown(wait=True, cancel_futures=True)

    L('mosaico (celdas): %d fotos · lienzo de trabajo %.1f GB en disco · %d hilos' % (n, need / 1e9, nthreads))
    try:
        run_phase(prep, 0.12, 0.28, 'Preparando zonas y tonos')
        L('mosaico: tonos nivelados entre fotos (mezcla ancha de %.0f m, detalle sin mezclar)' % (2 * LEVEL_FW * 99 * g / 0.03))
        run_phase(paint, 0.28, 0.82, 'Armando mosaico')
    except BaseException:
        del C, A
        for pth in (cpath, apath):
            try: os.remove(pth)
            except OSError: pass
        raise
    L('mosaico (celdas): tiempo de CPU por etapa (suma de hilos): zonas %.0f s · decodificar+deformar %.0f s · espera de cerrojo %.0f s · mezcla %.0f s · %.1f MP por foto · ajuste de tono medio %.1f %%'
      % (tacc['zona'], tacc['lectura'], tacc['espera'], tacc['mezcla'], tacc['mp'] / max(1, n), 100 * tacc.get('d', 0.0) / max(1, n)))
    # --- cortar el lienzo en mosaicos
    T_ = T
    rows_done = [0]; ntiles = [0]; tl = threading.Lock()

    def tile_row(ty):
        if stop.is_set():
            raise RuntimeError('Cancelado')
        y_a, y_b = ty * T_, min(H, (ty + 1) * T_)
        cnt = 0
        for tx in range(nx):
            x_a, x_b = tx * T_, min(W, (tx + 1) * T_)
            okv = A[y_a:y_b, x_a:x_b] > 0
            if not okv.any():
                continue
            d = os.path.join(out_dir, 'tiles', str(top), str(tx)); os.makedirs(d, exist_ok=True)
            if okv.all() and (y_b - y_a) == T_ and (x_b - x_a) == T_:
                Image.fromarray(np.ascontiguousarray(C[y_a:y_b, x_a:x_b])).save(os.path.join(d, '%d.jpg' % ty), 'JPEG', quality=quality, subsampling=0)
            else:
                tile = np.zeros((T_, T_, 4), np.uint8)
                tile[:y_b - y_a, :x_b - x_a, :3] = C[y_a:y_b, x_a:x_b]
                tile[:y_b - y_a, :x_b - x_a, 3] = np.where(okv, 255, 0)
                if okv.all():
                    pass
                Image.fromarray(tile, 'RGBA').save(os.path.join(d, '%d.png' % ty), 'PNG', compress_level=3)
            cnt += 1
        with tl:
            rows_done[0] += 1; ntiles[0] += cnt

    ex = ThreadPoolExecutor(max_workers=nthreads)
    try:
        futs = [ex.submit(tile_row, ty) for ty in range(ny)]
        pend = set(futs)
        while pend:
            dn, pend = wait(pend, timeout=0.5, return_when=FIRST_COMPLETED)
            for f_ in dn:
                f_.result()
            prog(0.82 + 0.08 * rows_done[0] / max(1, ny), 'Guardando mosaicos · fila %d/%d' % (rows_done[0], ny))
            chk()
    except BaseException:
        stop.set(); raise
    finally:
        ex.shutdown(wait=True, cancel_futures=True)
        del C, A
        for pth in (cpath, apath):
            try: os.remove(pth)
            except OSError: pass
    return ntiles[0]


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


def resource_plan(resources=None, workers=None):
    """Hilos de trabajo según el porcentaje de recursos que el usuario le deja al programa (30-90 %, 80 % por defecto) y la RAM libre."""
    try:
        pct = float(resources if resources not in (None, '', 0) else (os.environ.get('AGRO_RESOURCE_PCT') or 80))
    except (TypeError, ValueError):
        pct = 80.0
    pct = max(30.0, min(90.0, pct))
    cpu = os.cpu_count() or 2
    n = int(workers) if workers else max(1, int(round(cpu * pct / 100.0)))
    ram_cap = max(1, int(pct / 100.0 * total_ram() // 0.5e9))             # ~0,5 GB por hilo
    return pct, cpu, max(1, min(n, ram_cap, cpu))


def build_mosaic(files, out_dir, res_m=None, quality=92, workers=None, progress=None, cancel=None, max_photos=None, log=None, stall_s=None, resources=None):
    """files: rutas de fotos RGB. res_m: tamaño de píxel de salida en metros (None = el de las fotos).
    progress(pct, msg) se llama seguido (por foto); log(msg) deja constancia con hora; si el armado no avanza durante
    stall_s segundos (300 por defecto) se corta con un error claro en vez de quedar colgado."""
    import queue as _queue
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

    pct_res, cpu, nwc = resource_plan(resources, workers)
    try:                                                             # prioridad algo menor: con muchos hilos la interfaz y el resto de la PC siguen fluidos
        if os.name == 'nt':
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    except Exception:
        pass
    L('mosaico: recursos %d %% -> %d hilos de trabajo de %d' % (pct_res, nwc, cpu))
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
    # --- alineación por imagen: corrige posición y escala (altura) midiendo el contenido real de las fotos vecinas
    al = {}
    if os.environ.get('AGRO_ALIGN', '1') != '0' and len(P) >= 12:
        ts = time.time()
        def atick(i, n):
            chk(); prog(0.0 + 0.03 * (i / max(1, n) if n > 1 else i), 'Alineando fotos entre sí por puntos de imagen…' if n <= 1 else 'Alineando fotos entre sí · par %d/%d' % (i, n))
        try:
            import photo_align
            cn = lambda: bool(cancel and cancel())
            al = None
            try:                                   # 1) puntos de imagen (SIFT) + ajuste por foto: posición, giro y escala
                import photo_match
                if os.environ.get('AGRO_MATCH', '1') != '0' and photo_match.available():
                    al = photo_match.align(P, photo_align.gray_thumb, log=L, tick=lambda a, b: atick(a, b), threads=nwc, cancel=cn)
                    if al: al['metodo'] = 'puntos'
            except RuntimeError:
                raise
            except Exception as e:
                L('alineación por puntos: error (%s: %s); se usa la correlación de fase' % (type(e).__name__, e)); al = None
            if not al:                             # 2) respaldo: correlación de fase entre vecinas
                al = photo_align.align(P, log=L, tick=atick, threads=nwc, cancel=cn)
        except RuntimeError:
            raise
        except Exception as e:
            L('alineación: omitida por error (%s: %s); se usa el GPS tal cual' % (type(e).__name__, e))
        finally:
            try: photo_align.drop_thumbs()
            except Exception: pass
        tm['alineación'] = round(time.time() - ts, 1)
    g = res_m or float(np.median([q['g'] for q in P]))
    corners = [c for q in P for c in footprint(q, 1.0)]
    E0 = min(c[0] for c in corners); Emax = max(c[0] for c in corners)
    N1 = max(c[1] for c in corners); Nmin = min(c[1] for c in corners)
    W, H = int(math.ceil((Emax - E0) / g)), int(math.ceil((N1 - Nmin) / g))
    nx, ny = (W + T - 1) // T, (H + T - 1) // T
    top = max(0, int(math.ceil(math.log2(max(1, max(nx, ny))))))
    levels = top + 1
    tm['lectura'] = round(time.time() - t0, 1)
    area_ha = (Emax - E0) * (N1 - Nmin) / 1e4
    L('mosaico: extensión %.0f × %.0f m (%.0f ha de caja) · %d×%d px · %d×%d mosaicos' % (Emax - E0, N1 - Nmin, area_ha, W, H, nx, ny))
    if W * H > float(os.environ.get('AGRO_MAX_PIXELS') or 4e10):
        # Un lote real de 400-1000 ha son 5-11 mil millones de px. Más que esto casi siempre son fotos con GPS erróneo o de otro vuelo/lote.
        me, mn = float(np.median([q['e'] for q in P])), float(np.median([q['n'] for q in P]))
        far = sorted(P, key=lambda q: -math.hypot(q['e'] - me, q['n'] - mn))[:3]
        raise RuntimeError('Las fotos cubren una zona de %.1f × %.1f km (%.0f ha): demasiado para un solo lote. Probablemente haya fotos de otro vuelo o con GPS erróneo '
                           '(por ejemplo %s, a %.1f km del centro). Dejá en la carpeta solo las fotos de un lote.'
                           % ((Emax - E0) / 1000, (N1 - Nmin) / 1000, area_ha, ', '.join(os.path.basename(q['path']) for q in far), math.hypot(far[0]['e'] - me, far[0]['n'] - mn) / 1000))
    L('mosaico: %d fotos con GPS · %d×%d px a %.2f cm/px · %d×%d mosaicos · %d niveles' % (len(P), W, H, g * 100, nx, ny, levels))

    # --- viñeteo
    ts = time.time()
    def vtick(i, n):
        chk()
        if i % 10 == 0:
            prog(0.02 + 0.06 * i / n, 'Corrigiendo viñeteo · foto %d/%d' % (i, n))
        if i % max(1, n // 5) == 0:
            L('viñeteo: foto %d de %d' % (i, n))
    rb, prof = vignette_profile(P, tick=vtick)
    tm['viñeteo'] = round(time.time() - ts, 1); L('mosaico: viñeteo listo en %.1f s' % tm['viñeteo'])

    # --- exposición entre fotos
    ts = time.time()
    def gtick(stage, i, n):
        chk()
        fr_ = {'miniaturas': 0.0 + 0.5 * i / n, 'pares': 0.5 + 0.45 * i / n, 'resolver': 0.95}[stage]
        txt = {'miniaturas': 'miniaturas %d/%d' % (i, n), 'pares': 'comparando fotos vecinas %d/%d' % (i, n), 'resolver': 'resolviendo ganancias'}[stage]
        if stage == 'resolver': L('mosaico: resolviendo ganancias de exposición')
        prog(0.08 + 0.04 * fr_, 'Igualando exposición entre fotos · ' + txt)
        if stage != 'resolver' and i and i % max(1, n // 4) == 0:
            L('exposición: %s' % txt)
    gains = solve_gains(P, fr, prof, rb, g, tick=gtick, log=L)
    try:
        L('exposición: %s' % json.dumps(solve_gains.diag))
    except Exception:
        pass
    tm['exposición'] = round(time.time() - ts, 1); L('mosaico: exposición lista en %.1f s' % tm['exposición'])

    shutil.rmtree(os.path.join(out_dir, 'tiles'), ignore_errors=True); os.makedirs(os.path.join(out_dir, 'tiles'), exist_ok=True)
    grid = {'E0': E0, 'N1': N1, 'g': g, 'W': W, 'H': H}

    # --- armado: por celdas (cada foto dibuja su zona) y, si no se puede (disco, memoria), por franjas
    ntiles, jobs, finished, nw, mode = None, [], {}, nwc, ''
    if os.environ.get('AGRO_RENDER', 'celdas') != 'bandas':
        ts = time.time()
        try:
            ntiles = render_cells(P, gains, grid, prof, rb, out_dir, top, quality, nx, ny, nwc, prog, chk, L, stall_s, theta=getattr(solve_gains, 'theta', None))
            tm['celdas'] = round(time.time() - ts, 1); L('mosaico: celdas listas en %.1f s (%d mosaicos)' % (tm['celdas'], ntiles))
        except (OSError, MemoryError) as e:
            L('mosaico: no se pudo armar por celdas (%s: %s) -> se arma por franjas' % (type(e).__name__, e))
            shutil.rmtree(os.path.join(out_dir, 'tiles'), ignore_errors=True); os.makedirs(os.path.join(out_dir, 'tiles'), exist_ok=True)
            ntiles = None
    if ntiles is None:
        # --- franjas: tamaño según el ancho (memoria por trabajador ≈ franja × ancho × 19 bytes) y cantidad de trabajadores según la RAM libre
        budget = float(os.environ.get('AGRO_BAND_BYTES') or 1.6e9)
        bandh = int(max(1, min(8, budget // (max(1, W) * 19.0 * T))))
        per_worker = bandh * T * W * 19.0 + 0.7e9
        cpu = os.cpu_count() or 2
        cap = 1 if cpu <= 1 else min(8, max(2, cpu - 1))
        ram_cap = max(1, int(0.65 * total_ram() // per_worker))
        nw = int(workers) if workers else max(1, min(cap, ram_cap))
        prog(0.12, 'Preparando franjas de trabajo…', True)
        bands = [(k, ty, min(ny, ty + bandh)) for k, ty in enumerate(range(0, ny, bandh))]
        sels = [[] for _ in bands]; sgs = [[] for _ in bands]
        band_rows = bandh * T * g                                 # alto de una franja en metros
        for i, p in enumerate(P):                                 # cada foto va solo a las franjas que toca (antes: franjas × fotos)
            ns_ = [c[1] for c in footprint(p, 1.0)]
            k0 = max(0, int((N1 - max(ns_) - 1) // band_rows)); k1 = min(len(bands) - 1, int((N1 - min(ns_) + 1) // band_rows))
            for k in range(k0, k1 + 1):
                sels[k].append(p); sgs[k].append(gains[i])
        jobs = [(k, ty0, ty1, sels[k], grid, prof, rb, sgs[k], out_dir, top, quality) for k, ty0, ty1 in bands if sels[k]]
        L('mosaico: %d franjas de %d fila(s) de mosaicos · %d trabajador(es) · %.1f GB por trabajador · RAM libre %.1f GB · %d fotos por franja (máx.)'
          % (len(jobs), bandh, nw, per_worker / 1e9, total_ram() / 1e9, max(len(j[3]) for j in jobs)))

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
                    L('franja %d/%d lista · %d fotos · %d mosaicos' % (len(finished), len(jobs), r[1], r[2]))
            finally:
                _PROG = None

        def run_threads(todo):
            """Franjas en hilos dentro del mismo proceso: sin arrancar procesos nuevos (en Windows, con el motor empaquetado, el arranque de
            los procesos trabajadores no daba señales). Decodificar JPEG, transformar y operar arrays grandes liberan el GIL: escala bien."""
            global _PROG
            import threading
            qin, qout, stop, news = _queue.Queue(), _queue.Queue(), threading.Event(), [time.time()]
            for j in todo:
                qin.put(j)

            def f(b, k, n):
                if stop.is_set():
                    raise RuntimeError('Cancelado')
                state[b] = (k, n); news[0] = time.time()

            def work():
                while not stop.is_set():
                    try:
                        j = qin.get_nowait()
                    except _queue.Empty:
                        return
                    try:
                        qout.put(('ok', render_band(j)))
                    except BaseException as e:
                        qout.put(('err', e)); return

            _PROG = f
            ths = [threading.Thread(target=work, daemon=True, name='franja-%d' % i) for i in range(nw)]
            for t in ths:
                t.start()
            L('mosaico: %d hilos de trabajo iniciados para %d franjas' % (nw, len(todo)))
            ndone, t_start = 0, time.time()
            try:
                while ndone < len(todo):
                    try:
                        kind, r = qout.get(timeout=0.5)
                    except _queue.Empty:
                        kind = None
                    if kind == 'ok':
                        finished[r[0]] = (r[1], r[2]); ndone += 1
                        L('franja %d/%d lista · %d fotos · %d mosaicos · %.0f s' % (ndone, len(todo), r[1], r[2], time.time() - t_start))
                    elif kind == 'err':
                        raise r
                    if not state and not finished:
                        prog(0.12, 'Armando mosaico · iniciando %d hilos de trabajo (%d s)' % (nw, int(time.time() - t_start)))
                    else:
                        report(' · %d hilos' % nw)
                    if time.time() - news[0] > stall_s:
                        raise RuntimeError('El armado del mosaico no avanza hace %d s (%d de %d franjas). Mirá el registro (motor.log).' % (int(time.time() - news[0]), ndone, len(todo)))
                    chk()
            finally:
                stop.set(); _PROG = None

        if nw <= 1:
            run_seq(jobs, ' · 1 hilo')
        else:
            try:
                run_threads(jobs)
            except MemoryError:                                      # sin memoria con varios hilos: se termina de a una franja
                L('mosaico: sin memoria con %d hilos -> se termina en un solo hilo' % nw)
                for b_ in list(state):
                    if b_ not in finished: state.pop(b_)
                run_seq([j for j in jobs if j[0] not in finished], ' · 1 hilo (sin memoria)')
        tm['franjas'] = round(time.time() - ts, 1); L('mosaico: franjas listas en %.1f s (%d mosaicos)' % (tm['franjas'], ntiles))

    # --- pirámide de vistas reducidas
    ts = time.time()
    prog(0.92, 'Generando vistas reducidas', True)
    lastp = [-1]
    def ptick(f):
        chk(); prog(0.92 + 0.07 * f, 'Generando vistas reducidas · %d%%' % int(f * 100))
        if int(f * 10) != lastp[0]:
            lastp[0] = int(f * 10); L('vistas reducidas: %d%%' % int(f * 100))
    build_pyramid(out_dir, top, nx, ny, ptick, threads=nw)
    tm['vistas'] = round(time.time() - ts, 1); L('mosaico: vistas reducidas listas en %.1f s' % tm['vistas'])
    hl = hull(corners)
    poly = [[(c[0] - E0) / g, (N1 - c[1]) / g] for c in hull([c for q in P for c in footprint(q, 0.96)])]
    meta = {'w': W, 'h': H, 'tile': T, 'levels': levels, 'mpp': g, 'E0': E0, 'N1': N1, 'lat0': fr.lat0, 'lon0': fr.lon0, 'exact': True, 'kx': fr.kx, 'ky': fr.ky,
            'photos': len(P), 'tiles': ntiles, 'poly_px': poly, 'cover_ha': 0, 'seconds': round(time.time() - t0, 1),
            'rtk': sum(1 for q in P if q.get('rtk') == 50), 'alt': float(np.median([q['alt'] or 0 for q in P])), 'quality': quality,
            'vignette': [float(prof[0, 1]), float(prof[-1, 1])], 'gain_range': [float(gains.min()), float(gains.max())],
            'workers': nw, 'bands': len(jobs), 'timings': tm, 'single_process_fallback': False, 'engine': 'celdas' if not jobs else 'hilos'}
    # superficie cubierta (unión aproximada: área de píxeles con peso) = tiles no vacíos × área de mosaico (cota superior); la exacta la da el motor de análisis
    meta['cover_ha'] = round(ntiles * (T * g) ** 2 / 1e4, 2)
    json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'))
    prog(1.0, 'Ortomosaico listo', True)
    return meta
