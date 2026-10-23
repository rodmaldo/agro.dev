"""Verifica que las características por celda (cells.compute) coinciden con un cálculo de referencia (girar + reducir + promediar)."""
import os, sys, math, tempfile, json
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cells, mosaic_gps as M

def make_mosaic(img, d, g):
    h, w = img.shape[:2]; T = 512; nx, ny = (w + T - 1) // T, (h + T - 1) // T
    top = max(0, int(math.ceil(math.log2(max(nx, ny))))) if max(nx, ny) > 1 else 0
    for ty in range(ny):
        for tx in range(nx):
            a = np.zeros((T, T, 4), np.uint8); b = img[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T]
            a[:b.shape[0], :b.shape[1], :3] = b; a[:b.shape[0], :b.shape[1], 3] = 255
            dd = os.path.join(d, 'tiles', str(top), str(tx)); os.makedirs(dd, exist_ok=True)
            if b.shape[0] == T and b.shape[1] == T: Image.fromarray(a[..., :3]).save(os.path.join(dd, '%d.jpg' % ty), quality=100, subsampling=0)
            else: Image.fromarray(a, 'RGBA').save(os.path.join(dd, '%d.png' % ty))
    M.build_pyramid(d, top, nx, ny)
    return {'w': w, 'h': h, 'levels': top + 1, 'mpp': g}

def main():
    rng = np.random.default_rng(1)
    h, w, g = 3000, 4200, 0.03
    yy, xx = np.mgrid[0:h, 0:w]
    img = np.stack([60 + 90 * (xx / w), 120 + 60 * np.sin(yy / 300.0), 80 + 50 * (yy / h)], -1)
    img[900:1700, 1200:2400] = (215, 205, 180)                        # una "mancha" clara
    img = np.clip(img + rng.normal(0, 4, img.shape), 0, 255).astype(np.uint8)
    d = tempfile.mkdtemp(); meta = make_mosaic(img, d, g)
    mv = g * 4
    for theta, cell_m in [(0, 5.0), (25, 5.0), (-12, 2.0)]:
        t = math.radians(theta); co, si = abs(math.cos(t)), abs(math.sin(t))
        Wn, Hn = math.ceil(w * co + h * si), math.ceil(w * si + h * co)         # como rotateCanvas (px nativos)
        W, H = math.ceil(Wn * g / mv), math.ceil(Hn * g / mv)                    # marco de análisis virtual
        cs = cell_m / mv; gw, gh = math.ceil(W / cs), math.ceil(H / cs)
        res = cells.compute(d, meta, {'cs': cs, 'W': W, 'H': H, 'mpp_v': mv, 'theta': theta, 'gw': gw, 'gh': gh})
        # referencia: girar la imagen completa (mismo criterio que la interfaz: antihorario θ), reducir x4, promediar por celda
        ref = Image.fromarray(img).convert('RGBA').rotate(theta, expand=True, resample=Image.BILINEAR)
        ref = ref.resize((W, H), Image.BOX); ra = np.asarray(ref, np.float32)
        errs = []; cmp_n = 0
        for j in range(gh):
            for i in range(gw):
                x0, x1, y0, y1 = int(i * cs), min(W, int((i + 1) * cs)), int(j * cs), min(H, int((j + 1) * cs))
                blk = ra[y0:y1, x0:x1]; v = blk[..., 3] > 127
                if v.mean() < 0.9: continue
                k = j * gw + i
                if res['n'][k] == 0: errs.append(99); continue
                mean = np.array([res['sr'][k], res['sg'][k], res['sb'][k]]) / res['n'][k]
                errs.append(np.abs(mean - blk[v][:, :3].mean(0)).max()); cmp_n += 1
        errs = np.array(errs)
        print('θ=%5.1f° celda %.1f m · %dx%d celdas · comparadas %d · error medio %.2f · p95 %.2f · máx %.2f (niveles de 0-255) · muestras/celda %d² · nivel %d · cobertura %.1f ha'
              % (theta, cell_m, gw, gh, cmp_n, errs.mean(), np.percentile(errs, 95), errs.max(), res['samples'], res['level'], res['cover_ha']))
        assert cmp_n > 50 and np.percentile(errs, 95) < 4.0 and errs.max() < 12, 'las celdas no coinciden con la referencia'
        exp = w * h * g * g / 1e4
        assert abs(res['cover_ha'] - exp) / exp < 0.06, ('cobertura', res['cover_ha'], exp)
    print('OK')
main()
