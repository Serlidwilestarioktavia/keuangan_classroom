(function () {
  "use strict";

  var LEGACY_DATABASE = "MyMoneyDatabase";
  var LEGACY_STORE = "records";
  var LEGACY_STATE_ID = "main";
  var LEGACY_KEY = "mymoney-data-v1";
  var client;
  var dataOwnerId;

  function initialize() {
    var config = window.MYMONEY_CONFIG || {};
    if (!window.supabase || !config.url || !config.anonKey ||
        config.url.indexOf("YOUR_PROJECT") >= 0 || config.anonKey.indexOf("YOUR_SUPABASE") >= 0) {
      throw new Error("Isi URL dan anon key Supabase di frontend/config.js terlebih dahulu.");
    }
    client = window.supabase.createClient(config.url, config.anonKey);
  }

  function getSession() {
    return client.auth.getSession().then(function (result) {
      if (result.error) throw result.error;
      return result.data.session;
    });
  }

  async function ensureDeviceSession() {
    var session = await getSession();
    if (session) return session;

    var result = await client.auth.signInAnonymously();
    if (result.error) throw result.error;
    return result.data.session;
  }

  async function loadState() {
    var session = await getSession();
    if (!session) throw new Error("Sesi perangkat tidak ditemukan. Muat ulang aplikasi.");

    var result = await client.from("user_data")
      .select("user_id,data")
      .maybeSingle();
    if (result.error) throw result.error;
    if (result.data) {
      dataOwnerId = result.data.user_id;
      return result.data.data;
    }

    dataOwnerId = session.user.id;
    var legacyState;
    try {
      legacyState = await loadLegacyState();
    } catch (error) {
      console.warn("Data lokal lama tidak dapat dimigrasikan.", error);
      legacyState = null;
    }
    if (legacyState) {
      await saveState(legacyState);
      return legacyState;
    }
    return null;
  }

  async function saveState(state) {
    var session = await getSession();
    if (!session) throw new Error("Sesi perangkat berakhir. Muat ulang aplikasi.");
    if (!dataOwnerId) dataOwnerId = session.user.id;

    var result = await client.from("user_data").upsert({
      user_id: dataOwnerId,
      data: state,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (result.error) throw result.error;
  }

  async function createPairingCode() {
    if (!window.crypto || !window.crypto.getRandomValues) {
      throw new Error("Kode perangkat memerlukan koneksi HTTPS dan browser yang mendukung Web Crypto.");
    }
    var bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    var code = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
    var result = await client.rpc("create_device_pairing", { p_code: code });
    if (result.error) throw result.error;
    return code;
  }

  async function claimPairingCode(code) {
    var normalizedCode = String(code || "").replace(/\s/g, "").toLowerCase();
    var result = await client.rpc("claim_device_pairing", { p_code: normalizedCode });
    if (result.error) throw result.error;
  }

  function loadLegacyState() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }

      var request = window.indexedDB.open(LEGACY_DATABASE, 1);
      request.onerror = function () { resolve(readLegacyLocalStorage()); };
      request.onblocked = function () { resolve(readLegacyLocalStorage()); };
      request.onsuccess = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(LEGACY_STORE)) {
          database.close();
          resolve(readLegacyLocalStorage());
          return;
        }
        var transaction = database.transaction(LEGACY_STORE, "readonly");
        var record = transaction.objectStore(LEGACY_STORE).get(LEGACY_STATE_ID);
        record.onsuccess = function () {
          var state = record.result ? record.result.value : null;
          database.close();
          resolve(state || readLegacyLocalStorage());
        };
        record.onerror = function () {
          database.close();
          resolve(readLegacyLocalStorage());
        };
      };
    });
  }

  function readLegacyLocalStorage() {
    try {
      var value = window.localStorage.getItem(LEGACY_KEY);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.warn("Data lokal lama tidak dapat dimigrasikan.", error);
      return null;
    }
  }

  window.MyMoneyDB = {
    initialize: initialize,
    ensureDeviceSession: ensureDeviceSession,
    loadState: loadState,
    saveState: saveState,
    createPairingCode: createPairingCode,
    claimPairingCode: claimPairingCode
  };
}());
