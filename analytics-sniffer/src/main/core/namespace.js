/**
 * Analytics Sniffer — namespace + registry + settings gate
 * World: MAIN | Caricato per PRIMO, prima di ogni altro script dell'estensione.
 *
 * v3 — quattro modifiche ai settings:
 *   1. autoListener: quando true (default) i tool rilevati compaiono da soli.
 *      Quando false, l'utente sceglie a mano quali mostrare — risolve il caso
 *      "GTM non riesco a disattivarlo", dove il toggle fermava lo sniffing ma
 *      la tab restava perche i suoi eventi erano gia in memoria.
 *   2. categoryState: per ogni categoria di campi (Identity & Session, Consent,
 *      Config...) si decide se nasce aperta o chiusa. Configurabile dal
 *      pannello, con default sensati.
 *   3. rimosso 'eddl-mapper' dai connettori. Non era un connettore: non produce
 *      eventi propri, arricchisce quelli Adobe. Diventa la feature
 *      adobeMapper, gestita da adobe-mapper.js.
 *   4. rimosso ui.showToolbarIcons: era una duplicazione. Un solo toggle per
 *      funzione, che controlla anche la sua icona.
 *
 * Responsabilita:
 *  1. creare l'unico namespace globale window.__UAD
 *  2. tenere il registry dei connettori (auto-dichiaranti)
 *  3. fare da gate: un connettore disattivato non riceve NULLA
 *  4. bufferizzare gli eventi che arrivano prima dei settings, e rigiocarli dopo
 */
(function () {
  'use strict';

  // Guard anti doppia-injection (bfcache, injection ripetuta, stesso documento).
  // __UAD_FORCE_REINIT e' una valvola SOLO per lo sviluppo da console: in
  // produzione quella variabile non esiste mai.
  if (window.__UAD && window.__UAD.__initialized && !window.__UAD_FORCE_REINIT) return;

  var CH = {
    HIT:      '__UAD_HIT__',        // MAIN  -> ISOLATED : evento catturato
    READY:    '__UAD_READY__',      // MAIN  -> ISOLATED : "sono su, mandami i settings"
    SETTINGS: '__UAD_SETTINGS__',   // ISOLATED -> MAIN  : settings correnti
    COMMAND:  '__UAD_COMMAND__'     // ISOLATED -> MAIN  : comandi dal panel
  };

  /**
   * DEFAULTS — unica fonte di verita della forma dei settings.
   * Aggiungere qui una chiave la rende disponibile a tutti gli utenti esistenti
   * (vedi mergeDefaults) senza perdere le loro scelte.
   * NOTA: tools{} viene esteso a runtime da register().
   */
  var DEFAULTS = {
    schemaVersion: 3,

    // ── CORE: quali tool sniffare. L'ordine di questo array = ordine tab.
    toolOrder: ['ga4', 'gtm', 'adobe-legacy', 'adobe-aep'],
    tools: {
      'ga4':          true,
      'gtm':          true,
      'adobe-legacy': true,
      'adobe-aep':    true,
      'generic':      false   // "Altri tool": solo match su URL vendor
    },

    /**
     * Rilevamento automatico dei tool.
     *   true  (default) i tool rilevati compaiono da soli come tab
     *   false            compaiono SOLO quelli spuntati manualmente sopra
     *
     * Serve perche disattivare un tool ferma lo sniffing, ma gli eventi gia
     * raccolti restano in memoria e la tab non spariva. Con autoListener a
     * false, la visibilita delle tab dipende esclusivamente da tools{}.
     */
    autoListener: true,

    // ── FUNZIONI AGGIUNTIVE. Un solo flag per funzione: controlla il
    //    comportamento E la visibilita della sua icona in barra.
    features: {
      cookieInspector:      false,  // richiede permesso "cookies" — include il clear
      cookieCrossCheck:     false,  // 🔗/⚠️ match cid, sessione, ECID contro i cookie
      stopNavigation:       false,  // blocco redirect via declarativeNetRequest
      devReferences:        false,  // copia url+timestamp per il tab Network
      aggressiveHeuristics: false,  // polling data element Adobe Launch
      adobeMapper:          false   // legge il mapper eVar -> nome umano (EDDL)
    },

    /**
     * Stato iniziale delle sezioni di campi dentro ogni evento.
     * true = nasce aperta, false = nasce chiusa.
     *
     * Il criterio dei default: le sezioni del COSA (parametri, eVars, prodotti)
     * aperte, quelle del COME (identita, consenso, configurazione, endpoint)
     * chiuse. Chi apre un evento vuole vedere prima cosa e' stato misurato.
     *
     * Ogni categoria non elencata qui nasce aperta.
     */
    categoryState: {
      'Event Params':        true,
      'Parametri':           true,
      'dataLayer':           true,
      'Ecommerce':           true,
      'eVars':               true,
      'Props':               true,
      'Events':              true,
      'Commerce':            true,
      'XDM custom':          true,
      'Data (non-XDM)':      true,
      'Web / Page':          true,
      'Web / Link':          true,
      'Context Data':        true,
      'Diagnostica':         true,
      'Evento':              true,

      'User Properties':     false,
      'Identity':            false,
      'Identity & Session':  false,
      'Consent':             false,
      'Account':             false,
      'Container':           false,
      'GTM':                 false,
      'Config':              false,
      'Core':                false,
      'Richiesta':           false,
      'Body':                false,
      'Altri parametri':     false,
      'Hierarchy':           false,
      'List Props':          false,
      'List Vars':           false
    },

    // ── UI
    ui: {
      theme:             'system',   // 'light' | 'dark' | 'system'
      showAllFields:     false,      // mostra anche i campi vuoti
      collapseByDefault: false       // eventi e view chiusi all'arrivo
    },

    // ── LIMITI
    limits: {
      maxEventsPerTab: 2000,
      maxValueChars:   8000,
      maxDepth:        12
    },

    debug: false
  };

  /**
   * Percorsi che sono "dizionari aperti": accettano chiavi non previste dai
   * DEFAULTS.
   *   tools          -> connettori registrati a runtime, ignoti al core
   *   categoryState  -> categorie introdotte da connettori nuovi
   * E' cio che rende reale la promessa "aggiungi un plugin senza toccare il core".
   */
  var OPEN_MAPS = { 'tools': true, 'categoryState': true };

  /**
   * Merge profondo non distruttivo: i valori salvati vincono, le chiavi nuove
   * arrivano dai default. Nelle OPEN_MAPS preserva anche le chiavi ignote, ma
   * solo primitivi (per non far entrare oggetti arbitrari nei settings).
   */
  function mergeDefaults(saved, defaults, path) {
    var out = {}, k;
    path = path || '';

    for (k in defaults) {
      if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
      var d = defaults[k];
      var s = (saved && typeof saved === 'object' && Object.prototype.hasOwnProperty.call(saved, k))
        ? saved[k] : undefined;
      var childPath = path ? (path + '.' + k) : k;

      if (Array.isArray(d)) {
        out[k] = Array.isArray(s) ? s.slice() : d.slice();
      } else if (d && typeof d === 'object') {
        out[k] = mergeDefaults(s, d, childPath);
      } else {
        out[k] = (s === undefined) ? d : s;
      }
    }

    if (OPEN_MAPS[path] && saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (k in saved) {
        if (!Object.prototype.hasOwnProperty.call(saved, k)) continue;
        if (Object.prototype.hasOwnProperty.call(out, k)) continue;
        var v = saved[k];
        if (v === null || typeof v !== 'object') out[k] = v;   // solo primitivi
      }
    }
    return out;
  }

  var UAD = {
    __initialized: true,
    VERSION: '0.2.0',
    NAME: 'Analytics Sniffer',
    CH: CH,
    DEFAULTS: DEFAULTS,

    // Settings correnti. Prima che il bridge risponda usiamo i DEFAULTS, ma
    // settingsReady=false: finche e' false NON emettiamo, bufferizziamo.
    settings: mergeDefaults(null, DEFAULTS),
    settingsReady: false,

    connectors: [],      // [{connector, active}]
    _byId: {},

    // Buffer pre-settings: globali comparse e request passate troppo presto.
    _pending: { globals: [], requests: [] },
    _PENDING_CAP: 300,

    // ──────────────────────────────────────────────────────────── logging
    log: function () {
      if (!UAD.settings.debug) return;
      try {
        console.log.apply(console,
          ['%c[Sniffer]', 'color:#7c5cf0;font-weight:600'].concat([].slice.call(arguments)));
      } catch (e) {}
    },
    error: function (where, err) {
      // MAI ingoiare un errore in silenzio (vincolo di progetto).
      try { console.error('[Sniffer] errore in ' + where + ':', err); } catch (e) {}
    },
    /** Esegue fn isolando la pagina da qualunque nostro bug. */
    safe: function (where, fn) {
      return function () {
        try { return fn.apply(this, arguments); }
        catch (err) { UAD.error(where, err); return undefined; }
      };
    },

    // ────────────────────────────────────────────────────────── registry
    /**
     * @param {object}  connector
     * @param {boolean} [defaultEnabled=false] stato di default al primo avvio
     */
    register: function (connector, defaultEnabled) {
      if (!connector || !connector.id) { UAD.error('register', 'connettore senza id'); return; }
      if (UAD._byId[connector.id]) { UAD.log('connettore gia registrato:', connector.id); return; }

      // Auto-dichiarazione nei settings: nessuna modifica al core necessaria
      // per aggiungere un connettore nuovo.
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS.tools, connector.id)) {
        DEFAULTS.tools[connector.id] = (defaultEnabled === true);
      }
      if (!Object.prototype.hasOwnProperty.call(UAD.settings.tools, connector.id)) {
        UAD.settings.tools[connector.id] = DEFAULTS.tools[connector.id];
      }

      var entry = { connector: connector, active: false };
      UAD._byId[connector.id] = entry;
      UAD.connectors.push(entry);
      UAD.log('registrato connettore:', connector.id, '(default:', DEFAULTS.tools[connector.id], ')');
    },
    get: function (id) { return UAD._byId[id] ? UAD._byId[id].connector : null; },

    /** Gate unico: la domanda "devo occuparmi di questo tool?" si fa SOLO qui. */
    isEnabled: function (toolId) {
      return UAD.settingsReady === true && UAD.settings.tools[toolId] === true;
    },

    /** Connettori attivi, nell'ordine scelto dall'utente nei Settings. */
    activeConnectors: function () {
      var order = UAD.settings.toolOrder || [];
      var seen = {}, out = [], i, e;
      for (i = 0; i < order.length; i++) {
        e = UAD._byId[order[i]];
        if (e && e.active) { out.push(e.connector); seen[order[i]] = 1; }
      }
      for (i = 0; i < UAD.connectors.length; i++) {   // attivi non in toolOrder
        e = UAD.connectors[i];
        if (e.active && !seen[e.connector.id]) out.push(e.connector);
      }
      return out;
    },

    /** Una feature aggiuntiva e' attiva? Usata dai connettori. */
    hasFeature: function (name) {
      return UAD.settingsReady === true &&
             !!(UAD.settings.features && UAD.settings.features[name] === true);
    },

    /**
     * Stato iniziale di una categoria di campi.
     * Le categorie non configurate nascono aperte: un connettore nuovo resta
     * leggibile senza dover aggiungere nulla qui.
     */
    categoryOpen: function (category) {
      var cs = UAD.settings.categoryState || {};
      if (Object.prototype.hasOwnProperty.call(cs, category)) return cs[category] === true;
      return true;
    },

    // ─────────────────────────────────────────────────── buffer & replay
    bufferGlobal: function (name, value) {
      if (UAD._pending.globals.length >= UAD._PENDING_CAP) return;
      UAD._pending.globals.push({ name: name, value: value, t: Date.now() });
    },
    bufferRequest: function (req) {
      if (UAD._pending.requests.length >= UAD._PENDING_CAP) return;
      UAD._pending.requests.push(req);
    },

    // ───────────────────────────────────────────────── settings lifecycle
    /**
     * Chiamata dal bridge quando i settings arrivano da chrome.storage.local e a
     * ogni modifica successiva dal pannello. Attiva/disattiva i connettori in
     * base al diff, poi rigioca il buffer verso i soli connettori attivi.
     */
    applySettings: function (incoming) {
      var first = !UAD.settingsReady;

      // Preserva le auto-dichiarazioni gia presenti in UAD.settings.tools per
      // connettori registrati ma assenti nel payload in arrivo.
      var merged = mergeDefaults(incoming, DEFAULTS);
      for (var id in UAD._byId) {
        if (!Object.prototype.hasOwnProperty.call(UAD._byId, id)) continue;
        if (!Object.prototype.hasOwnProperty.call(merged.tools, id)) {
          merged.tools[id] = (UAD.settings.tools && UAD.settings.tools[id] === true);
        }
      }
      UAD.settings = merged;
      UAD.settingsReady = true;

      for (var i = 0; i < UAD.connectors.length; i++) {
        var e = UAD.connectors[i];
        var want = UAD.settings.tools[e.connector.id] === true;

        if (want && !e.active) {
          e.active = true;
          if (typeof e.connector.activate === 'function') {
            UAD.safe('activate:' + e.connector.id, e.connector.activate)(UAD);
          }
          UAD.log('connettore ATTIVO:', e.connector.id);
        } else if (!want && e.active) {
          e.active = false;
          // NOTA ONESTA: non rimuoviamo i wrapper gia installati (rimuoverli e'
          // pericoloso se altro codice ha wrappato dopo di noi). Diventano
          // pass-through inerti grazie al gate isEnabled(). Un reload della
          // pagina riporta lo stato completamente pulito.
          if (typeof e.connector.deactivate === 'function') {
            UAD.safe('deactivate:' + e.connector.id, e.connector.deactivate)(UAD);
          }
          UAD.log('connettore DISATTIVO:', e.connector.id);
        }
      }

      if (first) UAD._replay();
    },

    _replay: function () {
      var g = UAD._pending.globals, r = UAD._pending.requests, i;
      UAD._pending = { globals: [], requests: [] };
      UAD.log('replay buffer:', g.length, 'globali /', r.length, 'request');

      for (i = 0; i < g.length; i++) {
        if (typeof UAD._onGlobalReplay === 'function') {
          UAD.safe('replay:global', UAD._onGlobalReplay)(g[i].name, g[i].value);
        }
      }
      for (i = 0; i < r.length; i++) {
        if (typeof UAD._onRequestReplay === 'function') {
          UAD.safe('replay:request', UAD._onRequestReplay)(r[i]);
        }
      }
    }
  };

  window.__UAD = UAD;

  // Segnala al bridge (ISOLATED) che siamo pronti a ricevere i settings.
  // Entrambi partono a document_start ma l'ordine non e' garantito: il bridge
  // invia i settings ANCHE spontaneamente.
  try {
    window.dispatchEvent(new CustomEvent(CH.READY, { detail: { v: UAD.VERSION } }));
  } catch (e) { UAD.error('dispatch READY', e); }

  // Ascolto dei settings in arrivo (canale unico, sempre stringa JSON).
  window.addEventListener(CH.SETTINGS, function (ev) {
    try {
      var payload = (ev && ev.detail) ? JSON.parse(ev.detail) : null;
      UAD.applySettings(payload);
    } catch (err) { UAD.error('onSettings', err); }
  }, false);
})();