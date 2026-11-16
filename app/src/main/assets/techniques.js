// Система музыкальных техник (Musical Techniques).
// Здесь только музыкальная логика и справка: какие техники бывают, как их хранить у ноты,
// как они звучат (реализация в MIDI-события). Отрисовка — в views.js, звук — в model.js/engine.js.
//
// У каждой ноты (событие) есть: t (начало, тики), d (длительность), m (высота MIDI), v (динамика 1–127),
// s/f (струна/лад для струнных), x (техники и артикуляция: объект ниже), h (рука для фортепиано).
// У дорожки: bends — кривая подтяжки/рычага канала [[тик, полутоны], ...], pedal — [[начало, конец], ...].
//
// x = { hp:'h'|'p', sl:'shift'|'legato'|'up'|'down'|'pickdown'|'pickup'|'inbelow'|'inabove', slTo: лад/высота,
//       bend:{type, max (полутоны), pts:[[0..60, полутоны]]}, vib:'slight'|'wide', tr: высота трели, trillAux: true,
//       tap, pm, harm:'N'|'A'|'P'|'T'|'S'|'F', trem: штрихи, dead, ghost, ring, stroke:'up'|'down',
//       brush:'up'|'down', arp:'up'|'down', whammy:{type, pts}, slap, pop, rasg,
//       stacc, acc: 1 акцент | 2 маркато | 3 тенуто, leg (легато к следующей), orn:'turn'|'iturn'|'umord'|'lmord',
//       gliss, grace:'before'|'on'|'bend', ferm:'short'|'medium'|'long', cresc:'cresc'|'dim', dyn:'pp'…, tup:'3:2', ott:'8va'… }

export const TECH = {
  hp_h: { name: 'Hammer-on (хаммер-он)', sym: 'h', for: 'g', text: 'Следующая нота извлекается ударом пальца левой руки по ладу, без удара медиатором.', how: 'Сыграйте первую ноту, затем резко «молоточком» опустите другой палец на нужный лад той же струны.', anim: 'hammer' },
  hp_p: { name: 'Pull-off (пулл-офф)', sym: 'p', for: 'g', text: 'Следующая нота звучит, когда палец снимается со струны.', how: 'Прижмите обе ноты заранее. Снимая верхний палец, слегка зацепите струну вниз — прозвучит нижняя нота.', anim: 'pull' },
  sl: { name: 'Слайд (скольжение)', sym: '/ \\', for: 'g', text: 'Палец скользит по струне к другому ладу, звук не прерывается.', how: 'Не ослабляя прижатия, ведите палец вдоль струны до целевого лада. При «legato»-слайде вторую ноту не играют медиатором, при «shift» — играют.', anim: 'slide' },
  bend: { name: 'Бенд (подтяжка)', sym: 'b ↑', for: 'g', text: 'Струна подтягивается поперёк грифа, высота звука растёт.', how: 'Прижмите лад и, помогая соседними пальцами, тяните струну вверх (или вниз), пока не услышите нужную ноту: ½ — на полтона, full — на тон.', anim: 'bend' },
  release: { name: 'Release (возврат бенда)', sym: 'r ↓', for: 'g', text: 'Подтянутая струна плавно возвращается на место, звук опускается.', how: 'После бенда, не отпуская лад, медленно верните струну в обычное положение.', anim: 'release' },
  vib: { name: 'Вибрато', sym: '~', for: 'gp', text: 'Высота ноты периодически слегка колеблется.', how: 'На гитаре — ритмично и немного подтягивайте и отпускайте струну. «Широкое» вибрато — с большей амплитудой.', anim: 'vibrato' },
  trill: { name: 'Трель', sym: 'tr', for: 'gp', text: 'Быстрое чередование основной ноты и соседней.', how: 'Гитара: быстро чередуйте хаммер-он и пулл-офф. Фортепиано: быстро и ровно чередуйте две соседние клавиши.', anim: 'trill' },
  tap: { name: 'Тэппинг', sym: 'T', for: 'g', text: 'Нота извлекается ударом пальца правой руки по ладу.', how: 'Указательным или средним пальцем правой руки резко прижмите струну на нужном ладу, затем сорвите палец (пулл-офф).', anim: 'tap' },
  pm: { name: 'Palm Mute (глушение ладонью)', sym: 'P.M.', for: 'g', text: 'Струны приглушаются ребром ладони — короткий плотный звук.', how: 'Положите ребро правой ладони на струны у самой подставки и играйте, не убирая её.', anim: 'mute' },
  harm_N: { name: 'Натуральный флажолет', sym: 'NH ◇', for: 'g', text: 'Призрачный звенящий звук: палец лишь касается струны над ладовой порожкой.', how: 'Легко коснитесь струны точно над порожкой (12, 7, 5 лад), не прижимая, ударьте и сразу уберите палец.', anim: 'harmonic' },
  harm_A: { name: 'Искусственный флажолет', sym: 'AH', for: 'g', text: 'Флажолет на 12 ладов выше прижатой ноты.', how: 'Прижмите ноту, указательным пальцем правой руки коснитесь струны на 12 ладов выше и заденьте её большим пальцем или медиатором.', anim: 'harmonic' },
  harm_P: { name: 'Щипковый флажолет', sym: 'PH', for: 'g', text: 'Визжащий высокий призвук, характерный для рока и метала.', how: 'Держите медиатор так, чтобы большой палец сразу после удара чиркнул по струне. Положение руки определяет высоту призвука.', anim: 'harmonic' },
  harm_T: { name: 'Тэп-флажолет', sym: 'TH', for: 'g', text: 'Флажолет, извлечённый ударом пальца правой руки по струне над порожкой.', how: 'Прижмите ноту и коротко ударьте пальцем правой руки по струне на 12 ладов выше.', anim: 'harmonic' },
  harm_S: { name: 'Полуфлажолет', sym: 'SH', for: 'g', text: 'Смесь обычного звука и флажолета.', how: 'Как щипковый флажолет, но большой палец касается струны слабее.', anim: 'harmonic' },
  harm_F: { name: 'Флажолет от обратной связи', sym: 'Fdbk', for: 'g', text: 'Звук, раскачанный обратной связью усилителя.', how: 'Держите ноту рядом с громким усилителем, пока она не перейдёт в протяжный обертон.', anim: 'harmonic' },
  trem: { name: 'Тремоло (повтор ноты)', sym: '≡', for: 'gp', text: 'Очень быстрое многократное повторение одной ноты.', how: 'Гитара: быстрые удары медиатором вверх-вниз. Фортепиано: быстро чередуйте пальцы на клавише (или два звука).', anim: 'tremolo' },
  dead: { name: 'Глухая нота (dead note)', sym: 'x', for: 'g', text: 'Перкуссионный щелчок без высоты.', how: 'Слегка коснитесь струны пальцами левой руки, не прижимая к ладу, и ударьте по ней.', anim: 'dead' },
  ghost: { name: 'Призрачная нота', sym: '( )', for: 'gp', text: 'Очень тихая, едва слышная нота.', how: 'Сыграйте ноту заметно тише соседних.', anim: 'ghost' },
  ring: { name: 'Let Ring (пусть звучит)', sym: 'l.r.', for: 'g', text: 'Ноты не глушатся и продолжают звучать вместе.', how: 'Не снимайте пальцы с ладов и не глушите струны, пока звучат следующие ноты.', anim: 'ring' },
  stroke_up: { name: 'Удар вверх (апстрок)', sym: '↑ V', for: 'g', text: 'Медиатор движется снизу вверх.', how: 'Ударьте по струнам движением от пола к потолку.', anim: 'up' },
  stroke_down: { name: 'Удар вниз (даунстрок)', sym: '↓ ⊓', for: 'g', text: 'Медиатор движется сверху вниз.', how: 'Ударьте по струнам движением от потолка к полу.', anim: 'down' },
  brush: { name: 'Расщипанный аккорд (brush)', sym: '↕', for: 'g', text: 'Ноты аккорда звучат не одновременно, а быстро друг за другом.', how: 'Проведите медиатором или пальцами по струнам не мгновенно, а с небольшим растягиванием.', anim: 'arp' },
  whammy: { name: 'Рычаг тремоло (whammy bar)', sym: 'w/bar', for: 'g', text: 'Высота всех звучащих нот меняется рычагом бриджа.', how: 'Нажмите или потяните рычаг тремоло на нужную величину и верните его.', anim: 'bend' },
  slap: { name: 'Слэп', sym: 'S', for: 'b', text: 'Удар большим пальцем по струне бас-гитары — щёлкающий звук.', how: 'Ударьте боковой стороной большого пальца по струне у конца грифа и сразу отскочите.', anim: 'tap' },
  pop: { name: 'Поп', sym: 'P', for: 'b', text: 'Струна подцепляется пальцем и отпускается — хлёсткий звук.', how: 'Подцепите струну указательным или средним пальцем, оттяните от грифа и отпустите.', anim: 'pull' },
  rasg: { name: 'Расгеадо', sym: 'rasg.', for: 'g', text: 'Фламенко-техника: веерный удар пальцами по струнам.', how: 'Сожмите пальцы в кулак и по очереди резко «выстреливайте» ими по струнам, начиная с мизинца.', anim: 'arp' },
  stacc: { name: 'Стаккато', sym: '•', for: 'gp', text: 'Отрывисто: нота короче записанной длительности.', how: 'Сразу после нажатия отпустите клавишу (или заглушите струну) — примерно вдвое короче.', anim: 'staccato' },
  acc: { name: 'Акцент', sym: '>', for: 'gp', text: 'Нота громче соседних.', how: 'Сыграйте эту ноту с заметно большей силой.', anim: 'accent' },
  marc: { name: 'Маркато', sym: '^', for: 'gp', text: 'Сильный, подчёркнутый акцент.', how: 'Сыграйте ноту очень решительно и громко, слегка отделяя от соседних.', anim: 'accent' },
  ten: { name: 'Тенуто', sym: '–', for: 'gp', text: 'Выдержать ноту полностью, с лёгким нажимом.', how: 'Держите клавишу на всю длительность, чуть выделяя ноту.', anim: 'ring' },
  leg: { name: 'Легато', sym: '⌒', for: 'gp', text: 'Ноты связно переходят одна в другую без пауз.', how: 'Отпускайте клавишу только в момент нажатия следующей.', anim: 'legato' },
  orn_turn: { name: 'Группетто', sym: '∾', for: 'p', text: 'Украшение: верхняя соседняя, основная, нижняя соседняя, основная.', how: 'Быстро сыграйте четыре ноты: на ступень выше, основную, на ступень ниже, основную.', anim: 'turn' },
  orn_iturn: { name: 'Обратное группетто', sym: '∿', for: 'p', text: 'Группетто, начинающееся с нижней ноты.', how: 'Быстро: ступень ниже, основная, ступень выше, основная.', anim: 'turn' },
  orn_umord: { name: 'Мордент', sym: '𝆖', for: 'p', text: 'Быстрое «основная — верхняя — основная».', how: 'На начале доли быстро сыграйте основную, соседнюю сверху и снова основную.', anim: 'trill' },
  orn_lmord: { name: 'Перечёркнутый мордент', sym: '𝆗', for: 'p', text: 'Быстрое «основная — нижняя — основная».', how: 'На начале доли быстро сыграйте основную, соседнюю снизу и снова основную.', anim: 'trill' },
  gliss: { name: 'Глиссандо', sym: 'gliss.', for: 'p', text: 'Скольжение по клавишам от одной ноты к другой.', how: 'Проведите ногтем (обратной стороной пальца) по белым клавишам от начальной ноты к конечной.', anim: 'gliss' },
  grace: { name: 'Форшлаг', sym: '♪', for: 'gp', text: 'Очень короткая украшающая нота перед основной.', how: 'Сыграйте маленькую ноту как можно быстрее и сразу переходите на основную.', anim: 'grace' },
  arp: { name: 'Арпеджио', sym: '⌇', for: 'p', text: 'Ноты аккорда берутся быстро одна за другой (обычно снизу вверх).', how: 'Нажимайте клавиши аккорда по очереди очень быстро, удерживая уже нажатые.', anim: 'arp' },
  ferm: { name: 'Фермата', sym: '𝄐', for: 'gp', text: 'Нота (или пауза) выдерживается дольше записанного.', how: 'Задержитесь на этой ноте примерно в полтора-два раза дольше, по ощущению.', anim: 'ring' },
  pedal: { name: 'Педаль сустейна', sym: 'Ped.', for: 'p', text: 'Правая педаль: звуки продолжают звучать после отпускания клавиш.', how: 'Нажмите правую педаль ногой там, где начинается полоса педали, и отпустите в её конце (символ *).', anim: 'pedal' },
  pedalUp: { name: 'Снятие педали', sym: '*', for: 'p', text: 'Педаль отпускается — звучание глушится.', how: 'Поднимите ногу с педали в отмеченный момент; для «чистой» смены педали отпустите и сразу нажмите снова.', anim: 'pedal' },
  cresc: { name: 'Крещендо', sym: '<', for: 'gp', text: 'Постепенно громче.', how: 'Плавно усиливайте нажим на протяжении знака.', anim: 'cresc' },
  dim: { name: 'Диминуэндо', sym: '>', for: 'gp', text: 'Постепенно тише.', how: 'Плавно ослабляйте нажим на протяжении знака.', anim: 'dim' },
  dyn: { name: 'Динамика', sym: 'pp p mp mf f ff', for: 'gp', text: 'Общая громкость фрагмента: pp — очень тихо, p — тихо, mp — умеренно тихо, mf — умеренно громко, f — громко, ff — очень громко.', how: 'Держите указанную громкость до следующего обозначения.', anim: 'cresc' },
  tup: { name: 'Триоль / группа', sym: '3', for: 'gp', text: 'Несколько нот укладываются в время другого числа нот (например, 3 восьмые вместо 2).', how: 'Распределите ноты группы равномерно на отведённое время: «раз-и-а» вместо «раз-и».', anim: 'tuplet' },
  ott: { name: 'Перенос на октаву', sym: '8va', for: 'p', text: '8va — играть на октаву выше записанного, 8vb — ниже (15ma/15mb — на две).', how: 'Сдвиньте руку на октаву (или две) в указанную сторону на протяжении знака.', anim: 'gliss' },
  hand_L: { name: 'Левой рукой (L.H.)', sym: 'L.H.', for: 'p', text: 'Отмеченные ноты играются левой рукой, хотя записаны в партии правой.', how: 'Перенесите эти ноты в левую руку.', anim: 'accent' }
};

const DYN = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'pppp', 'ppppp', 'pppppp', 'ffff', 'fffff', 'ffffff', 'sf', 'sfp', 'sfpp', 'fp', 'rf', 'rfz', 'sfz', 'sffz', 'fz', 'n', 'pf', 'sfzp'];
export const dynName = i => DYN[i] || null;
export const velToDyn = v => v < 30 ? 'pp' : v < 50 ? 'p' : v < 66 ? 'mp' : v < 84 ? 'mf' : v < 104 ? 'f' : 'ff';

// Список техник ноты → ключи справочника TECH
export function techIds(x, kind) {
  if (!x) return [];
  const ids = [];
  if (x.hp) ids.push('hp_' + x.hp);
  if (x.sl) ids.push(kind === 'piano' ? 'gliss' : 'sl');
  if (x.gliss) ids.push('gliss');
  if (x.bend) ids.push(/release/i.test(x.bend.type) && !/bend/i.test(x.bend.type.replace('release', '')) ? 'release' : 'bend');
  if (x.vib) ids.push('vib');
  if (x.tr != null || x.trillAux) ids.push('trill');
  if (x.tap) ids.push('tap');
  if (x.pm) ids.push('pm');
  if (x.harm) ids.push('harm_' + x.harm);
  if (x.trem) ids.push('trem');
  if (x.dead) ids.push('dead');
  if (x.ghost) ids.push('ghost');
  if (x.ring) ids.push('ring');
  if (x.stroke) ids.push('stroke_' + x.stroke);
  if (x.brush) ids.push('brush');
  if (x.arp) ids.push('arp');
  if (x.whammy) ids.push('whammy');
  if (x.slap) ids.push('slap');
  if (x.pop) ids.push('pop');
  if (x.rasg) ids.push('rasg');
  if (x.stacc) ids.push('stacc');
  if (x.acc === 1) ids.push('acc'); else if (x.acc === 2) ids.push('marc'); else if (x.acc === 3) ids.push('ten');
  if (x.leg) ids.push('leg');
  if (x.orn) ids.push('orn_' + x.orn);
  if (x.grace) ids.push('grace');
  if (x.ferm) ids.push('ferm');
  if (x.cresc) ids.push(x.cresc === 'dim' ? 'dim' : 'cresc');
  if (x.dynMark) ids.push('dyn');
  if (x.tup) ids.push('tup');
  if (x.ott) ids.push('ott');
  if (x.lh) ids.push('hand_L');
  return ids;
}

// Короткая подпись техники для табулатуры и падающих нот
export function techLabel(x) {
  if (!x) return '';
  const L = [];
  if (x.harm) L.push(x.harm === 'N' ? 'NH' : x.harm + 'H');
  if (x.pm) L.push('PM');
  if (x.tap) L.push('T');
  if (x.slap) L.push('S'); if (x.pop) L.push('P');
  if (x.bend) L.push('b' + bendText(x.bend.max));
  if (x.vib) L.push('~');
  if (x.tr != null) L.push('tr');
  if (x.trem) L.push('≡');
  if (x.ring) L.push('l.r.');
  if (x.whammy) L.push('w/b');
  if (x.rasg) L.push('rasg');
  return L.join(' ');
}
export function bendText(semi) {
  if (semi == null) return '';
  const t = Math.round(semi * 2) / 4; // полутоны → тоны, шаг ¼
  if (t === 0.25) return '¼'; if (t === 0.5) return '½'; if (t === 1) return ' full'; if (t === 0.75) return '¾';
  if (t === 1.5) return ' 1½'; if (t === 2) return ' 2';
  return ' ' + (+t.toFixed(2));
}

// Значение кривой [[тик, полутоны], ...] в момент tick (ступенчато-линейно)
export function curveAt(curve, tick) {
  if (!curve || !curve.length) return 0;
  let lo = 0, hi = curve.length - 1;
  if (tick < curve[0][0]) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (curve[m][0] <= tick) lo = m; else hi = m - 1; }
  return curve[lo][1];
}

// Динамика — громкость (velocity) MIDI
export const DYN_VEL = { pppp: 12, ppp: 20, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 124, ffff: 127, sfz: 120, fz: 118, sf: 116, fp: 96 };

// ---------- Звучание техник (для нот, у которых его ещё нет: PDF и т. п.) ----------
// Возвращает список звучащих событий для ноты: [{ t, d, m, v, ch:'pm'|'harm'|'dead'|null }],
// и добавляет подтяжки в bends (кривая канала) — для слайдов, бендов и вибрато.
export function realize(n, ctx) {
  const x = n.x || {};
  const P = ctx.ppq;
  let t = n.t, d = n.d, m = n.m, v = n.v || 96;
  const out = [];
  if (x.ghost) v = Math.round(v * 0.55);
  if (x.acc === 1) v = Math.min(127, Math.round(v * 1.25)); else if (x.acc === 2) v = Math.min(127, Math.round(v * 1.4));
  if (x.stacc) d = Math.max(P / 16, Math.round(d * 0.5));
  if (x.ferm) d = Math.round(d * (x.ferm === 'long' ? 2 : x.ferm === 'short' ? 1.3 : 1.6));
  if (x.pm) { d = Math.min(d, Math.round(P * 0.14)); v = Math.round(v * 0.9); }
  if (x.dead) { d = Math.min(d, Math.round(P / 20)); v = Math.round(v * 0.8); }
  if (x.harm === 'A' || x.harm === 'T') m += 12;
  else if (x.harm === 'N' && n.f != null) m = (n.m - n.f) + naturalHarmonic(n.f);
  else if (x.harm === 'P' || x.harm === 'S') m += 19;
  const ch = x.dead ? 'dead' : x.pm ? 'pm' : x.harm ? 'harm' : null;
  if (x.tr != null && x.tr !== m) {
    const step = Math.max(P / 16, P / 8);
    for (let k = 0, tt = t; tt < t + d - 1; k++, tt += step) out.push({ t: tt, d: Math.min(step, t + d - tt), m: k % 2 ? x.tr : m, v, ch });
    return out;
  }
  if (x.trem) {
    const step = P / Math.pow(2, Math.max(1, x.trem));
    for (let tt = t; tt < t + d - 1; tt += step) out.push({ t: tt, d: Math.min(step, t + d - tt), m, v, ch });
    return out;
  }
  if (x.orn) {
    const up = x.orn === 'umord' || x.orn === 'turn' ? 2 : -2, s = Math.min(P / 8, d / 4);
    const seq = x.orn === 'turn' ? [m + 2, m, m - 2, m] : x.orn === 'iturn' ? [m - 2, m, m + 2, m] : [m, m + up, m];
    seq.forEach((q, k) => out.push({ t: t + k * s, d: k === seq.length - 1 ? d - k * s : s, m: q, v, ch: null }));
    return out;
  }
  if (x.gliss && x.slTo != null && ctx.kind === 'piano') {
    const to = x.slTo, dir = to > m ? 1 : -1, keys = [];
    for (let q = m; dir > 0 ? q < to : q > to; q += dir) if (![1, 3, 6, 8, 10].includes(((q % 12) + 12) % 12)) keys.push(q);
    const s = d / Math.max(1, keys.length);
    keys.forEach((q, k) => out.push({ t: t + k * s, d: s, m: q, v: Math.round(v * 0.85), ch: null }));
    return out;
  }
  out.push({ t, d, m, v, ch });
  // подтяжки для струнных: бенд, вибрато, слайд → кривая высоты
  if (ctx.bends && (x.bend || x.vib || (x.sl && x.slTo != null && ctx.kind !== 'piano'))) {
    const B = ctx.bends;
    const slDiff = x.sl && x.slTo != null && n.f != null ? x.slTo - n.f : 0;
    // высота в доле ноты o ∈ [0, 60]: подтяжка + слайд (вибрато качает вокруг неё, а не вокруг нуля)
    const base = o => {
      let v = 0;
      if (x.bend && x.bend.pts && x.bend.pts.length) { const pts = x.bend.pts; if (o <= pts[0][0]) v = pts[0][1]; else { v = pts[pts.length - 1][1]; for (let k = 1; k < pts.length; k++) if (o <= pts[k][0]) { const [a0, va] = pts[k - 1], [a1, vb] = pts[k]; v = va + (vb - va) * (a1 > a0 ? (o - a0) / (a1 - a0) : 1); break; } } }
      if (slDiff) { const f = Math.max(0, Math.min(1, (o / 60 - 0.5) * 2)); v += slDiff * Math.round(f * 6) / 6; }
      return v;
    };
    if (x.vib) {
      const amp = (x.vib === 'wide' ? 0.5 : 0.25) * 0.5, step = P / 16;
      for (let tt = t, k = 0; tt < t + d; tt += step, k++) B.push([Math.round(tt), base((tt - t) / d * 60) + amp * Math.sin(k * Math.PI / 2)]);
    } else {
      if (x.bend && x.bend.pts) for (const [o, semi] of x.bend.pts) B.push([Math.round(t + d * o / 60), semi]);
      if (slDiff) for (let k = 0; k <= 6; k++) B.push([Math.round(t + d * (0.5 + k / 12)), slDiff * k / 6]);
    }
    B.push([t + d, 0]);
  }
  return out;
}
// Высота натурального флажолета по ладу (в полутонах над открытой струной)
export function naturalHarmonic(fret) {
  const H = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31, 2: 34, 15: 31 };
  return H[Math.round(fret)] != null ? H[Math.round(fret)] : 12 + fret;
}

// ---------- Исполнение дорожки ----------
// Превращает ноты дорожки в звучащие события с учётом техник. Используется и для звука, и для картинки,
// поэтому они всегда совпадают. Ноты, у которых звучание уже рассчитано при импорте (real), не меняются,
// кроме расщипанных аккордов/арпеджио (их растягиваем по времени сами).
export function perform(track, ppq, oct = 0) {
  const kind = track.kind;
  const bends = [];
  const events = [];
  const ctx = { ppq, kind, bends };
  track.notes.forEach((n, i) => {
    if (n.deleted || n.tie) return;
    const evs = n.real ? [{ t: n.t, d: n.d, m: n.m, v: n.v || 96, ch: n.x ? (n.x.dead ? 'dead' : n.x.pm ? 'pm' : n.x.harm ? 'harm' : null) : null }] : realize(n, ctx);
    for (const e of evs) { e.src = i; e.m += kind === 'drums' ? 0 : 12 * oct; events.push(e); }
  });
  // арпеджио, расщипанный аккорд, удар вверх/вниз: ноты аккорда по очереди
  const byT = new Map();
  for (const e of events) { const x = track.notes[e.src].x; if (x && (x.arp || x.brush || x.stroke || x.rasg)) { if (!byT.has(e.t)) byT.set(e.t, []); byT.get(e.t).push(e); } }
  for (const [t, ch] of byT) {
    if (ch.length < 2) continue;
    const x = track.notes[ch[0].src].x;
    const dir = x.arp || x.brush || x.stroke || 'down';
    // «вниз» по струнам гитары = от низкой ноты к высокой; арпеджио «вверх» — тоже снизу вверх
    const asc = (x.arp && dir === 'up') || (!x.arp && dir === 'down') || x.rasg;
    ch.sort((a, b) => asc ? a.m - b.m : b.m - a.m);
    const total = Math.min(x.arp ? ppq / 2 : ppq / 6, Math.min(...ch.map(e => e.d)) * 0.6);
    const step = total / (ch.length - 1);
    ch.forEach((e, k) => { const off = Math.round(step * k); e.t += off; e.d = Math.max(1, e.d - off); });
  }
  events.sort((a, b) => a.t - b.t || a.m - b.m);
  // кривая подтяжек: из файла (track.bends) + рассчитанная для PDF
  let curve = track.bends ? track.bends.slice() : [];
  if (bends.length) { curve = curve.concat(bends).sort((a, b) => a[0] - b[0]); }
  return { events, bends: curve };
}
