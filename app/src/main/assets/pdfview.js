// Оригинальные страницы PDF с отметками распознанных нот и ручной правкой
export class PdfView {
  constructor(el, pdfjsLib, onPick) {
    this.el = el; this.pdfjs = pdfjsLib; this.onPick = onPick; this.boxes = []; this.key = null;
  }
  async show(song, bytes) {
    const key = song.id + ':' + (song.editVer || 0);
    if (this.key === key) return;
    this.key = key;
    this.el.innerHTML = '<div class="muted small pad">Загружаю страницы…</div>';
    if (!bytes) { this.el.innerHTML = '<div class="muted pad">Исходный файл не сохранился. Откройте PDF заново, чтобы видеть оригинал.</div>'; return; }
    const doc = await this.pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    this.el.innerHTML = '';
    const tip = document.createElement('div'); tip.className = 'muted small pad';
    tip.textContent = 'Рамки — распознанные ноты. Нажмите на рамку, чтобы исправить или удалить ноту.';
    this.el.appendChild(tip);
    this.zoom = this.zoom || 1;
    const W = Math.round((Math.min(this.el.clientWidth || 360, 900) - 8) * this.zoom);
    const zb = document.createElement('div'); zb.className = 'row gap pad';
    for (const [z, t] of [[1, 'Страница целиком'], [1.7, 'Крупнее'], [2.6, 'Ещё крупнее']]) {
      const b = document.createElement('button'); b.className = 'chip' + (this.zoom === z ? ' on' : ''); b.textContent = t;
      b.onclick = () => { this.zoom = z; this.key = null; this.show(song, bytes); };
      zb.appendChild(b);
    }
    this.el.appendChild(zb);
    this.boxes = []; this.byBar = new Map();
    const NM = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
    const label = m => NM[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
    const pages = new Set(); for (const tr of song.tracks) for (const n of tr.notes) if (n.page) pages.add(n.page);
    const withLabels = !!song.omr;
    if (song.omr) tip.textContent = 'Рядом с каждой нотой — как она распознана. Оранжевые рамки — проверить, зелёные — исправлены. Нажмите на рамку, чтобы исправить высоту или удалить ноту.';
    for (let p = 1; p <= doc.numPages; p++) {
      if (!pages.has(p)) continue;
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = W / vp1.width, dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: scale * dpr });
      const wrap = document.createElement('div'); wrap.className = 'pdfpage'; wrap.style.width = W + 'px'; wrap.style.height = vp1.height * scale + 'px';
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.style.width = '100%'; c.style.height = '100%';
      wrap.appendChild(c); this.el.appendChild(wrap);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      song.tracks.forEach((tr, ti) => tr.notes.forEach((n, i) => {
        if (n.page !== p || !n.box || n.deleted) return;
        const b = document.createElement('div'); b.className = 'nbox' + (n.edited ? ' edited' : n.unsure ? ' unsure' : '');
        const [x0, y0, x1, y1] = n.box, pad = 1.5;
        Object.assign(b.style, { left: (x0 - pad) * scale + 'px', top: (y0 - pad) * scale + 'px', width: (x1 - x0 + pad * 2) * scale + 'px', height: (y1 - y0 + pad * 2) * scale + 'px' });
        if (withLabels && tr.kind !== 'drums') { const l = document.createElement('span'); l.className = 'nl'; l.textContent = label(n.m); b.appendChild(l); }
        b.onclick = e => { e.stopPropagation(); this.onPick(i, ti); };
        wrap.appendChild(b); const key = ti + ':' + i; this.boxes.push({ el: b, i, key });
        if (!this.byBar.has(n.bar)) this.byBar.set(n.bar, b);
      }));
    }
  }
  scrollToBar(bar) { const b = this.byBar && this.byBar.get(bar); if (b) b.scrollIntoView({ block: 'center' }); }
  highlight(activeSet) {
    for (const b of this.boxes) {
      const on = activeSet.has(b.key);
      if (on !== b.on) { b.on = on; b.el.classList.toggle('on', on); if (on && this.follow) b.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  }
}
