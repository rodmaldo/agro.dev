"""agro.dev · características por celda de la grilla, calculadas sobre los píxeles del ortomosaico (no sobre una copia reducida).

La grilla vive en el "marco de análisis": el ortomosaico girado −θ (para alinear las celdas con los surcos/pasadas) y escalado a un
tamaño de píxel virtual `mpp_v`. Cada celda (i, j) cubre los píxeles de análisis [i·cs, (i+1)·cs) × [j·cs, (j+1)·cs).
Para cada celda se muestrea el mosaico original (girado) con ~16×16 muestras y se devuelven sumas de R, G, B y luminancia² sobre las
muestras válidas (con datos). La interfaz calcula a partir de esas sumas los mismos índices que antes (ExG, brillo, saturación, textura).
"""
import math, os, struct
from collections import OrderedDict
import numpy as np
from PIL import Image

T = 512


class TileReader:
    def __init__(self, d, cap=300):
        self.dir, self.cap, self.c = d, cap, OrderedDict()

    def get(self, z, x, y):
        k = (z, x, y)
        v = self.c.get(k)
        if v is not None:
            self.c.move_to_end(k); return v
        b = os.path.join(self.dir, 'tiles', str(z), str(x), str(y)); a = None
        for e in ('.jpg', '.png'):
            if os.path.exists(b + e):
                with Image.open(b + e) as im:
                    a = np.asarray(im.convert('RGBA'))
                break
        self.c[k] = a
        while len(self.c) > self.cap:
            self.c.popitem(last=False)
        return a

    def crop(self, z, x0, y0, x1, y1):
        """Rectángulo [x0,x1)×[y0,y1) en píxeles del nivel z, como RGBA (transparente donde no hay mosaico)."""
        out = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
        for ty in range(max(0, y0 // T), max(0, (y1 - 1) // T) + 1):
            for tx in range(max(0, x0 // T), max(0, (x1 - 1) // T) + 1):
                a = self.get(z, tx, ty)
                if a is None:
                    continue
                ax0, ay0 = max(x0, tx * T), max(y0, ty * T)
                ax1, ay1 = min(x1, (tx + 1) * T), min(y1, (ty + 1) * T)
                if ax1 > ax0 and ay1 > ay0:
                    out[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = a[ay0 - ty * T:ay1 - ty * T, ax0 - tx * T:ax1 - tx * T]
        return out


def compute(d, meta, spec, progress=None, cancel=None):
    """spec: cs, W, H (marco de análisis, px), mpp_v (m/px de análisis), theta (grados), gw, gh. Devuelve dict con arrays y área."""
    g = meta['mpp']; top = meta['levels'] - 1
    cs, W, H, mv, gw, gh = float(spec['cs']), float(spec['W']), float(spec['H']), float(spec['mpp_v']), int(spec['gw']), int(spec['gh'])
    th = math.radians(float(spec.get('theta', 0))); co, si = math.cos(th), math.sin(th)
    r = mv / g                                   # píxeles nativos por píxel de análisis
    cxn, cyn, cxa, cya = meta['w'] / 2, meta['h'] / 2, W / 2, H / 2
    cell_native = cs * r
    k = int(max(0, min(top, math.floor(math.log2(max(1.0, cell_native / 16.0))))))
    s = 2 ** k; z = top - k
    cell_lv = cell_native / s
    m = int(min(16, max(2, round(cell_lv))))
    step = cs / m                                # píxeles de análisis por muestra
    B = max(1, 1024 // m)                        # celdas por lado de bloque
    N = gw * gh
    n = np.zeros(N, np.uint32); sr = np.zeros(N, np.float32); sg = np.zeros(N, np.float32); sb = np.zeros(N, np.float32); sq = np.zeros(N, np.float32)
    rd = TileReader(d)
    tot_valid = 0
    nbx, nby = (gw + B - 1) // B, (gh + B - 1) // B
    for bj in range(nby):
        if cancel and cancel():
            raise RuntimeError('Cancelado')
        for bi in range(nbx):
            i0, j0 = bi * B, bj * B
            Cc, Rc = min(B, gw - i0), min(B, gh - j0)
            ow, oh = Cc * m, Rc * m
            A = r * co * step / s; Bc = -r * si * step / s; D = r * si * step / s; E = r * co * step / s
            C = (cxn + r * (co * (i0 * cs - cxa) - si * (j0 * cs - cya))) / s
            F = (cyn + r * (si * (i0 * cs - cxa) + co * (j0 * cs - cya))) / s
            xs = [C + A * u + Bc * v for u in (0, ow) for v in (0, oh)]; ys = [F + D * u + E * v for u in (0, ow) for v in (0, oh)]
            x0, x1 = int(math.floor(min(xs))) - 2, int(math.ceil(max(xs))) + 2
            y0, y1 = int(math.floor(min(ys))) - 2, int(math.ceil(max(ys))) + 2
            lw = int(math.ceil(meta['w'] / s)); lh = int(math.ceil(meta['h'] / s))
            if x1 <= 0 or y1 <= 0 or x0 >= lw or y0 >= lh:
                continue
            crop = rd.crop(z, x0, y0, x1, y1)
            if not crop[..., 3].any():
                continue
            im = Image.fromarray(crop, 'RGBA')
            blk = np.asarray(im.transform((ow, oh), Image.AFFINE, (A, Bc, C - x0, D, E, F - y0), Image.BILINEAR), np.float32)
            valid = blk[..., 3] > 127
            rgb = blk[..., :3] * valid[..., None]
            lum = rgb.sum(-1) / 765.0
            def red(a):
                return a.reshape(Rc, m, Cc, m).sum((1, 3))
            cnt = red(valid.astype(np.float32))
            ax = i0 * cs + (np.arange(ow) + 0.5) * step; ay = j0 * cs + (np.arange(oh) + 0.5) * step
            inf = ((ay[:, None] < H) & (ax[None, :] < W)).astype(np.float32)        # muestras dentro del marco de análisis
            cin = red(inf)
            okc = (cin > 0) & (cnt >= 0.5 * cin)
            idx = ((j0 + np.arange(Rc))[:, None] * gw + (i0 + np.arange(Cc))[None, :])
            sel = okc
            n[idx[sel]] = cnt[sel].astype(np.uint32)
            sr[idx[sel]] = red(rgb[..., 0])[sel]; sg[idx[sel]] = red(rgb[..., 1])[sel]; sb[idx[sel]] = red(rgb[..., 2])[sel]; sq[idx[sel]] = red(lum * lum)[sel]
            tot_valid += float(cnt[sel].sum())
        if progress:
            progress((bj + 1) / nby, 'Analizando celdas %d/%d' % (bj + 1, nby))
    cover_ha = tot_valid * (step * mv) ** 2 / 1e4
    return {'gw': gw, 'gh': gh, 'n': n, 'sr': sr, 'sg': sg, 'sb': sb, 'sq': sq, 'cover_ha': cover_ha, 'level': z, 'samples': m}


def pack(res):
    head = b'AZC1' + struct.pack('<IId', res['gw'], res['gh'], res['cover_ha'])
    return head + res['n'].tobytes() + res['sr'].tobytes() + res['sg'].tobytes() + res['sb'].tobytes() + res['sq'].tobytes()
