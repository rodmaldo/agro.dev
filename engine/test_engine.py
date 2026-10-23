"""Pruebas del motor: python engine/test_engine.py [carpeta_con_fotos_geoetiquetadas] [ortomosaico.png]"""
import json, os, subprocess, sys, urllib.request, io, tempfile
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import agro_engine as E

class Eng:
    def __init__(self):
        self.p = subprocess.Popen([sys.executable, os.path.join(HERE, 'agro_engine.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.n = 0
    def call(self, cmd, **args):
        self.n += 1
        self.p.stdin.write(json.dumps({'id': self.n, 'cmd': cmd, 'args': args}) + '\n'); self.p.stdin.flush()
        prog = []
        while True:
            m = json.loads(self.p.stdout.readline())
            if m['id'] != self.n: continue
            if m['type'] == 'progress': prog.append(m['pct'])
            elif m['type'] == 'result': return m['data'], prog
            elif m['type'] == 'error': raise RuntimeError(m['error'])
    def close(self): self.p.stdin.close(); self.p.wait(timeout=10)

def main():
    flight = sys.argv[1] if len(sys.argv) > 1 else None
    png = sys.argv[2] if len(sys.argv) > 2 else None
    e = Eng()
    d, _ = e.call('ping'); print('ping', d)
    # --- args de ODM
    a = E.odm_args('balanced', 3.0, 300); assert '--fast-orthophoto' in a and '--split' not in a
    b = E.odm_args('max', 2.7, 2400, cpu=6); assert '--split' in b and b[b.index('--max-concurrency') + 1] == '6'
    print('odm balanced:', ' '.join(a)); print('odm max 2400 fotos:', ' '.join(b))
    # --- scan
    if flight:
        d, pr = e.call('scan', folders=[flight]); print('scan', {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items() if k not in ('folders', 'files', 'by_dir')})
        assert d['rgb'] > 0 and d['geotagged'] == d['rgb']
    # --- ortho sin docker -> error claro
    try:
        e.call('ortho', folders=[flight or '.'], out=tempfile.mkdtemp()); print('ortho: (hay docker)')
    except RuntimeError as ex: print('ortho sin docker/fotos ->', str(ex)[:90])
    # --- mosaicos por demanda sobre una imagen grande sintética + la del test
    tmp = tempfile.mkdtemp(); big = os.path.join(tmp, 'big.png')
    yy, xx = np.mgrid[0:6000, 0:9000]
    arr = np.stack([(xx // 9) % 256, (yy // 7) % 256, ((xx + yy) // 13) % 256], -1).astype(np.uint8)
    Image.fromarray(arr).save(big)
    for path in [big] + ([png] if png else []):
        d, _ = e.call('open_ortho', path=path); print('open_ortho', os.path.basename(path), d['w'], 'x', d['h'], 'niveles', d['levels'])
        meta = json.load(urllib.request.urlopen(d['url'] + '/meta')); assert meta['w'] == d['w']
        top = d['levels'] - 1
        # a resolución nativa un mosaico (1,1) debe coincidir píxel a píxel con la imagen original
        t = Image.open(io.BytesIO(urllib.request.urlopen('%s/tile/%d/1/1.png' % (d['url'], top)).read())).convert('RGB')
        with Image.open(path) as im: ref = im.convert('RGB').crop((512, 512, 1024, 1024))
        diff = np.abs(np.asarray(t).astype(int) - np.asarray(ref).astype(int)).max(); print('  nativo: diferencia máx', diff); assert diff == 0
        # nivel 0 = toda la imagen reducida
        t0 = Image.open(io.BytesIO(urllib.request.urlopen('%s/tile/0/0/0.jpg' % d['url']).read())); assert t0.size == (512, 512)
        try: urllib.request.urlopen('%s/tile/%d/999/999.jpg' % (d['url'], top)); raise AssertionError('debía dar 404')
        except urllib.error.HTTPError as ex: assert ex.code == 404
        e.call('close_ortho', server=d['server'])
    # --- ortomosaico por posición (RTK) + servidor de la pirámide
    if flight:
        fl = sorted(os.path.join(dp, f) for dp, _, fs in os.walk(flight) for f in fs if f.lower().endswith('.jpg'))[:8]
        out = tempfile.mkdtemp()
        d, pr = e.call('mosaic', files=fl, out=out, res_cm=12, workers=1)
        print('mosaic', {k: d[k] for k in ('w', 'h', 'levels', 'tiles', 'photos', 'seconds')}, 'avance', len(pr), 'eventos'); assert d['tiles'] > 0 and pr
        o, _ = e.call('open_tiles', dir=out); top = o['levels'] - 1
        meta = json.load(urllib.request.urlopen(o['url'] + '/meta')); assert meta['w'] == d['w'] and meta['photos'] == len(fl)
        got = 0
        for x in range(0, 3):
            for y in range(0, 3):
                try: urllib.request.urlopen('%s/tile/%d/%d/%d.jpg' % (o['url'], top, x, y)).read(); got += 1
                except urllib.error.HTTPError as ex: assert ex.code == 404
        z0 = urllib.request.urlopen('%s/tile/0/0/0.jpg' % o['url']).read(); assert len(z0) > 1000
        print('  mosaicos nativos leídos', got); assert got > 0
        e.call('close_ortho', server=o['server'])
    e.close(); print('OK')
if __name__ == '__main__':
    main()
