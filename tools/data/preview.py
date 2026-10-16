#!/usr/bin/env python3
"""Make labelled-free preview sheets of the planet maps for visual checking.

Usage: python3 -I preview.py DATA_DIR OUT_DIR

Each map is shrunk to 512x256 with a red line at lon 0 / lat 0 and a cyan
line at lon +90 (east). Height maps are shown as grayscale. Sheets are 2 maps
wide, 3 maps tall; the order is printed.
"""
import glob, os, sys
import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None


def thumb(p):
    im = Image.open(p)
    if im.mode in ('I;16', 'I;16B', 'I'):
        a = np.asarray(im).astype(np.float32)
        a = (a - a.min()) / max(1.0, a.max() - a.min()) * 255
        im = Image.fromarray(a.astype(np.uint8))
    im = im.convert('RGB').resize((512, 256), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    d.line([(256, 0), (256, 256)], fill=(255, 0, 0))
    d.line([(0, 128), (512, 128)], fill=(255, 0, 0))
    d.line([(384, 0), (384, 256)], fill=(0, 255, 255))
    return im


def main(data, outdir):
    os.makedirs(outdir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(data, 'planets', '*.jpg')) + glob.glob(os.path.join(data, 'planets', '*_height.png'))
                   + glob.glob(os.path.join(data, 'planets', '*_mask.png')))
    per = 6
    for s in range(0, len(files), per):
        chunk = files[s:s + per]
        sheet = Image.new('RGB', (1024 + 4, 256 * 3 + 8), (40, 40, 40))
        for k, f in enumerate(chunk):
            sheet.paste(thumb(f), ((k % 2) * 516, (k // 2) * 260))
        name = os.path.join(outdir, f'sheet_{s // per}.png')
        sheet.save(name)
        print(name, [os.path.basename(f) for f in chunk])


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
