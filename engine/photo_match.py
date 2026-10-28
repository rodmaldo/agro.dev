"""agro.dev · alineación por puntos de imagen (SIFT) de las fotos, parecida a lo que hace la fotogrametría.

Cada foto aporta puntos característicos (esquinas, piedras, rastrojo). Entre fotos vecinas (también de pasadas distintas) se buscan los
mismos puntos y se verifican geométricamente (RANSAC con una semejanza). Con todas las coincidencias se resuelve, por mínimos cuadrados
robustos, una corrección POR FOTO: posición (E, N), giro (rumbo) y escala (altura). Así se arreglan los errores que el GPS no ve:
rumbo del gimbal distinto en cada foto y altura mal estimada, que desplazan los bordes de la foto varios metros.
Sin BLAS/LAPACK en la parte numérica (gradiente conjugado con bincount), por el cuelgue de LAPACK en el ejecutable congelado.
"""
import math, os, threading, time
import numpy as np

try:
    import cv2
except Exception:                      # el motor sigue funcionando (con la alineación por correlación) si no está OpenCV
    cv2 = None

DIV = 4
MAX_KP = 2500


def available():
    return cv2 is not None


def _to_enu(p, x, y, sc):
    """Píxeles de la miniatura (x, y) -> E, N en metros (con la pose actual de la foto p)."""
    ps = math.radians(p['yaw']); cs, sn = math.cos(ps), math.sin(ps)
    u = (x / sc - p['w'] / 2) * p['g']; v = -(y / sc - p['h'] / 2) * p['g']
    return p['e'] + cs * u + sn * v, p['n'] - sn * u + cs * v


def _features(p, gray_thumb):
    th, (w, h) = gray_thumb(p['path'], DIV)
    a = np.asarray(th)
    sc = a.shape[1] / float(w)
    cl = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(6, 6))
    a = cl.apply(a)
    sift = cv2.SIFT_create(nfeatures=MAX_KP, contrastThreshold=0.015, edgeThreshold=12)
    kp, de = sift.detectAndCompute(a, None)
    if de is None or len(kp) < 20:
        return None
    # descartar las esquinas oscuras del lente
    xy = np.array([k.pt for k in kp], np.float32)
    cx, cy = a.shape[1] / 2.0, a.shape[0] / 2.0
    r = np.hypot((xy[:, 0] - cx) / cx, (xy[:, 1] - cy) / cy)
    ok = r < 0.92
    xy, de = xy[ok], de[ok]
    if len(xy) < 20:
        return None
    return {'xy': xy, 'de': de.astype(np.float32), 'sc': sc}


def _match_pair(pi, pj, fi, fj, ratio=0.8, tol_m=0.6):
    """Coincidencias verificadas entre dos fotos: arrays de puntos (E, N) de i y de j (poses actuales) o None."""
    bf = cv2.BFMatcher(cv2.NORM_L2)
    m = bf.knnMatch(fi['de'], fj['de'], k=2)
    gi, gj = [], []
    for t in m:
        if len(t) == 2 and t[0].distance < ratio * t[1].distance:
            gi.append(t[0].queryIdx); gj.append(t[0].trainIdx)
    if len(gi) < 12:
        return None
    a = np.array([_to_enu(pi, x, y, fi['sc']) for x, y in fi['xy'][gi]], np.float64)
    b = np.array([_to_enu(pj, x, y, fj['sc']) for x, y in fj['xy'][gj]], np.float64)
    # semejanza (traslación + giro + escala) entre las dos nubes; la foto es casi nadir, el terreno casi plano
    M, inl = cv2.estimateAffinePartial2D(b.astype(np.float32), a.astype(np.float32), method=cv2.RANSAC, ransacReprojThreshold=tol_m, maxIters=2000, confidence=0.995)
    if M is None or inl is None or int(inl.sum()) < 12:
        return None
    s = math.hypot(M[0, 0], M[1, 0]); ang = math.degrees(math.atan2(M[1, 0], M[0, 0]))
    if not (0.9 < s < 1.1) or abs(ang) > 6.0:
        return None
    k = inl.ravel().astype(bool)
    pa, pb = a[k], b[k]
    # evitar que unas pocas coincidencias agrupadas dominen: limitar a 60 repartidas
    if len(pa) > 60:
        sel = np.linspace(0, len(pa) - 1, 60).astype(int); pa, pb = pa[sel], pb[sel]
    return pa, pb


def _pairs(P, k=8):
    pos = np.array([[p['e'], p['n']] for p in P])
    out = set()
    for i in range(len(P)):
        d = np.hypot(pos[:, 0] - pos[i, 0], pos[:, 1] - pos[i, 1])
        lim = 0.75 * min(P[i]['w'], P[i]['h']) * P[i]['g']          # solape mínimo ~25 %
        for j in np.argsort(d)[1:k + 1]:
            if d[j] < lim:
                out.add((min(i, int(j)), max(i, int(j))))
    return sorted(out)


def _solve(P, pairs, mats, L, iters=5, sig_t=0.5, sig_th=math.radians(8.0), sig_s=0.12, tol=0.35):
    """Incógnitas por foto (tE, tN, θ, s): X_i = c_i + t_i + (1+s_i)·R(θ_i)·(p − c_i). Linealizado. IRLS sobre las coincidencias."""
    n = len(P)
    ci = np.array([[p['e'], p['n']] for p in P])
    I, Jx, A, B = [], [], [], []
    for (i, j), (pa, pb) in zip(pairs, mats):
        m = len(pa)
        I.append(np.full(m, i)); Jx.append(np.full(m, j)); A.append(pa); B.append(pb)
    I = np.concatenate(I); Jx = np.concatenate(Jx); A = np.concatenate(A); B = np.concatenate(B)
    xa = A - ci[I]; xb = B - ci[Jx]                       # coordenadas locales
    ra = A - B                                            # residuo inicial (i menos j)
    m = len(I)
    w = np.ones(m)
    x = np.zeros((n, 4))
    pr = np.array([1 / sig_t ** 2, 1 / sig_t ** 2, 1 / sig_th ** 2, 1 / sig_s ** 2])

    def matvec(v):              # A v -> (m, 2)
        vi, vj = v[I], v[Jx]
        e = vi[:, 0] - vj[:, 0] + (-vi[:, 2] * xa[:, 1] + vj[:, 2] * xb[:, 1]) + (vi[:, 3] * xa[:, 0] - vj[:, 3] * xb[:, 0])
        nn = vi[:, 1] - vj[:, 1] + (vi[:, 2] * xa[:, 0] - vj[:, 2] * xb[:, 0]) + (vi[:, 3] * xa[:, 1] - vj[:, 3] * xb[:, 1])
        return e, nn

    def rmatvec(e, nn):         # Aᵀ r -> (n, 4)
        out = np.zeros((n, 4))
        out[:, 0] = np.bincount(I, e, n) - np.bincount(Jx, e, n)
        out[:, 1] = np.bincount(I, nn, n) - np.bincount(Jx, nn, n)
        out[:, 2] = np.bincount(I, -e * xa[:, 1] + nn * xa[:, 0], n) - np.bincount(Jx, -e * xb[:, 1] + nn * xb[:, 0], n)
        out[:, 3] = np.bincount(I, e * xa[:, 0] + nn * xa[:, 1], n) - np.bincount(Jx, e * xb[:, 0] + nn * xb[:, 1], n)
        return out

    for it in range(iters):
        # (AᵀWA + Λ) x = −AᵀW ra
        bE, bN = -w * ra[:, 0], -w * ra[:, 1]
        rhs = rmatvec(bE, bN)
        diag = np.zeros((n, 4))
        diag[:, 0] = np.bincount(I, w, n) + np.bincount(Jx, w, n)
        diag[:, 1] = diag[:, 0]
        diag[:, 2] = np.bincount(I, w * (xa ** 2).sum(1), n) + np.bincount(Jx, w * (xb ** 2).sum(1), n)
        diag[:, 3] = diag[:, 2]
        dg = diag + pr[None, :] + 1e-9

        def mv(v):
            e, nn = matvec(v)
            o = rmatvec(w * e, w * nn)
            return o + pr[None, :] * v
        xx = np.zeros((n, 4)); r = rhs.copy(); z = r / dg; pv = z.copy(); rz = (r * z).sum(); nb = math.sqrt((rhs * rhs).sum()) + 1e-30
        for _ in range(4000):
            if math.sqrt((r * r).sum()) / nb < 1e-9:
                break
            Ap = mv(pv); al = rz / max((pv * Ap).sum(), 1e-300)
            xx += al * pv; r -= al * Ap; z = r / dg
            rz2 = (r * z).sum(); pv = z + (rz2 / max(rz, 1e-300)) * pv; rz = rz2
        x = xx
        e, nn = matvec(x)
        res = np.hypot(ra[:, 0] + e, ra[:, 1] + nn)
        w = 1.0 / (1.0 + (res / tol) ** 2)
        w[res > 6 * tol + 1.0] = 0.0
    return x, res, w, (I, Jx)


def align(P, gray_thumb, log=None, tick=None, threads=4, cancel=None):
    """Corrige P (e, n, g, yaw) en el lugar. Devuelve estadísticas o None si no hubo suficientes coincidencias."""
    L = log or (lambda s: None)
    if cv2 is None:
        L('alineación por puntos: OpenCV no disponible')
        return None
    t0 = time.time(); n = len(P)
    feats = [None] * n; lock = threading.Lock(); cnt = [0]
    try:
        cv2.setNumThreads(1)
    except Exception:
        pass

    def fwork(idx):
        for i in idx:
            if cancel and cancel():
                return
            try:
                feats[i] = _features(P[i], gray_thumb)
            except Exception:
                feats[i] = None
            with lock:
                cnt[0] += 1
                if tick and cnt[0] % 20 == 0:
                    tick(0.5 * cnt[0] / n, 1.0)
    run(fwork, list(range(n)), threads)
    if cancel and cancel():
        raise RuntimeError('Cancelado')
    nf = sum(1 for f in feats if f is not None)
    L('alineación por puntos: %d de %d fotos con puntos característicos · %.1f s' % (nf, n, time.time() - t0))
    pairs = [(i, j) for i, j in _pairs(P) if feats[i] is not None and feats[j] is not None]
    res = [None] * len(pairs); cnt[0] = 0

    def mwork(idx):
        for k in idx:
            if cancel and cancel():
                return
            i, j = pairs[k]
            try:
                res[k] = _match_pair(P[i], P[j], feats[i], feats[j])
            except Exception:
                res[k] = None
            with lock:
                cnt[0] += 1
                if tick and cnt[0] % 40 == 0:
                    tick(0.5 + 0.5 * cnt[0] / max(1, len(pairs)), 1.0)
    run(mwork, list(range(len(pairs))), threads)
    if cancel and cancel():
        raise RuntimeError('Cancelado')
    ok = [(pr, r) for pr, r in zip(pairs, res) if r is not None]
    deg = np.zeros(n, int)
    for (i, j), _ in ok:
        deg[i] += 1; deg[j] += 1
    L('alineación por puntos: %d de %d pares verificados · %d fotos con ≥2 pares · %.1f s' % (len(ok), len(pairs), int((deg >= 2).sum()), time.time() - t0))
    if len(ok) < max(8, n // 2) or (deg >= 2).sum() < 0.6 * n:
        L('alineación por puntos: insuficiente, se usa la correlación de fase')
        return None
    pp = [pr for pr, _ in ok]; mm = [r for _, r in ok]
    x, resid, w, (I, Jx) = _solve(P, pp, mm, L)
    before = np.hypot(*(np.concatenate([a for a, _ in mm]) - np.concatenate([b for _, b in mm])).T)
    good = w > 0.2
    L('alineación por puntos: desfase mediano en coincidencias %.2f m -> %.2f m (p90 %.2f -> %.2f) · %d coincidencias' % (
        float(np.median(before)), float(np.median(resid[good])), float(np.percentile(before, 90)), float(np.percentile(resid[good], 90)), len(before)))
    # la solución es relativa: se fija el ancla quitando la traslación media (el lote no se corre en bloque)
    x[:, 0] -= float(x[deg > 0, 0].mean()); x[:, 1] -= float(x[deg > 0, 1].mean())
    for i, p in enumerate(P):
        if deg[i] == 0:
            continue
        te, tn, th, s = x[i]
        # X = c + t + (1+s)·R_ccw(θ)·x ;  yaw' = yaw − θ (el rumbo gira en sentido horario) ; GSD' = GSD·(1+s)
        p['e'] += float(te); p['n'] += float(tn)
        p['yaw'] = p['yaw'] - math.degrees(float(th)); p['g'] = p['g'] * (1.0 + float(s))
    st = {'pairs': len(ok), 'before_m': float(np.median(before)), 'after_m': float(np.median(resid[good])),
          'rot_deg': float(np.median(np.abs(np.degrees(x[:, 2])))), 'scale_pct': float(np.median(np.abs(x[:, 3])) * 100),
          'moved_m': float(np.median(np.hypot(x[:, 0], x[:, 1])))}
    L('alineación por puntos: corrección mediana por foto · posición %.2f m · giro %.2f° · escala %.2f %% · %.1f s' % (st['moved_m'], st['rot_deg'], st['scale_pct'], time.time() - t0))
    return st


def run(fn, items, threads):
    threads = max(1, int(threads)); step = (len(items) + threads - 1) // threads; th = []
    for t in range(threads):
        chunk = items[t * step:(t + 1) * step]
        if chunk:
            th.append(threading.Thread(target=fn, args=(chunk,), daemon=True)); th[-1].start()
    for t in th:
        t.join()
