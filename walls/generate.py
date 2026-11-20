# Генератор «импрессионистских» подложек: тысячи коротких мазков по полю направлений
import math, random, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
W, H = 1440, 960
def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
def jit(c, j=18): return tuple(max(0, min(255, int(v + random.uniform(-j, j)))) for v in c)
def grad(stops, y):
    t = y / H
    for i in range(len(stops) - 1):
        (t0, c0), (t1, c1) = stops[i], stops[i + 1]
        if t0 <= t <= t1: return lerp(c0, c1, (t - t0) / max(1e-6, t1 - t0))
    return stops[-1][1]
class Canvas:
    def __init__(s, base):
        s.img = base.convert('RGBA')
    def strokes(s, items, alpha=170):
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(layer)
        for (x, y, ang, ln, wd, col) in items:
            dx, dy = math.cos(ang) * ln / 2, math.sin(ang) * ln / 2
            d.line([(x - dx, y - dy), (x + dx, y + dy)], fill=col + (alpha,), width=int(wd))
            d.ellipse([x + dx - wd / 2, y + dy - wd / 2, x + dx + wd / 2, y + dy + wd / 2], fill=col + (alpha,))
        s.img = Image.alpha_composite(s.img, layer)
    def dots(s, items, alpha=200):
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(layer)
        for (x, y, r, col) in items: d.ellipse([x - r, y - r, x + r, y + r], fill=col + (alpha,))
        s.img = Image.alpha_composite(s.img, layer)
    def save(s, name):
        im = s.img.convert('RGB').filter(ImageFilter.SMOOTH_MORE)
        im.save(f'walls/{name}.jpg', quality=78, optimize=True, progressive=True)
        im.resize((240, 160)).save(f'walls/{name}-thumb.jpg', quality=75)
def base_from(stops):
    a = np.zeros((H, W, 3), np.uint8)
    for y in range(H): a[y, :] = grad(stops, y)
    return Image.fromarray(a)
def field_strokes(n, colfn, angfn, ln=(14, 30), wd=(4, 8), region=lambda x, y: True):
    out = []
    while len(out) < n:
        x, y = random.uniform(0, W), random.uniform(0, H)
        if not region(x, y): continue
        out.append((x, y, angfn(x, y), random.uniform(*ln), random.uniform(*wd), colfn(x, y)))
    return out
random.seed(7)

# 1. Кувшинки — в духе Моне
stops = [(0, (92, 132, 160)), (.5, (70, 120, 130)), (1, (58, 92, 120))]
c = Canvas(base_from(stops))
water = [(122, 160, 190), (96, 140, 170), (140, 170, 200), (84, 128, 120), (160, 150, 200), (110, 150, 140)]
for _ in range(3): c.strokes(field_strokes(9000, lambda x, y: jit(random.choice(water), 22), lambda x, y: random.gauss(0, .12), (18, 40), (4, 9)), 120)
for _ in range(38):  # листья
    cx, cy, r = random.uniform(0, W), random.uniform(0, H), random.uniform(40, 110)
    c.strokes(field_strokes(int(r * 4), lambda x, y: jit(random.choice([(80, 130, 70), (100, 150, 80), (60, 110, 70), (130, 160, 90)]), 15),
        lambda x, y: random.uniform(-.6, .6), (10, 22), (5, 9), lambda x, y, cx=cx, cy=cy, r=r: ((x - cx) / r) ** 2 + ((y - cy) / (r * .45)) ** 2 < 1), 190)
    if random.random() < .6:
        c.dots([(cx + random.gauss(0, 8), cy - r * .1 + random.gauss(0, 6), random.uniform(3, 7), jit(random.choice([(240, 170, 190), (250, 240, 240), (230, 130, 160)]), 10)) for _ in range(26)], 230)
c.save('lilies')

# 2. Восход над водой — в духе Моне
random.seed(11)
stops = [(0, (120, 140, 160)), (.45, (150, 150, 165)), (.55, (110, 130, 150)), (1, (70, 95, 120))]
c = Canvas(base_from(stops))
haze = [(150, 160, 175), (170, 160, 170), (130, 150, 170), (190, 170, 160)]
c.strokes(field_strokes(14000, lambda x, y: jit(random.choice(haze), 20), lambda x, y: random.gauss(0, .3), (20, 45), (5, 10), lambda x, y: y < H * .55), 110)
c.strokes(field_strokes(16000, lambda x, y: jit(random.choice([(90, 115, 140), (110, 130, 150), (70, 100, 125), (130, 140, 155)]), 18),
    lambda x, y: random.gauss(0, .07), (22, 50), (4, 8), lambda x, y: y >= H * .5), 140)
sx, sy = W * .62, H * .3
c.dots([(sx + random.gauss(0, 14), sy + random.gauss(0, 14), random.uniform(6, 14), jit((245, 120, 40), 15)) for _ in range(160)], 220)
c.strokes([(sx + random.gauss(0, 30), H * .52 + abs(random.gauss(0, 120)), random.gauss(0, .05), random.uniform(20, 50), random.uniform(5, 9), jit((240, 130, 50), 20)) for _ in range(260)], 200)
for bx, by in [(W * .3, H * .66), (W * .45, H * .78), (W * .22, H * .86)]:
    c.strokes([(bx + random.gauss(0, 18), by + random.gauss(0, 4), random.gauss(0, .2), random.uniform(10, 26), random.uniform(5, 8), jit((40, 50, 70), 10)) for _ in range(60)], 210)
c.save('sunrise')

# 3. Маковое поле — в духе Моне
random.seed(21)
stops = [(0, (150, 185, 220)), (.38, (200, 215, 225)), (.4, (120, 150, 90)), (1, (90, 130, 60))]
c = Canvas(base_from(stops))
c.strokes(field_strokes(9000, lambda x, y: jit(random.choice([(170, 200, 230), (220, 225, 235), (245, 245, 245), (150, 180, 215)]), 15),
    lambda x, y: random.gauss(.2, .4), (20, 40), (6, 11), lambda x, y: y < H * .4), 140)
c.strokes(field_strokes(4000, lambda x, y: jit(random.choice([(70, 100, 70), (90, 120, 80), (60, 90, 80)]), 12), lambda x, y: random.gauss(0, .2), (16, 30), (6, 10),
    lambda x, y: H * .34 < y < H * .44), 190)
c.strokes(field_strokes(18000, lambda x, y: jit(random.choice([(110, 150, 70), (140, 170, 80), (90, 130, 60), (170, 180, 90)]), 18),
    lambda x, y: -math.pi / 2 + random.gauss(0, .5), (12, 26), (4, 8), lambda x, y: y > H * .4), 150)
c.dots([(x, y, random.uniform(3, 4 + (y - H * .4) / 90), jit((215, 50, 40), 18)) for x, y in ((random.uniform(0, W), H * .4 + (random.random() ** 1.3) * H * .6) for _ in range(2600))], 220)
c.save('poppies')

# 4. Звёздная ночь — в духе Ван Гога
random.seed(31)
stops = [(0, (20, 40, 100)), (.7, (35, 60, 130)), (1, (20, 30, 60))]
c = Canvas(base_from(stops))
vort = [(W * .35, H * .3, 220), (W * .62, H * .38, 170), (W * .82, H * .2, 120)]
def ang(x, y):
    a = .15 * math.sin(y / 90)
    for vx, vy, r in vort:
        d = math.hypot(x - vx, y - vy)
        if d < r * 1.6: a = math.atan2(y - vy, x - vx) + math.pi / 2 + .2
    return a
blues = [(40, 70, 160), (60, 100, 190), (90, 140, 210), (30, 50, 120), (140, 180, 220), (70, 110, 170)]
for _ in range(3): c.strokes(field_strokes(9000, lambda x, y: jit(random.choice(blues), 18), ang, (16, 30), (5, 8), lambda x, y: y < H * .78), 170)
for sx, sy, r in [(W * .12, H * .15, 26), (W * .5, H * .12, 20), (W * .72, H * .55, 18), (W * .25, H * .55, 22), (W * .9, H * .45, 16), (W * .9, H * .12, 40)]:
    c.strokes([(sx + math.cos(t) * rr, sy + math.sin(t) * rr, t + math.pi / 2, random.uniform(10, 18), random.uniform(4, 7), jit((240, 220, 110), 15))
               for t in np.linspace(0, 2 * math.pi, 40) for rr in (r * 1.4, r * 2.0)], 200)
    c.dots([(sx + random.gauss(0, r * .3), sy + random.gauss(0, r * .3), random.uniform(4, 8), jit((255, 235, 120), 10)) for _ in range(40)], 240)
c.strokes(field_strokes(9000, lambda x, y: jit(random.choice([(20, 35, 50), (40, 50, 70), (30, 60, 60), (60, 70, 90)]), 12), lambda x, y: random.gauss(0, .3), (14, 26), (5, 8), lambda x, y: y > H * .75 - 40 * math.sin(x / 150)), 200)
c.strokes([(W * .1 + random.gauss(0, 18), y, -math.pi / 2 + random.gauss(0, .25), random.uniform(20, 40), random.uniform(6, 10), jit((25, 35, 25), 10)) for y in np.linspace(H * .25, H, 260)], 230)
c.save('starry')

# 5. Подсолнухи — в духе Ван Гога
random.seed(41)
stops = [(0, (230, 200, 90)), (1, (210, 160, 60))]
c = Canvas(base_from(stops))
c.strokes(field_strokes(16000, lambda x, y: jit(random.choice([(235, 200, 90), (220, 180, 70), (240, 215, 120), (205, 165, 60)]), 15), lambda x, y: random.gauss(.6, .5), (18, 34), (5, 9)), 140)
for _ in range(16):
    cx, cy, r = random.uniform(80, W - 80), random.uniform(80, H - 80), random.uniform(50, 95)
    c.strokes([(cx + math.cos(t) * r * random.uniform(.6, 1.1), cy + math.sin(t) * r * random.uniform(.6, 1.1), t, random.uniform(r * .35, r * .6), random.uniform(7, 11),
                jit(random.choice([(250, 190, 30), (240, 160, 20), (255, 210, 60)]), 15)) for t in np.linspace(0, 2 * math.pi, 34)], 220)
    c.dots([(cx + random.gauss(0, r * .18), cy + random.gauss(0, r * .18), random.uniform(3, 6), jit(random.choice([(110, 70, 20), (80, 50, 20), (140, 90, 30)]), 12)) for _ in range(int(r * 2))], 235)
c.save('sunflowers')

# 6. Летний сад — в духе Ренуара
random.seed(51)
stops = [(0, (170, 200, 160)), (1, (120, 160, 120))]
c = Canvas(base_from(stops))
garden = [(120, 170, 110), (150, 190, 120), (90, 140, 100), (190, 210, 150), (230, 220, 170), (100, 150, 130)]
for _ in range(3): c.strokes(field_strokes(9000, lambda x, y: jit(random.choice(garden), 20), lambda x, y: random.uniform(0, math.pi), (14, 28), (6, 11)), 130)
c.dots([(random.uniform(0, W), random.uniform(0, H), random.uniform(5, 12), jit(random.choice([(255, 245, 210), (250, 230, 190)]), 8)) for _ in range(700)], 150)
c.dots([(random.uniform(0, W), random.uniform(0, H), random.uniform(4, 9), jit(random.choice([(240, 150, 170), (250, 190, 200), (230, 110, 140), (255, 220, 230), (200, 160, 220)]), 15)) for _ in range(1600)], 210)
c.save('garden')
print('ok')
