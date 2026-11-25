// ============================================================
// IndexedDB 轻量封装
// stores:
//   localComments  离线/本地审阅意见（按 commentId 合并）
//   drafts         回执草案（离线可写，联网提交）
//   receipts       回执账（追加）
//   packages       物化签名交付包
//   audit          审计事件（追加）
//   kv              服务端状态快照 / 会话
// ============================================================

const DB_NAME = 'dcp-delivery-contract';
const DB_VERSION = 1;

export const STORES = {
  localComments: 'localComments',
  drafts: 'drafts',
  receipts: 'receipts',
  packages: 'packages',
  audit: 'audit',
  kv: 'kv',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.localComments)) {
        db.createObjectStore(STORES.localComments, { keyPath: 'commentId' });
      }
      if (!db.objectStoreNames.contains(STORES.drafts)) {
        db.createObjectStore(STORES.drafts, { keyPath: 'draftId' });
      }
      if (!db.objectStoreNames.contains(STORES.receipts)) {
        db.createObjectStore(STORES.receipts, { keyPath: 'receiptId' });
      }
      if (!db.objectStoreNames.contains(STORES.packages)) {
        db.createObjectStore(STORES.packages, { keyPath: 'packageId' });
      }
      if (!db.objectStoreNames.contains(STORES.audit)) {
        db.createObjectStore(STORES.audit, { keyPath: 'eventId' });
      }
      if (!db.objectStoreNames.contains(STORES.kv)) {
        db.createObjectStore(STORES.kv, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export async function idbPut<T extends object>(store: string, value: T): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.put(value));
}

export async function idbBulkPut<T extends object>(store: string, values: T[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(key));
}

export async function idbClear(store: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await idbPut(STORES.kv, { key, value });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await idbGet<{ key: string; value: T }>(STORES.kv, key);
  return row?.value;
}

export async function wipeAll(): Promise<void> {
  const db = await openDb();
  await Promise.all(
    Object.values(STORES).map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(name, 'readwrite');
          t.objectStore(name).clear();
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        }),
    ),
  );
}
