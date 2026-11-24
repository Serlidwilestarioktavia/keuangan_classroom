(function () {
  "use strict";

  var DATABASE_NAME = "MyMoneyDatabase";
  var DATABASE_VERSION = 1;
  var STORE_NAME = "records";
  var STATE_ID = "main";
  var LEGACY_KEY = "mymoney-data-v1";

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("Browser ini tidak mendukung IndexedDB. Buka MyMoney di browser versi terbaru."));
        return;
      }

      var request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("Database MyMoney tidak dapat dibuka.")); };
      request.onblocked = function () { reject(new Error("Database MyMoney sedang dibuka di tab lain. Tutup tab lama lalu coba lagi.")); };
    });
  }

  function readRecord(database) {
    return new Promise(function (resolve, reject) {
      var transaction = database.transaction(STORE_NAME, "readonly");
      var request = transaction.objectStore(STORE_NAME).get(STATE_ID);
      request.onsuccess = function () { resolve(request.result ? request.result.value : null); };
      request.onerror = function () { reject(request.error || new Error("Data MyMoney tidak dapat dibaca.")); };
      transaction.onabort = function () { reject(transaction.error || new Error("Pembacaan database dibatalkan.")); };
    });
  }

  function writeRecord(database, value) {
    return new Promise(function (resolve, reject) {
      var transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ id: STATE_ID, value: value });
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error("Data MyMoney tidak dapat disimpan.")); };
      transaction.onabort = function () { reject(transaction.error || new Error("Penyimpanan database dibatalkan.")); };
    });
  }

  async function loadState() {
    var database = await openDatabase();
    try {
      var state = await readRecord(database);
      if (state) return state;

      var legacyValue;
      try {
        legacyValue = window.localStorage.getItem(LEGACY_KEY);
      } catch (error) {
        console.warn("Data lama MyMoney tidak dapat diakses untuk migrasi.", error);
        return null;
      }
      if (!legacyValue) return null;

      try {
        state = JSON.parse(legacyValue);
      } catch (error) {
        console.error("Data lama MyMoney tidak valid dan tidak dapat dimigrasikan.", error);
        return null;
      }
      await writeRecord(database, state);
      try {
        window.localStorage.removeItem(LEGACY_KEY);
      } catch (error) {
        console.warn("Data MyMoney sudah dimigrasikan, tetapi data lama tidak dapat dihapus.", error);
      }
      return state;
    } finally {
      database.close();
    }
  }

  async function saveState(state) {
    var database = await openDatabase();
    try {
      await writeRecord(database, state);
    } finally {
      database.close();
    }
  }

  window.MyMoneyDB = {
    loadState: loadState,
    saveState: saveState
  };
}());
