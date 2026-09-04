/**
 * Analytics Sniffer — mapper Adobe: eVar/prop → nome umano (pattern EDDL)
 * World: MAIN | Carica DOPO il core, PRIMA di adobe-legacy.js e adobe-aep.js
 *
 * COS'E — e perche non e' un connettore
 * Alcune implementazioni Adobe Launch adottano un pattern EDDL (Event Driven
 * Data Layer): un data layer con nomi umani e leggibili
 *
 *   { page: { pageInfo: { site_code: "IT", page_type: "PDP" } } }
 *
 * piu un MAPPER separato, cioe un data element che e' una tabella di traduzione
 * da variabile Adobe a percorso del data layer
 *
 *   { eVar1: "page.pageInfo.site_code",
 *     eVar2: "page.pageInfo.page_type",
 *     prop5: "user.loginStatus" }
 *
 * Questo modulo NON produce eventi propri e NON ha una tab: legge il mapper e
 * arricchisce il campo `src` delle righe prodotte dai connettori Adobe. Il
 * risultato visibile e' il tooltip ℹ️ con il nome leggibile, e la variabile
 * diventa cercabile e filtrabile per nome umano.
 *
 * Senza mapper:  eVar1  →  IT
 * Con mapper:    eVar1  ℹ️  IT      tooltip: page.pageInfo.site_code
 *
 * Su un'implementazione con 200 eVar, la differenza e' sostanziale.
 *
 * ⚠ LIMITE DICHIARATO
 * NON e' uno standard Adobe: e' una convenzione del singolo cliente. Il
 * rilevamento e' euristico — cerchiamo data element il cui valore e' un oggetto
 * con chiavi che matchano /^(eVar|prop)\d+$/ e valori stringa con punti. Se
 * troviamo qualcosa, funziona. Se no, non compare nulla e nessun danno.
 * Per questo la funzione e' opzionale (features.adobeMapper) e la sezione dei
 * Settings che la contiene dichiara di essere best-effort.
 *
 * API esposta ai connettori Adobe:
 *   __UAD.adobeMapper.resolve(varName)  -> string | null
 *   __UAD.adobeMapper.decorate(src, varName) -> string   (src arricchito)
 *   __UAD.adobeMapper.stats()
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[Sniffer] adobe-mapper: namespace assente'); } catch (e) {} return; }
  if (UAD.adobeMapper && !window.__UAD_FORCE_REINIT) return;

  /* ════════════════════════════════════════════════════════════════════════
     Configurazione
     ════════════════════════════════════════════════════════════════════════ */

  // Nomi di data element piu comuni per il mapper. Provati in ordine; se
  // nessuno funziona si passa alla scansione di tutti i data element.
  var CANDIDATE_NAMES = [
    'mapper', 'Mapper', 'varMapper', 'variableMapper', 'evarMapper',
    'eVarMapper', 'analyticsMapper', 'aaMapper', 'adobeMapper',
    'dataMapping', 'variableMapping', 'mapping', 'Mapping',
    'eddlMapper', 'EDDL Mapper', 'dl_mapper', 'varMap', 'variableMap'
  ];

  // Nomi di data element che contengono il data layer, per risolvere i percorsi
  // e mostrare anche il VALORE atteso oltre al nome.
  var DATALAYER_NAMES = [
    'eddl', 'EDDL', 'dataLayer', 'digitalData', 'dl', 'DL',
    'pageData', 'siteData', 'adobeDataLayer'
  ];

  var VAR_RE = /^(eVar|evar|prop|Prop)(\d{1,3})$/;

  var POLL_MS = 400;
  var POLL_MAX_MS = 25000;

  /* ════════════════════════════════════════════════════════════════════════
     Stato
     ════════════════════════════════════════════════════════════════════════ */

  var state = {
    active: false,
    map: {},              // 'eVar1' -> 'page.pageInfo.site_code'
    sourceElement: null,  // nome del data element da cui viene il mapper
    dataLayerElement: null,
    entries: 0,
    scans: 0,
    pollTimer: null,
    announced: false
  };

  /** Normalizza il nome variabile: evar1, eVar1, EVAR1 -> eVar1 */
  function normalizeVar(name) {
    var m = VAR_RE.exec(String(name || ''));
    if (!m) return null;
    var kind = /^p/i.test(m[1]) ? 'prop' : 'eVar';
    return kind + m[2];
  }

  /* ════════════════════════════════════════════════════════════════════════
     Riconoscimento del mapper
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Un oggetto e' un mapper se ha almeno 3 chiavi che sembrano variabili Adobe e
   * valori che sembrano percorsi (stringhe, tipicamente con punti).
   *
   * La soglia di 3 evita i falsi positivi: un oggetto con una sola chiave
   * "eVar1" potrebbe essere qualsiasi cosa.
   */
  function looksLikeMapper(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

    var keys;
    try { keys = Object.keys(obj); } catch (e) { return false; }
    if (keys.length < 3 || keys.length > 600) return false;

    var varLike = 0, pathLike = 0;

    for (var i = 0; i < keys.length; i++) {
      if (!VAR_RE.test(keys[i])) continue;
      varLike++;
      var v;
      try { v = obj[keys[i]]; } catch (e) { continue; }
      if (typeof v === 'string' && v.length > 1 && v.length < 300) pathLike++;
    }

    // Almeno 3 variabili riconosciute, e almeno la meta con un valore stringa.
    return varLike >= 3 && pathLike >= Math.ceil(varLike / 2);
  }

  /** Costruisce la mappa normalizzata da un oggetto mapper valido. */
  function buildMap(obj) {
    var out = {}, n = 0;
    var keys;
    try { keys = Object.keys(obj); } catch (e) { return { map: out, n: 0 }; }

    for (var i = 0; i < keys.length; i++) {
      var norm = normalizeVar(keys[i]);
      if (!norm) continue;
      var v;
      try { v = obj[keys[i]]; } catch (e) { continue; }
      if (typeof v !== 'string' || !v) continue;
      out[norm] = v;
      n++;
    }
    return { map: out, n: n };
  }

  /* ════════════════════════════════════════════════════════════════════════
     Lettura dei data element di Launch
     ════════════════════════════════════════════════════════════════════════ */

  function satellite() {
    try {
      var s = window._satellite;
      // Detection PER FORMA: il pre-flight ha trovato _satellite dichiarato come
      // getter che ritorna undefined da un'altra estensione installata.
      if (s && typeof s === 'object' && typeof s.getVar === 'function') return s;
      return null;
    } catch (e) { return null; }
  }

  function readVar(sat, name) {
    try { return sat.getVar(name); }
    catch (e) { return undefined; }
  }

  /** Elenco dei data element configurati, se il container e' ispezionabile. */
  function listDataElements(sat) {
    try {
      var c = sat._container;
      if (c && c.dataElements && typeof c.dataElements === 'object') {
        return Object.keys(c.dataElements);
      }
    } catch (e) {}
    return [];
  }

  /**
   * Cerca il mapper: prima i nomi candidati, poi tutti i data element del
   * container. La scansione completa e' l'ultima risorsa perche getVar() puo
   * eseguire codice custom del cliente, e chiamarlo su 200 data element non e'
   * gratis.
   */
  function findMapper() {
    var sat = satellite();
    if (!sat) return false;

    state.scans++;

    // 1. Nomi candidati.
    for (var i = 0; i < CANDIDATE_NAMES.length; i++) {
      var v = readVar(sat, CANDIDATE_NAMES[i]);
      if (looksLikeMapper(v)) return adopt(CANDIDATE_NAMES[i], v);
    }

    // 2. Tutti i data element dichiarati nel container.
    var all = listDataElements(sat);
    for (var j = 0; j < all.length; j++) {
      var name = all[j];
      // I candidati sono gia stati provati.
      if (CANDIDATE_NAMES.indexOf(name) !== -1) continue;
      // Un filtro sul nome riduce le chiamate: un mapper si chiama quasi sempre
      // in modo riconoscibile.
      if (!/map|dict|lookup|trad|conf|schema|var/i.test(name)) continue;
      var val = readVar(sat, name);
      if (looksLikeMapper(val)) return adopt(name, val);
    }

    return false;
  }

  function adopt(elementName, obj) {
    var built = buildMap(obj);
    if (!built.n) return false;

    var changed = (state.sourceElement !== elementName) || (built.n !== state.entries);

    state.map = built.map;
    state.entries = built.n;
    state.sourceElement = elementName;

    if (changed) {
      UAD.log('adobe-mapper: mapper trovato in "' + elementName + '" — ' +
              built.n + ' variabili mappate');
    }

    // Un evento informativo una volta sola: l'utente deve sapere che il tooltip
    // ℹ️ ora mostra i nomi umani, e da dove vengono.
    if (!state.announced) {
      state.announced = true;
      announce(elementName, built);
    }
    return true;
  }

  /** Cerca anche il data layer, per mostrare il valore atteso nel tooltip. */
  function findDataLayer() {
    var sat = satellite();
    if (!sat) return;
    if (state.dataLayerElement) return;

    for (var i = 0; i < DATALAYER_NAMES.length; i++) {
      var v = readVar(sat, DATALAYER_NAMES[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        var keys;
        try { keys = Object.keys(v); } catch (e) { continue; }
        if (keys.length >= 2) {
          state.dataLayerElement = DATALAYER_NAMES[i];
          UAD.log('adobe-mapper: data layer trovato in "' + DATALAYER_NAMES[i] + '"');
          return;
        }
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Evento informativo
     ════════════════════════════════════════════════════════════════════════ */

  function announce(elementName, built) {
    var cats = { 'Mapper': [], 'Mappature': [] };

    cats['Mapper'].push({
      key: 'data element', value: elementName, src: '_satellite.getVar("' + elementName + '")'
    });
    cats['Mapper'].push({ key: 'variabili mappate', value: built.n, src: null });
    if (state.dataLayerElement) {
      cats['Mapper'].push({
        key: 'data layer', value: state.dataLayerElement,
        src: '_satellite.getVar("' + state.dataLayerElement + '")'
      });
    }
    cats['Mapper'].push({
      key: 'nota',
      value: 'Il pattern EDDL non è uno standard Adobe: questa mappatura è ' +
             'un\'euristica sul data element trovato.',
      src: null
    });

    // Le prime mappature, come conferma visibile di cosa e' stato letto.
    var keys = Object.keys(built.map).sort(function (a, b) {
      var na = parseInt(a.replace(/\D/g, ''), 10);
      var nb = parseInt(b.replace(/\D/g, ''), 10);
      var ka = /^prop/.test(a) ? 1 : 0;
      var kb = /^prop/.test(b) ? 1 : 0;
      if (ka !== kb) return ka - kb;
      return na - nb;
    });

    var lim = Math.min(keys.length, 40);
    for (var i = 0; i < lim; i++) {
      cats['Mappature'].push({ key: keys[i], value: built.map[keys[i]], src: null });
    }
    if (keys.length > lim) {
      cats['Mappature'].push({
        key: '…', value: '+' + (keys.length - lim) + ' altre mappature', src: null
      });
    }

    // Emesso sul connettore Adobe attivo, cosi compare nella sua tab invece di
    // creare una tab per qualcosa che non e' un tool.
    var target = UAD.isEnabled('adobe-aep') ? 'adobe-aep'
               : UAD.isEnabled('adobe-legacy') ? 'adobe-legacy'
               : null;
    if (!target) return;

    UAD.emit(target, {
      name: 'mapper EDDL rilevato (' + built.n + ' variabili)',
      categorizedFields: cats,
      source: 'polling',
      status: 'ok',
      timestamp: Date.now(),
      meta: {
        adobeMapper: true,
        sourceElement: elementName,
        entries: built.n
      }
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     Polling
     ════════════════════════════════════════════════════════════════════════ */

  function startPolling() {
    if (state.pollTimer) return;
    var t0 = Date.now();

    state.pollTimer = setInterval(function () {
      UAD.safe('adobe-mapper.poll', function () {
        if (!UAD.hasFeature('adobeMapper')) { stopPolling(); return; }

        // Il mapper puo cambiare durante la vita della pagina (Launch ricarica i
        // data element su alcuni eventi): continuiamo a controllare anche dopo
        // averlo trovato, ma senza riemettere l'evento informativo.
        findDataLayer();
        var found = findMapper();

        // Trovato e stabile, oppure tempo scaduto: smettiamo.
        if (Date.now() - t0 > POLL_MAX_MS) {
          stopPolling();
          if (!found && !state.entries) {
            UAD.log('adobe-mapper: nessun mapper trovato dopo ' +
                    (POLL_MAX_MS / 1000) + 's (normale su implementazioni che non usano EDDL)');
          }
        }
      })();
    }, POLL_MS);
  }

  function stopPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /* ════════════════════════════════════════════════════════════════════════
     API per i connettori Adobe
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Percorso umano di una variabile, o null se non mappata.
   * @param {string} varName  'eVar1' | 'evar1' | 'prop5' | ...
   */
  function resolve(varName) {
    if (!state.entries) return null;
    var norm = normalizeVar(varName);
    if (!norm) return null;
    return state.map[norm] || null;
  }

  /**
   * Arricchisce il campo `src` di una riga con il nome umano.
   * Chiamata dai connettori Adobe per ogni eVar/prop.
   *
   * @param {string} currentSrc  src attuale, es. "s.eVar1"
   * @param {string} varName     nome della variabile
   * @returns {string} src arricchito, o quello originale se non mappata
   *
   * Esempio: decorate('s.eVar1', 'eVar1')
   *          -> 'page.pageInfo.site_code  ·  s.eVar1'
   * Il nome umano viene PRIMA: e' l'informazione che serve, e nel tooltip si
   * legge da sinistra.
   */
  function decorate(currentSrc, varName) {
    var human = resolve(varName);
    if (!human) return currentSrc || null;
    if (!currentSrc) return human;
    return human + '  ·  ' + currentSrc;
  }

  /** Mappa completa, per la diagnostica. */
  function getMap() {
    var out = {};
    for (var k in state.map) {
      if (Object.prototype.hasOwnProperty.call(state.map, k)) out[k] = state.map[k];
    }
    return out;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Attivazione
     ════════════════════════════════════════════════════════════════════════ */

  function activate() {
    if (state.active) return;
    state.active = true;

    // _satellite puo comparire dopo di noi: il watcher lo intercetta con
    // defineProperty, senza polling sulla global.
    UAD.watchGlobal('_satellite', function () {
      UAD.safe('adobe-mapper.onSatellite', function () {
        if (!UAD.hasFeature('adobeMapper')) return;
        findDataLayer();
        findMapper();
        startPolling();
      })();
    }, { test: UAD.globalWatcher.SHAPE.satellite });

    try {
      if (satellite()) { findDataLayer(); findMapper(); startPolling(); }
    } catch (e) { UAD.error('adobe-mapper.activate', e); }

    UAD.log('adobe-mapper attivo');
  }

  function deactivate() {
    state.active = false;
    stopPolling();
    state.map = {};
    state.entries = 0;
    state.sourceElement = null;
    state.announced = false;
    UAD.log('adobe-mapper disattivato');
  }

  /**
   * La feature si attiva e disattiva dai Settings senza reload: reagiamo al
   * cambio invece di leggere lo stato una volta sola.
   */
  window.addEventListener(UAD.CH.SETTINGS, function () {
    UAD.safe('adobe-mapper.onSettings', function () {
      var want = UAD.hasFeature('adobeMapper');
      if (want && !state.active) activate();
      else if (!want && state.active) deactivate();
    })();
  }, false);

  /* ════════════════════════════════════════════════════════════════════════
     Export
     Non e' un connettore: non chiamiamo UAD.register(). Non ha tab, non ha
     detect(), non produce eventi propri (tranne quello informativo iniziale).
     ════════════════════════════════════════════════════════════════════════ */

  UAD.adobeMapper = {
    resolve: resolve,
    decorate: decorate,
    getMap: getMap,
    get available() { return state.entries > 0; },
    stats: function () {
      return {
        active: state.active,
        entries: state.entries,
        sourceElement: state.sourceElement,
        dataLayerElement: state.dataLayerElement,
        scans: state.scans,
        polling: !!state.pollTimer
      };
    }
  };
})();