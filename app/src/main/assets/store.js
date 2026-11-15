// Хранилище: IndexedDB (композиции и исходные файлы), localStorage — только мелкие настройки
const DB = 'notyviz', VER = 1;
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs');
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
export const idb = {
  get: (store, k) => tx(store, 'readonly', s => s.get(k)),
  put: (store, k, v) => tx(store, 'readwrite', s => s.put(v, k)),
  del: (store, k) => tx(store, 'readwrite', s => s.delete(k)),
  all: store => tx(store, 'readonly', s => s.getAll())
};
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(k); } catch { } }
};
