const DB_NAME = "soda-reading";
const STORE_NAME = "documents";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withDatabase(mode, run) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => {
        db.close();
        resolve(request?.result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    } catch (error) {
      db.close();
      reject(error);
    }
  }));
}

export async function saveLocalDocument(document) {
  await withDatabase("readwrite", (store) => store.put(document));
  return document;
}

export async function listLocalDocuments() {
  const documents = await withDatabase("readonly", (store) => store.getAll());
  return (documents ?? []).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function getLocalDocument(id) {
  const document = await withDatabase("readonly", (store) => store.get(id));
  return document ?? null;
}

export function useStoredState(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function persistState(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const LEGACY_ACCOUNT_KEYS = {
  vocabulary: "soda.vocabulary",
  highlights: "soda.highlights",
  progress: "soda.progress",
  resume: "soda.resume",
};

export function accountStateKey(username, bucket) {
  const name = String(username || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "") || "local";
  return `soda.account.${name}.${bucket}`;
}

export function readAccountState(username, bucket, fallback) {
  const key = accountStateKey(username, bucket);
  const stored = localStorage.getItem(key);
  if (stored != null) {
    try {
      return JSON.parse(stored);
    } catch {
      return fallback;
    }
  }
  const legacyKey = LEGACY_ACCOUNT_KEYS[bucket];
  if (!legacyKey) return fallback;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy == null) return fallback;
  localStorage.setItem(key, legacy);
  localStorage.removeItem(legacyKey);
  try {
    return JSON.parse(legacy);
  } catch {
    return fallback;
  }
}

export function writeAccountState(username, bucket, value) {
  localStorage.setItem(accountStateKey(username, bucket), JSON.stringify(value));
}

export function resolveAccountBase(packet, owner, bucket, fallback) {
  if (packet?.owner === owner) return packet.value;
  if (!owner) return fallback;
  return readAccountState(owner, bucket, fallback);
}

