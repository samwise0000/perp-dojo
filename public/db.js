// A minimal IndexedDB key-value store: the browser's copy of your trades.
// IndexedDB holds far more than localStorage, which matters for two years of fills.
const DB = 'perp-dojo', STORE = 'kv';
let opening = null;
function open() {
  opening ??= new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return opening;
}
const run = (mode, fn) => open().then(db => new Promise((ok, fail) => {
  const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
  tx.oncomplete = () => ok(req?.result ?? null);
  tx.onerror = () => fail(tx.error);
}));
export const idbGet = k => run('readonly', s => s.get(k));
export const idbSet = (k, v) => run('readwrite', s => s.put(v, k));
export const idbDel = k => run('readwrite', s => s.delete(k));
