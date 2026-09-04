/**
 * Universal Analytics Debugger — intercettazione di rete centralizzata
 * World: MAIN | Carica dopo namespace.js, serializer.js, session.js, emitter.js
 *
 * REGOLA ARCHITETTURALE: fetch, XMLHttpRequest, sendBeacon, img.src e
 * setAttribute vengono patchati UNA SOLA VOLTA, qui. Un hook per connettore
 * produrrebbe doppi wrapping, ordini di esecuzione imprevedibili e hit
 * duplicate quando piu tool sono attivi.
 *
 * Ogni request osservata viene normalizzata e offerta a TUTTI i connettori
 * attivi: ciascuno decide con il proprio matches(url, method, body) se la
 * riguarda. Il core non sa nulla di GA4 o Adobe.
 *
 * I 5 canali sono quelli validati dal pre-flight su questo ambiente:
 *   fetch · XHR · sendBeacon · HTMLImageElement.src · Element.setAttribute
 *
 * VINCOLI DI SICUREZZA SULLA PAGINA:
 *   - il valore di ritorno originale viene SEMPRE restituito intatto
 *   - il body di una Request si legge solo su .clone(): leggere l'originale
 *     consumerebbe lo stream e ROMPEREBBE la request del sito
 *   - ogni hook e' in try/catch con console.error: mai errori silenziosi
 *
 * Request normalizzata passata ai connettori:
 *   {
 *     id, ts, via, url, urlObj, method,
 *     body, bodyType, bodyTruncated,
 *     status, ok, durationMs, initiator
 *   }
 *
 * API:
 *   __UAD.netHooks.onRequest(fn)   -> subscriber aggiuntivo (dedupe, debug)
 *   __UAD.netHooks.stats()
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] net-hooks: namespace.js non caricato'); } catch (e) {} return; }

  // Flag globale anti doppio-patch: sopravvive anche a un re-run del modulo.
  if (window.__UAD_NET_PATCHED__ && !window.__UAD_FORCE_REINIT) return;

  var MAX_BODY_CHARS = 200000;   // oltre questo il body viene troncato
  var MAX_BLOB_BYTES = 262144;   // 256KB: oltre non tentiamo la lettura async
  var PIXEL_DEDUPE_MS = 60;      // vedi nota "doppio canale pixel"

  var counters = { seen: 0, dispatched: 0, matched: 0, buffered: 0, errors: 0, skipped: 0 };
  var subscribers = [];
  var seq = 0;

  // Schemi che non sono mai hit di analytics: evitiamo rumore e lavoro inutile.
  var SKIP_SCHEME = /^(data|blob|javascript|about|chrome-extension|moz-extension):/i;

  // Un pixel impostato via setAttribute('src') fa scattare ANCHE il setter
  // .src su alcune implementazioni. Guardia a finestra breve per non contare
  // due volte lo stesso pixel.
  var recentPixels = [];

  function pixelAlreadySeen(url) {
    var now = Date.now();
    for (var i = recentPixels.length - 1; i >= 0; i--) {
      if (now - recentPixels[i].t > PIXEL_DEDUPE_MS) { recentPixels.splice(0, i + 1); break; }
      if (recentPixels[i].u === url) return true;
    }
    recentPixels.push({ u: url, t: now });
    if (recentPixels.length > 40) recentPixels.shift();
    return false;
  }

  // ------------------------------------------------------------------- utils

  /** Risolve gli url relativi: i connettori matchano sul PATH, quindi un url
   *  relativo non risolto li farebbe fallire silenziosamente. */
  function absolutize(u) {
    try { return new URL(String(u), location.href).href; }
    catch (e) { return String(u || ''); }
  }

  function parseUrl(href) {
    try { return new URL(href); } catch (e) { return null; }
  }

  function clampBody(s) {
    if (typeof s !== 'string') return { body: s, truncated: false };
    if (s.length <= MAX_BODY_CHARS) return { body: s, truncated: false };
    return { body: s.slice(0, MAX_BODY_CHARS), truncated: true };
  }

  function decodeBuffer(buf) {
    try {
      var view = (buf instanceof ArrayBuffer) ? new Uint8Array(buf)
               : (buf && typeof buf.byteLength === 'number') ? new Uint8Array(buf.buffer || buf)
               : null;
      if (!view) return null;
      var txt = new TextDecoder('utf-8', { fatal: false }).decode(view);
      // Se il contenuto e' binario la decodifica produce molti caratteri di
      // rimpiazzo: in quel caso e' piu onesto dichiararlo binario.
      var bad = (txt.match(/\uFFFD/g) || []).length;
      if (bad > txt.length * 0.05) return null;
      return txt;
    } catch (e) { return null; }
  }

  /**
   * Normalizza un body di qualunque tipo.
   * @returns {{body:*, bodyType:string, truncated:boolean, promise?:Promise}}
   */
  function normalizeBody(raw) {
    if (raw === null || raw === undefined) return { body: null, bodyType: 'none', truncated: false };

    if (typeof raw === 'string') {
      var c = clampBody(raw);
      return { body: c.body, bodyType: 'string', truncated: c.truncated };
    }

    // URLSearchParams: hit GA4 e molti pixel via sendBeacon
    if (typeof raw.toString === 'function' && typeof raw.getAll === 'function' && typeof raw.sort === 'function') {
      var s = clampBody(raw.toString());
      return { body: s.body, bodyType: 'urlencoded', truncated: s.truncated };
    }

    // FormData
    if (typeof raw.forEach === 'function' && typeof raw.getAll === 'function' && typeof raw.append === 'function') {
      var o = {};
      try { raw.forEach(function (v, k) { o[k] = (v && v.name) ? '[File ' + v.name + ']' : String(v); }); }
      catch (e) { UAD.error('net-hooks.normalizeBody FormData', e); }
      return { body: o, bodyType: 'formdata', truncated: false };
    }

    // Blob: lettura ASINCRONA. Il payload JSON di Adobe AEP via sendBeacon
    // arriva quasi sempre come Blob.
    if (typeof raw.size === 'number' && typeof raw.type === 'string' && typeof raw.slice === 'function') {
      if (raw.size > MAX_BLOB_BYTES) {
        return { body: '[Blob ' + raw.size + ' byte non letto: oltre il limite]', bodyType: 'blob', truncated: true };
      }
      var p = null;
      try {
        p = (typeof raw.text === 'function')
          ? raw.text()
          : new Promise(function (res, rej) {
              var fr = new FileReader();
              fr.onload = function () { res(String(fr.result || '')); };
              fr.onerror = function () { rej(fr.error); };
              fr.readAsText(raw);
            });
      } catch (e) { UAD.error('net-hooks.normalizeBody Blob', e); }
      return { body: '[Blob in lettura]', bodyType: 'blob', truncated: false, promise: p };
    }

    // ArrayBuffer / TypedArray
    if (raw instanceof ArrayBuffer || (typeof raw.byteLength === 'number' && typeof raw.BYTES_PER_ELEMENT === 'number')) {
      var txt = decodeBuffer(raw);
      if (txt !== null) {
        var cb = clampBody(txt);
        return { body: cb.body, bodyType: 'buffer', truncated: cb.truncated };
      }
      return { body: '[binario ' + (raw.byteLength || 0) + ' byte]', bodyType: 'binary', truncated: false };
    }

    // Request/Response passati come body: caso raro, gestito difensivamente.
    if (typeof raw.clone === 'function' && typeof raw.text === 'function') {
      var pr = null;
      try { pr = raw.clone().text(); } catch (e) { UAD.error('net-hooks.normalizeBody clone', e); }
      return { body: '[body in lettura]', bodyType: 'stream', truncated: false, promise: pr };
    }

    // Oggetto generico: lasciamo al serializer la messa in sicurezza.
    return { body: raw, bodyType: 'object', truncated: false };
  }

  // -------------------------------------------------------------- dispatch

  function makeRecord(via, url, method, bodyInfo, extra) {
    var href = absolutize(url);
    var rec = {
      id:            'net_' + (++seq),
      ts:            Date.now(),
      via:           via,
      url:           href,
      urlObj:        parseUrl(href),
      method:        String(method || 'GET').toUpperCase(),
      body:          bodyInfo ? bodyInfo.body : null,
      bodyType:      bodyInfo ? bodyInfo.bodyType : 'none',
      bodyTruncated: bodyInfo ? !!bodyInfo.truncated : false,
      status:        null,
      ok:            null,
      durationMs:    null,
      initiator:     (extra && extra.initiator) || null
    };
    return rec;
  }

  /**
   * Offre la request a tutti i connettori attivi.
   * Prima dei settings NON possiamo sapere quali tool sono attivi: la request
   * va nel buffer di namespace.js e verra rigiocata da _onRequestReplay.
   */
  function dispatchRequest(rec) {
    counters.seen++;

    if (!rec.urlObj || SKIP_SCHEME.test(rec.urlObj.protocol)) { counters.skipped++; return; }

    if (!UAD.settingsReady) {
      counters.buffered++;
      UAD.bufferRequest(rec);
      return;
    }

    counters.dispatched++;

    // Subscriber interni (dedupe, strumenti di debug): ricevono tutto.
    for (var s = 0; s < subscribers.length; s++) {
      UAD.safe('net-hooks.subscriber', subscribers[s])(rec);
    }

    var conns = UAD.activeConnectors();
    for (var i = 0; i < conns.length; i++) {
      var c = conns[i];
      if (typeof c.matches !== 'function') continue;

      var hit = UAD.safe('matches:' + c.id, function () {
        return c.matches(rec.url, rec.method, rec.body, rec);
      })();
      if (!hit) continue;

      counters.matched++;
      if (typeof c.parseNetwork === 'function') {
        UAD.safe('parseNetwork:' + c.id, function () { c.parseNetwork(rec); })();
      }
    }
  }

  /** Se il body arriva da una lettura asincrona, dispatchiamo a lettura finita. */
  function dispatchWhenBodyReady(rec, promise) {
    if (!promise || typeof promise.then !== 'function') { dispatchRequest(rec); return; }
    promise.then(function (txt) {
      var c = clampBody(String(txt || ''));
      rec.body = c.body;
      rec.bodyTruncated = c.truncated;
      dispatchRequest(rec);
    }, function (err) {
      UAD.error('net-hooks: lettura body asincrona', err);
      rec.body = '[body non leggibile]';
      dispatchRequest(rec);
    });
  }

  // Rigiocata dal core quando i settings arrivano: e' il meccanismo che evita
  // di perdere il pageview, che avviene sistematicamente prima dei settings.
  UAD._onRequestReplay = function (rec) {
    if (!rec) return;
    counters.buffered--;
    dispatchRequest(rec);
  };

  // ============================================================== 1. fetch
  (function patchFetch() {
    var orig = window.fetch;
    if (typeof orig !== 'function') return;

    window.fetch = function (input, init) {
      var rec = null, bodyPromise = null, t0 = 0;

      try {
        var url, method, rawBody;

        if (input && typeof input === 'object' && typeof input.url === 'string') {
          // Request object: il body si legge SOLO sul clone.
          url = input.url;
          method = (init && init.method) || input.method || 'GET';
          rawBody = (init && init.body !== undefined) ? init.body : null;
          if (rawBody === null && typeof input.clone === 'function' && input.body) {
            try { bodyPromise = input.clone().text(); } catch (e) { UAD.error('net-hooks.fetch clone', e); }
          }
        } else {
          url = input;
          method = (init && init.method) || 'GET';
          rawBody = (init && init.body !== undefined) ? init.body : null;
        }

        var bi = (rawBody !== null && rawBody !== undefined) ? normalizeBody(rawBody) : null;
        if (bi && bi.promise) bodyPromise = bi.promise;
        rec = makeRecord('fetch', url, method, bi || { body: null, bodyType: 'none', truncated: false });
        t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      } catch (e) { counters.errors++; UAD.error('net-hooks.fetch (cattura)', e); }

      var p;
      try {
        p = orig.apply(this, arguments);
      } catch (e) {
        // Errore sincrono della fetch originale: lo lasciamo passare intatto.
        if (rec) { rec.status = 0; rec.ok = false; dispatchWhenBodyReady(rec, bodyPromise); }
        throw e;
      }

      if (rec) {
        // Osservatore su un RAMO LATERALE: la promise restituita al chiamante
        // resta quella originale, identita e comportamento inclusi.
        try {
          p.then(function (res) {
            try {
              rec.status = res && res.status;
              rec.ok = !!(res && res.ok);
              if (t0) rec.durationMs = Math.round(((performance.now ? performance.now() : 0) - t0));
            } catch (e) {}
            dispatchWhenBodyReady(rec, bodyPromise);
          }, function () {
            rec.status = 0; rec.ok = false;
            dispatchWhenBodyReady(rec, bodyPromise);
          });
        } catch (e) {
          UAD.error('net-hooks.fetch (osservatore)', e);
          dispatchWhenBodyReady(rec, bodyPromise);
        }
      }

      return p;
    };
  })();

  // ================================================================ 2. XHR
  (function patchXHR() {
    var P = XMLHttpRequest.prototype;
    var origOpen = P.open, origSend = P.send;
    if (typeof origOpen !== 'function' || typeof origSend !== 'function') return;

    P.open = function (method, url) {
      try { this.__uad = { method: method, url: url, t0: Date.now() }; }
      catch (e) { counters.errors++; UAD.error('net-hooks.xhr.open', e); }
      return origOpen.apply(this, arguments);
    };

    P.send = function (body) {
      var self = this, rec = null, bodyPromise = null;

      try {
        var info = this.__uad || {};
        var bi = normalizeBody(body);
        if (bi.promise) bodyPromise = bi.promise;
        rec = makeRecord('xhr', info.url, info.method, bi);

        // loadend copre load/error/abort/timeout in un solo punto.
        this.addEventListener('loadend', function () {
          try {
            rec.status = self.status;
            rec.ok = (self.status >= 200 && self.status < 400);
            rec.durationMs = Date.now() - (info.t0 || rec.ts);
          } catch (e) {}
          dispatchWhenBodyReady(rec, bodyPromise);
        }, false);
      } catch (e) { counters.errors++; UAD.error('net-hooks.xhr.send (cattura)', e); }

      try {
        return origSend.apply(this, arguments);
      } catch (e) {
        if (rec) { rec.status = 0; rec.ok = false; dispatchWhenBodyReady(rec, bodyPromise); }
        throw e;
      }
    };
  })();

  // ========================================================= 3. sendBeacon
  (function patchBeacon() {
    var orig = navigator.sendBeacon;
    if (typeof orig !== 'function') return;

    navigator.sendBeacon = function (url, data) {
      var rec = null, bodyPromise = null;
      try {
        var bi = normalizeBody(data);
        if (bi.promise) bodyPromise = bi.promise;
        rec = makeRecord('beacon', url, 'POST', bi);
      } catch (e) { counters.errors++; UAD.error('net-hooks.sendBeacon (cattura)', e); }

      var ret;
      try {
        // this DEVE essere navigator, altrimenti alcune build lanciano.
        ret = orig.apply(navigator, arguments);
      } catch (e) {
        if (rec) { rec.ok = false; dispatchWhenBodyReady(rec, bodyPromise); }
        throw e;
      }

      if (rec) {
        rec.ok = (ret !== false);
        rec.status = (ret === false) ? 0 : null;   // sendBeacon non espone lo status
        dispatchWhenBodyReady(rec, bodyPromise);
      }
      return ret;
    };
  })();

  // ================================== 4. pixel: img.src e script.src
  (function patchPixelSrc() {
    [['HTMLImageElement', HTMLImageElement], ['HTMLScriptElement', HTMLScriptElement]].forEach(function (pair) {
      var name = pair[0], Ctor = pair[1];
      if (!Ctor || !Ctor.prototype) return;

      var d = Object.getOwnPropertyDescriptor(Ctor.prototype, 'src');
      if (!d || !d.configurable || typeof d.set !== 'function') {
        UAD.log('net-hooks: ' + name + '.src non patchabile, canale ignorato');
        return;
      }

      try {
        Object.defineProperty(Ctor.prototype, 'src', {
          configurable: true,
          enumerable: d.enumerable,
          get: d.get,
          set: function (v) {
            try {
              var href = absolutize(v);
              if (!SKIP_SCHEME.test(href.split(':')[0] + ':') && !pixelAlreadySeen(href)) {
                dispatchRequest(makeRecord(name === 'HTMLImageElement' ? 'img.src' : 'script.src',
                                           href, 'GET', null, { initiator: name }));
              }
            } catch (e) { counters.errors++; UAD.error('net-hooks.' + name + '.src', e); }
            return d.set.call(this, v);   // il valore originale passa intatto
          }
        });
      } catch (e) { UAD.error('net-hooks.patchPixelSrc ' + name, e); }
    });
  })();

  // ============================================ 5. Element.setAttribute
  // AppMeasurement e diversi pixel usano img.setAttribute('src', ...), che
  // BYPASSA il setter di proprieta: senza questo canale sarebbero invisibili.
  (function patchSetAttribute() {
    var orig = Element.prototype.setAttribute;
    if (typeof orig !== 'function') return;

    Element.prototype.setAttribute = function (name, value) {
      try {
        if (name && String(name).toLowerCase() === 'src') {
          var tag = '';
          try { tag = String(this.tagName || '').toUpperCase(); } catch (e) {}
          if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'IFRAME') {
            var href = absolutize(value);
            if (!SKIP_SCHEME.test(href.split(':')[0] + ':') && !pixelAlreadySeen(href)) {
              dispatchRequest(makeRecord('setAttribute', href, 'GET', null, { initiator: tag }));
            }
          }
        }
      } catch (e) { counters.errors++; UAD.error('net-hooks.setAttribute', e); }
      return orig.apply(this, arguments);
    };
  })();

  // --------------------------------------------------------------------- API
  UAD.netHooks = {
    onRequest: function (fn) { if (typeof fn === 'function') subscribers.push(fn); },
    stats: function () {
      return {
        seen: counters.seen, dispatched: counters.dispatched, matched: counters.matched,
        buffered: counters.buffered, skipped: counters.skipped, errors: counters.errors,
        subscribers: subscribers.length
      };
    },
    normalizeBody: normalizeBody,
    absolutize: absolutize
  };

  window.__UAD_NET_PATCHED__ = true;
  UAD.log('net-hooks pronto: 5 canali installati');
})();