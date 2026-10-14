(function (scope) {
  const DB_NAME = "cartoon-clipper-pending-uploads";
  const DB_VERSION = 1;
  const STORE_NAME = "items";

  function createIndexedDbStore(indexedDb = scope.indexedDB) {
    if (!indexedDb) throw new Error("当前浏览器不支持待上传队列");
    let databasePromise = null;

    const database = () => {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDb.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("待上传队列打开失败"));
      });
      return databasePromise;
    };

    const run = async (mode, makeRequest) => {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = makeRequest(transaction.objectStore(STORE_NAME));
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error("待上传队列操作失败"));
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error || new Error("待上传队列写入失败"));
        transaction.onerror = () => reject(transaction.error || new Error("待上传队列操作失败"));
      });
    };

    return {
      put: (item) => run("readwrite", (store) => store.put(item)),
      list: () => run("readonly", (store) => store.getAll()),
      delete: (id) => run("readwrite", (store) => store.delete(id)),
      count: () => run("readonly", (store) => store.count()),
    };
  }

  function createQueue({ store }) {
    if (!store) throw new Error("缺少待上传存储");
    let flushPromise = null;

    const count = () => store.count();
    const enqueue = async (item) => {
      if (!item?.id || !item?.dataUrl) throw new Error("待上传图片不完整");
      await store.put(item);
      return count();
    };
    const flush = (upload) => {
      if (flushPromise) return flushPromise;
      if (typeof upload !== "function") throw new Error("缺少上传方法");
      flushPromise = (async () => {
        let uploadedCount = 0;
        let attempted = false;
        while (true) {
          const items = await store.list();
          if (!items.length) {
            return { ok: true, attempted, uploadedCount, pendingCount: 0, error: "" };
          }
          attempted = true;
          for (const item of items) {
            let result;
            try {
              result = await upload(item);
            } catch (error) {
              result = { ok: false, error: error?.message || String(error || "") };
            }
            if (!result?.ok) {
              return {
                ok: false,
                attempted: Boolean(result?.attempted),
                uploadedCount,
                pendingCount: await count(),
                error: result?.error || "",
              };
            }
            await store.delete(item.id);
            uploadedCount += 1;
          }
        }
      })().finally(() => { flushPromise = null; });
      return flushPromise;
    };

    return { enqueue, flush, count };
  }

  const api = { createIndexedDbStore, createQueue };
  scope.CartoonClipperPendingUploads = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
