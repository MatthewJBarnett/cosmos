# Analyse frames from jitter.mjs: the planet disk's weighted centroid and the edge positions on the middle row per
# frame, and the mean absolute pixel change between frames. Usage: python3 jitter.py outdir
import sys, glob
from PIL import Image
fs = sorted(glob.glob(sys.argv[1] + '/j*.png'), key=lambda f: int(f.split('/j')[-1][:-4]))
prev = None
for f in fs:
    im = Image.open(f).convert('L'); w, h = im.size; px = im.load()
    sw = sx = sy = 0; row = [x for x in range(w) if px[x, h // 2] > 40]
    for y in range(0, h):
        for x in range(0, w):
            l = px[x, y]
            if l > 40: sw += l; sx += x * l; sy += y * l
    d = 0
    if prev is not None:
        pp = prev.load(); d = sum(abs(px[x, y] - pp[x, y]) for y in range(0, h, 2) for x in range(0, w, 2)) / (w * h / 4)
    prev = im
    print(f.split('/')[-1], 'centroid %.2f,%.2f' % (sx / max(sw, 1), sy / max(sw, 1)), 'row', (row[0], row[-1]) if row else '-', 'dpix %.2f' % d)
