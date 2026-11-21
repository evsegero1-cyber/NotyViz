// Общая «анимация техник» для всех видов: где сейчас струна при бенде и слайде,
// значки-подсказки (бенд, слайд, h/p, вибрато, P.M., флажолет…) и плашка «что сейчас будет».
import { guideLabel } from './performance-guide.js';
import { TECH, techIds, bendText } from './techniques.js';

const clamp01 = v => Math.max(0, Math.min(1, v));

// подтяжка (полутоны) в доле ноты frac ∈ [0,1] по точкам бенда [[0..60, полутоны]]
export function bendAt(x, frac) {
  const b = x && x.bend; if (!b) return 0;
  const pts = b.pts && b.pts.length ? b.pts : [[0, 0], [20, b.max || 1], [60, b.max || 1]];
  const p = clamp01(frac) * 60;
  if (p <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (p <= pts[i][0]) { const [a, va] = pts[i - 1], [c, vc] = pts[i]; return va + (vc - va) * (c > a ? (p - a) / (c - a) : 1); }
  return pts[pts.length - 1][1];
}
// где палец на струне (лад, дробный) в доле ноты frac — слайды туда, слайды «из ниоткуда» и «в никуда»
export function slideAt(q, frac) {
  const x = q.x; let f = q.f;
  if (!x || f == null) return f;
  if (x.slIn && f > 0) { const k = clamp01(frac / 0.15); f += (x.slIn === 'below' ? -2 : 2) * (1 - k); }
  if (x.sl && x.slTo != null) { const k = clamp01((frac - 0.5) / 0.5); f += (x.slTo - q.f) * k * k * (3 - 2 * k); }
  else if (x.sl === 'down' || x.sl === 'pickdown' || x.sl === 'up' || x.sl === 'pickup') { const k = clamp01((frac - 0.7) / 0.3); f += (x.sl.endsWith('up') ? 3 : -Math.min(3, q.f)) * k; }
  return f;
}
// дрожание вибрато (доля «полутона») в момент t
export function vibAt(x, t) { if (!x || !x.vib) return 0; return Math.sin(t * Math.PI * 2 * 5.5) * (x.vib === 'wide' ? 0.5 : 0.25); }
// трель: попеременно основной лад и лад трели
export function trillFret(q, t) { const x = q.x; if (!x || x.tr == null || x.trillAux || q.f == null || q.m == null) return q.f; return Math.floor(t * 14) % 2 ? q.f + (x.tr - q.m) : q.f; }

// короткая подпись техники для значка над нотой
export function techMark(x, f) {
  if (!x) return '';
  const guide = guideLabel(x);
  if (guide) return guide;
  if (x.stroke) return x.stroke === 'up' ? '↑' : '↓';
  if (x.bend) return '';           // бенд рисуется стрелкой
  if (x.hp) return x.hp === 'h' ? 'H' : 'P';
  if (x.harm) return x.harm === 'N' ? 'NH' : x.harm + 'H';
  if (x.tap) return 'T'; if (x.slap) return 'S'; if (x.pop) return 'P';
  if (x.pm) return 'PM'; if (x.trem) return '≡'; if (x.tr != null && !x.trillAux) return 'tr';
  if (x.ring) return 'l.r.'; if (x.whammy) return 'w/b'; if (x.rasg) return 'rasg';
  return '';
}

// стрелка бенда: вверх (подтяжка) или вниз (возврат), с подписью ½ / full / 1½
export function drawBendArrow(g, x, y, h, semi, col, down) {
  const w = h * 0.45;
  g.strokeStyle = col; g.fillStyle = col; g.lineWidth = Math.max(1.5, h * 0.09); g.lineCap = 'round';
  g.beginPath();
  if (!down) { g.moveTo(x - w, y); g.quadraticCurveTo(x, y, x, y - h); g.stroke(); g.beginPath(); g.moveTo(x, y - h - 2); g.lineTo(x - h * 0.18, y - h + h * 0.24); g.lineTo(x + h * 0.18, y - h + h * 0.24); }
  else { g.moveTo(x, y - h); g.quadraticCurveTo(x, y, x + w, y); g.stroke(); g.beginPath(); g.moveTo(x + w + 2, y); g.lineTo(x + w - h * 0.22, y - h * 0.18); g.lineTo(x + w - h * 0.22, y + h * 0.18); }
  g.closePath(); g.fill();
  const t = bendText(semi).trim();
  if (t) { g.font = `700 ${Math.max(9, Math.round(h * 0.5))}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(t, x, y - h - 3); }
  g.lineCap = 'butt';
}

// маленькая анимированная пиктограмма техники (ph — время в секундах)
export function drawTechIcon(g, id, x, y, s, ph, C = '#ffd9bd') {
  g.save(); g.translate(x, y); g.lineWidth = 2; g.lineCap = 'round'; g.strokeStyle = C; g.fillStyle = C;
  const cyc = (ph % 1.2) / 1.2;
  const str = (yy, bend) => { g.strokeStyle = C === '#000' ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.45)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-s, yy); if (bend) g.quadraticCurveTo(0, yy - bend * 2, s, yy); else g.lineTo(s, yy); g.stroke(); g.strokeStyle = C; g.lineWidth = 2; };
  switch (id) {
    case 'bend': case 'release': case 'whammy': {
      const k = id === 'release' ? 1 - Math.min(1, cyc * 1.6) : Math.min(1, cyc * 1.6), up = k * s * 0.7;
      str(s * 0.4, up / 2); g.beginPath(); g.arc(0, s * 0.4 - up, s * 0.28, 0, 7); g.fill(); break;
    }
    case 'sl': case 'gliss': { str(0); const k = cyc < 0.8 ? cyc / 0.8 : 1; g.beginPath(); g.arc(-s * 0.8 + k * s * 1.6, 0, s * 0.28, 0, 7); g.fill(); g.beginPath(); g.moveTo(s * 0.5, -s * 0.5); g.lineTo(s, 0); g.lineTo(s * 0.5, s * 0.5); g.stroke(); break; }
    case 'vib': { g.beginPath(); for (let i = -s; i <= s; i += 1) g.lineTo(i, Math.sin(i / s * 3 * Math.PI + ph * 18) * s * 0.3); g.stroke(); break; }
    case 'hp_h': case 'hp_p': case 'tap': case 'slap': case 'pop': {
      str(s * 0.5); const k = Math.abs(Math.sin(ph * 6)); const yy = id === 'hp_p' || id === 'pop' ? s * 0.5 - k * s : -s * 0.6 + k * s * 1.0;
      g.beginPath(); g.arc(id === 'hp_p' ? s * 0.2 : 0, Math.min(s * 0.3, yy), s * 0.3, 0, 7); g.fill(); break;
    }
    case 'pm': { str(0); g.globalAlpha = 0.7; g.fillRect(s * 0.25, -s * 0.8, s * 0.7, s * 1.6); g.globalAlpha = 1; g.beginPath(); g.arc(-s * 0.3, 0, s * 0.25 * (1 - cyc * 0.5), 0, 7); g.fill(); break; }
    default: if (id && id.startsWith('harm')) { const k = 0.6 + 0.4 * Math.sin(ph * 8); g.beginPath(); g.moveTo(0, -s * k); g.lineTo(s * k, 0); g.lineTo(0, s * k); g.lineTo(-s * k, 0); g.closePath(); g.stroke(); }
      else if (id === 'dead') { g.beginPath(); g.moveTo(-s * 0.6, -s * 0.6); g.lineTo(s * 0.6, s * 0.6); g.moveTo(s * 0.6, -s * 0.6); g.lineTo(-s * 0.6, s * 0.6); g.stroke(); }
      else if (id === 'trem' || id === 'trill') { for (let i = 0; i < 3; i++) { g.globalAlpha = (Math.floor(ph * 12) % 3 === i) ? 1 : 0.35; g.fillRect(-s + i * s * 0.75, -s * 0.5, s * 0.45, s); } g.globalAlpha = 1; }
      else { g.beginPath(); g.arc(0, 0, s * (0.4 + 0.15 * Math.sin(ph * 6)), 0, 7); g.fill(); }
  }
  g.restore();
}

// Плашка «техника»: какая техника играется сейчас или будет через миг (с анимацией и подсказкой)
export function techCaption(notes, t, firstIdx, kind) {
  let best = null;
  for (let i = firstIdx(notes, t - 4); i < notes.length; i++) {
    const q = notes[i]; if (q.s > t + 1.3) break;
    if (q.e < t || !q.x) continue;
    const ids = techIds(q.x, q.f != null || q.st != null ? 'g' : kind).filter(id => TECH[id] && !['stroke_up', 'stroke_down', 'dyn', 'acc', 'tup', 'hand_L', 'leg', 'ten', 'cresc', 'dim'].includes(id));
    if (!ids.length) continue;
    const on = q.s <= t;
    if (!best || (on && !best.on) || (on === best.on && q.s < best.q.s)) best = { q, ids, on };
    if (on) break;
  }
  if (!best) return null;
  const id = best.ids[0], x = best.q.x;
  const short = i => { const nm = TECH[i].name, m = nm.match(/^([^(]+)\(([^)]+)\)/); if (m && /[a-z]/i.test(m[1])) return m[2][0].toUpperCase() + m[2].slice(1); return nm.split(' (')[0]; };
  let name = short(id);
  if (x.bend && (id === 'bend' || id === 'release')) name += ' ' + (bendText(x.bend.max).trim() === 'full' ? 'на тон' : bendText(x.bend.max).trim() === '½' ? 'на полтона' : bendText(x.bend.max).trim());
  if (x.sl && x.slTo != null && best.q.f != null) name += ` ${best.q.f} → ${x.slTo}`;
  if (x.detail) name += ' · ' + x.detail;
  if (best.ids.length > 1) name += ' · ' + best.ids.slice(1, 3).map(short).join(' · ');
  return { id, name, on: best.on, inSec: best.q.s - t };
}
export function drawCaption(g, cap, cx, y, ph) {
  if (!cap) return;
  g.font = '600 13px system-ui';
  const lbl = (cap.on ? '' : 'Скоро: ') + cap.name, tw = g.measureText(lbl).width, w = tw + 46, x = cx - w / 2, h = 26;
  g.beginPath(); const r = 13; g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  g.fillStyle = cap.on ? 'rgba(255,138,61,.92)' : 'rgba(23,26,33,.9)'; g.fill(); g.strokeStyle = cap.on ? '#ffb27a' : '#3a404c'; g.lineWidth = 1; g.stroke();
  drawTechIcon(g, cap.id, x + 18, y + h / 2, 8, ph, cap.on ? '#000' : '#ffd9bd');
  g.fillStyle = cap.on ? '#000' : '#ffd9bd'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(lbl, x + 34, y + h / 2 + 0.5);
}
