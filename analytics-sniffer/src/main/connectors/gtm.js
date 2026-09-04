/**
 * Universal Analytics Debugger — connettore Google Tag Manager
 * World: MAIN | Carica dopo il core, prima di content-script.js
 *
 * v2 — tre correzioni:
 *   1. riconoscimento dei container GT- (Google tag). readContainers accettava
 *      GTM-, G-, AW-, DC- ma non GT-: un sito con solo un Google tag non
 *      mostrava alcun container.
 *   2. rilevamento server-side piu solido: l'hostname del container e quello
 *      delle hit possono differire, e va detto perche cambia dove finiscono i
 *      dati.
 *   3. Consent Mode v2: tutte e sette le dimensioni, con distinzione fra
 *      default e update e diagnostica sull'ordine.
 *
 * COSA MOSTRA QUESTA TAB — e perche e' diversa dalle altre
 * GTM non misura: contiene. Qui non mostriamo "hit inviate" ma la DIMENSIONE
 * TAG MANAGER:
 *   - ogni push nel dataLayer, con il suo nome evento
 *   - lo stato dei container (GTM-XXXX, GT-XXXX, versione, ambiente)
 *   - il Consent Mode: default, update, stato corrente
 *   - i comandi gtag('consent') intercettati
 *
 * SOVRAPPOSIZIONE VOLUTA CON LA TAB GA4
 * gtag() scrive nel dataLayer, quindi lo stesso evento puo comparire in
 * entrambe le tab. NON e' un doppione: qui vedi l'INPUT (cosa e' stato
 * chiesto), in GA4 l'OUTPUT (cosa e' stato inviato). Un push presente qui senza
 * la hit corrispondente in GA4 e' esattamente la diagnosi che serve: trigger
 * mancante, tag in pausa, consenso negato, errore JS nel tag.
 *
 * PERCHE NIENTE CORRELAZIONE COL DEDUPE
 * Gli altri connettori fondono hook e rete. Qui no: un push nel dataLayer NON
 * e' una hit di rete, e fonderlo nasconderebbe proprio l'informazione che
 * vogliamo (push presente, hit assente). Ogni push e' un evento a se.
 *
 * INSIDIA DEL dataLayer
 * Non e' un array normale: dopo il caricamento di GTM, .push e' una funzione
 * sostituita da GTM stesso che processa l'evento. Va wrappata, non
 * rimpiazzata, e il valore di ritorno (la nuova lunghezza) va preservato:
 * alcune implementazioni lo usano.
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] gtm: namespace assente'); } catch (e) {} return; }

  var ID = 'gtm';

  /* ════════════════════════════════════════════════════════════════════════
     Consent Mode
     ════════════════════════════════════════════════════════════════════════ */

  // Tutte e sette le dimensioni: le prime quattro sono quelle di Consent Mode
  // v2, obbligatorie in EEA da marzo 2024.
  var CONSENT_KEYS = [
    'ad_storage',
    'analytics_storage',
    'ad_user_data',
    'ad_personalization',
    'functionality_storage',
    'personalization_storage',
    'security_storage'
  ];

  var CONSENT_V2 = { ad_user_data: 1, ad_personalization: 1 };

  // Stato ricostruito dai comandi osservati: prima il default, poi gli update.
  var consentState = {
    hasDefault: false,
    defaultAt: null,
    current: {},
    defaults: {},
    history: []
  };

  function recordConsent(mode, params) {
    var changed = {};
    CONSENT_KEYS.forEach(function (k) {
      if (params && params[k] !== undefined) {
        consentState.current[k] = params[k];
        changed[k] = params[k];
        if (mode === 'default') consentState.defaults[k] = params[k];
      }
    });
    if (mode === 'default') {
      consentState.hasDefault = true;
      if (consentState.defaultAt === null) consentState.defaultAt = Date.now();
    }
    consentState.history.push({ mode: mode, changed: changed, ts: Date.now() });
    if (consentState.history.length > 50) consentState.history.shift();
    return changed;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Container: lettura dello stato reale
     ════════════════════════════════════════════════════════════════════════ */

  // GT- e' il Google tag introdotto da Google: puo contenere piu destinazioni
  // (GA4 + Ads) in un solo tag. Nella v1 mancava dall'elenco.
  var CONTAINER_RE = /^(GTM-|GT-|G-|AW-|DC-|MC-)/;

  /** Metadati scoperti dalle request /gtm.js e /gtag/js. */
  var containerMeta = {};   // id -> { version, env, dataLayerName, host, serverSide }

  function readContainers() {
    var out = [];
    try {
      var gtm = window.google_tag_manager;
      if (!gtm || typeof gtm !== 'object') return out;

      Object.keys(gtm).forEach(function (k) {
        if (!CONTAINER_RE.test(k)) return;
        var c = gtm[k];
        var info = { id: k, dataLayerName: null, preview: null, type: containerType(k) };

        // Le proprieta interne di GTM non sono documentate e cambiano tra
        // versioni: ogni lettura e' isolata.
        try {
          if (c && typeof c === 'object') {
            if (c.dataLayer && c.dataLayer.name) info.dataLayerName = c.dataLayer.name;
            if (typeof c.gtm_preview === 'string' && c.gtm_preview) info.preview = c.gtm_preview;
          }
        } catch (e) {}

        out.push(info);
      });
    } catch (e) { UAD.error(ID + '.readContainers', e); }
    return out;
  }

  function containerType(id) {
    if (/^GTM-/.test(id)) return 'container GTM';
    if (/^GT-/.test(id))  return 'Google tag';
    if (/^G-/.test(id))   return 'GA4';
    if (/^AW-/.test(id))  return 'Google Ads';
    if (/^DC-/.test(id))  return 'Floodlight';
    if (/^MC-/.test(id))  return 'Merchant Center';
    return 'destinazione';
  }

  /* ════════════════════════════════════════════════════════════════════════
     Costruzione dell'evento
     ════════════════════════════════════════════════════════════════════════ */

  function pushRow(cats, cat, key, value, src) {
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ key: key, value: value, src: src || null });
  }

  /** Appiattisce un oggetto in righe con path puntato: ecommerce.items[0].id */
  function flatten(obj, cats, cat, prefix, depth) {
    depth = depth || 0;
    if (depth > 8 || !obj || typeof obj !== 'object') return;

    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      var path = prefix ? (prefix + '.' + k) : k;

      if (v === null || v === undefined) {
        pushRow(cats, cat, path, v === null ? 'null' : '[undefined]', path);
        return;
      }
      if (Array.isArray(v)) {
        if (!v.length) { pushRow(cats, cat, path, '[]', path); return; }
        for (var i = 0; i < Math.min(v.length, 100); i++) {
          if (v[i] && typeof v[i] === 'object') flatten(v[i], cats, cat, path + '[' + i + ']', depth + 1);
          else pushRow(cats, cat, path + '[' + i + ']', v[i], path + '[' + i + ']');
        }
        if (v.length > 100) pushRow(cats, cat, path + '[…]', '+' + (v.length - 100) + ' elementi', path);
        return;
      }
      if (typeof v === 'object') {
        // Gli auto-event di GTM mettono gtm.element nel dataLayer: un nodo DOM
        // con React fiber attaccato. Riconoscerlo evita di attraversare un
        // grafo enorme.
        if (typeof v.nodeType === 'number') {
          pushRow(cats, cat, path, '[elemento DOM ' + String(v.nodeName || '').toLowerCase() + ']', path);
          return;
        }
        flatten(v, cats, cat, path, depth + 1);
        return;
      }
      if (typeof v === 'function') {
        pushRow(cats, cat, path, '[funzione' + (v.name ? ' ' + v.name : '') + ']', path);
        return;
      }
      pushRow(cats, cat, path, v, path);
    });
  }

  /** Eventi generati automaticamente da GTM, non dal codice del sito. */
  function isGtmInternal(name) {
    return typeof name === 'string' && /^gtm\./.test(name);
  }

  var INTERNAL_LABEL = {
    'gtm.js':                'GTM caricato',
    'gtm.dom':               'DOM pronto',
    'gtm.load':              'pagina caricata',
    'gtm.click':             'click (auto-event)',
    'gtm.linkClick':         'click su link (auto-event)',
    'gtm.formSubmit':        'submit form (auto-event)',
    'gtm.elementVisibility': 'elemento visibile (auto-event)',
    'gtm.scrollDepth':       'scroll (auto-event)',
    'gtm.video':             'video (auto-event)',
    'gtm.historyChange':     'cambio history (auto-event)',
    'gtm.historyChange-v2':  'cambio history v2 (auto-event)',
    'gtm.timer':             'timer (auto-event)',
    'gtm.init':              'inizializzazione',
    'gtm.init_consent':      'inizializzazione consenso',
    'gtm.triggerGroup':      'trigger group'
  };

  function buildFromPush(entry, index) {
    var cats = {};
    var name = null;
    var isInternal = false;

    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      name = entry.event || null;
      isInternal = isGtmInternal(name);

      // I dati del push, esclusi i campi tecnici di GTM.
      var payload = {};
      Object.keys(entry).forEach(function (k) {
        if (k === 'event') return;
        if (k === 'gtm.uniqueEventId' || k === 'eventCallback' || k === 'eventTimeout') return;
        payload[k] = entry[k];
      });

      // L'ecommerce merita la sua categoria: e' cio che si controlla piu spesso.
      if (payload.ecommerce !== undefined) {
        flatten({ ecommerce: payload.ecommerce }, cats, 'Ecommerce', '', 0);
        delete payload.ecommerce;
      }
      flatten(payload, cats, 'dataLayer', '', 0);

      // Campi tecnici GTM in categoria separata.
      if (entry['gtm.uniqueEventId'] !== undefined) {
        pushRow(cats, 'GTM', 'uniqueEventId', entry['gtm.uniqueEventId'], 'gtm.uniqueEventId');
      }
      if (typeof entry.eventCallback === 'function') {
        pushRow(cats, 'GTM', 'eventCallback', '[funzione presente]', 'eventCallback');
      }
      if (entry.eventTimeout !== undefined) {
        pushRow(cats, 'GTM', 'eventTimeout', entry.eventTimeout, 'eventTimeout');
      }
      if (isInternal && INTERNAL_LABEL[name]) {
        pushRow(cats, 'GTM', 'tipo', INTERNAL_LABEL[name], null);
      }

    } else if (Array.isArray(entry)) {
      // Forma arguments di gtag: ['event','purchase',{...}]
      name = 'gtag: ' + String(entry[0] || '?') +
             (typeof entry[1] === 'string' ? ' ' + entry[1] : '');
      for (var i = 0; i < entry.length; i++) {
        if (entry[i] && typeof entry[i] === 'object') {
          flatten(entry[i], cats, 'Parametri', 'arg' + i, 0);
        } else {
          pushRow(cats, 'Parametri', 'arg' + i, entry[i], null);
        }
      }

    } else {
      pushRow(cats, 'dataLayer', 'valore', entry, null);
    }

    // Stato consenso al momento dell'evento: sapere COSA era concesso spiega
    // perche un tag non ha sparato.
    if (Object.keys(consentState.current).length) {
      CONSENT_KEYS.forEach(function (k) {
        if (consentState.current[k] === undefined) return;
        var label = k + (CONSENT_V2[k] ? ' (v2)' : '');
        pushRow(cats, 'Consent', label, consentState.current[k], 'consent state');
      });
      if (!consentState.hasDefault) {
        pushRow(cats, 'Consent', '⚠ nessun consent default',
          'osservato un update senza default precedente', null);
      }
    }

    // Container attivi.
    var containers = readContainers();
    containers.forEach(function (c) {
      var extra = containerMeta[c.id] || {};
      var parts = [c.type];
      if (extra.version) parts.push('v' + extra.version);
      if (extra.env || c.preview) parts.push('env ' + (extra.env || c.preview));
      if (extra.serverSide) parts.push('server-side');
      pushRow(cats, 'Container', c.id, parts.join(' · '), 'google_tag_manager');
    });

    return {
      name: name || ('push #' + index),
      categorizedFields: cats,
      source: 'datalayer',
      timestamp: Date.now(),
      meta: {
        dataLayerIndex: index,
        gtmInternal: isInternal || undefined,
        containers: containers.map(function (c) { return c.id; }),
        uniqueEventId: (entry && entry['gtm.uniqueEventId']) || undefined
      }
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     Consent: evento dedicato
     ════════════════════════════════════════════════════════════════════════ */

  function emitConsent(mode, params) {
    var wasDefault = consentState.hasDefault;
    var changed = recordConsent(mode, params);
    var cats = {};

    // Cio che questo comando ha modificato.
    Object.keys(changed).forEach(function (k) {
      var label = k + (CONSENT_V2[k] ? ' (v2)' : '');
      pushRow(cats, 'Modificati', label, changed[k], 'gtag consent ' + mode);
    });

    // Il resto dello stato, per contesto.
    CONSENT_KEYS.forEach(function (k) {
      if (consentState.current[k] === undefined) return;
      if (changed[k] !== undefined) return;
      pushRow(cats, 'Stato corrente', k + (CONSENT_V2[k] ? ' (v2)' : ''),
        consentState.current[k], null);
    });

    if (params && params.wait_for_update !== undefined) {
      pushRow(cats, 'Modificati', 'wait_for_update', params.wait_for_update, 'gtag consent');
    }
    if (params && params.region) {
      pushRow(cats, 'Modificati', 'region',
        Array.isArray(params.region) ? params.region.join(', ') : params.region,
        'gtag consent');
    }

    // Diagnostica: le dimensioni v2 mancanti nel default sono un errore di
    // implementazione frequente, obbligatorie in EEA da marzo 2024.
    if (mode === 'default') {
      var missingV2 = Object.keys(CONSENT_V2).filter(function (k) {
        return consentState.defaults[k] === undefined;
      });
      if (missingV2.length) {
        pushRow(cats, 'Diagnostica', '⚠ dimensioni v2 assenti dal default',
          missingV2.join(', ') + ' — richieste in EEA da marzo 2024', null);
      }
    }

    var orphanUpdate = (mode === 'update' && !wasDefault);
    if (orphanUpdate) {
      pushRow(cats, 'Diagnostica', '⚠ update senza default',
        'Nessun consent default osservato prima di questo update: i tag potrebbero ' +
        'aver sparato senza restrizioni, oppure essere stati bloccati.', null);
    }

    UAD.emit(ID, {
      name: 'consent ' + mode,
      categorizedFields: cats,
      source: 'hook',
      timestamp: Date.now(),
      status: orphanUpdate ? 'partial' : 'ok',
      meta: {
        consentMode: mode,
        orphanUpdate: orphanUpdate || undefined
      }
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     Hook sul dataLayer
     ════════════════════════════════════════════════════════════════════════ */

  var state = {
    attached: false,
    bound: [],       // array wrappati (possono essere piu di uno)
    processed: new Map(),   // array -> indice ultimo elemento emesso
    hits: 0
  };

  function emitPush(entry, index) {
    if (!UAD.isEnabled(ID)) return;
    state.hits++;
    var raw = UAD.safe(ID + '.buildFromPush', function () {
      return buildFromPush(entry, index);
    })();
    if (raw) UAD.emit(ID, raw);
  }

  /**
   * Wrappa dataLayer.push preservando comportamento e valore di ritorno.
   * GTM sostituisce push con la propria funzione: la wrappiamo, non la
   * rimpiazziamo.
   */
  function wrapPush(dl) {
    if (!dl || typeof dl.push !== 'function') return false;
    if (dl.push.__uadWrapped) return true;

    var orig = dl.push;
    var wrapped = function () {
      var args = arguments;
      var startIndex = dl.length;

      // 1. PRIMA la chiamata originale: GTM deve processare l'evento nello
      //    stesso tick, senza ritardi introdotti da noi.
      var ret;
      try {
        ret = orig.apply(this, args);
      } catch (e) {
        // Un errore in GTM e' un problema del sito: logghiamo e rilanciamo.
        UAD.error(ID + '.dataLayer.push (chiamata originale)', e);
        throw e;
      }

      // 2. POI la nostra osservazione, isolata.
      UAD.safe(ID + '.push', function () {
        for (var i = 0; i < args.length; i++) {
          emitPush(args[i], startIndex + i);
        }
        state.processed.set(dl, Math.max(state.processed.get(dl) || 0, startIndex + args.length));
      })();

      return ret;
    };
    wrapped.__uadWrapped = true;

    try {
      dl.push = wrapped;
      if (state.bound.indexOf(dl) === -1) state.bound.push(dl);
      UAD.log(ID + ': dataLayer.push wrappato');
      return true;
    } catch (e) {
      UAD.error(ID + '.wrapPush', e);
      return false;
    }
  }

  /**
   * Elementi presenti PRIMA del nostro wrapping. Su ogni sito ce ne sono: lo
   * snippet GTM inline gira prima di qualsiasi content script, e ha gia spinto
   * il container, i consent default e spesso il primo pageview.
   */
  function drainExisting(dl) {
    if (!dl || typeof dl.length !== 'number') return;
    var from = state.processed.get(dl) || 0;
    var n = Math.min(dl.length, 500);

    for (var i = from; i < n; i++) {
      var entry = dl[i];

      // I consent arrivati prima di noi vanno REGISTRATI nello stato, non solo
      // mostrati: servono a spiegare gli eventi successivi.
      if (Array.isArray(entry) && entry[0] === 'consent' &&
          typeof entry[1] === 'string' && entry[2]) {
        recordConsent(entry[1], entry[2]);
      }
      emitPush(entry, i);
    }
    state.processed.set(dl, n);
  }

  function bindDataLayer(dl) {
    if (!dl || typeof dl.push !== 'function') return;
    if (state.bound.indexOf(dl) !== -1 && dl.push.__uadWrapped) return;
    drainExisting(dl);
    wrapPush(dl);
  }

  /**
   * gtag() e' un canale separato: i comandi consent vanno intercettati qui per
   * ricostruire lo stato, perche nel dataLayer arrivano in forma arguments e
   * andrebbero interpretati due volte.
   */
  function wrapGtagForConsent(fn) {
    if (typeof fn !== 'function' || fn.__uadGtmWrapped) return fn;

    var wrapped = function () {
      var args = arguments;
      UAD.safe(ID + '.gtag', function () {
        if (!UAD.isEnabled(ID)) return;
        if (args[0] === 'consent' && typeof args[1] === 'string') {
          emitConsent(args[1], args[2] || {});
        }
      })();
      return fn.apply(this, args);
    };
    wrapped.__uadGtmWrapped = true;
    return wrapped;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Rete: /gtm.js e /gtag/js portano versione e ambiente del container
     ════════════════════════════════════════════════════════════════════════ */

  function parseContainerRequest(rec) {
    try {
      var u = rec.urlObj;
      if (!u) return;

      var q = u.searchParams;
      var id = q.get('id') || '';
      if (!id) return;

      // Server-side tagging: il container arriva da un dominio del cliente
      // invece che da googletagmanager.com. Cambia dove finiscono le hit, e
      // spiega perche le request GA4 hanno un hostname inatteso.
      var serverSide = !/(^|\.)googletagmanager\.com$/.test(u.hostname);

      var meta = containerMeta[id] || {};
      meta.host = u.hostname;
      meta.serverSide = serverSide;
      if (q.get('l')) meta.dataLayerName = q.get('l');

      // gtm_auth + gtm_preview indicano un ambiente non di produzione.
      var env = null;
      if (q.get('gtm_auth')) env = 'preview/staging (gtm_auth)';
      else if (q.get('gtm_preview')) env = q.get('gtm_preview');
      if (env) meta.env = env;

      containerMeta[id] = meta;

      var cats = {};
      pushRow(cats, 'Container', 'ID', id, 'query id');
      pushRow(cats, 'Container', 'tipo', containerType(id), null);
      pushRow(cats, 'Container', 'endpoint', u.hostname + u.pathname, null);
      if (meta.dataLayerName) {
        pushRow(cats, 'Container', 'nome dataLayer', meta.dataLayerName, 'query l');
      }
      if (env) pushRow(cats, 'Container', 'ambiente', env, 'gtm_auth / gtm_preview');
      if (rec.status !== null && rec.status !== undefined) {
        pushRow(cats, 'Container', 'HTTP status', rec.status, null);
      }
      if (serverSide) {
        pushRow(cats, 'Diagnostica', 'server-side tagging',
          'container servito da ' + u.hostname + ' invece di googletagmanager.com: ' +
          'le hit dei tag potrebbero essere inoltrate lato server', null);
      }

      // Ambiente non di produzione: va segnalato, perche i dati raccolti in
      // preview possono non arrivare nella property di produzione.
      var status = 'ok';
      if (env) status = 'partial';

      UAD.emit(ID, {
        name: 'container caricato: ' + id,
        categorizedFields: cats,
        source: 'network',
        status: status,
        timestamp: rec.ts,
        rawDebugString: rec.url,
        meta: {
          containerId: id,
          httpStatus: rec.status,
          serverSide: serverSide || undefined,
          environment: env || undefined
        }
      });

      // Container con dataLayer di nome custom: ci agganciamo subito.
      if (meta.dataLayerName && meta.dataLayerName !== 'dataLayer') {
        setTimeout(function () {
          UAD.safe(ID + '.customDataLayer', function () {
            var custom = window[meta.dataLayerName];
            if (custom && typeof custom.push === 'function') bindDataLayer(custom);
          })();
        }, 0);
      }
    } catch (e) { UAD.error(ID + '.parseContainerRequest', e); }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Connettore
     ════════════════════════════════════════════════════════════════════════ */

  var connector = {
    id: ID,
    label: 'GTM',
    colorTheme: '#4285f4',

    /** Detection per FORMA: un array con push, non la semplice esistenza. */
    detect: function (win) {
      try {
        if (Array.isArray(win.dataLayer) && typeof win.dataLayer.push === 'function') return true;

        if (win.google_tag_manager && typeof win.google_tag_manager === 'object') {
          var keys = Object.keys(win.google_tag_manager);
          for (var i = 0; i < keys.length; i++) {
            if (CONTAINER_RE.test(keys[i])) return true;
          }
        }
        return state.hits > 0;
      } catch (e) { return false; }
    },

    attach: function () {
      if (state.attached) return;
      state.attached = true;

      // Il dataLayer puo essere creato dopo di noi (document_start) o
      // riassegnato: il watcher copre entrambi i casi.
      UAD.watchGlobal('dataLayer', function (v) {
        UAD.safe(ID + '.onDataLayer', bindDataLayer)(v);
      }, { test: UAD.globalWatcher.SHAPE.dataLayer });

      try { if (window.dataLayer) bindDataLayer(window.dataLayer); }
      catch (e) { UAD.error(ID + '.attach dataLayer', e); }

      // gtag: solo per i comandi consent. Gli eventi arrivano via dataLayer.
      UAD.watchGlobal('gtag', function (v) {
        UAD.safe(ID + '.onGtag', function () {
          if (typeof v !== 'function' || v.__uadGtmWrapped) return;
          try { window.gtag = wrapGtagForConsent(v); }
          catch (e) { UAD.error(ID + '.assign gtag', e); }
        })();
      }, { test: UAD.globalWatcher.SHAPE.gtag });

      try {
        if (typeof window.gtag === 'function' && !window.gtag.__uadGtmWrapped) {
          window.gtag = wrapGtagForConsent(window.gtag);
        }
      } catch (e) { UAD.error(ID + '.attach gtag', e); }

      // Alcuni container usano un dataLayer con nome custom, dichiarato nel
      // parametro l= dello snippet. Se la request /gtm.js non e' ancora passata
      // proviamo i nomi piu comuni, poi ci agganciamo dalla request.
      setTimeout(function () {
        UAD.safe(ID + '.guessCustomDataLayer', function () {
          ['dataLayer', 'digitalData', 'tagData'].forEach(function (n) {
            var dl = window[n];
            if (dl && typeof dl.push === 'function' && Array.isArray(dl)) bindDataLayer(dl);
          });
          Object.keys(containerMeta).forEach(function (id) {
            var n = containerMeta[id].dataLayerName;
            if (n && n !== 'dataLayer' && window[n] && typeof window[n].push === 'function') {
              bindDataLayer(window[n]);
            }
          });
        })();
      }, 1500);

      UAD.log(ID + ' attach completato');
    },

    /** Match sul PATH: i container server-side stanno su domini del cliente. */
    matches: function (url, method, body, rec) {
      try {
        var u = rec && rec.urlObj;
        if (!u) return false;
        var p = u.pathname;
        // /gtm.js e /gtag/js sono gli endpoint del container; /gtm/js compare
        // in alcune configurazioni server-side.
        return /\/gtm\.js$/.test(p) || /\/gtag\/js$/.test(p) || /\/gtm\/js$/.test(p);
      } catch (e) { return false; }
    },

    parseNetwork: function (rec) {
      UAD.safe(ID + '.parseNetwork', parseContainerRequest)(rec);
    }
  };

  UAD.register(connector, true);
})();