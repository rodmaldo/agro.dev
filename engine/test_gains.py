"""Prueba del solucionador de ganancias (gradiente conjugado, sin BLAS/LAPACK) contra la solución directa."""
import os, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mosaic_gps import _cg_laplacian


def main():
    rng = np.random.default_rng(2); n = 400
    pairs = sorted({(i, j) for i in range(n) for j in range(i + 1, min(n, i + 9))})
    ri = np.array([a for a, b in pairs]); rj = np.array([b for a, b in pairs]); w2 = rng.uniform(.3, 1, len(pairs)) ** 2
    tr = rng.normal(0, .1, n); B = np.zeros((n, 3))
    for c in range(3):
        v = (tr[ri] - tr[rj] + rng.normal(0, .01, len(pairs))) * w2
        B[:, c] = np.bincount(ri, v, n) - np.bincount(rj, v, n)
    X = _cg_laplacian(ri, rj, w2, B, n)
    A = np.zeros((n, n)); np.add.at(A, (ri, ri), w2); np.add.at(A, (rj, rj), w2); np.add.at(A, (ri, rj), -w2); np.add.at(A, (rj, ri), -w2)
    A += .02 ** 2 + np.eye(n) * 1e-9
    d = np.abs(X - np.linalg.solve(A, B)).max()
    assert d < 1e-6, d
    print('ganancias: CG vs directo, diferencia máx %.2e' % d)
    print('OK')


if __name__ == '__main__':
    main()
