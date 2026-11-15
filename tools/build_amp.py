# Сборка набора «электрогитара через усилитель»: DI-семплы Emilyguitar (CC0) → нейросетевой слепок
# настоящего усилителя (NAM) → импульс кабинета 4×12 V30 (CC0) → Ogg. Пауэр-аккорды рендерятся целиком
# (перегруз смешивает струны — так и звучит настоящий аккорд), отдельно глушение ладонью.
import sys, json, os, numpy as np, soundfile as sf
from scipy.signal import resample, butter, sosfilt, fftconvolve, resample_poly
sys.path.insert(0, os.path.dirname(__file__)); from namrun import load, run
SRC = '/home/claude/notyviz/app/src/main/assets/snd/egtr/'
MODEL, IR, OUT, NAME = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
SR, OSR = 48000, 44100
IN_GAIN = 10 ** (-6.5 / 20)
pk = json.load(open(SRC + 'pack.json')); R = pk['programs']['notes']['regions']
FS = '/home/claude/ext/fsbs/direct/EGuitarFSBS-direct SFZ+FLAC-20220911/'
import re
def parse_sfz(path):
    regs, grp = [], {}
    cur = None
    for line in open(path, encoding='utf-8', errors='ignore'):
        line = line.split('//')[0].strip()
        if not line: continue
        if line.startswith('<group>'): grp = {}; cur = grp; line = line[7:]
        elif line.startswith('<region>'): cur = dict(grp); regs.append(cur); line = line[8:]
        elif line.startswith('<global>'): cur = {}; line = line[8:]
        for k, v in re.findall(r'(\w+)=(\S+)', line):
            if cur is not None: cur[k] = v
    return regs
FR = [r for r in parse_sfz(FS + 'EGuitarFSBS-direct bridge 20220911.sfz') if 'sample' in r]
for r in FR:
    if 'key' in r: r.setdefault('lokey', r['key']); r.setdefault('hikey', r['key']); r.setdefault('pitch_keycenter', r['key'])
FZ = sorted(set((int(r['lokey']), int(r['hikey']), int(r['pitch_keycenter'])) for r in FR))
def fs_files(root, hard):
    out = []
    for r in FR:
        if int(r['pitch_keycenter']) != root: continue
        lv, hv = int(r.get('lovel', 1)), int(r.get('hivel', 127))
        if (hard and hv == 127) or (not hard and lv == 1): out.append(r['sample'])
    return sorted(out)
model = load(MODEL)
ir, isr = sf.read(IR); ir = ir if ir.ndim == 1 else ir.mean(1)
if isr != SR: ir = resample_poly(ir, SR, isr)
p0 = int(np.argmax(np.abs(ir))); ir = ir[max(0, p0 - 32):][:int(0.08 * SR)].copy(); ir[-int(0.015*SR):] *= np.cos(np.linspace(0, np.pi/2, int(0.015*SR)))**2
ir /= np.sqrt((ir**2).sum())
cache = {}
def raw(s):
    if s not in cache: x, sr = sf.read(SRC + pk['samples'][s]); cache[s] = x if x.ndim == 1 else x.mean(1)
    return cache[s]
fcache = {}
def fsraw(name):
    if name not in fcache:
        x, sr = sf.read(FS + name); x = x if x.ndim == 1 else x.mean(1); assert sr == SR
        fcache[name] = x[:int(5 * SR)]
    return fcache[name]
def di(m, v, rr=0):
    """DI-нота m (миди): Fender, звукосниматель у подставки; v ≥ 93 — сильный удар. 48 кГц"""
    z = min(FZ, key=lambda z: (0 if z[0] <= m <= z[1] else 1, abs(z[2] - m)))
    fl = fs_files(z[2], v >= 93); x = fsraw(fl[rr % len(fl)])
    ratio = 2 ** ((m - z[2]) / 12)
    if abs(ratio - 1) > 1e-6: x = resample(x, int(round(len(x) / ratio)))
    lvl = 10 ** ((-8 if v >= 93 else -15) / 20) * (v / (124 if v >= 93 else 80)) ** 1.2
    return x * lvl
def pm(x):  # глушение ладонью: быстрое затухание струны и глухой верх
    t = np.arange(len(x)) / SR; env = np.where(t < 0.012, 1.0, np.exp(-(t - 0.012) / 0.085))
    return sosfilt(butter(2, 1400, 'low', fs=SR, output='sos'), x * env)
def amp(x, tail=0.15):
    x = np.concatenate([np.zeros(int(0.01 * SR)), x, np.zeros(int(tail * SR))])
    y = run(model, x)
    y = fftconvolve(y, ir)[:len(y)]
    return y[int(0.01 * SR):]
def finish(y, length):
    n = min(len(y), int(length * SR)); y = y[:n].copy(); f = int(0.06 * SR); y[-f:] *= np.cos(np.linspace(0, np.pi/2, f))**2
    return resample_poly(y, OSR, SR)
os.makedirs(OUT, exist_ok=True)
samples, progs, bufs = [], {}, []
def add(y, prog, reg):
    bufs.append(y); samples.append('%03d.ogg' % len(samples)); reg['s'] = len(samples) - 1
    base = dict(tune=0.0, vol=0.0, pan=0.0, att=0.001, hold=0.0, dec=0.0, sus=1.0, rel=0.12, rr=1, rrn=1); base.update(reg)
    progs.setdefault(prog, []).append(base)
zones = FZ
LAY = [(1, 60, 50), (61, 92, 80), (93, 112, 105), (113, 127, 124)]
for lk, hk, root in zones:
    for lv, hv, v in LAY:
        for rr in range(2):
            add(finish(amp(di(root, v, rr)), 3.5), 'notes', dict(lk=lk, hk=hk, lv=lv, hv=hv, root=root, rr=rr + 1, rrn=2))
    for lv, hv, v in [(1, 100, 90), (101, 127, 120)]:
        add(finish(amp(pm(di(root, v))), 0.8), 'pm', dict(lk=lk, hk=hk, lv=lv, hv=hv, root=root, rel=0.06))
    print('note', root, flush=True)
# звуки отпускания струны (через усилитель они дают живой «щелчок» глушения)
for r in [r for r in R if r.get('trig') == 'r']:
    x = raw(r['s']) ; x = resample(x, int(len(x) * SR / OSR)) * IN_GAIN * 0.5
    add(finish(amp(x), 0.6), 'notes', dict(lk=r['lk'], hk=r['hk'], lv=1, hv=127, root=r['root'], trig='r', rel=0.1))
# глухие ноты
D = pk['programs']['dead']['regions']
for i, r in enumerate(D):
    x = raw(r['s']); x = resample(x, int(len(x) * SR / OSR)) * IN_GAIN
    add(finish(amp(x), 0.5), 'dead', dict(lk=0, hk=127, lv=1, hv=127, root=None, rr=r.get('rr', i + 1), rrn=len(D), rel=0.05))
# пауэр-аккорды: квинта (r, r+7) и с октавой (r, r+7, r+12); удар вниз, струны с разницей 6 мс
for root in range(36, 66, 2):
    for kind, iv in (('p5', (0, 7)), ('p8', (0, 7, 12))):
        for pmode in (False, True):
            for lv, hv, v in [(1, 100, 90), (101, 127, 120)]:
                parts = [di(root + d, v, i) for i, d in enumerate(iv)]
                n = max(len(p) for p in parts) + int(0.02 * SR); x = np.zeros(n)
                for i, p in enumerate(parts): o = int(i * 0.006 * SR); x[o:o + len(p)] += p[:n - o]
                if pmode: x = pm(x)
                add(finish(amp(x), 0.8 if pmode else 3.5), kind + ('pm' if pmode else ''), dict(lk=root - 1, hk=root, lv=lv, hv=hv, root=root, rel=0.06 if pmode else 0.12))
    print('chord', root, flush=True)
# общая нормировка (громкости слоёв остаются как есть)
g = 0.89 / max(np.abs(b).max() for b in bufs)
for name, b in zip(samples, bufs): sf.write(OUT + '/' + name, (b * g).astype(np.float32), OSR, format='OGG', subtype='VORBIS')
json.dump({'name': NAME, 'meta': {'title': NAME, 'source': 'Emilyguitar DI (CC0) → NAM capture → Jester Dyne V30 IR (CC0)'},
           'samples': samples, 'programs': {k: {'name': k, 'regions': v} for k, v in progs.items()}}, open(OUT + '/pack.json', 'w'), ensure_ascii=False)
print('samples', len(samples), {k: len(v) for k, v in progs.items()})
