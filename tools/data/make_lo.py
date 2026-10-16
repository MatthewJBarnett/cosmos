"""Build 1024x512 preview maps (loaded first) and lossless WebP full-resolution height maps."""
import sys, os
import numpy as np
from PIL import Image
D = sys.argv[1] if len(sys.argv) > 1 else 'data/planets'
for b in ['earth', 'moon', 'mars']:
    h = np.asarray(Image.open(f'{D}/{b}_height16.png').convert('RGB')).astype(np.uint32)
    v = (h[..., 0] << 8 | h[..., 1]).astype(np.float64)
    lo = v.reshape(512, 4, 1024, 4).mean(axis=(1, 3))
    lo = np.clip(np.round(lo), 0, 65535).astype(np.uint32)
    rgb = np.zeros((512, 1024, 3), np.uint8); rgb[..., 0] = lo >> 8; rgb[..., 1] = lo & 255
    Image.fromarray(rgb, 'RGB').save(f'{D}/{b}_height16_lo.png', optimize=True)
    Image.open(f'{D}/{b}_height16.png').save(f'{D}/{b}_height16.webp', 'WEBP', lossless=True, quality=100, method=6)
    Image.open(f'{D}/{b}_color.jpg').resize((1024, 512), Image.LANCZOS).save(f'{D}/{b}_color_lo.jpg', quality=88)
    print(b, os.path.getsize(f'{D}/{b}_height16_lo.png') // 1024, 'KB lo height,', os.path.getsize(f'{D}/{b}_height16.webp') // 1024, 'KB webp')
