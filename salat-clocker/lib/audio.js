/* Azan audio blobs in IndexedDB (with an in-memory fallback for tests). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalatAudio = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const DB_NAME = "salat-clocker";
  const STORE = "audio";
  const hasIDB = typeof indexedDB !== "undefined";
  const mem = {};

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function reqPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function save(id, blob) {
    if (!hasIDB) {
      mem[id] = blob;
      return;
    }
    const db = await openDb();
    await reqPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put(blob, id));
    db.close();
  }

  async function get(id) {
    if (!hasIDB) return mem[id] || null;
    const db = await openDb();
    const blob = await reqPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
    db.close();
    return blob || null;
  }

  async function remove(id) {
    if (!hasIDB) {
      delete mem[id];
      return;
    }
    const db = await openDb();
    await reqPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
    db.close();
  }

  return { save, get, remove };
});
