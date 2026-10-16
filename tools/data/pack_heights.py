"""Repack 16-bit grayscale height PNGs into 8-bit RGB PNGs (R = high byte, G = low byte) that browsers decode losslessly."""
import sys
import numpy as np
from PIL import Image

for src in sys.argv[1:]:
    a = np.array(Image.open(src)).astype(np.uint16)
    if a.ndim == 3:
        a = a[..., 0]
    rgb = np.zeros(a.shape + (3,), np.uint8)
    rgb[..., 0] = a >> 8
    rgb[..., 1] = a & 255
    dst = src.replace('_height.png', '_height16.png')
    Image.fromarray(rgb, 'RGB').save(dst, optimize=True)
    print(dst, a.shape, a.min(), a.max())
