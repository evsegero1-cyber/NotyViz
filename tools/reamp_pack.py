# Перезапись готового набора семплов через слепок усилителя: python3 reamp_pack.py SRC_DIR MODEL IR|none OUT_DIR "Название" [peak_dbfs]
import sys, json, os, numpy as np, soundfile as sf
from scipy.signal import resample_poly, fftconvolve
sys.path.insert(0, os.path.dirname(__file__)); from namrun import load, run
src, model_p, ir_p, out, name = sys.argv[1:6]; peak_in = float(sys.argv[6]) if len(sys.argv) > 6 else -8
SR, OSR = 48000, 44100
pk = json.load(open(src + '/pack.json')); model = load(model_p)
ir = None
if ir_p != 'none':
    ir, isr = sf.read(ir_p); ir = ir if ir.ndim == 1 else ir.mean(1)
    if isr != SR: ir = resample_poly(ir, SR, isr)
    p0 = int(np.argmax(np.abs(ir))); ir = ir[max(0, p0 - 32):][:int(0.08 * SR)].copy(); ir /= np.sqrt((ir ** 2).sum())
xs = []
for f in pk['samples']:
    x, sr = sf.read(src + '/' + f); x = x if x.ndim == 1 else x.mean(1); xs.append(resample_poly(x, SR, sr))
g_in = 10 ** (peak_in / 20) / max(np.abs(x).max() for x in xs)
ys = []
for x in xs:
    z = np.concatenate([np.zeros(480), x * g_in, np.zeros(int(0.1 * SR))]); y = run(model, z)[480:]
    if ir is not None: y = fftconvolve(y, ir)[:len(y)]
    f = min(len(y), int(0.03 * SR)); y[-f:] *= np.cos(np.linspace(0, np.pi / 2, f)) ** 2
    ys.append(resample_poly(y, OSR, SR))
g = 0.89 / max(np.abs(y).max() for y in ys)
os.makedirs(out, exist_ok=True)
for f, y in zip(pk['samples'], ys): sf.write(out + '/' + f.rsplit('.', 1)[0] + '.ogg', (y * g).astype(np.float32), OSR, format='OGG', subtype='VORBIS')
pk['samples'] = [f.rsplit('.', 1)[0] + '.ogg' for f in pk['samples']]
pk['name'] = name; pk['meta'] = {'title': name, 'source': 'перезаписано через слепок усилителя (NAM): ' + os.path.basename(model_p)}
for p in pk['programs'].values(): p['vt'] = 0.5
json.dump(pk, open(out + '/pack.json', 'w'), ensure_ascii=False)
print('ok', len(ys))
