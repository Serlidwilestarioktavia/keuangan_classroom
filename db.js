(function () {
  "use strict";

  var LEGACY_DATABASE = "MyMoneyDatabase";
  var LEGACY_STORE = "records";
  var LEGACY_STATE_ID = "main";
  var LEGACY_KEY = "mymoney-data-v1";
  var client;

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

  function signIn(email, password) {
    return client.auth.signInWithPassword({ email: email, password: password }).then(function (result) {
      if (result.error) throw result.error;
      return result.data.session;
    });
  }

  function signUp(email, password) {
    return client.auth.signUp({ email: email, password: password }).then(function (result) {
      if (result.error) throw result.error;
      return result.data.session;
    });
  }

  function signOut() {
    return client.auth.signOut().then(function (result) {
      if (result.error) throw result.error;
    });
  }

  function loadLegacyState() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }

      var request = window.indexedDB.open(LEGACY_DATABASE, 1);
      request.onerror = function () { resolve(null); };
      request.onblocked = function () { resolve(null); };
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

  async function loadState() {
    var session = await getSession();
    if (!session) throw new Error("Sesi akun tidak ditemukan. Silakan masuk kembali.");

    var result = await client.from("user_data")
      .select("data")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (result.error) throw result.error;
    if (result.data) return result.data.data;

    var legacyState;
    try {
      legacyState = await loadLegacyState();
    } catch (error) {
      console.warn("Data lokal lama tidak dapat dimigrasikan.", error);
      legacyState = null;
    }
    if (legacyState) await saveState(legacyState);
    return legacyState;
  }

  async function saveState(state) {
    var session = await getSession();
    if (!session) throw new Error("Sesi akun berakhir. Silakan masuk kembali.");

    var result = await client.from("user_data").upsert({
      user_id: session.user.id,
      data: state,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (result.error) throw result.error;
  }

  window.MyMoneyDB = {
    initialize: initialize,
    getSession: getSession,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    loadState: loadState,
    saveState: saveState
  };
}());
