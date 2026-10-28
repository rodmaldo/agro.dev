"""Valida estrictamente el shapefile de prescripción (sin librerías): cabeceras, longitudes, .shx, anillos cerrados, orientación, .dbf y áreas."""
import sys, zipfile, struct, math
z = zipfile.ZipFile(sys.argv[1]); names = z.namelist(); print(names)
base = [n for n in names if n.endswith('.shp')][0][:-4]
shp, shx, dbf, prj = (z.read(base + e) for e in ('.shp', '.shx', '.dbf', '.prj'))
assert names[0].startswith('Rx/'), 'los archivos deben ir dentro de Rx/'
code, = struct.unpack('>i', shp[:4]); assert code == 9994
flen = struct.unpack('>i', shp[24:28])[0] * 2; assert flen == len(shp), (flen, len(shp))
ver, st = struct.unpack('<ii', shp[28:36]); assert ver == 1000 and st == 5
assert struct.unpack('>i', shx[24:28])[0] * 2 == len(shx)
nrec = (len(shx) - 100) // 8
off = 100; recs = []
bx = struct.unpack('<4d', shp[36:68])
def area(r): return sum(r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1] for i in range(len(r)-1))/2
for k in range(nrec):
    so, sl = struct.unpack('>ii', shx[100+k*8:108+k*8]); assert so*2 == off, (k, so*2, off)
    rn, cl = struct.unpack('>ii', shp[off:off+8]); assert rn == k+1 and cl == sl
    t, = struct.unpack('<i', shp[off+8:off+12]); assert t == 5
    mnx, mny, mxx, mxy = struct.unpack('<4d', shp[off+12:off+44]); npart, npt = struct.unpack('<ii', shp[off+44:off+52])
    assert cl*2 == 44 + 4*npart + 16*npt
    parts = struct.unpack('<%di' % npart, shp[off+52:off+52+4*npart]); p0 = off+52+4*npart
    pts = [struct.unpack('<2d', shp[p0+16*i:p0+16*i+16]) for i in range(npt)]
    rings = [pts[parts[i]:(parts[i+1] if i+1 < npart else npt)] for i in range(npart)]
    for i, r in enumerate(rings):
        assert r[0] == r[-1] and len(r) >= 4, 'anillo sin cerrar'
        a = area(r)
        assert (a < 0) if i == 0 else (a > 0), ('orientación', k, i, a)        # exterior horario (área<0 en x=lon,y=lat), huecos antihorarios
        assert mnx-1e-12 <= min(p[0] for p in r) and max(p[0] for p in r) <= mxx+1e-12
    assert bx[0]-1e-12 <= mnx and mxx <= bx[2]+1e-12 and bx[1]-1e-12 <= mny and mxy <= bx[3]+1e-12
    recs.append(rings); off += 8 + cl*2
assert off == len(shp)
# dbf
nr, hl, rl = struct.unpack('<IHH', dbf[4:12]); assert nr == nrec and dbf[-1] == 26
fields = []; p = 32
while dbf[p] != 13: fields.append((dbf[p:p+11].rstrip(b'\0').decode(), chr(dbf[p+11]), dbf[p+16], dbf[p+17])); p += 32
assert sum(f[2] for f in fields)+1 == rl and p+1 == hl, 'cabecera dbf'
print('campos', fields)
rows = []
for k in range(nr):
    rec = dbf[hl+k*rl:hl+(k+1)*rl]; q = 1; row = {}
    for f in fields: row[f[0]] = rec[q:q+f[2]].decode().strip(); q += f[2]
    rows.append(row)
by = {}
for r in rows: by[(r['CLASE'], float(r['RATE']))] = by.get((r['CLASE'], float(r['RATE'])), 0) + float(r['AREA_HA'])
print('registros', nr, 'ha por clase/dosis', {k: round(v, 2) for k, v in by.items()})
print('prj:', prj.decode()[:60]); print('OK shapefile válido:', nrec, 'polígonos')
