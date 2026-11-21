// Учебные обозначения. Разметка хранится у исходной ноты и не меняет её высоту и тембр.
const rows = [
  ['g','barre','Баррэ','B','Прижмите несколько струн одним пальцем на одном ладу.'],
  ['g','alternate','Переменный штрих','↓↑','Чередуйте удары вниз и вверх, сохраняя пульс.'],
  ['g','downpick','Даунпикинг','↓↓','Извлекайте каждую ноту ударом медиатора вниз.'],
  ['g','sweep','Свип','SW','Проведите медиатор одним движением по соседним струнам, поочерёдно снимая пальцы.'],
  ['g','economy','Экономный штрих','ECO','При переходе на соседнюю струну продолжите движение медиатора в том же направлении.'],
  ['g','hybrid','Гибридный штрих','M+p','Играйте нижнюю струну медиатором, верхние подцепляйте свободными пальцами.'],
  ['g','fingerpick','Пальцевый перебор','pima','Распределите струны между большим, указательным, средним и безымянным пальцами.'],
  ['g','tapLeft','Тэппинг левой рукой','T·Л','Извлеките ноту ударом пальца левой руки по ладу.'],
  ['g','tapRight','Тэппинг правой рукой','T·П','Ударьте по выбранному ладу пальцем правой руки.'],
  ['g','unison','Бенд в унисон','B=','Оставьте соседнюю струну звучать и подтяните нижнюю по высоте ноту до совпадения.'],
  ['g','heldBend','Бенд с удержанием второй ноты','B+','Удерживайте соседнюю ноту на месте, подтягивая другую струну.'],
  ['g','skip','Пропуск струн','SK','Перенесите медиатор через промежуточную струну и заглушите её.'],
  ['g','restStroke','Апояндо','AP','После щипка остановите палец на соседней струне.'],
  ['g','freeStroke','Тирандо','TI','После щипка ведите палец к ладони, оставляя соседнюю струну свободной.'],
  ['g','classTrem','Классическое тремоло','pami','Играйте бас большим пальцем, затем мелодию безымянным, средним и указательным.'],
  ['g','bodyHit','Удар по корпусу','GOL','Коснитесь деки пальцем или основанием ладони в ритм партии.'],
  ['b','doubleThumb','Двойной удар большим пальцем','T↓↑','Проведите большим пальцем через струну и извлеките вторую ноту обратным движением.'],
  ['b','raking','Рейкинг','RK','Продолжайте щипок тем же пальцем на соседней более толстой струне.'],
  ['b','threeFinger','Трёхпальцевая игра','ami','Чередуйте безымянный, средний и указательный пальцы на повторяющейся фигуре.'],
  ['p','substitute','Подмена пальца','4→3','На удерживаемой клавише замените один палец другим без повторной атаки.'],
  ['p','crossL','Левая поверх правой','Л↗','Перенесите левую руку над правой к следующей группе клавиш.'],
  ['p','crossR','Правая поверх левой','П↖','Проведите правую руку над левой и заранее подготовьте место приземления.'],
  ['p','voicing','Выделение голоса','VO','Сыграйте отмеченную ноту выразительнее остальных звуков аккорда.'],
  ['p','sostenuto','Педаль sostenuto','Sost.','Нажмите среднюю педаль, удерживая выбранные клавиши, затем продолжите играть.'],
  ['p','halfPedal','Полупедаль','½ Ped','Уменьшите глубину нажатия правой педали для частичного глушения струн.'],
  ['d','rightHand','Правая рука','R','Сыграйте правой палочкой.'],['d','leftHand','Левая рука','L','Сыграйте левой палочкой.'],
  ['d','paradiddle','Парадидл','RLRR','Сыграйте R L R R, затем L R L L.'],
  ['d','flam','Флэм','Fl','Тихий предварительный удар одной рукой опережает основной удар другой.'],
  ['d','doubles','Двойки','RRLL','Играйте два равных удара каждой рукой.'],
  ['d','buzz','Дробь с отскоком','Z','Позвольте каждой палочке несколько раз отскочить, соединяя серии в непрерывную дробь.'],
  ['d','choke','Глушение тарелки','Ch','После удара остановите край тарелки рукой в отмеченный момент.'],
  ['d','leftFoot','Двойная педаль — левая нога','LF','Сыграйте отмеченный удар левой ногой.'],
  ['d','rightFoot','Двойная педаль — правая нога','RF','Сыграйте отмеченный удар правой ногой.'],
  ['s','upBow','Смычок вверх','V','Ведите смычок от конца к колодке.'],['s','downBow','Смычок вниз','Π','Ведите смычок от колодки к концу.'],
  ['s','oneBow','На один смычок','⌒','Соедините отмеченную группу одним движением смычка.'],
  ['s','spiccato','Спиккато','Sp','Позвольте смычку отскакивать после каждого короткого штриха.'],
  ['s','pizz','Пиццикато','pizz.','Отложите движение смычка и извлеките звук щипком.'],['s','arco','Возврат к смычку','arco','После щипков возобновите игру смычком.'],
  ['s','shiftPos','Смена позиции','Pos','Перенесите кисть вдоль грифа к следующей позиции.'],
  ['w','breath','Вдох','ʹ','Возьмите дыхание в отмеченной точке.'],['w','oneBreath','Фраза на одном дыхании','⌒','Распределите выдох до конца отмеченной фразы.'],
  ['w','doubleTongue','Двойная атака','TK','Чередуйте артикуляцию та-ка.'],['w','tripleTongue','Тройная атака','TTK','Равномерно повторяйте та-та-ка.'],
  ['w','flutter','Фруллато','frull.','На непрерывном выдохе добавьте раскатистую артикуляцию.'],
  ['w','tromPos','Позиция кулисы','Pos','Выдвиньте кулису до обозначенной позиции.'],
  ['m','malletRoll','Дробь палочками','RL','Чередуйте палочки для ровного продолжительного звука.'],
  ['m','fourMallet','Выбор из четырёх палочек','1–4','Считайте палочки слева направо и используйте указанную.'],
  ['m','damp','Глушение пластины','+','Остановите колебание пластины в отмеченной точке.']
];
export const GUIDE = Object.fromEntries(rows.map(([family,id,name,sym,how]) => [id,{for:family,name,sym,how,text:'Исполнительское обозначение в партии.'}]));
export function guideFamily(tr) {
  if (tr.kind === 'drums') return 'dm';
  if (tr.kind === 'bass' && tr.program === 32 && !/guitar|гитар/i.test(tr.name)) return 's';
  if (tr.kind === 'bass') return 'gb';
  if (['guitar','eguitar','aguitar'].includes(tr.kind)) return 'g';
  if (tr.kind === 'piano') return 'p';
  if (tr.program >= 40 && tr.program <= 51) return 's';
  if (tr.program >= 56 && tr.program <= 79) return 'w';
  if (tr.program >= 8 && tr.program <= 15) return 'm';
  return 'swm';
}
export function guitarPart(tr) {
  if (!tr || !['guitar','aguitar','eguitar','bass'].includes(tr.kind) || !tr.tuning) return false;
  const label = [tr.name,tr.instrument].join(' ').toLowerCase();
  if (/vocal|голос|вокал|sax|сакс|flute|флейт|violin|скрипк|cello|виолонч|bassoon|фагот|synth.?bass|синт.?бас|keyboard|фортеп|piano|trombone|trumpet|clarinet|контрабас|contrabass|double bass/.test(label)) return false;
  if (tr.program === 32 && !/гитар|guitar/i.test(tr.name || '')) return false;
  if ((tr.program >= 38 || tr.program < 24) && !/гитар|guitar|rhythm|ритм|бас-гитара|bass guitar/i.test(tr.name || '')) return false;
  return tr.notes.some(n => !n.deleted && n.s != null && n.f != null);
}
export function guideLabel(x) {
  if (!x) return '';
  return [...(x.guides || []).map(id => GUIDE[id]?.sym), x.leftFinger, x.rightFinger, x.detail].filter(Boolean).join(' ');
}

export function inferGuitarGuides(notes) {
  let previous = null;
  const ringing = new Map();
  for (let i = 0; i < notes.length;) {
    let end = i + 1;
    while (end < notes.length && notes[end].s === notes[i].s) end++;
    const group = notes.slice(i, end);
    for (const [st, q] of ringing) if (q.e <= group[0].s) ringing.delete(st);
    for (const q of group) ringing.set(q.st, q);
    for (const q of group) {
      if (q.x?.manualGuide) continue;
      const ids = new Set(q.x?.guides);
      if (previous && group.length === 1 && q.s - previous.e < 0.35 && Math.abs(previous.st - q.st) >= 2) ids.add('skip');
      if (q.x?.bend?.max > 0) {
        const held = [...ringing.values()].filter(other => other.st !== q.st && !other.x?.bend);
        if (held.length) ids.add(held.some(other => Math.abs(other.m - q.m - q.x.bend.max) < 0.1) ? 'unison' : 'heldBend');
      }
      if (ids.size) q.x = { ...q.x, guides: [...ids] };
    }
    previous = group.length === 1 ? group[0] : null;
    i = end;
  }
}

const aliases = {
  'sweep picking':'sweep', 'economy picking':'economy', 'hybrid picking':'hybrid',
  'alternate picking':'alternate', 'downpicking':'downpick','fingerpicking':'fingerpick',
  'apoyando':'restStroke','tirando':'freeStroke','golpe':'bodyHit','double thumb':'doubleThumb',
  'raking':'raking','spiccato':'spiccato','pizz.':'pizz','pizzicato':'pizz','arco':'arco',
  'flutter tongue':'flutter','frull.':'flutter','double tonguing':'doubleTongue','triple tonguing':'tripleTongue',
  'flam':'flam','paradiddle':'paradiddle','buzz roll':'buzz','choke':'choke','sost.':'sostenuto'
};
const namedGuides = new Map(Object.entries(GUIDE).map(([id,g]) => [g.name.toLowerCase(),id]));
export function guideFromText(text, tr) {
  if (typeof text !== 'string') return;
  const key = text.trim().toLowerCase();
  const id = namedGuides.get(key) || aliases[key];
  if (GUIDE[id] && guideFamily(tr).includes(GUIDE[id].for)) return id;
}
