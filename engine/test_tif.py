import sys, os, json, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from PIL import Image
import export_tif
from cells import TileReader
Image.MAX_IMAGE_PIXELS = None
d = sys.argv[1]; meta = json.load(open(os.path.join(d, 'meta.json')))
w, h = meta['w'], meta['h']; print('mosaico', w, h, 'niveles', meta['levels'])
cx, cy, r = w * .5, h * .5, min(w, h) * .3
poly = [[cx + r * np.cos(t), cy + r * np.sin(t)] for t in np.linspace(0, 2 * np.pi, 60, endpoint=False)]
for shift in (2, 3):
    out = os.path.join(tempfile.mkdtemp(), 't.tif'); prog = []
    res = export_tif.write(meta, d, out, poly, shift, progress=lambda p, m: prog.append(p))
    im = Image.open(out); a = np.asarray(im); tg = im.tag_v2
    print('shift', shift, im.size, im.mode, 'KB', res['bytes'] // 1024, 'pixel m', round(res['mpp'], 3))
    assert im.size == (res['w'], res['h']) and im.mode == 'RGBA'
    al = a[..., 3]; inside = (al > 0).mean(); print('  área válida %.2f (círculo ≈ %.2f de su caja)' % (inside, np.pi / 4)); assert 0 < inside <= np.pi / 4 + 0.01
    assert (a[al == 0][:, :3] == 0).all(), 'fuera del límite debe quedar vacío'
    sc, tp = tg[33550], tg[33922]; print('  escala', sc, 'tiepoint', tp[3:5], 'geokeys', tg[34735][:8])
    assert abs(sc[0] * 111320 * np.cos(np.radians(tp[4])) - res['mpp']) / res['mpp'] < 0.02 and abs(sc[1] * 111132.9 - res['mpp']) / res['mpp'] < 0.02
    assert 34735 in tg and tg[34735][-1] == 4326
    # compara contra los mosaicos: el centro de la imagen exportada debe ser igual a lo que hay en la pirámide
    z = meta['levels'] - 1 - shift; pl = export_tif.plan(meta, poly, shift)
    yy, xx = np.nonzero(al); k = len(yy) // 2; cy_, cx_ = int(yy[k]), int(xx[k]); y0_, x0_ = max(0, cy_ - 15), max(0, cx_ - 15)
    ref = TileReader(d).crop(z, pl['x0'] + x0_, pl['y0'] + y0_, pl['x0'] + x0_ + 30, pl['y0'] + y0_ + 30); got = a[y0_:y0_ + 30, x0_:x0_ + 30]
    both = (got[..., 3] > 0)
    assert both.any() and (got[both][:, :3] == ref[both][:, :3]).all(), 'los píxeles deben coincidir con la pirámide (sin pérdidas)'
print('plan', [(p['shift'], round(p['mpx'], 1)) for p in [dict(export_tif.plan(meta, poly, k), shift=k) for k in range(3)]])
print('OK GeoTIFF')
