/**
 * Universal Analytics Debugger — connettore Adobe Experience Platform Web SDK
 * (Alloy.js), standalone o orchestrato da Adobe Launch
 * World: MAIN | Carica dopo il core, prima di content-script.js
 *
 * DETECTION — quattro strati in ordine di affidabilita
 *
 *  1. window.__alloyNS — array con i NOMI di tutte le istanze create dal base
 *     code di Alloy. E' il canale primario perche il nome dell'istanza e'
 *     CONFIGURABILE: in Adobe Launch spesso non e' "alloy" ma "WebSDK_prod" o
 *     simili, e window.alloy non esiste affatto.
 *     ⚠ ONESTA: __alloyNS e' un dettaglio implementativo del base code, NON un
 *     contratto pubblico documentato da Adobe. Funziona su tutte le
 *     installazioni standard osservate, ma va trattato come euristica.
 *     E' anche il motivo per cui il canale rete resta obbligatorio.
 *
 *  2. window.alloy — caso standalone classico.
 *
 *  3. window._satellite — conferma che Launch c'e', ma NON da accesso all'XDM.
 *     ⚠ Il pre-flight ha trovato _satellite e __alloyNS dichiarati come GETTER
 *     che ritornano undefined da un'ALTRA estensione Adobe installata. Un check
 *     `'_satellite' in window` passerebbe su un sito senza Adobe. Per questo la
 *     detection e' sempre PER FORMA, mai per esistenza.
 *
 *  4. RETE — la verita. Match su body JSON con `xdm` o `events[].xdm` di primo
 *     livello, indipendentemente dall'hostname: i CNAME first-party
 *     (data.brand.com, smetrics.brand.com) sono la norma.
 *
 * BATCH: una singola request Edge puo contenere piu eventi in events[]. Chi non
 * splitta vede un evento invece di N.
 *
 * CASE-INCONSISTENCY: le chiavi eVar compaiono sia come eVarN sia come evarN in
 * implementazioni reali. Il parser e' case-insensitive su quel prefisso.
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] adobe-aep: namespace assente'); } catch (e) {} return; }

  var ID = 'adobe-aep';

  /* ════════════════════════════════════════════════════════════════════════
     Parsing XDM — schema standard documentato Adobe, universale
     ════════════════════════════════════════════════════════════════════════ */

  function pushRow(cats, cat, key, value, src) {
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ key: key, value: value, src: src || null });
  }

  /** Accesso a un path senza mai lanciare. */
  function dig(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur === null || typeof cur !== 'object') return undefined;
      try { cur = cur[path[i]]; } catch (e) { return undefined; }
    }
    return cur;
  }

  /**
   * Trova una chiave con match case-insensitive su un pattern.
   * Necessario per eVars/evars, props/Props e event1to100/Event1to100.
   */
  function findKey(obj, re) {
    if (!obj || typeof obj !== 'object') return null;
    var keys;
    try { keys = Object.keys(obj); } catch (e) { return null; }
    for (var i = 0; i < keys.length; i++) if (re.test(keys[i])) return keys[i];
    return null;
  }

  /** Estrae il valore da una struttura Adobe: {value: N} oppure valore diretto. */
  function measureValue(v) {
    if (v && typeof v === 'object') {
      if (v.value !== undefined) return v.value;
      if (v.id !== undefined) return v.id;
      try { return JSON.stringify(v); } catch (e) { return '[object]'; }
    }
    return v;
  }

  /**
   * Legge il ramo _experience.analytics: eVars, props, events, hierarchies.
   * @param {object} root       nodo che contiene _experience (xdm o productListItem)
   * @param {object} cats       accumulatore categorie
   * @param {string} srcPrefix  path per il campo `src`
   * @param {string} suffix     etichetta aggiuntiva (per i prodotti)
   */
  function readAnalyticsBranch(root, cats, srcPrefix, suffix) {
    var an = dig(root, ['_experience', 'analytics']);
    if (!an || typeof an !== 'object') return false;
    var found = false;
    var lbl = suffix ? (' ' + suffix) : '';

    // --- customDimensions: eVars / props / listProps / hierarchies
    var cd = an.customDimensions;
    if (cd && typeof cd === 'object') {
      // eVars: case-insensitive (eVars | evars | eVar | evar)
      var kEv = findKey(cd, /^ev(ar)?s?$/i);
      if (kEv && cd[kEv] && typeof cd[kEv] === 'object') {
        Object.keys(cd[kEv]).forEach(function (k) {
          var v = measureValue(cd[kEv][k]);
          if (v === undefined || v === null || v === '') return;
          // Normalizziamo la visualizzazione: evar3 -> eVar3
          var norm = String(k).replace(/^ev(ar)?/i, 'eVar');
          pushRow(cats, 'eVars' + lbl, norm, v,
            srcPrefix + '._experience.analytics.customDimensions.' + kEv + '.' + k);
          found = true;
        });
      }

      var kPr = findKey(cd, /^props?$/i);
      if (kPr && cd[kPr] && typeof cd[kPr] === 'object') {
        Object.keys(cd[kPr]).forEach(function (k) {
          var v = measureValue(cd[kPr][k]);
          if (v === undefined || v === null || v === '') return;
          var norm = String(k).replace(/^prop/i, 'prop');
          pushRow(cats, 'Props' + lbl, norm, v,
            srcPrefix + '._experience.analytics.customDimensions.' + kPr + '.' + k);
          found = true;
        });
      }

      var kLp = findKey(cd, /^listprops?$/i);
      if (kLp && cd[kLp] && typeof cd[kLp] === 'object') {
        Object.keys(cd[kLp]).forEach(function (k) {
          var v = measureValue(cd[kLp][k]);
          if (v === undefined || v === null || v === '') return;
          pushRow(cats, 'List Props' + lbl, k, v,
            srcPrefix + '._experience.analytics.customDimensions.' + kLp + '.' + k);
          found = true;
        });
      }

      var kHi = findKey(cd, /^(hierarchies|lists)$/i);
      if (kHi && cd[kHi] && typeof cd[kHi] === 'object') {
        Object.keys(cd[kHi]).forEach(function (k) {
          var node = cd[kHi][k];
          var v = (node && node.values && Array.isArray(node.values))
            ? node.values.join(' > ')
            : measureValue(node);
          if (v === undefined || v === null || v === '') return;
          pushRow(cats, 'Hierarchy' + lbl, k, v,
            srcPrefix + '._experience.analytics.customDimensions.' + kHi + '.' + k);
          found = true;
        });
      }
    }

    // --- events: eventNtoM, un ramo per fascia (event1to100, event101to200, ...)
    Object.keys(an).forEach(function (branch) {
      if (!/^event\d+to\d+$/i.test(branch)) return;
      var node = an[branch];
      if (!node || typeof node !== 'object') return;
      Object.keys(node).forEach(function (evName) {
        var e = node[evName];
        var parts = [];
        if (e && typeof e === 'object') {
          if (e.value !== undefined) parts.push('value=' + e.value);
          if (e.id !== undefined) parts.push('id=' + e.id);
        }
        pushRow(cats, 'Events' + lbl, evName,
          parts.length ? parts.join(' · ') : '(senza valore)',
          srcPrefix + '._experience.analytics.' + branch + '.' + evName);
        found = true;
      });
    });

    // --- campaign, purchaseID, transactionID e simili
    ['campaign', 'purchaseID', 'transactionID', 'channel'].forEach(function (k) {
      var v = an[k];
      if (v === undefined || v === null || v === '') return;
      pushRow(cats, 'Core', k, measureValue(v),
        srcPrefix + '._experience.analytics.' + k);
      found = true;
    });

    return found;
  }

  /** Identity map: ECID e altri namespace. */
  function readIdentity(xdm, cats) {
    var im = xdm.identityMap;
    if (!im || typeof im !== 'object') return;
    Object.keys(im).forEach(function (ns) {
      var arr = im[ns];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (item, i) {
        if (!item || typeof item !== 'object') return;
        var label = ns + (arr.length > 1 ? ' [' + i + ']' : '');
        pushRow(cats, 'Identity', label, item.id,
          'identityMap.' + ns + '[' + i + '].id');
        if (item.authenticatedState) {
          pushRow(cats, 'Identity', label + ' · stato', item.authenticatedState,
            'identityMap.' + ns + '[' + i + '].authenticatedState');
        }
        if (item.primary !== undefined) {
          pushRow(cats, 'Identity', label + ' · primary', item.primary,
            'identityMap.' + ns + '[' + i + '].primary');
        }
      });
    });
  }

  /** Ramo web: pagina, referrer, interazione con i link. */
  function readWeb(xdm, cats) {
    var pd = dig(xdm, ['web', 'webPageDetails']);
    if (pd && typeof pd === 'object') {
      ['name', 'URL', 'server', 'siteSection', 'isErrorPage', 'isHomePage'].forEach(function (k) {
        if (pd[k] === undefined || pd[k] === null || pd[k] === '') return;
        pushRow(cats, 'Web / Page', k, pd[k], 'web.webPageDetails.' + k);
      });
      if (pd.pageViews && pd.pageViews.value !== undefined) {
        pushRow(cats, 'Web / Page', 'pageViews', pd.pageViews.value, 'web.webPageDetails.pageViews.value');
      }
    }

    var li = dig(xdm, ['web', 'webInteraction']);
    if (li && typeof li === 'object') {
      ['name', 'type', 'URL', 'region'].forEach(function (k) {
        if (li[k] === undefined || li[k] === null || li[k] === '') return;
        pushRow(cats, 'Web / Link', k, li[k], 'web.webInteraction.' + k);
      });
      if (li.linkClicks && li.linkClicks.value !== undefined) {
        pushRow(cats, 'Web / Link', 'linkClicks', li.linkClicks.value, 'web.webInteraction.linkClicks.value');
      }
    }

    var rf = dig(xdm, ['web', 'webReferrer']);
    if (rf && rf.URL) pushRow(cats, 'Web / Page', 'referrer', rf.URL, 'web.webReferrer.URL');
  }

  /** Commerce: carrello, ordine, checkout. */
  function readCommerce(xdm, cats) {
    var c = xdm.commerce;
    if (!c || typeof c !== 'object') return;

    Object.keys(c).forEach(function (k) {
      var node = c[k];
      if (node && typeof node === 'object') {
        if (node.value !== undefined) {
          pushRow(cats, 'Commerce', k, node.value, 'commerce.' + k + '.value');
          return;
        }
        // order, cart: oggetti con sotto-campi
        Object.keys(node).forEach(function (sk) {
          var v = node[sk];
          if (v === undefined || v === null || v === '') return;
          if (typeof v === 'object') {
            if (Array.isArray(v)) {
              pushRow(cats, 'Commerce', k + '.' + sk, v.length + ' elementi', 'commerce.' + k + '.' + sk);
            } else if (v.value !== undefined) {
              pushRow(cats, 'Commerce', k + '.' + sk, v.value, 'commerce.' + k + '.' + sk + '.value');
            }
            return;
          }
          pushRow(cats, 'Commerce', k + '.' + sk, v, 'commerce.' + k + '.' + sk);
        });
        return;
      }
      if (node !== undefined && node !== null && node !== '') {
        pushRow(cats, 'Commerce', k, node, 'commerce.' + k);
      }
    });
  }

  /** productListItems: ognuno con le sue eVars/events di merchandising. */
  function readProducts(xdm) {
    var items = xdm.productListItems;
    if (!Array.isArray(items) || !items.length) return [];

    return items.map(function (it, i) {
      var fields = [];
      var pcats = {};

      if (it && typeof it === 'object') {
        ['SKU', 'name', 'quantity', 'priceTotal', 'currencyCode', 'productAddMethod',
         'product', 'productImageUrl', '_id'].forEach(function (k) {
          if (it[k] === undefined || it[k] === null || it[k] === '') return;
          fields.push({ key: k, value: it[k], src: 'productListItems[' + i + '].' + k });
        });

        // eVars/events specifici del prodotto (merchandising)
        readAnalyticsBranch(it, pcats, 'productListItems[' + i + ']', '');
        Object.keys(pcats).forEach(function (cat) {
          pcats[cat].forEach(function (r) {
            fields.push({ key: cat + ': ' + r.key, value: r.value, src: r.src });
          });
        });
      }

      return {
        SKU: it && it.SKU,
        name: (it && (it.name || it.SKU)) || 'prodotto ' + (i + 1),
        fields: fields
      };
    });
  }

  /** Rami XDM non riconosciuti: mostrati appiattiti, invece di essere persi. */
  var KNOWN_TOP = {
    '_experience': 1, 'identityMap': 1, 'web': 1, 'commerce': 1,
    'productListItems': 1, 'eventType': 1, 'timestamp': 1, 'implementationDetails': 1,
    'environment': 1, 'device': 1, 'placeContext': 1, '_id': 1
  };

  function readCustom(xdm, cats) {
    Object.keys(xdm).forEach(function (k) {
      if (KNOWN_TOP[k]) return;
      var v = xdm[k];
      if (v === undefined || v === null) return;

      if (typeof v !== 'object') {
        pushRow(cats, 'XDM custom', k, v, k);
        return;
      }
      // Un solo livello di flatten: gli schemi custom possono essere profondi,
      // e il payload grezzo resta disponibile nel dettaglio dell'evento.
      (function walk(o, prefix, depth) {
        if (depth > 5) { pushRow(cats, 'XDM custom', prefix, '[…]', prefix); return; }
        Object.keys(o).forEach(function (sk) {
          var sv = o[sk];
          var path = prefix + '.' + sk;
          if (sv === undefined || sv === null) return;
          if (Array.isArray(sv)) {
            pushRow(cats, 'XDM custom', path, sv.length + ' elementi', path);
            return;
          }
          if (typeof sv === 'object') { walk(sv, path, depth + 1); return; }
          pushRow(cats, 'XDM custom', path, sv, path);
        });
      })(v, k, 0);
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     Nome evento: eventType -> pageName -> link name -> fallback
     ════════════════════════════════════════════════════════════════════════ */

  var EVENT_TYPE_LABEL = {
    'web.webpagedetails.pageViews': 'page view',
    'web.webinteraction.linkClicks': 'link click',
    'commerce.productViews': 'product view',
    'commerce.productListAdds': 'add to cart',
    'commerce.productListRemovals': 'remove from cart',
    'commerce.productListViews': 'cart view',
    'commerce.checkouts': 'checkout',
    'commerce.purchases': 'purchase',
    'commerce.saveForLaters': 'save for later',
    'decisioning.propositionDisplay': 'proposition display',
    'decisioning.propositionInteract': 'proposition interact'
  };

  function resolveName(xdm) {
    var et = xdm.eventType;
    var pageName = dig(xdm, ['web', 'webPageDetails', 'name']);
    var linkName = dig(xdm, ['web', 'webInteraction', 'name']);

    if (et) {
      var label = EVENT_TYPE_LABEL[String(et).toLowerCase()] || et;
      if (linkName) return label + ': ' + linkName;
      if (pageName) return label + ': ' + pageName;
      return label;
    }
    if (linkName) return 'link: ' + linkName;
    if (pageName) return pageName;
    return null;   // l'emitter applica la sua catena di fallback
  }

  function dedupeKey(xdm, configId) {
    var et = xdm.eventType || '?';
    var name = dig(xdm, ['web', 'webPageDetails', 'name']) ||
               dig(xdm, ['web', 'webInteraction', 'name']) || '?';
    return ID + '|' + (configId || '') + '|' + et + '|' + name;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Costruzione dell'evento da un XDM
     ════════════════════════════════════════════════════════════════════════ */

  function buildFromXdm(xdm, ctx) {
    var cats = {};
    if (!xdm || typeof xdm !== 'object') return null;

    // Core
    if (xdm.eventType) pushRow(cats, 'Core', 'eventType', xdm.eventType, 'eventType');
    if (xdm.timestamp) pushRow(cats, 'Core', 'timestamp XDM', xdm.timestamp, 'timestamp');
    if (ctx.configId) pushRow(cats, 'Core', 'datastream ID', ctx.configId, 'query configId');
    if (ctx.endpoint) pushRow(cats, 'Core', 'endpoint', ctx.endpoint, null);
    if (ctx.via) pushRow(cats, 'Core', 'canale invio', ctx.via, null);
    if (ctx.httpStatus !== null && ctx.httpStatus !== undefined) {
      pushRow(cats, 'Core', 'HTTP status', ctx.httpStatus, null);
    }
    var impl = dig(xdm, ['implementationDetails', 'name']);
    if (impl) {
      pushRow(cats, 'Core', 'implementazione', impl +
        (dig(xdm, ['implementationDetails', 'version']) ? ' v' + xdm.implementationDetails.version : ''),
        'implementationDetails');
    }

    var hasAnalytics = readAnalyticsBranch(xdm, cats, '', '');
    readIdentity(xdm, cats);
    readWeb(xdm, cats);
    readCommerce(xdm, cats);
    readCustom(xdm, cats);

    var products = readProducts(xdm);

    // Diagnostica utile: XDM valido ma senza il ramo Analytics significa che i
    // dati non arriveranno in Adobe Analytics (manca la mappatura nel
    // datastream, oppure e' un evento destinato solo ad AEP).
    if (!hasAnalytics && !products.length) {
      pushRow(cats, 'Diagnostica', 'nessun ramo _experience.analytics',
        'l\'evento non porta eVars/props/events: verificare la mappatura del datastream ' +
        'se questi dati sono attesi in Adobe Analytics', null);
    }

    var raw = null;
    try { raw = JSON.stringify(xdm, null, 2); } catch (e) {}

    return {
      name: resolveName(xdm),
      eventType: xdm.eventType,
      categorizedFields: cats,
      products: products.length ? products : undefined,
      source: ctx.channel,
      timestamp: ctx.ts || Date.now(),
      rawDebugString: raw ? ((ctx.url ? ctx.url + '\n\n[XDM]\n' : '[XDM]\n') + raw) : undefined,
      status: (!hasAnalytics && !products.length) ? 'partial' : 'ok',
      meta: {
        configId: ctx.configId || undefined,
        eventType: xdm.eventType || undefined,
        batch: ctx.batch || undefined,
        observedVia: ctx.observedVia || undefined
      },
      __key: dedupeKey(xdm, ctx.configId)
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     Offerta al dedupe
     ════════════════════════════════════════════════════════════════════════ */

  var state = {
    attached: false,
    instances: {},      // nome istanza -> true (wrappate)
    configIds: {},
    hits: 0,
    pollTimer: null,
    pollFound: false
  };

  function offer(channel, raw) {
    if (!raw) return;
    state.hits++;
    var key = raw.__key;
    delete raw.__key;
    raw.source = channel;
    UAD.dedupe.offer(ID, { channel: channel, key: key, raw: raw, timestamp: raw.timestamp });
  }

  /* ════════════════════════════════════════════════════════════════════════
     Canale rete: /ee/, interact, collect — riconoscimento per FORMA
     ════════════════════════════════════════════════════════════════════════ */

  function extractXdmList(body) {
    // Il body puo essere: {events:[{xdm},{xdm}]} oppure {xdm:{...}}
    if (!body || typeof body !== 'object') return [];
    if (Array.isArray(body.events)) {
      return body.events
        .map(function (e) { return e && e.xdm; })
        .filter(function (x) { return x && typeof x === 'object'; });
    }
    if (body.xdm && typeof body.xdm === 'object') return [body.xdm];
    return [];
  }

  function parseNetwork(rec) {
    var body = rec.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { return; }
    }
    var list = extractXdmList(body);
    if (!list.length) return;

    var configId = null;
    try {
      if (rec.urlObj) configId = rec.urlObj.searchParams.get('configId') ||
                                 rec.urlObj.searchParams.get('datastreamId');
    } catch (e) {}
    if (configId) state.configIds[configId] = true;

    for (var i = 0; i < list.length; i++) {
      var raw = buildFromXdm(list[i], {
        channel: 'network',
        configId: configId,
        endpoint: rec.urlObj ? (rec.urlObj.hostname + rec.urlObj.pathname) : null,
        via: rec.via,
        httpStatus: rec.status,
        ts: rec.ts,
        url: rec.url,
        batch: list.length > 1 ? (i + 1) + ' di ' + list.length : undefined
      });
      if (raw) offer('network', raw);
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Canale hook: wrap delle istanze Alloy
     ════════════════════════════════════════════════════════════════════════ */

  function wrapInstance(name) {
    var fn;
    try { fn = window[name]; } catch (e) { return false; }
    if (typeof fn !== 'function') return false;
    if (fn.__uadWrapped) { state.instances[name] = true; return true; }

    var wrapped = function () {
      var args = arguments;

      UAD.safe(ID + '.alloy(' + name + ')', function () {
        if (!UAD.isEnabled(ID)) return;
        var cmd = args[0];
        var opts = args[1];

        if (cmd === 'configure' && opts && typeof opts === 'object') {
          if (opts.datastreamId) state.configIds[opts.datastreamId] = true;
          if (opts.edgeConfigId) state.configIds[opts.edgeConfigId] = true;
          return;
        }
        if (cmd !== 'sendEvent' || !opts || typeof opts !== 'object') return;
        if (!opts.xdm || typeof opts.xdm !== 'object') return;

        var cid = Object.keys(state.configIds)[0] || null;
        var raw = buildFromXdm(opts.xdm, {
          channel: 'hook',
          configId: cid,
          ts: Date.now(),
          observedVia: name + '("sendEvent")'
        });

        // I dati non-XDM (`data`) sono usati per il forwarding lato datastream:
        // vanno mostrati, non ignorati.
        if (raw && opts.data && typeof opts.data === 'object') {
          (function walk(o, prefix, depth) {
            if (depth > 5) return;
            Object.keys(o).forEach(function (k) {
              var v = o[k];
              var path = prefix ? (prefix + '.' + k) : k;
              if (v === null || v === undefined) return;
              if (typeof v === 'object' && !Array.isArray(v)) { walk(v, path, depth + 1); return; }
              pushRow(raw.categorizedFields, 'Data (non-XDM)', path,
                Array.isArray(v) ? JSON.stringify(v) : v, 'data.' + path);
            });
          })(opts.data, '', 0);
        }

        if (raw) offer('hook', raw);
      })();

      // La chiamata originale non viene MAI alterata: alloy restituisce una
      // promise che il sito puo usare.
      return fn.apply(this, args);
    };
    wrapped.__uadWrapped = true;

    try {
      window[name] = wrapped;
      state.instances[name] = true;
      UAD.log(ID + ': istanza "' + name + '" wrappata');
      return true;
    } catch (e) {
      UAD.error(ID + '.wrapInstance ' + name, e);
      return false;
    }
  }

  /** Scopre le istanze da __alloyNS e le wrappa tutte. */
  function bindFromNS(ns) {
    if (!Array.isArray(ns)) return;
    for (var i = 0; i < ns.length; i++) {
      var n = ns[i];
      if (typeof n !== 'string' || state.instances[n]) continue;
      wrapInstance(n);
      // L'istanza puo essere assegnata dopo la comparsa di __alloyNS.
      UAD.watchGlobal(n, function (name) {
        return function () { UAD.safe(ID + '.rewrap', wrapInstance)(name); };
      }(n), { test: UAD.globalWatcher.SHAPE.alloyFn });
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Canale terziario: polling sui data element di Launch
     Attivo SOLO con "euristiche sperimentali". Best-effort dichiarato: molte
     implementazioni non espongono l'XDM in un data element leggibile, e un
     evento assente NON e' un bug.
     ════════════════════════════════════════════════════════════════════════ */

  var DE_CANDIDATES = ['xdm', 'XDM', 'WebSDK_xdm', 'webSdkXdm', 'xdmObject', 'XDM Object'];

  function startPolling() {
    if (state.pollTimer) return;
    var lastSig = null;
    var elapsed = 0;

    state.pollTimer = setInterval(function () {
      elapsed += 250;
      // Dopo 30s smettiamo: se non c'e' un data element leggibile, non ci sara.
      if (elapsed > 30000) { clearInterval(state.pollTimer); state.pollTimer = null; return; }

      UAD.safe(ID + '.polling', function () {
        if (!UAD.isEnabled(ID)) return;
        var sat = window._satellite;
        if (!sat || typeof sat.getVar !== 'function') return;

        for (var i = 0; i < DE_CANDIDATES.length; i++) {
          var v;
          try { v = sat.getVar(DE_CANDIDATES[i]); } catch (e) { continue; }
          if (!v || typeof v !== 'object') continue;

          var sig;
          try { sig = JSON.stringify(v); } catch (e) { continue; }
          if (sig === lastSig) return;
          lastSig = sig;
          state.pollFound = true;

          var raw = buildFromXdm(v, {
            channel: 'polling',
            configId: Object.keys(state.configIds)[0] || null,
            ts: Date.now(),
            observedVia: '_satellite.getVar("' + DE_CANDIDATES[i] + '")'
          });
          if (raw) {
            raw.status = 'partial';
            raw.meta = raw.meta || {};
            raw.meta.warning = 'osservato via polling su data element: euristica ' +
              'best-effort, il contenuto puo non corrispondere all\'evento inviato';
            offer('polling', raw);
          }
          return;
        }
      })();
    }, 250);
  }

  /* ════════════════════════════════════════════════════════════════════════
     Connettore
     ════════════════════════════════════════════════════════════════════════ */

  var connector = {
    id: ID,
    label: 'Adobe Web SDK',
    colorTheme: '#c9252d',

    /** SEMPRE per forma: il pre-flight ha trovato global Adobe dichiarate come
     *  getter vuoti da un'altra estensione installata. */
    detect: function (win) {
      try {
        var ns = win.__alloyNS;
        if (Array.isArray(ns) && ns.length) {
          for (var i = 0; i < ns.length; i++) {
            if (typeof win[ns[i]] === 'function') return true;
          }
          return true;   // istanza non ancora assegnata, ma il base code c'e'
        }
        if (typeof win.alloy === 'function') return true;

        var sat = win._satellite;
        if (sat && typeof sat === 'object' &&
            (typeof sat.track === 'function' || typeof sat.getVar === 'function' || !!sat._container)) {
          return true;
        }
        return state.hits > 0;   // rilevato dalla sola rete
      } catch (e) { return false; }
    },

    attach: function () {
      if (state.attached) return;
      state.attached = true;

      // 1. __alloyNS: canale primario, copre i nomi di istanza custom.
      UAD.watchGlobal('__alloyNS', function (v) {
        UAD.safe(ID + '.onAlloyNS', bindFromNS)(v);
      }, { test: UAD.globalWatcher.SHAPE.alloyNS });

      try { if (Array.isArray(window.__alloyNS)) bindFromNS(window.__alloyNS); }
      catch (e) { UAD.error(ID + '.attach __alloyNS', e); }

      // 2. window.alloy: caso standalone.
      UAD.watchGlobal('alloy', function () {
        UAD.safe(ID + '.onAlloy', wrapInstance)('alloy');
      }, { test: UAD.globalWatcher.SHAPE.alloyFn });

      try { if (typeof window.alloy === 'function') wrapInstance('alloy'); }
      catch (e) { UAD.error(ID + '.attach alloy', e); }

      // 3. Polling: solo su richiesta esplicita.
      if (UAD.settings && UAD.settings.features && UAD.settings.features.aggressiveHeuristics) {
        UAD.watchGlobal('_satellite', function () {
          UAD.safe(ID + '.startPolling', startPolling)();
        }, { test: UAD.globalWatcher.SHAPE.satellite });
        try { if (window._satellite) startPolling(); } catch (e) {}
      }

      UAD.log(ID + ' attach completato');
    },

    /**
     * Match per FORMA del payload, non per hostname: i CNAME first-party
     * (data.brand.com, smetrics.brand.com) sono la norma nelle installazioni
     * enterprise. Il path e' un indizio, il body e' la prova.
     */
    matches: function (url, method, body, rec) {
      try {
        var u = rec && rec.urlObj;
        if (!u) return false;
        var p = u.pathname, q = u.search || '';

        var pathHint = /\/ee\//.test(p) ||
                       /\/(interact|collect)$/.test(p) ||
                       /\/ee\/v\d+\//.test(p);
        var queryHint = /[?&](configId|datastreamId)=/.test(q);

        // Prova definitiva: il body JSON ha `xdm` o `events[].xdm`.
        var bodyHint = false;
        if (typeof body === 'string' && body.length > 2 && body.charAt(0) === '{') {
          bodyHint = /"xdm"\s*:/.test(body);
        } else if (body && typeof body === 'object') {
          bodyHint = !!(body.xdm || (Array.isArray(body.events) && body.events.some(function (e) {
            return e && e.xdm;
          })));
        }

        if (bodyHint) return true;
        if (pathHint && queryHint) return true;
        if (/\/ee\//.test(p) && method === 'POST') return true;
        return false;
      } catch (e) { return false; }
    },

    parseNetwork: function (rec) {
      UAD.safe(ID + '.parseNetwork', parseNetwork)(rec);
    }
  };

  UAD.register(connector, true);
})();