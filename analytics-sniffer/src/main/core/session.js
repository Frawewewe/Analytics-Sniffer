/**
 * Universal Analytics Debugger — sessione di pagina e view SPA
 * World: MAIN | Carica dopo namespace.js
 *
 * Due identificatori, due scopi distinti:
 *
 *   pageSessionId  generato UNA volta per ogni vera injection del content
 *                  script (= caricamento di pagina reale). Serve a distinguere
 *                  due visite alla STESSA url: raggruppare per url farebbe
 *                  ricadere gli eventi della seconda visita nel vecchio
 *                  accordion invece di crearne uno nuovo e distinto.
 *
 *   viewId         cambia anche senza reload, su pushState/replaceState/
 *                  popstate. Su una SPA il content script NON viene
 *                  re-iniettato: senza viewId tutti gli eventi di
 *                  Home -> Categoria -> Prodotto -> Carrello finirebbero in un
 *                  unico accordion gigante intitolato con la url iniziale.
 *
 * Il pannello raggruppa i macro-accordion per viewId e mostra un marker
 * "SPA view" quando la view non deriva da un caricamento reale.
 *
 * API:
 *   __UAD.session.info()            -> snapshot corrente
 *   __UAD.session.onViewChange(fn)  -> callback (info) => void
 *   __UAD.session.isSpa()           -> boolean (euristica)
 *   __UAD.session.forceNewView(r)   -> apre una view manualmente
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] session: namespace.js non caricato'); } catch (e) {} return; }
  if (UAD.session && !window.__UAD_FORCE_REINIT) return;

  // Alcuni router chiamano pushState e subito replaceState per UNA sola
  // navigazione logica: senza debounce si creerebbero due view identiche.
  var VIEW_DEBOUNCE_MS = 120;

  function uid(prefix) {
    var rnd;
    try {
      var a = new Uint32Array(2);
      crypto.getRandomValues(a);
      rnd = a[0].toString(36) + a[1].toString(36);
    } catch (e) {
      rnd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return prefix + Date.now().toString(36) + '-' + rnd;
  }

  function currentUrl() {
    try { return location.href; } catch (e) { return ''; }
  }

  /** Identita di una view: hash ESCLUSO, perche molti siti usano il fragment
   *  per tab e accordion interni, non per navigare. */
  function viewKey() {
    try { return location.pathname + location.search; } catch (e) { return ''; }
  }

  var state = {
    pageSessionId: uid('ps_'),
    pageLoadTs: Date.now(),
    viewId: null,
    viewIndex: 0,
    viewStartTs: 0,
    viewUrl: '',
    viewKey: '',
    isSpaView: false,       // true = view aperta da pushState, non da reload
    navigationType: 'load'  // load | bfcache | pushState | replaceState | popstate | hashchange | manual
  };

  var listeners = [];
  var debounceTimer = null;
  var pendingReason = null;

  function notify() {
    var info = api.info();
    for (var i = 0; i < listeners.length; i++) {
      UAD.safe('session.onViewChange', listeners[i])(info);
    }
  }

  /**
   * Apre una nuova view.
   * @param {string}  reason
   * @param {boolean} isSpaView  false solo per primo caricamento e bfcache
   */
  function openView(reason, isSpaView) {
    state.viewIndex++;
    state.viewId = state.pageSessionId + '.v' + state.viewIndex;
    state.viewStartTs = Date.now();
    state.viewUrl = currentUrl();
    state.viewKey = viewKey();
    state.isSpaView = !!isSpaView;
    state.navigationType = reason;
    UAD.log('view #' + state.viewIndex, reason, state.viewUrl);
    notify();
  }

  /** Nuova sessione di pagina senza reload: solo ripristino da bfcache. */
  function newPageSession(reason) {
    state.pageSessionId = uid('ps_');
    state.pageLoadTs = Date.now();
    state.viewIndex = 0;
    openView(reason, false);
  }

  /** Valuta se la url e' cambiata abbastanza da aprire una nuova view.
   *  Debounced: piu chiamate ravvicinate producono UNA sola view. */
  function maybeNewView(reason) {
    pendingReason = reason;
    if (debounceTimer) return;
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      var r = pendingReason;
      pendingReason = null;
      try {
        if (viewKey() === state.viewKey) {
          // Stessa url logica: non e' una navigazione. Aggiorniamo solo la url
          // completa, che puo essere cambiata nel solo hash.
          state.viewUrl = currentUrl();
          return;
        }
        openView(r, true);
      } catch (err) { UAD.error('session.maybeNewView', err); }
    }, VIEW_DEBOUNCE_MS);
  }

  // ------------------------------------------------------ hook di navigazione
  function installHooks() {
    // pushState / replaceState: il pre-flight ne ha confermato la patchabilita.
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      try {
        history[m] = function () {
          var ret;
          try {
            ret = orig.apply(this, arguments);
          } catch (e) {
            // Non ingoiare: se pushState fallisce e' un problema del sito e
            // deve restare visibile, quindi rilanciamo.
            UAD.error('history.' + m + ' (chiamata originale)', e);
            throw e;
          }
          try { maybeNewView(m); } catch (e) { UAD.error('session.' + m, e); }
          return ret;
        };
      } catch (e) { UAD.error('session.installHooks ' + m, e); }
    });

    window.addEventListener('popstate', function () {
      UAD.safe('session.popstate', function () { maybeNewView('popstate'); })();
    }, false);

    window.addEventListener('hashchange', function () {
      UAD.safe('session.hashchange', function () {
        state.viewUrl = currentUrl();   // url allineata, ma nessuna view nuova
        maybeNewView('hashchange');
      })();
    }, false);

    // bfcache: tornando "indietro" su una pagina ripristinata il content
    // script NON viene re-iniettato, ma per l'utente e' una visita nuova.
    window.addEventListener('pageshow', function (ev) {
      if (ev && ev.persisted) {
        UAD.safe('session.pageshow', function () { newPageSession('bfcache'); })();
      }
    }, false);
  }

  // ----------------------------------------------------------- euristica SPA
  // Le global dei framework (window.React, __NEXT_DATA__) in produzione spesso
  // non esistono: React moderno non espone nulla su window. I fiber attaccati
  // ai nodi DOM invece si, ed e' cosi che il pre-flight ha rilevato React su
  // un sito che sembrava "classico".
  var spaCache = null;
  function detectSpa() {
    if (spaCache !== null) return spaCache;
    var found = false;
    try {
      if (window.__NEXT_DATA__ || window.__NUXT__ || window.__remixContext) found = true;

      if (!found && document.body) {
        found = Object.keys(document.body).some(function (k) {
          return /^__react|^__vue|^__svelte|^_reactList/.test(k);
        });
      }
      if (!found) {
        var nodes = document.querySelectorAll('div,main,section');
        var lim = Math.min(nodes.length, 30);
        for (var i = 0; i < lim && !found; i++) {
          found = Object.keys(nodes[i]).some(function (k) {
            return /^__react|^__vue|^__svelte/.test(k);
          });
        }
      }
    } catch (e) { UAD.error('session.detectSpa', e); }

    // Cache SOLO con DOM popolato: a document_start non c'e' nulla da
    // ispezionare e un "no" verrebbe congelato per errore.
    if (document.body && document.body.childNodes.length) spaCache = found;
    return found;
  }

  // --------------------------------------------------------------------- API
  var api = {
    info: function () {
      var now = Date.now();
      return {
        pageSessionId:    state.pageSessionId,
        viewId:           state.viewId,
        viewIndex:        state.viewIndex,
        pageUrl:          currentUrl(),
        viewUrl:          state.viewUrl,
        pageLoadTs:       state.pageLoadTs,
        viewStartTs:      state.viewStartTs,
        msSincePageLoad:  now - state.pageLoadTs,
        msSinceViewStart: now - state.viewStartTs,
        isSpaView:        state.isSpaView,
        navigationType:   state.navigationType
      };
    },

    onViewChange: function (fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },

    isSpa: detectSpa,

    /** Apre una view manualmente (pulsante "nuova sezione" nel pannello). */
    forceNewView: function (reason) { openView(reason || 'manual', true); }
  };

  UAD.session = api;

  openView('load', false);
  installHooks();
})();