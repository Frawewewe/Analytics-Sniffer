/**
 * Analytics Sniffer — mapper Adobe: eVar/prop → nome umano (pattern EDDL)
 * World: MAIN | Carica DOPO il core, PRIMA di adobe-legacy.js e adobe-aep.js
 *
 * v2 — il mapper NON è più un evento.
 *
 * Prima emetteva un evento informativo che finiva in mezzo alle hit, sporcando la
 * cronologia con qualcosa che non è una chiamata di analytics. Ora pubblica la
 * mappa su un canale dedicato: il pannello la intercetta, non la memorizza tra
 * gli eventi, e la usa per mostrare una barra in cima alla tab Adobe con un
 * interruttore. Attivandolo, accanto a ogni eVar e prop compare la mappatura.
 *
 * COS'È IL PATTERN EDDL
 * Alcune implementazioni Adobe Launch adottano un Event Driven Data Layer: un
 * data layer con nomi umani
 *
 *   { page: { pageInfo: { site_code: "IT", page_type: "PDP" } } }
 *
 * più un MAPPER separato, cioè un data element che traduce variabile Adobe →
 * percorso del data layer
 *
 *   { eVar1: "page.pageInfo.site_code", prop5: "user.loginStatus" }
 *
 * Senza mapper:  eVar1              IT
 * Con mapper:    eVar1 | page.pageInfo.site_code    IT
 *
 * Su un'implementazione con 200 eVar, la differenza è sostanziale.
 *
 * LIMITE DICHIARATO
 * NON è uno standard Adobe: è una convenzione del singolo cliente. Il
 * rilevamento è euristico — cerchiamo data element il cui valore è un oggetto con
 * chiavi che matchano /^(eVar|prop)\d+$/ e valori stringa. Se troviamo qualcosa
 * funziona, altrimenti non compare nulla e nessun danno.
 *
 * API:
 *   __UAD.adobeMapper.resolve(varName)        -> string | null
 *   __UAD.adobeMapper.decorate(src, varName)  -> src arricchito (per il tooltip)
 *   __UAD.adobeMapper.republish()             -> ripubblica la mappa al pannello
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

  // Nomi di data element più comuni per il mapper. Provati in ordine; se nessuno
  // funziona si passa alla scansione filtrata dei data element.
  var CANDIDATE_NAMES = [
    'mapper', 'Mapper', 'varMapper', 'variableMapper', 'evarMapper',
    'eVarMapper', 'analyticsMapper', 'aaMapper', 'adobeMapper',
    'dataMapping', 'variableMapping', 'mapping', 'Mapping',
    'eddlMapper', 'EDDL Mapper', 'dl_mapper', 'varMap', 'variableMap'
  ];

  // Data element che contengono il data layer: serve solo come informazione
  // aggiuntiva nella barra del pannello.
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
    sourceElement: null,  // data element da cui viene il mapper
    dataLayerElement: null,
    entries: 0,
    scans: 0,
    pollTimer: null,
    signature: null       // per ripubblicare solo quando la mappa cambia
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
   * Un oggetto è un mapper se ha almeno 3 chiavi che sembrano variabili Adobe e
   * valori stringa. La soglia di 3 evita i falsi positivi: un oggetto con una
   * sola chiave "eVar1" potrebbe essere qualsiasi cosa.
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
      // Detection PER FORMA: altre estensioni possono dichiarare _satellite come
      // getter che ritorna undefined.
      if (s && typeof s === 'object' && typeof s.getVar === 'function') return s;
      return null;
    } catch (e) { return null; }
  }

  function readVar(sat, name) {
    try { return sat.getVar(name); }
    catch (e) { return undefined; }
  }

  /** Elenco dei data element configurati, se il container è ispezionabile. */
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
   * Cerca il mapper: prima i nomi candidati, poi i data element del container il
   * cui nome è plausibile. La scansione completa non è gratuita: getVar() può
   * eseguire codice custom del cliente, e chiamarlo su 200 data element ha un
   * costo reale.
   */
  function findMapper() {
    var sat = satellite();
    if (!sat) return false;

    state.scans++;

    for (var i = 0; i < CANDIDATE_NAMES.length; i++) {
      var v = readVar(sat, CANDIDATE_NAMES[i]);
      if (looksLikeMapper(v)) return adopt(CANDIDATE_NAMES[i], v);
    }

    var all = listDataElements(sat);
    for (var j = 0; j < all.length; j++) {
      var name = all[j];
      if (CANDIDATE_NAMES.indexOf(name) !== -1) continue;   // già provato
      if (!/map|dict|lookup|trad|conf|schema|var/i.test(name)) continue;
      var val = readVar(sat, name);
      if (looksLikeMapper(val)) return adopt(name, val);
    }

    return false;
  }

  function adopt(elementName, obj) {
    var built = buildMap(obj);
    if (!built.n) return false;

    state.map = built.map;
    state.entries = built.n;
    state.sourceElement = elementName;

    // Ripubblichiamo solo se la mappa è cambiata: Launch può ricaricare i data
    // element durante la vita della pagina, e un invio a ogni giro sarebbe rumore
    // inutile sul ponte.
    var sig = elementName + '|' + built.n;
    try { sig += '|' + JSON.stringify(built.map).length; } catch (e) {}

    if (sig !== state.signature) {
      state.signature = sig;
      UAD.log('adobe-mapper: mapper in "' + elementName + '" — ' + built.n + ' variabili');
      publish();
    }
    return true;
  }

  /** Cerca il data layer: informazione aggiuntiva mostrata nella barra. */
  function findDataLayer() {
    var sat = satellite();
    if (!sat || state.dataLayerElement) return;

    for (var i = 0; i < DATALAYER_NAMES.length; i++) {
      var v = readVar(sat, DATALAYER_NAMES[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        var keys;
        try { keys = Object.keys(v); } catch (e) { continue; }
        if (keys.length >= 2) {
          state.dataLayerElement = DATALAYER_NAMES[i];
          UAD.log('adobe-mapper: data layer in "' + DATALAYER_NAMES[i] + '"');
          return;
        }
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Pubblicazione verso il pannello
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Invia la mappa sul canale HIT con la chiave __uadMapper.
   *
   * NON è un evento: il pannello lo intercetta in ingest() e non lo memorizza tra
   * le hit. Lo stesso meccanismo usato dal comando "diagnose".
   *
   * Il motivo del cambio: un mapper rilevato non è una chiamata di analytics, e
   * comparire in mezzo alle hit sporcava la cronologia.
   */
  function publish() {
    try {
      var payload = {
        __uadMapper: {
          entries: state.entries,
          sourceElement: state.sourceElement,
          dataLayerElement: state.dataLayerElement,
          map: state.map,
          ts: Date.now()
        }
      };
      window.dispatchEvent(new CustomEvent(UAD.CH.HIT, {
        detail: UAD.serialize(payload)
      }));
    } catch (e) {
      UAD.error('adobe-mapper.publish', e);
    }
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

        findDataLayer();
        var found = findMapper();

        if (Date.now() - t0 > POLL_MAX_MS) {
          stopPolling();
          if (!found && !state.entries) {
            UAD.log('adobe-mapper: nessun mapper trovato dopo ' + (POLL_MAX_MS / 1000) +
                    's (normale su implementazioni che non usano il pattern EDDL)');
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
   * @param {string} varName  'eVar1' | 'evar1' | 'prop5'
   */
  function resolve(varName) {
    if (!state.entries) return null;
    var norm = normalizeVar(varName);
    if (!norm) return null;
    return state.map[norm] || null;
  }

  /**
   * Arricchisce il campo `src` di una riga con il nome umano.
   *
   * Resta disponibile per i connettori che vogliono il nome anche nel tooltip
   * della sorgente, ma NON è il canale principale: la visualizzazione inline
   * accanto alla chiave è gestita dal pannello, che riceve la mappa completa e
   * può accenderla e spegnerla con un interruttore.
   */
  function decorate(currentSrc, varName) {
    var human = resolve(varName);
    if (!human) return currentSrc || null;
    if (!currentSrc) return human;
    return human + '  ·  ' + currentSrc;
  }

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

    // _satellite può comparire dopo di noi: il watcher lo intercetta con
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
    state.signature = null;

    // Pubblichiamo la mappa vuota: il pannello nasconde la barra invece di
    // mostrare un mapper che non è più attivo.
    publish();
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
      // Il pannello può essere stato riaperto: ripubblichiamo perché ha perso la
      // mappa ricevuta prima.
      else if (want && state.entries) publish();
    })();
  }, false);

  /* ════════════════════════════════════════════════════════════════════════
     Export
     Non è un connettore: nessuna UAD.register(). Non ha tab, non ha detect(),
     non produce eventi.
     ════════════════════════════════════════════════════════════════════════ */

  UAD.adobeMapper = {
    resolve: resolve,
    decorate: decorate,
    getMap: getMap,
    republish: publish,
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