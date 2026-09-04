/**
 * Universal Analytics Debugger — correlazione hook <-> network
 * World: MAIN | Carica dopo namespace.js, session.js, emitter.js
 *
 * IL PROBLEMA
 * Lo stesso hit viene osservato da piu canali indipendenti:
 *   - gtag('event','purchase',{...})  -> hook su gtag
 *   - dataLayer.push({event:...})     -> hook su dataLayer (gtag pusha sempre)
 *   - POST /g/collect?en=purchase     -> canale di rete
 * Senza correlazione il pannello mostrerebbe TRE eventi per un solo hit.
 *
 * LA STRATEGIA
 * La rete e' la fonte di verita: e' cio che il vendor riceve davvero.
 * Gli hook sono ARRICCHIMENTO: portano i nomi delle variabili sorgente
 * (campo `src`), i tipi JS originali e l'intento dello sviluppatore.
 *
 * Ogni candidato entra in una finestra di attesa. Alla scadenza:
 *   hook + network  -> UN evento, source 'hook+network', arricchito
 *   solo network    -> UN evento, source 'network'
 *   solo hook       -> UN evento, source 'hook', status 'partial',
 *                      meta.warning = "nessuna hit di rete osservata"
 *
 * Quest'ultimo caso NON e' un difetto da nascondere: e' la diagnosi piu utile
 * del tool. Significa che il codice ha chiesto di tracciare ma nulla e'
 * partito - consenso negato, tag in pausa, trigger mancante, errore JS.
 *
 * API per i connettori:
 *   __UAD.dedupe.offer(toolId, candidate)
 *   __UAD.dedupe.flushNow(toolId)
 *   __UAD.dedupe.stats()
 *
 * candidate = {
 *   channel: 'hook'|'network'|'datalayer'|'polling',
 *   key:     string,          // chiave di correlazione (dedupeKey del connettore)
 *   raw:     object,          // payload per __UAD.emit()
 *   timestamp: number,
 *   weight:  number           // opzionale, priorita in caso di conflitto
 * }
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] dedupe: namespace.js non caricato'); } catch (e) {} return; }
  if (UAD.dedupe && !window.__UAD_FORCE_REINIT) return;

  // Finestra di attesa. Compromesso misurato: gtag costruisce e invia la
  // request nello stesso tick o subito dopo, ma GTM con consenso in attesa o
  // tag "batchati" puo ritardare di qualche centinaio di ms.
  var WINDOW_MS = 1200;

  // Un hit di rete puo essere ricevuto PRIMA dell'hook corrispondente
  // (sendBeacon su unload, batch). Teniamo un breve ricordo per correlare a
  // ritroso invece di emettere due eventi.
  var BACKLOG_MS = 400;

  // Priorita di default per canale: piu alto = piu affidabile come base.
  var CHANNEL_WEIGHT = { network: 100, hook: 60, datalayer: 40, polling: 20 };

  var PENDING_CAP = 300;

  var pending = {};   // key -> bucket
  var backlog = [];   // hit di rete recenti non ancora correlate
  var counters = {
    offered: 0, merged: 0, emittedNetwork: 0, emittedHookOnly: 0,
    emittedOther: 0, dropped: 0, expiredCap: 0
  };

  function now() { return Date.now(); }

  function weightOf(c) {
    if (typeof c.weight === 'number') return c.weight;
    return CHANNEL_WEIGHT[c.channel] || 10;
  }

  function bucketId(toolId, key) { return toolId + '\u0000' + key; }

  // --------------------------------------------------------------- merge

  /**
   * Fonde due payload raw. Il vincitore fornisce la struttura di base; il
   * perdente aggiunge cio che manca, senza mai sovrascrivere.
   *
   * Regola sui campi: la rete e' autorevole sui VALORI (e' cio che il vendor
   * ha ricevuto), l'hook e' autorevole sui NOMI SORGENTE (il campo `src`, che
   * la rete non puo conoscere perche i parametri arrivano gia mappati).
   */
  function mergeRaw(base, extra) {
    if (!extra) return base;
    if (!base) return extra;

    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];

    // scalari: riempiamo solo i buchi
    ['name', 'eventName', 'eventType', 'hitType', 'rawDebugString', 'timestamp'].forEach(function (f) {
      if ((out[f] === undefined || out[f] === null || out[f] === '') && extra[f] !== undefined) {
        out[f] = extra[f];
      }
    });

    // categorie: unione per categoria, poi per chiave
    var bf = base.categorizedFields || {};
    var ef = extra.categorizedFields || {};
    var cats = {}, cat;
    for (cat in bf) if (Object.prototype.hasOwnProperty.call(bf, cat)) cats[cat] = 1;
    for (cat in ef) if (Object.prototype.hasOwnProperty.call(ef, cat)) cats[cat] = 1;

    var merged = {};
    Object.keys(cats).forEach(function (c) {
      var rowsB = toRows(bf[c]);
      var rowsE = toRows(ef[c]);
      var byKey = {}, order = [];

      rowsB.forEach(function (r) {
        if (!(r.key in byKey)) order.push(r.key);
        byKey[r.key] = { key: r.key, value: r.value, src: r.src || null };
      });

      rowsE.forEach(function (r) {
        if (!(r.key in byKey)) {
          order.push(r.key);
          byKey[r.key] = { key: r.key, value: r.value, src: r.src || null };
          return;
        }
        var cur = byKey[r.key];
        // src: l'hook lo conosce, la rete no -> lo prendiamo sempre.
        if (!cur.src && r.src) cur.src = r.src;
        // valore: solo se mancante nel vincitore.
        if ((cur.value === undefined || cur.value === null || cur.value === '') &&
            r.value !== undefined && r.value !== null && r.value !== '') {
          cur.value = r.value;
        }
      });

      merged[c] = order.map(function (kk) { return byKey[kk]; });
    });
    out.categorizedFields = merged;

    // prodotti: prendiamo la lista piu ricca invece di concatenare, che
    // creerebbe duplicati sullo stesso ordine.
    var bp = base.products, ep = extra.products;
    if (Array.isArray(ep) && (!Array.isArray(bp) || ep.length > bp.length)) out.products = ep;

    // meta
    out.meta = {};
    if (base.meta) for (k in base.meta) if (Object.prototype.hasOwnProperty.call(base.meta, k)) out.meta[k] = base.meta[k];
    if (extra.meta) for (k in extra.meta) if (!(k in out.meta)) out.meta[k] = extra.meta[k];

    return out;
  }

  function toRows(v) {
    if (!v) return [];
    if (Array.isArray(v)) {
      return v.filter(Boolean).map(function (r, i) {
        if (typeof r === 'object' && 'key' in r) {
          return { key: String(r.key), value: r.value, src: r.src || null };
        }
        return { key: String(i), value: r, src: null };
      });
    }
    if (typeof v === 'object') {
      return Object.keys(v).map(function (k) { return { key: k, value: v[k], src: null }; });
    }
    return [];
  }

  // ---------------------------------------------------------------- emit

  function emitBucket(b) {
    try {
      var sorted = b.candidates.slice().sort(function (x, y) { return weightOf(y) - weightOf(x); });
      var winner = sorted[0];
      var raw = winner.raw || {};

      for (var i = 1; i < sorted.length; i++) raw = mergeRaw(raw, sorted[i].raw);

      var channels = {};
      b.candidates.forEach(function (c) { channels[c.channel] = 1; });
      var list = Object.keys(channels).sort();

      raw.source = list.join('+');
      // Il timestamp piu attendibile e' il PRIMO osservato: e' il momento in
      // cui il codice ha chiesto di tracciare.
      raw.timestamp = b.firstTs;

      var hasNet = !!channels.network;
      var hasHook = !!(channels.hook || channels.datalayer || channels.polling);

      if (hasNet && hasHook) {
        counters.merged++;
      } else if (hasNet) {
        counters.emittedNetwork++;
      } else if (hasHook) {
        // Caso diagnostico: dichiararlo, non nasconderlo.
        counters.emittedHookOnly++;
        raw.status = raw.status || 'partial';
        raw.meta = raw.meta || {};
        raw.meta.warning = 'nessuna hit di rete osservata entro ' + WINDOW_MS +
                           'ms: il tag potrebbe non aver sparato (consenso, trigger, errore JS)';
      } else {
        counters.emittedOther++;
      }

      raw.meta = raw.meta || {};
      raw.meta.channels = list;
      raw.meta.correlationKey = b.key;
      if (b.candidates.length > 1) {
        raw.meta.observedIn = b.candidates.map(function (c) {
          return c.channel + '@+' + (c.timestamp - b.firstTs) + 'ms';
        });
      }

      UAD.emit(b.toolId, raw);
    } catch (err) {
      UAD.error('dedupe.emitBucket', err);
    }
  }

  function closeBucket(id) {
    var b = pending[id];
    if (!b) return;
    delete pending[id];
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
    emitBucket(b);
  }

  function pendingCount() {
    var n = 0;
    for (var k in pending) if (Object.prototype.hasOwnProperty.call(pending, k)) n++;
    return n;
  }

  // ------------------------------------------------------------- backlog

  function pruneBacklog() {
    var t = now() - BACKLOG_MS;
    while (backlog.length && backlog[0].timestamp < t) backlog.shift();
  }

  function takeFromBacklog(toolId, key) {
    pruneBacklog();
    for (var i = 0; i < backlog.length; i++) {
      if (backlog[i].toolId === toolId && backlog[i].key === key) {
        return backlog.splice(i, 1)[0];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- API

  /**
   * @param {string} toolId
   * @param {object} candidate  { channel, key, raw, timestamp, weight }
   */
  function offer(toolId, candidate) {
    try {
      if (!toolId || !candidate) { counters.dropped++; return; }
      if (!UAD.isEnabled || !UAD.isEnabled(toolId)) {
        // Prima dei settings isEnabled() e' false: l'emitter ha la sua coda,
        // quindi qui ci limitiamo a passare oltre senza correlare.
        if (UAD.settingsReady) { counters.dropped++; return; }
      }

      counters.offered++;
      var ch = candidate.channel || 'unknown';
      var ts = (typeof candidate.timestamp === 'number') ? candidate.timestamp : now();

      // Senza chiave non c'e' correlazione possibile: emettiamo subito.
      // Meglio un evento non correlato che un evento perso.
      if (!candidate.key) {
        var solo = candidate.raw || {};
        solo.source = ch;
        solo.timestamp = ts;
        UAD.emit(toolId, solo);
        counters.emittedOther++;
        return;
      }

      var id = bucketId(toolId, candidate.key);
      var b = pending[id];

      if (!b) {
        // La rete puo essere arrivata prima dell'hook: recuperiamo a ritroso.
        var earlier = (ch !== 'network') ? takeFromBacklog(toolId, candidate.key) : null;

        if (pendingCount() >= PENDING_CAP) {
          // Cap raggiunto: chiudiamo il bucket piu vecchio invece di scartare
          // il nuovo, cosi nessun evento sparisce del tutto.
          var oldestId = null, oldestTs = Infinity;
          for (var k in pending) {
            if (Object.prototype.hasOwnProperty.call(pending, k) && pending[k].firstTs < oldestTs) {
              oldestTs = pending[k].firstTs; oldestId = k;
            }
          }
          if (oldestId) { counters.expiredCap++; closeBucket(oldestId); }
        }

        b = pending[id] = {
          toolId: toolId, key: candidate.key,
          firstTs: earlier ? Math.min(earlier.timestamp, ts) : ts,
          candidates: [], timer: null
        };
        if (earlier) b.candidates.push(earlier);

        b.timer = setTimeout(function () { closeBucket(id); }, WINDOW_MS);
      }

      b.candidates.push({ channel: ch, raw: candidate.raw, timestamp: ts, weight: candidate.weight });
      if (ts < b.firstTs) b.firstTs = ts;

      // La rete e' la verita: quando arriva, chiudiamo subito. Non ha senso
      // aspettare hook che potrebbero non arrivare mai, e la latenza percepita
      // nel pannello resta bassa.
      if (ch === 'network') {
        closeBucket(id);
      } else {
        // Memoria breve dell'hook, per il caso simmetrico gestito sopra.
        backlog.push({ toolId: toolId, key: candidate.key, channel: ch, raw: candidate.raw, timestamp: ts });
        if (backlog.length > 100) backlog.shift();
      }
    } catch (err) {
      UAD.error('dedupe.offer', err);
    }
  }

  /** Chiude subito i bucket in attesa. Usata su pagehide/unload: senza questo
   *  gli hit degli ultimi istanti di vita della pagina andrebbero persi. */
  function flushNow(toolId) {
    var ids = [];
    for (var k in pending) {
      if (!Object.prototype.hasOwnProperty.call(pending, k)) continue;
      if (!toolId || pending[k].toolId === toolId) ids.push(k);
    }
    for (var i = 0; i < ids.length; i++) closeBucket(ids[i]);
  }

  // pagehide copre anche il passaggio a bfcache, dove unload non scatta.
  window.addEventListener('pagehide', function () {
    UAD.safe('dedupe.pagehide', function () { flushNow(); })();
  }, false);

  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      UAD.safe('dedupe.visibilitychange', function () { flushNow(); })();
    }
  }, false);

  UAD.dedupe = {
    offer: offer,
    flushNow: flushNow,
    stats: function () {
      return {
        offered: counters.offered, merged: counters.merged,
        emittedNetwork: counters.emittedNetwork,
        emittedHookOnly: counters.emittedHookOnly,
        emittedOther: counters.emittedOther,
        dropped: counters.dropped, expiredCap: counters.expiredCap,
        pending: pendingCount(), backlog: backlog.length
      };
    },
    WINDOW_MS: WINDOW_MS,
    mergeRaw: mergeRaw
  };

  UAD.log('dedupe pronto (finestra ' + WINDOW_MS + 'ms)');
})();