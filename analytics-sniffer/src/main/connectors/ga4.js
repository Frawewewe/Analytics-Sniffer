/**
 * Universal Analytics Debugger — connettore Google Analytics 4
 * World: MAIN | Carica dopo il core, prima di content-script.js
 *
 * v2 — tre correzioni:
 *   1. dedupeKey include l'indice di batch. Prima, cinque eventi nella stessa
 *      request con lo stesso nome (tipico: due view_item in un batch) avevano
 *      chiave identica e timestamp identico: il dedupe li fondeva in UNO.
 *      Sintomo osservato: "vedo solo il pageview".
 *   2. supporto ai Google tag con prefisso GT-, che possono contenere piu
 *      destinazioni (GA4 + Ads) in un solo tag. Il matching cercava solo
 *      tid=G-: le hit GT- erano invisibili.
 *   3. Consent Mode v2 completo: ad_user_data e ad_personalization, oltre ai
 *      due storage originali.
 *
 * GERARCHIA DEI CANALI — decisione architetturale
 *
 *   RETE = VERITA. La request /g/collect e' cio che Google riceve davvero, con
 *   i parametri di config e set GIA mergiati. E' l'unico canale che funziona su
 *   qualsiasi sito: molte implementazioni GTM non chiamano mai window.gtag,
 *   perche il tag template costruisce la request internamente.
 *   Verificato sul campo: siti con GTM attivo, cookie _ga presenti e nessun
 *   gtag globale. Un connettore basato sull'hook li vedrebbe muti.
 *
 *   HOOK = ARRICCHIMENTO. gtag() porta i nomi delle variabili sorgente (campo
 *   `src`) e i tipi JS originali, che la rete non puo conoscere perche riceve
 *   i parametri gia mappati.
 *
 * TRE INSIDIE CHE ROMPONO I PARSER NAIF (tutte gestite qui):
 *   1. BATCH: un POST a /g/collect puo contenere N eventi nel body, separati da
 *      newline, con i parametri comuni in querystring.
 *   2. ITEMS: gli items ecommerce arrivano come pr1=idXX~nmYY~pr9.99, con la
 *      tilde come separatore e prefissi di 2 caratteri. Non sono JSON.
 *   3. FIRST-PARTY: con server-side GTM l'endpoint sta su un hostname del
 *      cliente (sgtm.brand.it). Il match si basa su PATH e query, mai
 *      sull'hostname.
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] ga4: namespace assente'); } catch (e) {} return; }

  var ID = 'ga4';

  /* ════════════════════════════════════════════════════════════════════════
     Mappa dei parametri (Measurement Protocol v2)
     ════════════════════════════════════════════════════════════════════════ */

  var PROTO = {
    v:    'versione protocollo',
    tid:  'measurement ID',
    gtm:  'container GTM',
    gcd:  'consent default (codificato)',
    _p:   'cache buster',
    _gaz: 'versione gtag',

    // identita e sessione
    cid:  'client ID',
    sid:  'session ID',
    sct:  'numero sessione',
    seg:  'sessione engaged',
    _s:   'numero hit nella sessione',
    _ss:  'inizio sessione',
    _nsi: 'nuova sessione',
    _fv:  'prima visita',
    uid:  'user ID',
    _eu:  'user properties encoded',

    // pagina
    dl:   'URL pagina',
    dr:   'referrer',
    dt:   'titolo pagina',
    ul:   'lingua',
    sr:   'risoluzione schermo',
    vp:   'viewport',
    sd:   'profondita colore',

    // evento
    en:   'nome evento',
    _et:  'engagement time (ms)',
    _c:   'client hints',
    ir:   'ignora referrer',
    tt:   'traffic type',
    cu:   'valuta',
    _uei: 'user engagement',
    are:  'invio automatico eventi',
    frm:  'frame',
    _dbg: 'debug mode',
    _z:   'transport',
    _rnd: 'random',
    tfd:  'time to first dispatch',
    pscdl: 'privacy sandbox',
    ep:   'parametro evento (string)',
    epn:  'parametro evento (number)',
    up:   'user property (string)',
    upn:  'user property (number)',

    // consenso e privacy
    gcs:  'consent state',
    npa:  'non-personalized ads',
    dma:  'DMA compliance',
    dma_cps: 'DMA consent',
    gdid: 'Google tag ID',

    // ads e linker
    gclid: 'Google Ads click ID',
    gbraid: 'Google Ads braid (app)',
    wbraid: 'Google Ads braid (web)',
    _gl:   'cross-domain linker',
    gac:   'Google Ads conversion',
    gacid: 'Google Ads client ID',

    // server-side
    richsstsse: 'server-side tagging',
    _uc:  'user consent (SST)'
  };

  /**
   * Consent Mode: gcs=G1-- oppure G1V1 nelle versioni recenti.
   * Posizione 2 = ad_storage, posizione 3 = analytics_storage.
   * Le due dimensioni v2 (ad_user_data, ad_personalization) arrivano nel
   * parametro gcd, che ha una codifica separata.
   */
  function decodeGcs(gcs) {
    if (typeof gcs !== 'string' || gcs.length < 4) return null;
    var map = { '1': 'concesso', '0': 'negato', '-': 'non impostato' };
    return {
      ad_storage:        map[gcs.charAt(2)] || gcs.charAt(2),
      analytics_storage: map[gcs.charAt(3)] || gcs.charAt(3)
    };
  }

  /**
   * gcd codifica i default di TUTTE le dimensioni v2 in una stringa tipo
   * "13t3t3t3t5l1". Ogni dimensione occupa due caratteri: una lettera di stato
   * e un separatore.
   *
   * NOTA ONESTA: questa codifica non e' documentata pubblicamente da Google e
   * puo cambiare. La decodifica sotto e' derivata da osservazione: la marchiamo
   * come tale, e in caso di dubbio il valore grezzo resta sempre visibile.
   */
  var GCD_STATE = {
    'l': 'non impostato',
    'p': 'negato (default)',
    'q': 'concesso (default)',
    'r': 'negato (update)',
    't': 'concesso (update)',
    'm': 'negato',
    'n': 'concesso',
    'u': 'non richiesto',
    'v': 'concesso implicito'
  };

  var GCD_ORDER = [
    'ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'
  ];

  function decodeGcd(gcd) {
    if (typeof gcd !== 'string' || gcd.length < 4) return null;
    // Salta il prefisso numerico iniziale (es. "13"), poi legge a coppie.
    var body = gcd.replace(/^\d+/, '');
    var out = {};
    for (var i = 0; i < GCD_ORDER.length; i++) {
      var ch = body.charAt(i * 2);
      if (!ch) break;
      out[GCD_ORDER[i]] = GCD_STATE[ch] || ('codice "' + ch + '"');
    }
    return Object.keys(out).length ? out : null;
  }

  /** Prefissi standard degli item ecommerce (formato pr1=idXX~nmYY~...). */
  var ITEM_PREFIX = {
    id: 'item_id', nm: 'item_name', br: 'item_brand',
    ca: 'item_category', c2: 'item_category2', c3: 'item_category3',
    c4: 'item_category4', c5: 'item_category5',
    va: 'item_variant', ln: 'item_list_name', li: 'item_list_id',
    lp: 'index', pr: 'price', qt: 'quantity',
    ds: 'discount', af: 'affiliation', cp: 'coupon',
    lo: 'location_id', pi: 'promotion_id', pn: 'promotion_name',
    cn: 'creative_name', cs: 'creative_slot',
    k0: 'param_key_0', k1: 'param_key_1', k2: 'param_key_2',
    k3: 'param_key_3', k4: 'param_key_4', k5: 'param_key_5',
    v0: 'param_value_0', v1: 'param_value_1', v2: 'param_value_2',
    v3: 'param_value_3', v4: 'param_value_4', v5: 'param_value_5'
  };

  /* ════════════════════════════════════════════════════════════════════════
     Parsing degli items: "idSKU1~nmScarpa~pr49.9~qt2"
     ════════════════════════════════════════════════════════════════════════ */

  function parseItem(raw, index, srcParam) {
    var fields = [], name = null, id = null;
    var tokens = String(raw || '').split('~');

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      var p = t.slice(0, 2);
      var v = t.slice(2);
      var label = ITEM_PREFIX[p] || p;
      if (label === 'item_name') name = v;
      if (label === 'item_id')   id = v;
      fields.push({ key: label, value: v, src: srcParam + ' [' + p + ']' });
    }

    return {
      item_id: id,
      name: name || id || 'item ' + (index + 1),
      fields: fields
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     Parsing di un set di parametri (query o riga di body)
     ════════════════════════════════════════════════════════════════════════ */

  function parseParams(str) {
    var out = { keys: [], map: {}, items: [] };
    if (!str) return out;
    if (str.charAt(0) === '?') str = str.slice(1);

    var parts = str.split('&');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var eq = p.indexOf('=');
      var rk = (eq === -1) ? p : p.slice(0, eq);
      var rv = (eq === -1) ? '' : p.slice(eq + 1);

      var k, v;
      try { k = decodeURIComponent(rk.replace(/\+/g, ' ')); } catch (e) { k = rk; }
      try { v = decodeURIComponent(rv.replace(/\+/g, ' ')); } catch (e) { v = rv; }

      // pr1, pr2, ... = items ecommerce
      var m = /^pr(\d+)$/.exec(k);
      if (m) { out.items.push({ index: parseInt(m[1], 10) - 1, raw: v, param: k }); continue; }

      if (!(k in out.map)) out.keys.push(k);
      out.map[k] = v;
    }
    return out;
  }

  function pushRow(cats, cat, key, value, src) {
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ key: key, value: value, src: src || null });
  }

  /* ════════════════════════════════════════════════════════════════════════
     Costruzione dell'evento dalla rete
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * @param {object} common    parametri della querystring (validi per tutti)
   * @param {object} own       parametri specifici dell'evento (riga di body)
   * @param {object} rec       record di rete normalizzato
   * @param {object} batchInfo { index, total } oppure null
   */
  function buildEvent(common, own, rec, batchInfo) {
    var cats = {};
    var merged = {};
    var order = [];

    // I parametri dell'evento vincono su quelli comuni.
    common.keys.forEach(function (k) {
      if (!(k in merged)) { merged[k] = common.map[k]; order.push(k); }
    });
    own.keys.forEach(function (k) {
      if (!(k in merged)) order.push(k);
      merged[k] = own.map[k];
    });

    var eventName = merged.en || null;

    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      var v = merged[k];
      if (k === 'en') continue;   // diventa il nome dell'evento

      var m;

      // ep.* / epn.* = parametri evento
      if ((m = /^epn?\.(.+)$/.exec(k))) {
        pushRow(cats, 'Event Params', m[1], v, k);
        continue;
      }
      // up.* / upn.* = user properties
      if ((m = /^upn?\.(.+)$/.exec(k))) {
        pushRow(cats, 'User Properties', m[1], v, k);
        continue;
      }

      // --- Consenso: categoria dedicata, e' cio che si guarda piu spesso in EU
      if (k === 'gcs') {
        pushRow(cats, 'Consent', 'gcs (grezzo)', v, k);
        var st = decodeGcs(v);
        if (st) {
          pushRow(cats, 'Consent', 'ad_storage', st.ad_storage, 'gcs[2]');
          pushRow(cats, 'Consent', 'analytics_storage', st.analytics_storage, 'gcs[3]');
        }
        continue;
      }
      if (k === 'gcd') {
        pushRow(cats, 'Consent', 'gcd (grezzo)', v, k);
        var dflt = decodeGcd(v);
        if (dflt) {
          Object.keys(dflt).forEach(function (dim) {
            pushRow(cats, 'Consent', dim + ' (default)', dflt[dim], 'gcd — decodifica non ufficiale');
          });
        }
        continue;
      }
      if (k === 'npa' || k === 'dma' || k === 'dma_cps' || k === '_gl' || k === '_uc') {
        pushRow(cats, 'Consent', PROTO[k] || k, v, k);
        continue;
      }

      // --- Identita e sessione: separate dalla config, sono le prime che si
      //     cercano, e su cui interviene il cross-check coi cookie.
      if (k === 'cid' || k === 'sid' || k === 'uid' || k === 'sct' || k === '_s' ||
          k === 'seg' || k === '_ss' || k === '_fv' || k === '_nsi') {
        pushRow(cats, 'Identity & Session', PROTO[k] || k, v, k);
        continue;
      }

      pushRow(cats, 'Config', PROTO[k] || k, v, k);
    }

    // Items ecommerce: prima quelli propri dell'evento, poi quelli comuni.
    var itemsRaw = own.items.length ? own.items : common.items;
    var products = itemsRaw
      .slice()
      .sort(function (a, b) { return a.index - b.index; })
      .map(function (it, i) { return parseItem(it.raw, i, it.param); });

    var tid = merged.tid || '';

    var meta = {
      measurementId: tid,
      via: rec.via,
      httpStatus: rec.status,
      transport: merged._z || null
    };

    if (batchInfo) {
      meta.batch = (batchInfo.index + 1) + ' di ' + batchInfo.total;
      // Gli eventi batchati sono partiti nello stesso istante: i delta ms tra
      // loro non riflettono momenti di chiamata distinti. render.js lo mostra
      // come nota, per non far dedurre una cronologia inesistente.
      if (batchInfo.total > 1) {
        meta.batchIndex = batchInfo.index;
        meta.batchTotal = batchInfo.total;
      }
    }

    return {
      name: eventName || 'hit GA4',
      categorizedFields: cats,
      products: products.length ? products : undefined,
      source: 'network',
      timestamp: rec.ts,
      rawDebugString: rec.url +
        (own.raw ? '\n\n[evento]\n' + own.raw : '') +
        (rec.bodyTruncated ? '\n\n[body troncato]' : ''),
      meta: meta,
      __key: dedupeKey(tid, eventName, merged.cid, batchInfo ? batchInfo.index : null)
    };
  }

  /**
   * Chiave di correlazione hook <-> rete.
   *
   * NON include i parametri: l'hook vede quelli passati a gtag(), la rete vede
   * quelli con i default di config GIA mergiati. Sono insiemi diversi, e
   * includerli impedirebbe qualsiasi correlazione.
   *
   * INCLUDE l'indice di batch: era il bug della v1. Cinque eventi nella stessa
   * request hanno timestamp identico, e due con lo stesso nome (due view_item
   * in un batch, caso normale su un listing) finivano nello stesso bucket e
   * venivano fusi in un solo evento.
   */
  function dedupeKey(tid, eventName, cid, batchIndex) {
    return ID + '|' + (tid || '?') + '|' + (eventName || '?') + '|' + (cid || '') +
           (batchIndex !== null && batchIndex !== undefined ? '|b' + batchIndex : '');
  }

  /* ════════════════════════════════════════════════════════════════════════
     Canale rete
     ════════════════════════════════════════════════════════════════════════ */

  function parseNetwork(rec) {
    var u = rec.urlObj;
    var common = parseParams(u ? u.search : '');
    var events = [];

    // BATCH: il body contiene una riga per evento. Chi non splitta vede un solo
    // evento invece di N.
    if (rec.body && typeof rec.body === 'string' && rec.body.indexOf('=') !== -1) {
      var lines = rec.body.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (lines.length) {
        for (var i = 0; i < lines.length; i++) {
          var own = parseParams(lines[i]);
          own.raw = lines[i];
          events.push(buildEvent(common, own, rec, { index: i, total: lines.length }));
        }
      }
    }

    // Nessun body utile: l'evento e' interamente in querystring (GET / pixel).
    if (!events.length) {
      events.push(buildEvent(common, { keys: [], map: {}, items: [] }, rec, null));
    }

    for (var j = 0; j < events.length; j++) offer('network', events[j]);
  }

  /* ════════════════════════════════════════════════════════════════════════
     Canale hook: gtag()
     ════════════════════════════════════════════════════════════════════════ */

  var state = {
    attached: false,
    gtagWrapped: false,
    measurementIds: {},   // 'G-XXXX' | 'GT-XXXX' -> true
    config: {},           // parametri di config/set
    hits: 0
  };

  /** Flatten di un oggetto in righe key/value con path puntato. */
  function flattenParams(obj, cats, cat, prefix, depth) {
    depth = depth || 0;
    if (depth > 8 || !obj || typeof obj !== 'object') return;

    Object.keys(obj).forEach(function (k) {
      if (k === 'items') return;   // gestiti a parte
      var v = obj[k];
      var path = prefix ? (prefix + '.' + k) : k;

      if (v === null || v === undefined) return;
      if (Array.isArray(v)) {
        pushRow(cats, cat, path, JSON.stringify(v), path);
        return;
      }
      if (typeof v === 'object') {
        // Un nodo DOM nei parametri e' possibile: riconoscerlo evita di
        // attraversare un grafo enorme.
        if (typeof v.nodeType === 'number') {
          pushRow(cats, cat, path, '[elemento DOM]', path);
          return;
        }
        flattenParams(v, cats, cat, path, depth + 1);
        return;
      }
      pushRow(cats, cat, path, v, path);
    });
  }

  function buildFromGtag(eventName, params) {
    var cats = {};
    var p = params || {};

    flattenParams(p, cats, 'Event Params', '', 0);

    // Le user_properties possono arrivare qui o via gtag('set').
    if (p.user_properties && typeof p.user_properties === 'object') {
      Object.keys(p.user_properties).forEach(function (k) {
        pushRow(cats, 'User Properties', k, p.user_properties[k], 'user_properties.' + k);
      });
    }

    var products = [];
    if (Array.isArray(p.items)) {
      products = p.items.map(function (it, i) {
        var fields = [];
        if (it && typeof it === 'object') {
          Object.keys(it).forEach(function (k) {
            fields.push({ key: k, value: it[k], src: 'items[' + i + '].' + k });
          });
        }
        return {
          item_id: it && (it.item_id || it.id),
          name: (it && (it.item_name || it.name || it.item_id)) || 'item ' + (i + 1),
          fields: fields
        };
      });
    }

    // Measurement ID dalla config: la rete lo ha sempre, l'hook no.
    var tid = Object.keys(state.measurementIds)[0] || '';
    if (tid) pushRow(cats, 'Config', 'measurement ID', tid, 'gtag config');

    return {
      name: eventName,
      categorizedFields: cats,
      products: products.length ? products : undefined,
      source: 'hook',
      timestamp: Date.now(),
      meta: { observedVia: 'gtag()' },
      // L'hook non conosce l'indice di batch: la rete decidera la
      // corrispondenza. Il primo evento del batch (index 0) e' quello che
      // correla con l'hook, ed e' il comportamento voluto.
      __key: dedupeKey(tid, eventName, null, 0)
    };
  }

  function wrapGtag(fn) {
    if (typeof fn !== 'function' || fn.__uadWrapped) return fn;

    var wrapped = function () {
      var args = arguments;

      // La cattura non deve MAI poter alterare la chiamata originale.
      UAD.safe(ID + '.gtag', function () {
        if (!UAD.isEnabled(ID)) return;
        var cmd = args[0];

        if (cmd === 'config') {
          var tid = args[1];
          // Accetta sia G- (GA4) sia GT- (Google tag multi-destinazione).
          if (typeof tid === 'string' && /^(G|GT)-/.test(tid)) {
            state.measurementIds[tid] = true;
          }
          if (args[2] && typeof args[2] === 'object') {
            Object.keys(args[2]).forEach(function (k) { state.config[k] = args[2][k]; });
          }
          return;
        }
        if (cmd === 'set') {
          var o = (typeof args[1] === 'object') ? args[1] : null;
          if (o) Object.keys(o).forEach(function (k) { state.config[k] = o[k]; });
          return;
        }
        if (cmd === 'event') {
          var name = args[1];
          if (typeof name !== 'string' || !name) return;
          state.hits++;
          offer('hook', buildFromGtag(name, args[2]));
          return;
        }
        // 'js', 'consent', 'get': non generano hit dirette in questa tab.
        // I comandi consent sono mostrati dal connettore GTM.
      })();

      return fn.apply(this, args);
    };

    wrapped.__uadWrapped = true;
    state.gtagWrapped = true;
    UAD.log(ID + ': gtag wrappato');
    return wrapped;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Offerta al dedupe
     ════════════════════════════════════════════════════════════════════════ */

  function offer(channel, raw) {
    if (!raw) return;
    var key = raw.__key;
    delete raw.__key;
    UAD.dedupe.offer(ID, {
      channel: channel,
      key: key,
      raw: raw,
      timestamp: raw.timestamp
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     Connettore
     ════════════════════════════════════════════════════════════════════════ */

  var connector = {
    id: ID,
    label: 'GA4',
    colorTheme: '#e8710a',

    /**
     * Detection a strati. L'ultimo e' il piu importante: su molti siti non
     * esiste gtag, ma il cookie _ga_<ID> rivela la property attiva.
     */
    detect: function (win) {
      try {
        if (typeof win.gtag === 'function') return true;

        // Measurement ID nel dataLayer: accetta G- e GT-.
        if (Array.isArray(win.dataLayer)) {
          for (var i = 0; i < win.dataLayer.length; i++) {
            var s = '';
            try { s = JSON.stringify(win.dataLayer[i]); } catch (e) { continue; }
            var m = /\b(GT?-[A-Z0-9]{6,})\b/.exec(s || '');
            if (m) { state.measurementIds[m[1]] = true; return true; }
          }
        }

        // Cookie _ga_<ID>: prova che GA4 sta misurando anche senza gtag.
        var ck = document.cookie.match(/_ga_([A-Z0-9]{6,})/);
        if (ck) { state.measurementIds['G-' + ck[1]] = true; return true; }

        return state.hits > 0;   // rilevato dalla sola rete
      } catch (e) { return false; }
    },

    attach: function () {
      if (state.attached) return;
      state.attached = true;

      // gtag puo comparire dopo di noi, o essere riassegnato: il watcher copre
      // entrambi i casi e ci fa ri-wrappare.
      UAD.watchGlobal('gtag', function (v) {
        UAD.safe(ID + '.onGtag', function () {
          if (typeof v !== 'function' || v.__uadWrapped) return;
          try { window.gtag = wrapGtag(v); }
          catch (e) { UAD.error(ID + '.assign gtag', e); }
        })();
      }, { test: UAD.globalWatcher.SHAPE.gtag });

      try {
        if (typeof window.gtag === 'function' && !window.gtag.__uadWrapped) {
          window.gtag = wrapGtag(window.gtag);
        }
      } catch (e) { UAD.error(ID + '.attach gtag', e); }

      UAD.log(ID + ' attach completato');
    },

    /**
     * Match per PATH + query, MAI per hostname: con server-side GTM l'endpoint
     * sta su un dominio del cliente (sgtm.brand.it/g/collect).
     *
     * Riconosce sia tid=G- (GA4 classico) sia tid=GT- (Google tag con piu
     * destinazioni): quest'ultimo era invisibile nella v1.
     */
    matches: function (url, method, body, rec) {
      try {
        var u = rec && rec.urlObj;
        if (!u) return false;
        var p = u.pathname;
        var q = u.search || '';

        var isCollect = /\/(g|mp)\/collect$/.test(p) ||
                        (/\/collect$/.test(p) && /[?&]v=2(&|$)/.test(q));
        if (!isCollect) return false;

        // v=2 distingue GA4 da Universal Analytics; tid=G-/GT- conferma.
        if (/[?&]tid=GT?-/.test(q)) return true;
        if (typeof body === 'string' && /(^|&)tid=GT?-/.test(body)) return true;

        // Endpoint /g/collect con v=2 ma tid altrove (raro, alcune
        // configurazioni server-side): accettiamo comunque.
        if (/\/g\/collect$/.test(p) && /[?&]v=2(&|$)/.test(q)) return true;

        return false;
      } catch (e) { return false; }
    },

    parseNetwork: function (rec) {
      UAD.safe(ID + '.parseNetwork', parseNetwork)(rec);
    }
  };

  UAD.register(connector, true);
})();