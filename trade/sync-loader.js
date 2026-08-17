(() => {
  'use strict';
  const DB_NAME = 'sharecapsule-trade-monitor';
  const STORE = 'local';
  const KEY_ID = 'device-key';

  function keyExists() {
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => resolve(false);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'id'});
      };
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY_ID);
        get.onerror = () => { db.close(); resolve(false); };
        get.onsuccess = () => { const ready = Boolean(get.result?.key); db.close(); resolve(ready); };
      };
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function start() {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await keyExists()) {
        try {
          await loadScript('./sync.js');
          await loadScript('./sync-collapse.js');
        } catch (error) {
          console.warn('Ticker Watch sync UI could not be started.', error);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn('Ticker Watch sync was not started because the local encryption key was unavailable.');
  }

  start();
})();
