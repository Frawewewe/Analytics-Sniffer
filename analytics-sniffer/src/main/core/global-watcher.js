/**
 * Universal Analytics Debugger — intercettazione delle global della pagina
 * World: MAIN | Carica dopo namespace.js
 *
 * IL PROBLEMA DEL document_start
 * A document_start window.gtag, window.s, window.alloy NON esistono ancora.
 * Wrapparli e' impossibile; pollarli e' imprecise e costoso.
 *
 * LA SOLUZIONE
 * Installiamo Object.defineProperty(window, name, {get, set}) PRIMA che la
 * pagina carichi qualsiasi script: catturiamo l'assegnazione nell'istante in
 * cui avviene. Zero polling, zero timing issue.
 *
 * Il pre-flight ha confermato su questo ambiente che tutte e sei le global di
 * interesse sono intercettabili e sopravvivono a riassegnazione multipla
 * (Adobe Launch riassegna `s` piu volte durante il caricamento).
 *
 * TRE ACCORTEZZE OBBLIGATORIE
 *   1. il setter deve restituire il valore INTATTO e restare trasparente:
 *      per la pagina window.gtag deve comportarsi esattamente come prima
 *   2. deve sopravvivere a riassegnazioni multiple, notificando ogni volta
 *   3. se la property e' non-configurable si degrada a polling: alcune
 *      librerie usano defineProperty a loro volta e possono renderla tale
 *
 * INTERCETTAZIONE PER FORMA, NON PER ESISTENZA
 * Il pre-flight ha rilevato window._satellite e window.__alloyNS presenti
 * come GETTER che ritornano undefined (dichiarati da un'altra estensione
 * Adobe installata). Un check `'_satellite' in window` passerebbe su una
 * pagina senza Adobe. Per questo il watcher notifica solo valori che
 * SUPERANO un test di forma definito dal chiamante.
 *
 * API:
 *   __UAD.watchGlobal(name, onReady, opts)
 *   __UAD.watchGlobals([names], onReady, opts)
 *   __UAD.watchProp(obj, prop, onReady, opts)   // per s.t, s.tl, alloy interni
 *   __UAD.globalWatcher.stats()
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] global-watcher: namespace.js non caricato'); } catch (e) {} return; }
  if (UAD.globalWatcher && !window.__UAD_FORCE_REINIT) return;

  var POLL_MS = 100;          // fallback per property non intercettabili
  var POLL_MAX_MS = 30000;    // dopo 30s smettiamo: la pagina e' caricata
  var MAX_NOTIFY = 30;        // per non impazzire su global riassegnate a ciclo

  var counters = { hooks: 0, polls: 0, notifies: 0, rejected: 0, failures: 0 };
  var watchers = {};   // name -> { installed, mode, notifies, callbacks[] }
  var pollTimer = null;
  var polled = [];     // [{ name, test, notify, seen, t0 }]

  /** Test di forma di default: qualsiasi valore non nullo.
   *  I connettori passeranno test specifici (es. per `s`: s.t o s.account). */
  function defaultTest(v) { return v !== null && v !== undefined; }

  function makeEntry(name) {
    if (!watchers[name]) {
      watchers[name] = { name: name, installed: false, mode: null, notifies: 0, subs: [] };
    }
    return watchers[name];
  }

  /** Notifica i subscriber il cui test di forma passa. */
  function fire(entry, value, how) {
    if (entry.notifies >= MAX_NOTIFY) return;

    var any = false;
    for (var i = 0; i < entry.subs.length; i++) {
      var s = entry.subs[i];
      var pass = false;
      try { pass = !!s.test(value); }
      catch (e) { UAD.error('watchGlobal.test ' + entry.name, e); }

      if (!pass) { counters.rejected++; continue; }

      // once: notifichiamo una sola volta, ma il getter/setter resta installato
      // (rimuoverlo sarebbe rischioso se altri hanno wrappato dopo di noi).
      if (s.once && s.fired) continue;
      s.fired = true;
      any = true;
      counters.notifies++;
      UAD.safe('watchGlobal.onReady ' + entry.name, s.notify)(value, entry.name, how);
    }
    if (any) {
      entry.notifies++;
      UAD.log('global "' + entry.name + '" catturata via ' + how);
    }
  }

  // ------------------------------------------------------------- defineProperty

  function installAccessor(name) {
    var entry = makeEntry(name);
    if (entry.installed) return true;

    var desc = null;
    try { desc = Object.getOwnPropertyDescriptor(window, name); } catch (e) {}

    // Non-configurable: nessun modo di intercettare, si degrada a polling.
    if (desc && desc.configurable === false) {
      UAD.log('global "' + name + '" non configurable: fallback a polling');
      return false;
    }

    // Valore o accessor preesistenti: li preserviamo e continuiamo a delegare,
    // cosi non rompiamo chi ha definito la property prima di noi (incluse
    // altre estensioni).
    var hadAccessor = !!(desc && (desc.get || desc.set));
    var origGet = desc && desc.get;
    var origSet = desc && desc.set;
    var store;
    try { store = desc ? (hadAccessor ? (origGet ? origGet.call(window) : undefined) : desc.value) : undefined; }
    catch (e) { store = undefined; }

    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: desc ? desc.enumerable !== false : true,
        get: function () {
          if (hadAccessor && origGet) {
            try { return origGet.call(window); } catch (e) { UAD.error('watchGlobal.get ' + name, e); return store; }
          }
          return store;
        },
        set: function (v) {
          // 1. PRIMA la catena originale: il comportamento della pagina non
          //    deve cambiare in alcun modo.
          if (hadAccessor && origSet) {
            try { origSet.call(window, v); } catch (e) { UAD.error('watchGlobal.set originale ' + name, e); }
          } else {
            store = v;
          }
          // 2. POI la notifica, isolata: un nostro errore non deve mai
          //    propagarsi al codice che stava assegnando.
          try { fire(entry, v, 'setter'); } catch (e) { UAD.error('watchGlobal.fire ' + name, e); }
        }
      });
      entry.installed = true;
      entry.mode = 'accessor';
      counters.hooks++;

      // La global potrebbe esistere GIA con un valore valido (script inline
      // prima di noi, o pagina gia caricata quando l'utente attiva un tool).
      if (store !== undefined && store !== null) {
        setTimeout(function () { fire(entry, store, 'preesistente'); }, 0);
      }
      return true;
    } catch (err) {
      counters.failures++;
      UAD.error('watchGlobal.installAccessor ' + name, err);
      return false;
    }
  }

  // -------------------------------------------------------------------- polling

  function startPolling() {
    if (pollTimer) return;
    var t0 = Date.now();
    pollTimer = setInterval(function () {
      counters.polls++;
      var alive = false;

      for (var i = 0; i < polled.length; i++) {
        var p = polled[i];
        if (p.seen) continue;
        alive = true;
        var v;
        try { v = window[p.name]; } catch (e) { continue; }
        var pass = false;
        try { pass = !!p.test(v); } catch (e) { UAD.error('polling.test ' + p.name, e); }
        if (pass) {
          p.seen = true;
          counters.notifies++;
          UAD.safe('polling.onReady ' + p.name, p.notify)(v, p.name, 'polling');
          UAD.log('global "' + p.name + '" catturata via polling');
        }
      }

      if (!alive || Date.now() - t0 > POLL_MAX_MS) {
        clearInterval(pollTimer);
        pollTimer = null;
        if (alive) UAD.log('polling terminato: ' + POLL_MAX_MS + 'ms scaduti');
      }
    }, POLL_MS);
  }

  // ------------------------------------------------------------------------ API

  /**
   * @param {string}   name          nome della global (es. 'gtag')
   * @param {function} onReady       (value, name, how) => void
   * @param {object}   [opts]
   * @param {function} [opts.test]   test di FORMA sul valore. Obbligatorio in
   *                                 pratica per _satellite e __alloyNS, che
   *                                 possono esistere come getter vuoti.
   * @param {boolean}  [opts.once]   notifica una sola volta (default false:
   *                                 Adobe Launch riassegna `s` piu volte)
   */
  function watchGlobal(name, onReady, opts) {
    if (!name || typeof onReady !== 'function') {
      UAD.error('watchGlobal', 'parametri non validi per "' + name + '"');
      return;
    }
    opts = opts || {};
    var test = (typeof opts.test === 'function') ? opts.test : defaultTest;

    var entry = makeEntry(name);
    entry.subs.push({ test: test, notify: onReady, once: !!opts.once, fired: false });

    var ok = installAccessor(name);

    if (!ok) {
      polled.push({ name: name, test: test, notify: onReady, seen: false });
      startPolling();
      return;
    }

    // Se l'accessor e' installato ma il valore c'e' gia e passa il test,
    // notifichiamo subito (caso: watcher aggiunto a pagina gia caricata,
    // es. l'utente attiva un tool dai Settings).
    var cur;
    try { cur = window[name]; } catch (e) { cur = undefined; }
    if (cur !== undefined && cur !== null) {
      var pass = false;
      try { pass = !!test(cur); } catch (e) {}
      if (pass) setTimeout(function () { fire(entry, cur, 'immediato'); }, 0);
    }
  }

  function watchGlobals(names, onReady, opts) {
    if (!Array.isArray(names)) return;
    for (var i = 0; i < names.length; i++) watchGlobal(names[i], onReady, opts);
  }

  /**
   * Intercetta una property di un OGGETTO, non di window. Serve per i metodi
   * che i connettori devono wrappare (s.t, s.tl) quando l'oggetto esiste ma il
   * metodo viene assegnato dopo, o riassegnato da Launch.
   *
   * @returns {boolean} true se l'accessor e' stato installato
   */
  function watchProp(obj, prop, onReady, opts) {
    if (!obj || typeof obj !== 'object' || !prop || typeof onReady !== 'function') return false;
    opts = opts || {};
    var test = (typeof opts.test === 'function') ? opts.test : defaultTest;

    var desc = null;
    try { desc = Object.getOwnPropertyDescriptor(obj, prop); } catch (e) {}
    if (desc && desc.configurable === false) {
      UAD.log('property "' + prop + '" non configurable');
      // Valore attuale comunque notificato, se valido.
      try { if (test(obj[prop])) UAD.safe('watchProp.onReady', onReady)(obj[prop], prop, 'non-configurable'); }
      catch (e) {}
      return false;
    }

    var hadAccessor = !!(desc && (desc.get || desc.set));
    var origGet = desc && desc.get, origSet = desc && desc.set;
    var store;
    try { store = desc ? (hadAccessor ? (origGet ? origGet.call(obj) : undefined) : desc.value) : undefined; }
    catch (e) { store = undefined; }

    try {
      Object.defineProperty(obj, prop, {
        configurable: true,
        enumerable: desc ? desc.enumerable !== false : true,
        get: function () {
          if (hadAccessor && origGet) {
            try { return origGet.call(this); } catch (e) { return store; }
          }
          return store;
        },
        set: function (v) {
          if (hadAccessor && origSet) {
            try { origSet.call(this, v); } catch (e) { UAD.error('watchProp.set originale ' + prop, e); }
          } else {
            store = v;
          }
          try {
            if (test(v)) {
              counters.notifies++;
              UAD.safe('watchProp.onReady ' + prop, onReady)(v, prop, 'setter');
            }
          } catch (e) { UAD.error('watchProp.fire ' + prop, e); }
        }
      });
      counters.hooks++;

      if (store !== undefined && store !== null) {
        var pass = false;
        try { pass = !!test(store); } catch (e) {}
        if (pass) setTimeout(function () {
          UAD.safe('watchProp.onReady ' + prop, onReady)(store, prop, 'preesistente');
        }, 0);
      }
      return true;
    } catch (err) {
      counters.failures++;
      UAD.error('watchProp ' + prop, err);
      return false;
    }
  }

  // Rigiocata dal core quando i settings arrivano: le global comparse prima
  // erano state messe in buffer da namespace.js.
  UAD._onGlobalReplay = function (name, value) {
    var entry = watchers[name];
    if (!entry) return;
    try { fire(entry, value, 'replay'); } catch (e) { UAD.error('globalWatcher.replay ' + name, e); }
  };

  UAD.watchGlobal  = watchGlobal;
  UAD.watchGlobals = watchGlobals;
  UAD.watchProp    = watchProp;

  UAD.globalWatcher = {
    stats: function () {
      var list = [];
      for (var k in watchers) {
        if (!Object.prototype.hasOwnProperty.call(watchers, k)) continue;
        list.push({
          name: k, mode: watchers[k].mode || 'polling',
          installed: watchers[k].installed, notifies: watchers[k].notifies,
          subscribers: watchers[k].subs.length
        });
      }
      return {
        hooks: counters.hooks, polls: counters.polls, notifies: counters.notifies,
        rejectedByShapeTest: counters.rejected, failures: counters.failures,
        polling: polled.filter(function (p) { return !p.seen; }).length,
        watched: list
      };
    },
    /** Test di forma pronti, usati dai connettori. Centralizzati qui perche
     *  sono la lezione del pre-flight: mai fidarsi dell'esistenza. */
    SHAPE: {
      gtag:       function (v) { return typeof v === 'function'; },
      dataLayer:  function (v) { return !!v && typeof v.push === 'function' && typeof v.length === 'number'; },
      // Adobe legacy: `s` deve avere i metodi di tracking o l'account
      adobeS:     function (v) { return !!v && typeof v === 'object' &&
                                        (typeof v.t === 'function' || typeof v.tl === 'function' ||
                                         typeof v.account === 'string'); },
      // Alloy: funzione chiamabile
      alloyFn:    function (v) { return typeof v === 'function'; },
      // __alloyNS: array NON vuoto (il pre-flight lo ha trovato come getter
      // che ritorna undefined su un sito senza Adobe)
      alloyNS:    function (v) { return Array.isArray(v) && v.length > 0; },
      // _satellite: deve avere i metodi reali di Launch
      satellite:  function (v) { return !!v && typeof v === 'object' &&
                                        (typeof v.track === 'function' || typeof v.getVar === 'function' ||
                                         !!v._container); }
    }
  };

  UAD.log('global-watcher pronto');
})();