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
    const tr = song.tracks[0];
    const W = Math.min(this.el.clientWidth || 360, 900) - 8;
    this.boxes = [];
    const pages = new Set(tr.notes.map(n => n.page).filter(Boolean));
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
      tr.notes.forEach((n, i) => {
        if (n.page !== p || !n.box) return;
        const b = document.createElement('div'); b.className = 'nbox' + (n.edited ? ' edited' : '');
        const [x0, y0, x1, y1] = n.box, pad = 1.5;
        Object.assign(b.style, { left: (x0 - pad) * scale + 'px', top: (y0 - pad) * scale + 'px', width: (x1 - x0 + pad * 2) * scale + 'px', height: (y1 - y0 + pad * 2) * scale + 'px' });
        b.onclick = e => { e.stopPropagation(); this.onPick(i); };
        wrap.appendChild(b); this.boxes.push({ el: b, i });
      });
    }
  }
  highlight(activeSet) {
    for (const b of this.boxes) {
      const on = activeSet.has(b.i);
      if (on !== b.on) { b.on = on; b.el.classList.toggle('on', on); if (on && this.follow) b.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  }
}
