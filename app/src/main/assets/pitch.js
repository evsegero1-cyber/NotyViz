// Определение высоты звука (метод Маклеода, NSDF) — для тюнера.
// Автокорреляция через БПФ, поэтому быстро даже для окна 8192 отсчётов (низкие струны баса).

function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const cache = new Map();
function bufs(n) { if (!cache.has(n)) cache.set(n, { re: new Float64Array(2 * n), im: new Float64Array(2 * n), nsdf: new Float64Array(n) }); return cache.get(n); }

// buf — отсчёты (Float32Array), sr — частота дискретизации.
// Возвращает { freq, clarity, rms } или null, если звука нет / он не похож на ноту.
export function detectPitch(buf, sr, opt = {}) {
  const n = buf.length, fMin = opt.fMin || 27, fMax = opt.fMax || 1400;
  let mean = 0; for (let i = 0; i < n; i++) mean += buf[i]; mean /= n;
  let rms = 0; for (let i = 0; i < n; i++) { const v = buf[i] - mean; rms += v * v; } rms = Math.sqrt(rms / n);
  if (rms < (opt.gate || 0.003)) return null;
  const { re, im, nsdf } = bufs(n);
  re.fill(0); im.fill(0);
  for (let i = 0; i < n; i++) re[i] = buf[i] - mean;
  fft(re, im, false);
  for (let i = 0; i < 2 * n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im, true); // re[tau]·2n — автокорреляция
  const tauMax = Math.min(n - 1, Math.floor(sr / fMin)), tauMin = Math.max(2, Math.floor(sr / fMax));
  // m(tau) = Σ x[i]² + x[i+tau]² считается накопительно
  let m = 0; for (let i = 0; i < n; i++) { const v = buf[i] - mean; m += 2 * v * v; }
  const sq = i => { const v = buf[i] - mean; return v * v; };
  nsdf[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    m -= sq(n - tau) + sq(tau - 1);
    nsdf[tau] = m > 0 ? 2 * (re[tau] / (2 * n)) / m : 0;
  }
  // ключевые максимумы между переходами через ноль
  const peaks = []; let pos = false, best = -1, bi = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    const v = nsdf[tau];
    if (!pos && v > 0 && nsdf[tau - 1] <= 0) { pos = true; best = -1; }
    if (pos) {
      if (v > best) { best = v; bi = tau; }
      if (v <= 0 && nsdf[tau - 1] > 0) { pos = false; if (bi >= tauMin) peaks.push(bi); }
    }
  }
  if (pos && bi >= tauMin && bi < tauMax) peaks.push(bi);
  if (!peaks.length) return null;
  let top = 0; for (const p of peaks) top = Math.max(top, nsdf[p]);
  const k = opt.k || 0.88;
  const p = peaks.find(t => nsdf[t] >= k * top);
  // уточнение параболой
  const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1] != null ? nsdf[p + 1] : b;
  const d = a - 2 * b + c; const shift = d !== 0 ? 0.5 * (a - c) / d : 0;
  const tau = p + Math.max(-1, Math.min(1, shift));
  return { freq: sr / tau, clarity: b, rms };
}

export const freqToMidi = (f, a4 = 440) => 69 + 12 * Math.log2(f / a4);
export const midiToFreq = (m, a4 = 440) => a4 * Math.pow(2, (m - 69) / 12);
