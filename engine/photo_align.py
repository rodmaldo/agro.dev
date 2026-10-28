"""agro.dev · alineación por imagen de las fotos (corrige el GPS / la altura de metadatos).

Posicionar cada foto solo con su GPS deja errores de 1-3 m entre fotos vecinas (el instante del GPS no es el de la exposición y la
altura relativa de vuelo no es la altura sobre ESTE terreno: un 5 % de error de escala son 2 m a 35 m de distancia). Con píxeles de 3 cm
eso es un desfase de ~70 px: al mezclar fotos se promedian cosas desplazadas y el detalle se borra.

Se mide, para pares de fotos vecinas, el desplazamiento del contenido (correlación de fase sobre una ventana centrada entre ambas) y se
resuelve por mínimos cuadrados una corrección de posición por foto. Además, el error de escala de la altura aparece como una corrección
proporcional a la posición: se ajusta una escala por vuelo y se aplica a la altura (GSD) de sus fotos. Todo con numpy puro (FFT) y sin BLAS.
"""
import math, os, threading, time
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
G_REG = 0.12            # m/px de trabajo (miniaturas a 1/4 de la resolución de la foto)
HALF = 24.0             # semi-lado de la ventana de medición (m)
_TH = {}
_TH_LOCK = threading.Lock()


def gray_thumb(path, div=4):
    """Miniatura en gris (PIL 'L') a 1/div; la decodificación JPEG reducida la hace rápida. Se guarda en caché."""
    with _TH_LOCK:
        t = _TH.get(path)
    if t is not None:
        return t
    with Image.open(path) as im:
        size = im.size
        im.draft('L', (im.width // div, im.height // div))
        t = im.convert('L')
    t = (t, size)
    with _TH_LOCK:
        _TH[path] = t
    return t


def drop_thumbs():
    with _TH_LOCK:
        _TH.clear()


def _photo_matrix(p, E0, N1, g):
    ps = math.radians(p['yaw']); cs, sn = math.cos(ps), math.sin(ps)
    gi = p['g']; w, h = p['w'], p['h']
    ax, bx = g * cs / gi, g * sn / gi
    ay, by = -g * sn / gi, g * cs / gi
    dE0, dN0 = E0 - p['e'], N1 - p['n']
    cx = w / 2 + (cs * dE0 - sn * dN0) / gi
    cy = h / 2 - (sn * dE0 + cs * dN0) / gi
    return (ax, bx, cx, ay, by, cy)


def render_gray(p, E0, N1, n, g=G_REG):
    """Ventana n×n (g m/px, esquina noroeste E0,N1) de la foto p, en gris float32, desde su miniatura."""
    th, (w, h) = gray_thumb(p['path'])
    s = th.size[0] / float(w)
    a, b, c, d, e, f = _photo_matrix(p, E0, N1, g)
    blk = th.transform((n, n), Image.AFFINE, (a * s, b * s, c * s, d * s, e * s, f * s), Image.BILINEAR)
    return np.asarray(blk, np.float32)


def _highpass(x, r=8):
    """Resta de un promedio local (caja de lado 2r+1) por imagen integral: deja textura y quita brillo/viñeteo."""
    x = x - x.mean()
    h, w = x.shape
    ii = np.pad(x, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    yy, xx = np.arange(h), np.arange(w)
    y0, y1 = np.clip(yy - r, 0, h), np.clip(yy + r + 1, 0, h)
    x0, x1 = np.clip(xx - r, 0, w), np.clip(xx + r + 1, 0, w)
    sm = (ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]) / ((y1 - y0)[:, None] * (x1 - x0)[None, :])
    return x - sm


def phase_shift(a, b, max_shift_px):
    """Desplazamiento (dx, dy) en px del contenido de b respecto del de a, y confianza del pico (0..1)."""
    n = a.shape[0]
    win = np.outer(np.hanning(n), np.hanning(n)).astype(np.float32)
    A = np.fft.rfft2(_highpass(a) * win); B = np.fft.rfft2(_highpass(b) * win)
    R = np.conj(A) * B
    R /= np.abs(R) + 1e-9
    r = np.fft.irfft2(R, s=a.shape)
    # solo desplazamientos dentro del rango de búsqueda
    m = int(max_shift_px)
    rr = np.roll(np.roll(r, m, 0), m, 1)[:2 * m + 1, :2 * m + 1]
    iy, ix = np.unravel_index(int(rr.argmax()), rr.shape)
    pk = float(rr[iy, ix])
    # refinamiento sub-píxel (parábola en cada eje)
    def sub(v, i):
        if 0 < i < len(v) - 1:
            d = v[i - 1] - 2 * v[i] + v[i + 1]
            return i + (0.5 * (v[i - 1] - v[i + 1]) / d if abs(d) > 1e-12 else 0.0)
        return float(i)
    fy, fx = sub(rr[:, ix], iy), sub(rr[iy, :], ix)
    # confianza: pico frente al ruido de fondo
    bg = float(np.median(np.abs(rr))) + 1e-9
    return fx - m, fy - m, pk, pk / (6 * bg)


def measure_pair(pi, pj, half=HALF, g=G_REG, max_shift_m=6.0):
    """Desplazamiento (m, en E y N) del contenido de pj respecto del de pi y confianza. None si no hay suficiente solape."""
    ce, cn = (pi['e'] + pj['e']) / 2, (pi['n'] + pj['n']) / 2
    n = int(2 * half / g) // 2 * 2
    E0, N1 = ce - half, cn + half
    a, b = render_gray(pi, E0, N1, n, g), render_gray(pj, E0, N1, n, g)
    if (a < 4).mean() > 0.03 or (b < 4).mean() > 0.03:
        return None
    if a.std() < 1.5 or b.std() < 1.5:
        return None
    dx, dy, pk, snr = phase_shift(a, b, max_shift_m / g)
    return dx * g, -dy * g, pk, snr          # y de imagen crece hacia el sur


def neighbor_pairs(P, k=8, dmin=6.0):
    pos = np.array([[p['e'], p['n']] for p in P])
    pairs = set()
    for i in range(len(P)):
        d = np.hypot(pos[:, 0] - pos[i, 0], pos[:, 1] - pos[i, 1])
        lim = 0.62 * min(P[i]['w'], P[i]['h']) * P[i]['g']          # solape mínimo ~40 %
        for j in np.argsort(d)[1:k + 3]:
            if dmin < d[j] < lim and len(pairs) < 60 * len(P):
                pairs.add((min(i, int(j)), max(i, int(j))))
    return sorted(pairs)


def cg_laplacian(ri, rj, w2, B, n, anchor=0.02 ** 2, prior=0.03 ** 2, tol=1e-10, max_it=20000):
    """(L + prior·I + anchor·11ᵀ) X = B por gradiente conjugado con precondicionador de Jacobi, solo con bincount (sin BLAS/LAPACK)."""
    def mv(x):
        d = w2 * (x[ri] - x[rj])
        return np.bincount(ri, d, n) - np.bincount(rj, d, n) + anchor * x.sum() + prior * x + 1e-12 * x
    dg = np.bincount(ri, w2, n) + np.bincount(rj, w2, n) + anchor + prior + 1e-12
    X = np.zeros_like(B)
    for c in range(B.shape[1]):
        b = B[:, c]; x = np.zeros(n); r = b.copy(); z = r / dg; pv = z.copy(); rz = (r * z).sum(); nb = math.sqrt((b * b).sum()) + 1e-30
        for _ in range(max_it):
            if math.sqrt((r * r).sum()) / nb < tol:
                break
            Ap = mv(pv); al = rz / max((pv * Ap).sum(), 1e-300)
            x += al * pv; r -= al * Ap; z = r / dg
            rz2 = (r * z).sum(); pv = z + (rz2 / max(rz, 1e-300)) * pv; rz = rz2
        X[:, c] = x
    return X


def solve_offsets(n, pairs, meas, iters=4, tol_m=0.8):
    """meas[k] = (mx, my, w): desplazamiento del contenido de j respecto de i. Devuelve o (n×2): corrección a SUMAR a la posición de cada foto
    (o_j - o_i = -m). Reponderación robusta: los pares que no encajan con el resto pierden peso."""
    ri = np.array([pairs[k][0] for k in range(len(pairs))]); rj = np.array([pairs[k][1] for k in range(len(pairs))])
    m = np.array([[x[0], x[1]] for x in meas]); w = np.array([x[2] for x in meas], float)
    wr = w.copy(); o = np.zeros((n, 2))
    for it in range(iters):
        w2 = wr * wr
        B = np.zeros((n, 2))
        for c in range(2):
            v = -m[:, c] * w2                                      # o_j - o_i = -m
            B[:, c] = np.bincount(rj, v, n) - np.bincount(ri, v, n)
        o = cg_laplacian(ri, rj, w2, B, n)
        res = np.hypot(*(o[rj] - o[ri] + m).T)
        wr = w / (1.0 + (res / tol_m) ** 2)
        wr[res > 4 * tol_m + 1.0] = 0.0
    res = np.hypot(*(o[rj] - o[ri] + m).T)
    return o, res, wr


def fit_similarity(P, o, groups):
    """Por vuelo: o_i ≈ k·x_i + d·J·x_i (x = posición menos el centro, J = giro de 90°). k = error de escala de la altura, d = error de rumbo (rad)."""
    out = {}
    for gname, idx in groups.items():
        if len(idx) < 12:
            continue
        pe = np.array([P[i]['e'] for i in idx]); pn = np.array([P[i]['n'] for i in idx])
        xe, xn = pe - pe.mean(), pn - pn.mean()
        A = np.zeros((2 * len(idx), 2)); y = np.zeros(2 * len(idx))
        A[:len(idx), 0] = xe; A[:len(idx), 1] = -xn; y[:len(idx)] = o[idx, 0] - o[idx, 0].mean()
        A[len(idx):, 0] = xn; A[len(idx):, 1] = xe; y[len(idx):] = o[idx, 1] - o[idx, 1].mean()
        den = np.linalg.det(A.T @ A) if False else None
        ata = A.T @ A
        if ata[0, 0] * ata[1, 1] - ata[0, 1] ** 2 < 1e-6:
            continue
        k, d = np.linalg.solve(ata, A.T @ y)
        out[gname] = (float(k), float(d), float(pe.mean()), float(pn.mean()))
    return out


def _resid(P, pairs, idxs):
    r = []
    for k in idxs:
        i, j = pairs[k]
        try:
            m = measure_pair(P[i], P[j])
        except Exception:
            m = None
        if m is not None and m[2] >= 0.08 and m[3] >= 1.5:
            r.append(math.hypot(m[0], m[1]))
    return float(np.median(r)) if len(r) >= 6 else None


def align(P, log=None, tick=None, threads=4, cancel=None):
    """Corrige P (lista de fotos: e, n, g) en el lugar. Devuelve estadísticas para el registro."""
    L = log or (lambda m: None)
    t0 = time.time()
    n = len(P)
    pairs = neighbor_pairs(P)
    L('alineación: %d pares de fotos vecinas a medir (miniaturas a %.0f cm/px)' % (len(pairs), G_REG * 100))
    meas = [None] * len(pairs); done = [0]; lock = threading.Lock()

    def work(lo, hi):
        for k in range(lo, hi):
            if cancel and cancel():
                return
            i, j = pairs[k]
            try:
                r = measure_pair(P[i], P[j])
            except Exception:
                r = None
            meas[k] = r
            with lock:
                done[0] += 1
                if tick and done[0] % 25 == 0:
                    tick(done[0], len(pairs))

    th = []; step = (len(pairs) + threads - 1) // max(1, threads)
    for t in range(max(1, threads)):
        lo, hi = t * step, min(len(pairs), (t + 1) * step)
        if lo < hi:
            th.append(threading.Thread(target=work, args=(lo, hi), daemon=True)); th[-1].start()
    for t in th:
        t.join()
    if cancel and cancel():
        raise RuntimeError('Cancelado')
    good = [(k, r) for k, r in enumerate(meas) if r is not None and r[2] >= 0.08 and r[3] >= 1.5]
    L('alineación: %d de %d pares con coincidencia confiable · %.1f s' % (len(good), len(pairs), time.time() - t0))
    stats = {'pairs': len(pairs), 'good': len(good), 'k': {}, 'before_m': None, 'after_m': None, 'moved_m': 0.0}
    if len(good) < max(8, n // 3):
        L('alineación: muy pocas coincidencias (¿suelo sin textura?): se mantiene la posición del GPS')
        return stats
    pg = [pairs[k] for k, _ in good]
    ms = [(r[0], r[1], min(1.0, r[2] * 3.0)) for _, r in good]
    o, res, wr = solve_offsets(n, pg, ms)
    raw = np.hypot(*np.array([[m[0], m[1]] for m in ms]).T)
    stats['before_m'] = float(np.median(raw)); stats['after_m'] = float(np.median(res[wr > 0])) if (wr > 0).any() else None
    # escala y rumbo por vuelo (carpeta): la parte lineal de o. El signo del giro se decide midiendo de nuevo.
    groups = {}
    for i, p in enumerate(P):
        groups.setdefault(os.path.dirname(p['path']), []).append(i)
    fit = fit_similarity(P, o, groups)
    sample = [k for k, _ in good][::max(1, len(good) // 40)]
    base = [(p['e'], p['n'], p['g'], p['yaw']) for p in P]
    best = None
    for sgn in (1, -1):
        for i, p in enumerate(P):
            p['e'], p['n'], p['g'], p['yaw'] = base[i]
        oo = o.copy()
        for gname, (kk, dd, pe, pn) in fit.items():
            for i in groups[gname]:
                xe, xn = P[i]['e'] - pe, P[i]['n'] - pn
                oo[i, 0] -= kk * xe - dd * xn; oo[i, 1] -= kk * xn + dd * xe
                P[i]['g'] = base[i][2] * (1.0 - kk); P[i]['yaw'] = base[i][3] + sgn * math.degrees(dd)
        for i, p in enumerate(P):
            p['e'] = base[i][0] + float(oo[i, 0]); p['n'] = base[i][1] + float(oo[i, 1])
        drop_thumbs_cache = None
        r_ = _resid(P, pairs, sample)
        L('alineación: prueba de giro %+d -> desfase %s' % (sgn, ('%.2f m' % r_) if r_ is not None else 's/d'))
        if r_ is not None and (best is None or r_ < best[0]):
            best = (r_, sgn, oo.copy())
    if best is None or not fit:
        for i, p in enumerate(P):
            p['e'], p['n'], p['g'], p['yaw'] = base[i]
        oo = o.copy()
        for i, p in enumerate(P):
            p['e'] += float(oo[i, 0]); p['n'] += float(oo[i, 1])
    else:
        _, sgn, oo = best
        for i, p in enumerate(P):
            p['e'], p['n'], p['g'], p['yaw'] = base[i]
        for gname, (kk, dd, pe, pn) in fit.items():
            for i in groups[gname]:
                P[i]['g'] = base[i][2] * (1.0 - kk); P[i]['yaw'] = base[i][3] + sgn * math.degrees(dd)
        for i, p in enumerate(P):
            p['e'] = base[i][0] + float(oo[i, 0]); p['n'] = base[i][1] + float(oo[i, 1])
    for gname, (kk, dd, pe, pn) in fit.items():
        L('alineación: vuelo %s · escala de la altura %+.1f %% · rumbo %+.2f° (%d fotos)' % (os.path.basename(gname) or gname, kk * 100, math.degrees(dd), len(groups[gname])))
    stats['k'] = {os.path.basename(g_) or g_: [v[0], v[1]] for g_, v in fit.items()}
    oo = oo if best is not None else o
    mv = np.hypot(oo[:, 0], oo[:, 1])
    o = oo
    stats['moved_m'] = float(np.median(np.hypot(o[:, 0], o[:, 1])))
    L('alineación: desfase mediano entre vecinas %.2f m -> %s · corrección de posición mediana %.2f m · %.1f s'
      % (stats['before_m'], ('%.2f m' % stats['after_m']) if stats['after_m'] is not None else 's/d', stats['moved_m'], time.time() - t0))
    return stats
