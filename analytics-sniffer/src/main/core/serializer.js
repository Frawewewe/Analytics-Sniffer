/**
 * Universal Analytics Debugger — serializer difensivo
 * World: MAIN | Carica dopo namespace.js
 *
 * Trasforma QUALSIASI valore in una struttura JSON-safe, senza mai lanciare.
 * Serve perché il ponte MAIN -> ISOLATED trasporta solo stringhe, e i payload
 * reali (dataLayer, oggetto `s`, XDM) contengono routinariamente cicli, nodi
 * DOM, funzioni, Blob, getter e oggetti enormi.
 *
 * ORDINE DEI CONTROLLI — vincolo architetturale, non modificare:
 *   1. primitivi
 *   2. NODI DOM e oggetti host        <-- PRIMA di cicli e ricorsione
 *   3. tipi noti non-JSON             (Date, RegExp, Blob, Map, FormData, ...)
 *   4. cicli
 *   5. profondita e budget
 *   6. ricorsione
 *
 * Motivo del punto 2: su siti React un nodo DOM ha un fiber attaccato, e
 * JSON.stringify lancia "Converting circular structure -> property 'stateNode'
 * closes the circle" PRIMA che qualsiasi altra protezione entri in gioco.
 *
 * API pubblica:
 *   __UAD.serializer.sanitize(value)   -> struttura JSON-safe
 *   __UAD.serializer.serialize(value)  -> stringa JSON (sempre valida)
 *   __UAD.serializer.lastStats()       -> statistiche dell'ultima operazione
 *   __UAD.serializer.isDomNode(value)  -> boolean
 *   __UAD.serialize(value)             -> scorciatoia per serialize()
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] serializer: namespace.js non caricato'); } catch (e) {} return; }
  if (UAD.serializer && !window.__UAD_FORCE_REINIT) return;

  // ------------------------------------------------------------------ limiti
  // I primi tre arrivano dai settings (configurabili dal pannello); gli altri
  // hanno un fallback interno e diventeranno configurabili piu avanti.
  function limits() {
    var L = (UAD.settings && UAD.settings.limits) || {};
    return {
      maxDepth:      L.maxDepth      || 12,
      maxValueChars: L.maxValueChars || 8000,
      maxArrayItems: L.maxArrayItems || 500,
      maxKeys:       L.maxKeys       || 300,
      maxTotalChars: L.maxTotalChars || 512000   // ~500KB per singolo evento
    };
  }

  // ------------------------------------------------------------ riconoscitori
  // Tutti basati su duck typing: `instanceof` fallisce sugli oggetti
  // provenienti da un altro realm (iframe), che e' esattamente il caso dei
  // dataLayer con checkout embeddati.

  function isDomNode(v) {
    return typeof v.nodeType === 'number' && typeof v.nodeName === 'string';
  }
  function isWindowLike(v) {
    try { return v.window === v || v.self === v; }
    catch (e) { return true; }   // accesso negato = cross-origin window
  }
  function isEventLike(v) {
    return typeof v.stopPropagation === 'function' && 'type' in v;
  }
  function isErrorLike(v) {
    return typeof v.message === 'string' && typeof v.stack === 'string';
  }
  function isDateLike(v) {
    return typeof v.getTime === 'function' && typeof v.toISOString === 'function';
  }
  function isRegExpLike(v) {
    return typeof v.test === 'function' && typeof v.source === 'string';
  }
  function isBlobLike(v) {
    return typeof v.size === 'number' && typeof v.type === 'string' && typeof v.slice === 'function';
  }
  function isTypedArray(v) {
    return typeof v.BYTES_PER_ELEMENT === 'number';
  }
  function isThenable(v) {
    return typeof v.then === 'function' && typeof v.catch === 'function';
  }
  function isEntriesLike(v) {   // FormData / URLSearchParams
    return typeof v.forEach === 'function' && typeof v.getAll === 'function' && typeof v.append === 'function';
  }
  function isMapLike(v) {
    return typeof v.forEach === 'function' && typeof v.get === 'function' &&
           typeof v.set === 'function' && typeof v.size === 'number';
  }
  function isSetLike(v) {
    return typeof v.forEach === 'function' && typeof v.has === 'function' && typeof v.add === 'function';
  }

  // -------------------------------------------------------------- descrittori
  function describeNode(v) {
    try {
      if (v.nodeType === 9)  return '[Document]';
      if (v.nodeType === 11) return '[DocumentFragment]';
      if (v.nodeType === 8)  return '[Comment]';
      if (v.nodeType === 3)  return '[TextNode "' + String(v.nodeValue || '').slice(0, 30) + '"]';
      var t = String(v.nodeName || 'node').toLowerCase();
      if (v.id) t += '#' + v.id;
      var cls = (typeof v.className === 'string') ? v.className.trim().split(/\s+/)[0] : '';
      if (cls) t += '.' + cls;
      return '[HTMLElement ' + t + ']';
    } catch (e) { return '[HTMLElement]'; }
  }

  function describeFn(v) {
    var name = '', native = false;
    try { name = v.name || ''; } catch (e) {}
    try { native = /\[native code\]/.test(String(v)); } catch (e) {}
    return '[Function' + (name ? ' ' + name : '') + (native ? ' native' : '') + ']';
  }

  function bytes(n) {
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }

  // ------------------------------------------------------------------- stato
  var stats, budget, LIM;

  function resetStats() {
    stats = {
      cycles: 0,            // riferimenti circolari incontrati
      depthHits: 0,         // rami tagliati per profondita
      truncatedStrings: 0,  // stringhe accorciate
      droppedItems: 0,      // elementi/chiavi omessi
      domNodes: 0,          // nodi DOM sostituiti
      functions: 0,
      getterErrors: 0,      // getter che hanno lanciato
      budgetExceeded: false,
      chars: 0
    };
    budget = 0;
  }

  function spend(n) { budget += n; stats.chars = budget; }

  function clampString(s) {
    if (s.length <= LIM.maxValueChars) { spend(s.length); return s; }
    stats.truncatedStrings++;
    spend(LIM.maxValueChars);
    return s.slice(0, LIM.maxValueChars) + '\u2026 [troncato: ' + s.length + ' caratteri totali]';
  }

  /**
   * Lettura sicura di una property. I getter non vengono saltati (nel dataLayer
   * i valori reali sono spesso getter) ma sono isolati: se lanciano diventano
   * un marker leggibile invece di far fallire l'intero evento.
   */
  function readProp(obj, key) {
    try { return { ok: true, value: obj[key] }; }
    catch (e) {
      stats.getterErrors++;
      return { ok: false, value: '[getter: ' + ((e && e.message) || 'errore') + ']' };
    }
  }

  // -------------------------------------------------------------- ricorsione
  /**
   * @param {*}      v
   * @param {number} depth
   * @param {Array}  stack  catena di ANTENATI, non "gia visti": un oggetto
   *                        referenziato in due rami diversi non e' un ciclo e
   *                        deve restare leggibile.
   * @param {string} path   solo per i messaggi di errore
   */
  function walk(v, depth, stack, path) {

    /* --- 1. primitivi --------------------------------------------------- */
    if (v === null) return null;
    var t = typeof v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'boolean')   { spend(5); return v; }
    if (t === 'number') {
      spend(8);
      if (v !== v)          return '[NaN]';        // JSON lo trasformerebbe in null
      if (v === Infinity)   return '[Infinity]';
      if (v === -Infinity)  return '[-Infinity]';
      return v;
    }
    if (t === 'string')  return clampString(v);
    if (t === 'bigint')  { spend(12); return String(v) + 'n'; }   // stringify lancerebbe
    if (t === 'symbol')  { spend(12); return '[Symbol ' + String(v.description || '') + ']'; }
    if (t === 'function') { stats.functions++; spend(20); return describeFn(v); }
    if (t !== 'object')  { spend(10); return '[' + t + ']'; }

    /* --- 2. DOM e oggetti host — PRIMA di tutto il resto ---------------- */
    if (isDomNode(v))    { stats.domNodes++; spend(30); return describeNode(v); }
    if (isWindowLike(v)) { spend(10); return '[Window]'; }
    if (isEventLike(v))  {
      spend(20);
      try { return '[Event ' + v.type + ']'; } catch (e) { return '[Event]'; }
    }
    try { if (v.jquery) { spend(20); return '[jQuery ' + (v.length || 0) + ' elementi]'; } } catch (e) {}

    /* --- 3. tipi noti non-JSON ----------------------------------------- */
    if (isErrorLike(v)) {
      spend(60);
      try { return '[Error: ' + v.message + ']'; } catch (e) { return '[Error]'; }
    }
    if (isDateLike(v)) {
      spend(24);
      try { return v.toISOString(); } catch (e) { return '[Date invalida]'; }
    }
    if (isRegExpLike(v)) { spend(20); return '[RegExp ' + String(v) + ']'; }
    if (isBlobLike(v))   { spend(30); return '[Blob ' + bytes(v.size) + (v.type ? ' ' + v.type : '') + ']'; }
    if (typeof v.byteLength === 'number' && typeof v.length !== 'number') {
      spend(30); return '[ArrayBuffer ' + bytes(v.byteLength) + ']';
    }
    if (isTypedArray(v)) {
      spend(30);
      var tn = 'TypedArray';
      try { tn = v.constructor.name || tn; } catch (e) {}
      return '[' + tn + ' ' + v.length + ']';
    }
    if (isThenable(v)) { spend(12); return '[Promise]'; }

    // FormData / URLSearchParams: payload tipici di sendBeacon, li rendiamo
    // leggibili come oggetto invece di mostrare un placeholder inutile.
    if (isEntriesLike(v)) {
      var kind = (typeof v.sort === 'function') ? 'URLSearchParams' : 'FormData';
      var eo = { __type: kind };
      try {
        v.forEach(function (val, key) {
          eo[key] = (val && typeof val === 'object')
            ? walk(val, depth + 1, stack, path + '.' + key)
            : clampString(String(val));
        });
      } catch (e) { eo.__error = String((e && e.message) || e); }
      return eo;
    }
    if (isMapLike(v)) {
      var mo = { __type: 'Map', entries: {} };
      try { v.forEach(function (val, key) { mo.entries[String(key)] = walk(val, depth + 1, stack, path); }); }
      catch (e) { mo.__error = String((e && e.message) || e); }
      return mo;
    }
    if (isSetLike(v)) {
      var so = { __type: 'Set', values: [] };
      try { v.forEach(function (val) { so.values.push(walk(val, depth + 1, stack, path)); }); }
      catch (e) { so.__error = String((e && e.message) || e); }
      return so;
    }

    /* --- 4. cicli (solo antenati) -------------------------------------- */
    if (stack.indexOf(v) !== -1) { stats.cycles++; spend(24); return '[Circular]'; }

    /* --- 5. profondita e budget ---------------------------------------- */
    if (depth >= LIM.maxDepth) {
      stats.depthHits++;
      return Array.isArray(v) ? '[Array: limite di profondita]' : '[Object: limite di profondita]';
    }
    if (budget > LIM.maxTotalChars) {
      stats.budgetExceeded = true;
      return '[omesso: payload troppo grande]';
    }

    /* --- 6. ricorsione -------------------------------------------------- */
    stack.push(v);
    var out;
    try {
      if (Array.isArray(v)) {
        out = [];
        var n = Math.min(v.length, LIM.maxArrayItems);
        for (var i = 0; i < n; i++) {
          if (budget > LIM.maxTotalChars) {
            stats.budgetExceeded = true;
            out.push('[omesso: budget superato]');
            break;
          }
          var ri = readProp(v, i);
          out.push(ri.ok ? walk(ri.value, depth + 1, stack, path + '[' + i + ']') : ri.value);
        }
        if (v.length > LIM.maxArrayItems) {
          stats.droppedItems += (v.length - LIM.maxArrayItems);
          out.push('[\u2026 ' + (v.length - LIM.maxArrayItems) + ' altri elementi omessi]');
        }
      } else {
        out = {};
        var keys;
        try { keys = Object.keys(v); }
        catch (e) {
          stack.pop();
          return '[Object non enumerabile: ' + ((e && e.message) || '') + ']';
        }
        var kn = Math.min(keys.length, LIM.maxKeys);
        for (var j = 0; j < kn; j++) {
          if (budget > LIM.maxTotalChars) {
            stats.budgetExceeded = true;
            out.__troncato = 'budget superato';
            break;
          }
          var k = keys[j];
          spend(k.length + 4);
          var rk = readProp(v, k);
          out[k] = rk.ok ? walk(rk.value, depth + 1, stack, path + '.' + k) : rk.value;
        }
        if (keys.length > LIM.maxKeys) {
          stats.droppedItems += (keys.length - LIM.maxKeys);
          out.__troncato = (keys.length - LIM.maxKeys) + ' chiavi omesse';
        }
      }
    } catch (err) {
      UAD.error('serializer.walk @ ' + path, err);
      out = '[errore di serializzazione: ' + ((err && err.message) || 'ignoto') + ']';
    }
    stack.pop();
    return out;
  }

  // --------------------------------------------------------------------- API
  var S = {
    /** Struttura JSON-safe. Non lancia mai. */
    sanitize: function (value) {
      LIM = limits();
      resetStats();
      try { return walk(value, 0, [], 'root'); }
      catch (err) {
        UAD.error('serializer.sanitize', err);
        return '[errore fatale di serializzazione]';
      }
    },

    /** Stringa JSON pronta per il ponte. Ritorna SEMPRE una stringa valida. */
    serialize: function (value) {
      var clean = S.sanitize(value);
      try { return JSON.stringify(clean); }
      catch (err) {
        // Non dovrebbe accadere: sanitize rimuove tutto il non-serializzabile.
        UAD.error('serializer.serialize (stringify fallito su output pulito)', err);
        try { return JSON.stringify({ __serializerError: String((err && err.message) || err) }); }
        catch (e2) { return '{"__serializerError":"irrecuperabile"}'; }
      }
    },

    /**
     * Statistiche dell'ultima operazione. Alimenta i badge "troncato" /
     * "ciclo" nel pannello: l'utente deve sapere quando sta guardando dati
     * potati, invece di crederli completi.
     */
    lastStats: function () {
      if (!stats) return null;
      try { return JSON.parse(JSON.stringify(stats)); } catch (e) { return null; }
    },

    /** Esportati per i connettori. */
    isDomNode: function (v) { return !!v && typeof v === 'object' && isDomNode(v); },
    describeNode: describeNode
  };

  UAD.serializer = S;
  UAD.serialize  = S.serialize;   // usata da emitter e connettori

  UAD.log('serializer pronto');
})();