/**
 * Universal Analytics Debugger — connettore Adobe Analytics legacy
 * (AppMeasurement / s_code, oggetto globale `s`)
 * World: MAIN | Carica dopo il core, prima di content-script.js
 *
 * TRE CANALI, in ordine di affidabilita:
 *
 *  1. s.registerPreTrackCallback  — API NATIVA di AppMeasurement 2.x, pensata
 *     esattamente per questo. Riceve la request URL gia costruita e permette di
 *     leggere `s` nello stesso tick. Strettamente meglio del monkey-patch di
 *     s.t: non entra in conflitto con altre estensioni o tag che patchano s.t,
 *     e non altera il valore di ritorno (alcune implementazioni lo usano per
 *     scrivere l'immagine nel documento).
 *
 *  2. wrap di s.t / s.tl — fallback per AppMeasurement pre-2.x (H-code), dove
 *     i callback non esistono. Snapshot di `s` PRIMA di chiamare l'originale:
 *     AppMeasurement azzera le variabili dopo l'invio, quindi leggere dopo
 *     restituirebbe un oggetto vuoto.
 *
 *  3. rete /b/ss/ — necessario perche AppMeasurement moderno usa sendBeacon o
 *     XHR POST, non piu solo l'image pixel. E' anche la sola verita su cosa
 *     Adobe ha davvero ricevuto.
 *
 * PARSING DELLA QUERYSTRING /b/ss/
 * Non e' piatta: usa compressione gerarchica per context data e liste
 * (c.&a.&x=1&y=2&.a&.c) con AQB/AQE come delimitatori. Un URLSearchParams
 * produrrebbe chiavi tipo "c.a.x" invece di "a.x". Serve un parser dedicato.
 *
 * CAVEAT linkTrackVars — informazione diagnostica di valore
 * Su s.tl() Adobe invia SOLO le variabili elencate in s.linkTrackVars. Leggere
 * tutto `s` mostrerebbe variabili che NON vengono inviate. Le separiamo in una
 * categoria dedicata: e' una delle cause piu comuni di "la eVar non arriva".
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] adobe-legacy: namespace assente'); } catch (e) {} return; }

  var ID = 'adobe-legacy';

  /* ════════════════════════════════════════════════════════════════════════
     Mappa posizionale standard Adobe (universale, non specifica di un cliente)
     ════════════════════════════════════════════════════════════════════════ */

  var CORE_MAP = {
    pageName: 'pageName', pageType: 'pageType', ch: 'channel', server: 'server',
    g: 'URL pagina', r: 'referrer', 'gn': 'URL pagina (long)',
    events: 'events', products: 'products', purchaseID: 'purchaseID',
    state: 'state', zip: 'zip', campaign: 'campaign',
    pe: 'tipo link', pev1: 'URL link', pev2: 'nome link', pev3: 'pev3',
    mid: 'ECID (Marketing Cloud ID)', aid: 'Analytics ID (legacy)',
    vid: 'Visitor ID custom', fid: 'Fallback ID',
    cc: 'valuta', ce: 'charset', ns: 'namespace', ndh: 'ndh',
    t: 'timestamp locale', ts: 'timestamp',
    s: 'risoluzione schermo', c: 'profondita colore', j: 'versione JS',
    v: 'cookie abilitati', k: 'cookie sessione', bw: 'larghezza browser',
    bh: 'altezza browser', ct: 'tipo connessione', hp: 'homepage',
    'AQB': null, 'AQE': null,          // delimitatori: non mostrarli
    pccr: 'pccr', cdp: 'cookie domain periods', vvp: 'vvp',
    lrt: 'tempo di risposta', 'D': 'debug'
  };

  /** c1..c75 -> propN · v1..v250 -> eVarN · h1..h5 -> hierN · l1..l3 -> listN */
  function decodePositional(k) {
    var m;
    if ((m = /^c(\d{1,3})$/.exec(k)))  return { cat: 'Props',  name: 'prop' + m[1] };
    if ((m = /^v(\d{1,3})$/.exec(k)))  return { cat: 'eVars',  name: 'eVar' + m[1] };
    if ((m = /^h(\d{1,2})$/.exec(k)))  return { cat: 'Hierarchy', name: 'hier' + m[1] };
    if ((m = /^l(\d{1,2})$/.exec(k)))  return { cat: 'List Vars', name: 'list' + m[1] };
    return null;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Parser della querystring gerarchica /b/ss/
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * @returns {{flat:Object, context:Object, order:string[]}}
   * `flat` = parametri di primo livello; `context` = context data (namespace c.)
   */
  function parseAdobeQuery(qs) {
    var flat = {}, context = {}, order = [];
    if (!qs) return { flat: flat, context: context, order: order };
    if (qs.charAt(0) === '?') qs = qs.slice(1);

    var parts = qs.split('&');
    var stack = [];

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;

      // Chiusura di namespace: ".a" oppure ".c"
      if (p.charAt(0) === '.' && p.indexOf('=') === -1) {
        if (stack.length) stack.pop();
        continue;
      }
      // Apertura di namespace: "c." oppure "a."
      if (p.charAt(p.length - 1) === '.' && p.indexOf('=') === -1) {
        stack.push(p.slice(0, -1));
        continue;
      }

      var eq = p.indexOf('=');
      var rawKey = (eq === -1) ? p : p.slice(0, eq);
      var rawVal = (eq === -1) ? '' : p.slice(eq + 1);

      var key, val;
      try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch (e) { key = rawKey; }
      try { val = decodeURIComponent(rawVal.replace(/\+/g, ' ')); } catch (e) { val = rawVal; }

      if (stack.length) {
        // Dentro un namespace: la radice "c" indica i context data.
        var root = stack[0];
        var path = stack.slice(1).concat([key]).join('.');
        if (root === 'c') {
          context[path] = val;
        } else {
          flat[stack.join('.') + '.' + key] = val;
        }
      } else {
        flat[key] = val;
        order.push(key);
      }
    }
    return { flat: flat, context: context, order: order };
  }

  /** RSID e versione dal path: /b/ss/<rsid>/<version>/... */
  function parsePath(pathname) {
    var m = /\/b\/ss\/([^/]*)\/(\d+)?/.exec(pathname || '');
    return {
      rsid: m ? decodeURIComponent(m[1] || '') : '',
      binaryVersion: m ? (m[2] || '') : ''
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     Parser della stringa products
     Formato: categoria;sku;quantita;prezzo;eventi;eVars   (piu prodotti con ,)
     eventi:  event1=1|event2      eVars: eVar1=x|eVar2=y
     ════════════════════════════════════════════════════════════════════════ */

  function parseProducts(str) {
    if (!str || typeof str !== 'string') return [];
    var out = [];
    var items = str.split(',');

    for (var i = 0; i < items.length; i++) {
      var raw = items[i];
      if (!raw || !raw.replace(/;/g, '').trim()) continue;

      var f = raw.split(';');
      var fields = [];
      var push = function (k, v, src) {
        if (v === undefined || v === '') return;
        fields.push({ key: k, value: v, src: src || null });
      };

      push('categoria', (f[0] || '').trim(), 'products[' + i + '].category');
      push('SKU',       (f[1] || '').trim(), 'products[' + i + '].sku');
      push('quantita',  (f[2] || '').trim(), 'products[' + i + '].quantity');
      push('prezzo',    (f[3] || '').trim(), 'products[' + i + '].price');

      // eventi di prodotto
      if (f[4]) {
        f[4].split('|').forEach(function (e) {
          if (!e) return;
          var kv = e.split('=');
          push(kv[0].trim(), kv.length > 1 ? kv[1] : '(senza valore)', 'products[' + i + '].events');
        });
      }
      // eVars di prodotto (merchandising)
      if (f[5]) {
        f[5].split('|').forEach(function (e) {
          if (!e) return;
          var kv = e.split('=');
          push(kv[0].trim(), kv.length > 1 ? kv[1] : '', 'products[' + i + '].evars');
        });
      }

      out.push({
        SKU: (f[1] || '').trim(),
        name: (f[1] || f[0] || 'prodotto ' + (i + 1)).trim(),
        fields: fields
      });
    }
    return out;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Costruzione dell'evento
     ════════════════════════════════════════════════════════════════════════ */

  function pushRow(cats, cat, key, value, src) {
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ key: key, value: value, src: src || null });
  }

  /** Nome evento: nome link -> pageName -> tipo hit -> path. Mai vuoto. */
  function resolveName(isLink, linkName, pageName) {
    if (isLink) return linkName ? ('link: ' + linkName) : 'link tracking';
    if (pageName) return pageName;
    return 'page view';
  }

  function linkTypeLabel(pe) {
    if (!pe) return null;
    if (/lnk_o/.test(pe)) return 'custom link';
    if (/lnk_d/.test(pe)) return 'download link';
    if (/lnk_e/.test(pe)) return 'exit link';
    return pe;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Canale 3 — parsing della request di rete
     ════════════════════════════════════════════════════════════════════════ */

  function buildFromNetwork(rec) {
    var u = rec.urlObj;
    var pathInfo = parsePath(u ? u.pathname : '');

    // Il payload puo stare in querystring (GET/pixel) o nel body (POST/beacon).
    var qs = (u && u.search) ? u.search : '';
    if (rec.body && typeof rec.body === 'string' && rec.body.indexOf('=') !== -1) {
      qs = qs ? (qs + '&' + rec.body) : rec.body;
    }

    var parsed = parseAdobeQuery(qs);
    var flat = parsed.flat, ctx = parsed.context;
    var cats = {};

    var isLink = !!flat.pe;
    var name = resolveName(isLink, flat.pev2, flat.pageName);

    // --- Core
    pushRow(cats, 'Core', 'report suite', pathInfo.rsid, 'path /b/ss/');
    pushRow(cats, 'Core', 'tipo hit', isLink ? (linkTypeLabel(flat.pe) || 'link') : 'page view', 'pe');
    pushRow(cats, 'Core', 'tracking server', u ? u.hostname : '', 'hostname');
    pushRow(cats, 'Core', 'canale invio', rec.via, null);
    if (rec.status !== null && rec.status !== undefined) {
      pushRow(cats, 'Core', 'HTTP status', rec.status, null);
    }

    // --- parametri di primo livello
    Object.keys(flat).forEach(function (k) {
      var v = flat[k];
      var pos = decodePositional(k);
      if (pos) { pushRow(cats, pos.cat, pos.name, v, k); return; }

      if (k === 'events') {
        String(v).split(',').forEach(function (e) {
          e = e.trim(); if (!e) return;
          var kv = e.split('=');
          pushRow(cats, 'Events', kv[0], kv.length > 1 ? kv[1] : '(senza valore)', 'events');
        });
        return;
      }
      if (k === 'products') return;   // gestiti a parte

      if (Object.prototype.hasOwnProperty.call(CORE_MAP, k)) {
        if (CORE_MAP[k] === null) return;   // AQB / AQE
        pushRow(cats, 'Core', CORE_MAP[k], v, k);
        return;
      }
      pushRow(cats, 'Altri parametri', k, v, k);
    });

    // --- context data
    Object.keys(ctx).forEach(function (k) {
      pushRow(cats, 'Context Data', k, ctx[k], 'c.' + k);
    });

    var products = parseProducts(flat.products);

    return {
      name: name,
      categorizedFields: cats,
      products: products.length ? products : undefined,
      source: 'network',
      timestamp: rec.ts,
      rawDebugString: rec.url + (rec.body && typeof rec.body === 'string' ? '\n\n[body]\n' + rec.body : ''),
      meta: {
        rsid: pathInfo.rsid,
        hitType: isLink ? 'link' : 'pageView',
        via: rec.via,
        httpStatus: rec.status
      },
      __key: dedupeKey(isLink, flat.pev2, flat.pageName, pathInfo.rsid)
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     Canali 1 e 2 — lettura dell'oggetto `s`
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Variabili che AppMeasurement invia. Su s.tl() solo quelle in linkTrackVars
   * partono davvero: le altre finiscono in una categoria dedicata.
   */
  function readSnapshot(s, isLink, requestUrl) {
    var cats = {};
    var notSent = [];
    var i, key, val;

    // linkTrackVars: "None" o vuoto significa "solo i default"
    var ltv = null;
    if (isLink) {
      var raw = s.linkTrackVars;
      if (typeof raw === 'string' && raw && !/^none$/i.test(raw)) {
        ltv = {};
        raw.split(',').forEach(function (n) { ltv[n.trim().toLowerCase()] = 1; });
      } else if (typeof raw === 'string' && /^none$/i.test(raw)) {
        ltv = {};   // nessuna variabile custom inviata
      }
    }
    var ltEvents = null;
    if (isLink && typeof s.linkTrackEvents === 'string' && s.linkTrackEvents &&
        !/^none$/i.test(s.linkTrackEvents)) {
      ltEvents = {};
      s.linkTrackEvents.split(',').forEach(function (n) { ltEvents[n.trim().toLowerCase()] = 1; });
    }

    function sent(varName) {
      if (!isLink || ltv === null) return true;
      return !!ltv[String(varName).toLowerCase()];
    }

    function add(cat, name, value, src) {
      if (value === undefined || value === null || value === '') return;
      if (!sent(name)) {
        notSent.push({ key: name, value: value, src: src || name });
        return;
      }
      pushRow(cats, cat, name, value, src || name);
    }

    // props / eVars
    for (i = 1; i <= 75; i++) {
      key = 'prop' + i;
      try { val = s[key]; } catch (e) { continue; }
      add('Props', key, val, 's.' + key);
    }
    for (i = 1; i <= 250; i++) {
      key = 'eVar' + i;
      try { val = s[key]; } catch (e) { continue; }
      add('eVars', key, val, 's.' + key);
    }
    for (i = 1; i <= 5; i++) {
      key = 'hier' + i;
      try { val = s[key]; } catch (e) { continue; }
      add('Hierarchy', key, val, 's.' + key);
    }
    for (i = 1; i <= 3; i++) {
      key = 'list' + i;
      try { val = s[key]; } catch (e) { continue; }
      add('List Vars', key, val, 's.' + key);
    }

    // events (rispettando linkTrackEvents)
    try {
      if (s.events) {
        String(s.events).split(',').forEach(function (e) {
          e = e.trim(); if (!e) return;
          var kv = e.split('=');
          var evName = kv[0].trim();
          var evVal = kv.length > 1 ? kv[1] : '(senza valore)';
          var ok = !isLink || ltEvents === null || !!ltEvents[evName.toLowerCase()];
          if (ok) pushRow(cats, 'Events', evName, evVal, 's.events');
          else notSent.push({ key: evName, value: evVal, src: 's.events (fuori da linkTrackEvents)' });
        });
      }
    } catch (e) { UAD.error(ID + '.readSnapshot events', e); }

    // core
    [['pageName', 'pageName'], ['pageType', 'pageType'], ['channel', 'channel'],
     ['server', 'server'], ['campaign', 'campaign'], ['state', 'state'],
     ['zip', 'zip'], ['purchaseID', 'purchaseID'], ['transactionID', 'transactionID'],
     ['currencyCode', 'valuta'], ['charSet', 'charset'], ['visitorID', 'Visitor ID custom'],
     ['account', 'report suite'], ['trackingServer', 'tracking server'],
     ['trackingServerSecure', 'tracking server secure'], ['version', 'versione AppMeasurement'],
     ['marketingCloudVisitorID', 'ECID']
    ].forEach(function (pair) {
      var v;
      try { v = s[pair[0]]; } catch (e) { return; }
      if (v === undefined || v === null || v === '') return;
      pushRow(cats, 'Core', pair[1], v, 's.' + pair[0]);
    });

    if (isLink) {
      try {
        if (s.linkName) pushRow(cats, 'Core', 'nome link', s.linkName, 's.linkName');
        if (s.linkType) pushRow(cats, 'Core', 'tipo link', s.linkType, 's.linkType');
        if (s.linkURL) pushRow(cats, 'Core', 'URL link', s.linkURL, 's.linkURL');
        if (s.linkTrackVars) pushRow(cats, 'Core', 'linkTrackVars', s.linkTrackVars, 's.linkTrackVars');
        if (s.linkTrackEvents) pushRow(cats, 'Core', 'linkTrackEvents', s.linkTrackEvents, 's.linkTrackEvents');
      } catch (e) {}
    }

    // context data
    try {
      if (s.contextData && typeof s.contextData === 'object') {
        Object.keys(s.contextData).forEach(function (k) {
          var v = s.contextData[k];
          if (v === undefined || v === null || v === '') return;
          pushRow(cats, 'Context Data', k, v, 's.contextData.' + k);
        });
      }
    } catch (e) { UAD.error(ID + '.readSnapshot contextData', e); }

    // prodotti
    var products = [];
    try { products = parseProducts(s.products); } catch (e) { UAD.error(ID + '.parseProducts', e); }

    // La categoria che spiega "perche la eVar non arriva".
    if (notSent.length) {
      cats['Non inviate (fuori da linkTrackVars)'] = notSent;
    }

    var pageName = null, linkName = null;
    try { pageName = s.pageName; linkName = s.linkName; } catch (e) {}

    return {
      name: resolveName(isLink, linkName, pageName),
      categorizedFields: cats,
      products: products.length ? products : undefined,
      timestamp: Date.now(),
      rawDebugString: requestUrl || undefined,
      meta: {
        hitType: isLink ? 'link' : 'pageView',
        appMeasurementVersion: (function () { try { return s.version; } catch (e) { return null; } })(),
        linkTrackVarsFiltered: notSent.length || undefined
      },
      __key: dedupeKey(isLink, linkName, pageName,
        (function () { try { return s.account; } catch (e) { return ''; } })())
    };
  }

  /**
   * Chiave di correlazione hook <-> rete.
   * LIMITE DICHIARATO: due hit identiche entro la finestra di dedupe (1200ms)
   * possono fondersi. In pratica raro, perche la rete chiude il bucket
   * immediatamente: la sequenza hook->rete->hook->rete resta separata.
   */
  function dedupeKey(isLink, linkName, pageName, rsid) {
    var label = isLink ? ('L:' + (linkName || '?')) : ('P:' + (pageName || '?'));
    var suite = String(rsid || '').split(',')[0];
    return ID + '|' + suite + '|' + label;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Connettore
     ════════════════════════════════════════════════════════════════════════ */

  var state = {
    attached: false,
    sObject: null,
    preTrackOk: false,
    wrappedT: false,
    wrappedTl: false,
    lastRequestUrl: null,
    hits: 0
  };

  /** Offerta al dedupe: la rete resta la verita, l'hook arricchisce con i `src`. */
  function offer(channel, raw) {
    if (!raw) return;
    state.hits++;
    var key = raw.__key;
    delete raw.__key;
    raw.source = channel;
    UAD.dedupe.offer(ID, { channel: channel, key: key, raw: raw, timestamp: raw.timestamp });
  }

  /** Canale 1: API nativa. Preferita quando disponibile. */
  function installPreTrack(s) {
    if (state.preTrackOk) return true;
    if (typeof s.registerPreTrackCallback !== 'function') return false;
    try {
      s.registerPreTrackCallback(function (requestUrl) {
        UAD.safe(ID + '.preTrack', function () {
          if (!UAD.isEnabled(ID)) return;
          state.lastRequestUrl = requestUrl || null;
          // `pe` nella URL distingue link da page view in modo affidabile.
          var isLink = /[?&]pe=/.test(String(requestUrl || ''));
          offer('hook', readSnapshot(s, isLink, requestUrl));
        })();
      });
      state.preTrackOk = true;
      UAD.log(ID + ': registerPreTrackCallback installato (canale primario)');
      return true;
    } catch (e) {
      UAD.error(ID + '.installPreTrack', e);
      return false;
    }
  }

  /** Canale 2: wrap di s.t / s.tl. Snapshot PRIMA della chiamata originale. */
  function wrapTrackMethods(s) {
    ['t', 'tl'].forEach(function (m) {
      var flag = (m === 't') ? 'wrappedT' : 'wrappedTl';
      var orig;
      try { orig = s[m]; } catch (e) { return; }
      if (typeof orig !== 'function') return;
      if (orig.__uadWrapped) { state[flag] = true; return; }

      var wrapped = function () {
        // Lo snapshot DEVE precedere la chiamata: AppMeasurement azzera le
        // variabili dopo l'invio.
        if (UAD.isEnabled(ID) && !state.preTrackOk) {
          UAD.safe(ID + '.wrap.' + m, function () {
            offer('hook', readSnapshot(s, m === 'tl', null));
          })();
        }
        return orig.apply(this, arguments);
      };
      wrapped.__uadWrapped = true;

      try {
        s[m] = wrapped;
        state[flag] = true;
        UAD.log(ID + ': s.' + m + ' wrappato (fallback)');
      } catch (e) { UAD.error(ID + '.wrap ' + m, e); }

      // Launch puo riassegnare s.t dopo di noi, sostituendo silenziosamente il
      // nostro hook: watchProp ci notifica e ri-wrappiamo.
      UAD.watchProp(s, m, function (nv) {
        if (typeof nv === 'function' && !nv.__uadWrapped) {
          setTimeout(function () { UAD.safe(ID + '.rewrap', wrapTrackMethods)(s); }, 0);
        }
      }, { test: function (v) { return typeof v === 'function'; } });
    });
  }

  function bindS(s) {
    if (!s || typeof s !== 'object') return;
    if (state.sObject === s && (state.preTrackOk || state.wrappedT || state.wrappedTl)) return;
    state.sObject = s;

    // Preferenza esplicita: se l'API nativa c'e', non tocchiamo s.t.
    if (!installPreTrack(s)) wrapTrackMethods(s);
  }

  var connector = {
    id: ID,
    label: 'Adobe AA',
    colorTheme: '#fa0f00',

    /** Detection PER FORMA, non per esistenza: il pre-flight ha trovato global
     *  Adobe dichiarate come getter vuoti da un'altra estensione installata. */
    detect: function (win) {
      try {
        var s = win.s;
        if (s && typeof s === 'object' &&
            (typeof s.t === 'function' || typeof s.tl === 'function' ||
             typeof s.account === 'string')) return true;
        // s_gi esiste anche prima che `s` sia creato.
        if (typeof win.s_gi === 'function') return true;
        return state.hits > 0;   // rilevato dalla sola rete
      } catch (e) { return false; }
    },

    attach: function () {
      if (state.attached) return;
      state.attached = true;

      // La global puo comparire dopo di noi (document_start) o essere
      // riassegnata piu volte da Launch: watchGlobal copre entrambi i casi.
      UAD.watchGlobal('s', function (v) {
        UAD.safe(ID + '.onS', bindS)(v);
      }, { test: UAD.globalWatcher.SHAPE.adobeS });

      // Gia presente al momento dell'attach.
      try { if (window.s) bindS(window.s); } catch (e) { UAD.error(ID + '.attach', e); }

      UAD.log(ID + ' attach completato');
    },

    /** Match per PATH, mai per hostname: i CNAME first-party
     *  (smetrics.brand.com) sono la norma nelle installazioni enterprise. */
    matches: function (url, method, body, rec) {
      try {
        var p = rec && rec.urlObj ? rec.urlObj.pathname : '';
        if (p.indexOf('/b/ss/') !== -1) return true;
        // Difesa: alcune implementazioni usano path custom ma conservano AQB.
        var q = rec && rec.urlObj ? rec.urlObj.search : '';
        if (/[?&]AQB=1/.test(q)) return true;
        if (typeof body === 'string' && /(^|&)AQB=1(&|$)/.test(body)) return true;
        return false;
      } catch (e) { return false; }
    },

    parseNetwork: function (rec) {
      var raw = buildFromNetwork(rec);
      offer('network', raw);
    }
  };

  // default ON: e' un tool day 1
  UAD.register(connector, true);
})();