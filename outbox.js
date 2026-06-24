// outbox.js - offline upload queue for photo saves.
//
// When a save can't reach Supabase (no signal), the photo plus everything needed to
// create it is stored in IndexedDB. When the device is back online the app uploads
// the queued items in order. IndexedDB is used (not localStorage) because the queued
// image data can be large.
//
// Item shape: { id, createdAt, payload } where payload is what commitSave() needs:
//   { targetPartId, newPart: { part_number, description, printers } | null,
//     partNumber, imageDataUrl, machine_label, position }

const DB_NAME = 'photo-tagger-outbox';
const DB_VERSION = 1;
const STORE = 'pending';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

export async function enqueue(payload) {
  const item = { id: crypto.randomUUID(), createdAt: Date.now(), payload };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve(item);
    tx.onerror = e => reject(e.target.error);
  });
}

export async function getAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('createdAt').getAll();
    req.onsuccess = e => resolve(e.target.result); // oldest first
    req.onerror = e => reject(e.target.error);
  });
}

export async function remove(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

export async function count() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
