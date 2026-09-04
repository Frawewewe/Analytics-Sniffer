/**
 * Universal Analytics Debugger — costruzione ed emissione dell'evento
 * World: MAIN | Carica dopo namespace.js, serializer.js, session.js
 *
 * Punto di uscita UNICO dal world MAIN. Ogni connettore chiama __UAD.emit() e
 * non sa nulla del trasporto. Qui accadono, in ordine:
 *
 *   1. gate            tool disattivato -> l'evento non esiste
 *   2. normalizzazione nome mai vuoto, delta ms, indici, categorie
 *   3. serializzazione stringa JSON difensiva (serializer.js)
 *   4. dispatch        CustomEvent su window, unico ponte MAIN <-> ISOLATED
 *
 * Modello dati emesso:
 *   {
 *     v, toolId, eventName, timestamp, seq,
 *     pageSessionId, viewId, viewIndex, isSpaView,
 *     pageUrl, viewUrl,
 *     deltaMs, msSincePageLoad,
 *     status, source,
 *     categorizedFields: { [categoria]: [{key, value, src}] },
 *     products, rawDebugString, meta
 *   }
 *
 * API:
 *   __UAD.emit(toolId, raw)   -> evento emesso, oppure null se scartato
 *   __UAD.emitter.stats()
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] emitter: namespace.js non caricato'); } catch (e) {} return; }
  if (UAD.emitter && !window.__UAD_FORCE_REINIT) return;

  var SCHEMA = 1;

  // Protezione della pagina: alcuni siti sparano centinaia di push in pochi
  // millisecondi. Oltre la soglia scartiamo, ma lo DICHIARIAMO invece di far
  // sparire eventi in silenzio.
  var BURST_WINDOW_MS = 1000;
  var BURST_MAX = 120;

  // Eventi prodotti prima che i settings arrivino dal bridge: il gate li
  // scarterebbe, e il primo hit di pagina (il pageview) cade proprio in quella
  // finestra. Secondo strato di protezione dopo il buffer di namespace.js.
  var PRE_CAP = 200;

  var counters = { emitted: 0, dropped: 0, gated: 0, throttled: 0, errors: 0 };
  var burst = { start: 0, n: 0, notified: false };
  var preSettings = [];

  // Delta ms calcolato per view: primo evento della view -> dall'inizio della
  // view; successivi -> dall'evento precedente.
  var lastTsByView = {};

  /**
   * Catena di fallback del nome evento: mai "n/d".
   * nome esplicito -> eventType/hitType -> ultimo segmento di path -> hit #N
   */
  function resolveName(raw, seq) {
    var cand = [raw && raw.name, raw && raw.eventName, raw && raw.eventType, raw && raw.hitType];
    for (var i = 0; i < cand.length; i++) {
      var c = cand[i];
      if (typeof c === 'string' && c.trim()) return c.trim();
      if (typeof c === 'number' && isFinite(c)) return String(c);
    }
    try {
      var p = location.pathname;
      if (p === '/') return 'home';
      if (p) {
        var last = p.replace(/\/+$/, '').split('/').pop();
        if (last) return decodeURIComponent(last);
      }
    } catch (e) {}
    return 'hit #' + seq;
  }

  /**
   * Normalizza le categorie nella forma attesa dal pannello.
   * Accetta sia { cat: [{key,value,src}] } sia { cat: {k: v} }, per comodita
   * dei connettori: e' il core che si adatta a loro, non il contrario.
   */
  function normalizeFields(cf) {
    var out = {};
    if (!cf || typeof cf !== 'object') return out;

    Object.keys(cf).forEach(function (cat) {
      var v = cf[cat], rows = [];

      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) {
          var r = v[i];
          if (r === null || r === undefined) continue;
          if (typeof r === 'object' && 'key' in r) {
            rows.push({
              key:   String(r.key),
              value: (r.value === undefined ? '[undefined]' : r.value),
              src:   (r.src === undefined || r.src === null) ? null : String(r.src)
            });
          } else {
            rows.push({ key: String(i), value: r, src: null });
          }
        }
      } else if (v && typeof v === 'object') {
        Object.keys(v).forEach(function (k) {
          rows.push({ key: k, value: v[k], src: null });
        });
      } else if (v !== undefined) {
        rows.push({ key: cat, value: v, src: null });
      }

      if (rows.length) out[cat] = rows;
    });
    return out;
  }

  /** Rate limit a finestra scorrevole. */
  function throttled() {
    var now = Date.now();
    if (now - burst.start > BURST_WINDOW_MS) {
      burst.start = now; burst.n = 0; burst.notified = false;
    }
    burst.n++;
    if (burst.n <= BURST_MAX) return false;

    counters.throttled++;
    if (!burst.notified) {
      burst.notified = true;
      UAD.error('emitter', 'burst oltre ' + BURST_MAX + ' eventi/s: eventi in eccesso scartati (vedi emitter.stats)');
    }
    return true;
  }

  function dispatch(json) {
    try {
      window.dispatchEvent(new CustomEvent(UAD.CH.HIT, { detail: json }));
      return true;
    } catch (err) {
      counters.errors++;
      UAD.error('emitter.dispatch', err);
      return false;
    }
  }

  function build(toolId, raw) {
    var s = UAD.session ? UAD.session.info() : {
      pageSessionId: 'ps_unknown', viewId: 'ps_unknown.v1', viewIndex: 1,
      pageUrl: location.href, viewUrl: location.href,
      pageLoadTs: Date.now(), viewStartTs: Date.now(),
      msSincePageLoad: 0, isSpaView: false
    };

    var ts = (raw && typeof raw.timestamp === 'number') ? raw.timestamp : Date.now();
    var seq = ++counters.emitted;

    var prev = lastTsByView[s.viewId];
    var delta = (prev === undefined) ? (ts - s.viewStartTs) : (ts - prev);
    lastTsByView[s.viewId] = ts;

    return {
      v:               SCHEMA,
      toolId:          String(toolId),
      eventName:       resolveName(raw, seq),
      timestamp:       ts,
      seq:             seq,

      pageSessionId:   s.pageSessionId,
      viewId:          s.viewId,
      viewIndex:       s.viewIndex,
      isSpaView:       s.isSpaView,

      pageUrl:         s.pageUrl,
      viewUrl:         s.viewUrl,

      deltaMs:         delta < 0 ? 0 : delta,
      msSincePageLoad: ts - s.pageLoadTs,

      // 'ok' | 'partial' | 'error' -> badge status nel pannello
      status:          (raw && raw.status) || 'ok',

      // 'hook' | 'network' | 'datalayer' | 'polling' | 'unknown'
      // Campo di prima classe: sapere che un evento arriva da 'hook' ma NON ha
      // una hit di rete corrispondente e' precisamente la diagnosi utile
      // quando un tag non spara. E' informazione, non un difetto.
      source:          (raw && raw.source) || 'unknown',

      categorizedFields: normalizeFields(raw && raw.categorizedFields),
      products:        (raw && raw.products) || undefined,
      rawDebugString:  (raw && raw.rawDebugString) || undefined,
      meta:            (raw && raw.meta) || undefined
    };
  }

  /**
   * @param {string} toolId  id di un connettore registrato
   * @param {object} raw     { name, categorizedFields, products, source,
   *                           status, rawDebugString, timestamp, meta }
   * @returns {object|null}  evento emesso, o null se scartato
   */
  function emit(toolId, raw) {
    try {
      if (!toolId) {
        counters.dropped++;
        UAD.error('emitter.emit', 'toolId mancante');
        return null;
      }

      // Prima dei settings non sappiamo se il tool e' attivo: mettiamo da parte
      // invece di scartare, cosi il pageview non si perde.
      if (!UAD.settingsReady) {
        if (preSettings.length < PRE_CAP) {
          preSettings.push({ toolId: toolId, raw: raw, t: Date.now() });
        } else {
          counters.dropped++;
        }
        return null;
      }

      if (!UAD.isEnabled(toolId)) { counters.gated++; return null; }
      if (throttled()) return null;

      var ev = build(toolId, raw);
      var json = UAD.serialize(ev);

      // Se il serializer ha potato qualcosa, l'evento lo DICHIARA: l'utente non
      // deve credere completo un payload che non lo e'.
      var st = (UAD.serializer && UAD.serializer.lastStats) ? UAD.serializer.lastStats() : null;
      if (st && (st.truncatedStrings || st.cycles || st.droppedItems || st.depthHits || st.budgetExceeded)) {
        ev.meta = ev.meta || {};
        ev.meta.serializer = st;
        if (ev.status === 'ok') ev.status = 'partial';
        json = UAD.serialize(ev);
      }

      if (!dispatch(json)) return null;

      UAD.log('emit', ev.toolId, ev.eventName, '(' + ev.source + ', +' + ev.deltaMs + 'ms)');
      return ev;
    } catch (err) {
      counters.errors++;
      UAD.error('emitter.emit', err);
      return null;
    }
  }

  /** Riemette la coda pre-settings, ora che sappiamo quali tool sono attivi. */
  function flushPreSettings() {
    if (!preSettings.length) return;
    var q = preSettings;
    preSettings = [];
    UAD.log('emitter: flush di ' + q.length + ' eventi pre-settings');
    for (var i = 0; i < q.length; i++) {
      var it = q[i];
      it.raw = it.raw || {};
      // Conserviamo il timestamp ORIGINALE: i delta ms devono riflettere
      // quando l'evento e' avvenuto, non quando lo abbiamo processato.
      if (typeof it.raw.timestamp !== 'number') it.raw.timestamp = it.t;
      emit(it.toolId, it.raw);
    }
  }

  // Il listener di namespace.js e' registrato prima del nostro e imposta
  // settingsReady: quando arriviamo qui il gate e' gia valido.
  window.addEventListener(UAD.CH.SETTINGS, function () {
    UAD.safe('emitter.flushPreSettings', flushPreSettings)();
  }, false);

  UAD.emitter = {
    emit: emit,
    stats: function () {
      return {
        emitted:            counters.emitted,
        dropped:            counters.dropped,
        gated:              counters.gated,
        throttled:          counters.throttled,
        errors:             counters.errors,
        pendingPreSettings: preSettings.length
      };
    },
    resolveName:     resolveName,
    normalizeFields: normalizeFields,
    SCHEMA:          SCHEMA
  };

  UAD.emit = emit;
  UAD.log('emitter pronto');
})();