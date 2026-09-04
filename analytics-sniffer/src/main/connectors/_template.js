/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEMPLATE CONNETTORE — Universal Analytics Debugger
 *
 * Questo file NON e' nel manifest: e' uno scheletro da copiare.
 *
 * COME AGGIUNGERE UN TOOL — tre passi, nessuna modifica al core
 *
 *   1. copia questo file in src/main/connectors/<mio-tool>.js
 *   2. sostituisci ID, label, colorTheme e implementa i metodi
 *   3. aggiungi il percorso all'array "js" del manifest, DOPO gli altri
 *      connettori e PRIMA di content-script.js
 *
 * Non serve toccare namespace.js (il connettore si auto-dichiara nei settings),
 * ne il pannello (label e colore di fallback vengono generati dall'id), ne
 * net-hooks.js (le request vengono offerte automaticamente a tutti).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PRIMA DI SCRIVERE: DECIDI LA GERARCHIA DEI CANALI
 *
 * La domanda non e' "come intercetto questo tool", ma "quale canale e' la
 * VERITA e quale l'arricchimento". Tre configurazioni possibili:
 *
 *   A) RETE = verita, HOOK = arricchimento          <- il caso normale
 *      Usato da ga4.js, adobe-legacy.js, adobe-aep.js.
 *      La rete e' cio che il vendor riceve davvero; l'hook aggiunge i nomi
 *      delle variabili sorgente (campo `src`), che la rete non puo conoscere
 *      perche riceve i parametri gia mappati.
 *      -> offri entrambi al dedupe con la stessa `key`.
 *
 *   B) SOLO RETE, nessuna correlazione
 *      Usato da generic-vendors.js.
 *      Non agganci hook: ogni request e' un'osservazione autonoma.
 *      -> chiama UAD.emit() direttamente, salti il dedupe.
 *
 *   C) SOLO HOOK, nessuna correlazione
 *      Usato da gtm.js.
 *      Il tool non invia hit proprie (e' un contenitore, o un layer di
 *      orchestrazione). Correlare nasconderebbe l'informazione utile.
 *      -> chiama UAD.emit() direttamente.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TRE ERRORI CHE COSTANO ORE — imparati sul campo
 *
 *   1. DETECTION PER ESISTENZA invece che per FORMA.
 *      `'_satellite' in window` era true su un sito SENZA Adobe: un'altra
 *      estensione installata aveva dichiarato la property come getter che
 *      ritorna undefined. Verifica sempre la FORMA:
 *      `typeof x.metodoCheDeveEsistere === 'function'`
 *
 *   2. MATCH SULL'HOSTNAME invece che sul PATH.
 *      Con server-side tagging e CNAME first-party, l'endpoint sta su un
 *      dominio del cliente (sgtm.brand.it, smetrics.brand.com). Un match su
 *      hostname non vedrebbe nulla proprio sui siti enterprise.
 *
 *   3. LEGGERE IL BODY DI UNA Request SENZA .clone().
 *      Consuma lo stream e ROMPE la request del sito. net-hooks.js lo fa
 *      correttamente per te: nel connettore ricevi `rec.body` gia pronto,
 *      non toccare mai l'oggetto Request.
 * ═══════════════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] <mio-tool>: namespace assente'); } catch (e) {} return; }

  // ID: usato nei settings, come chiave delle tab, nei log. Minuscolo, con
  // trattini. Deve essere stabile: cambiarlo azzera le preferenze dell'utente.
  var ID = 'mio-tool';

  /* ════════════════════════════════════════════════════════════════════════
     1. STATO DEL CONNETTORE
     Tutto lo stato vive qui, mai in variabili sparse: il connettore puo essere
     attivato e disattivato a runtime dai Settings.
     ════════════════════════════════════════════════════════════════════════ */

  var state = {
    attached: false,     // attach() e' idempotente
    wrapped: false,      // hook installati
    hits: 0,             // conteggio: alimenta detect() come ultimo strato
    accountId: null      // config scoperta dagli hook, utile per la dedupeKey
  };

  /* ════════════════════════════════════════════════════════════════════════
     2. HELPER
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Aggiunge una riga a una categoria.
   * Il campo `src` e' il path/nome della variabile ORIGINALE: il pannello lo
   * mostra in un tooltip ed e' cercabile e filtrabile. Compilalo sempre quando
   * lo conosci - e' la ragione per cui vale la pena avere un hook oltre alla
   * rete.
   */
  function pushRow(cats, categoria, chiave, valore, src) {
    if (!cats[categoria]) cats[categoria] = [];
    cats[categoria].push({ key: chiave, value: valore, src: src || null });
  }

  /**
   * Appiattisce un oggetto in righe con path puntato: a.b[0].c
   * Utile per payload JSON di forma non nota a priori.
   */
  function flatten(obj, cats, categoria, prefix, depth) {
    depth = depth || 0;
    if (depth > 8 || !obj || typeof obj !== 'object') return;

    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      var path = prefix ? (prefix + '.' + k) : k;

      if (v === null || v === undefined) return;

      // Un nodo DOM nel payload e' frequente (event.target, gtm.element): va
      // riconosciuto PRIMA di ricorrervi, altrimenti si attraversa un grafo
      // enorme. Il serializer lo gestirebbe comunque, ma sprecando lavoro.
      if (typeof v.nodeType === 'number') {
        pushRow(cats, categoria, path, '[elemento DOM]', path);
        return;
      }
      if (Array.isArray(v)) {
        if (!v.length) { pushRow(cats, categoria, path, '[]', path); return; }
        for (var i = 0; i < Math.min(v.length, 50); i++) {
          if (v[i] && typeof v[i] === 'object') flatten(v[i], cats, categoria, path + '[' + i + ']', depth + 1);
          else pushRow(cats, categoria, path + '[' + i + ']', v[i], path);
        }
        return;
      }
      if (typeof v === 'function') {
        pushRow(cats, categoria, path, '[funzione]', path);
        return;
      }
      if (typeof v === 'object') { flatten(v, cats, categoria, path, depth + 1); return; }

      pushRow(cats, categoria, path, v, path);
    });
  }

  /** Parsing di una querystring o di un body urlencoded. */
  function parseParams(str) {
    var out = {};
    if (!str) return out;
    if (str.charAt(0) === '?') str = str.slice(1);

    str.split('&').forEach(function (p) {
      if (!p) return;
      var eq = p.indexOf('=');
      var rk = (eq === -1) ? p : p.slice(0, eq);
      var rv = (eq === -1) ? '' : p.slice(eq + 1);
      try { out[decodeURIComponent(rk.replace(/\+/g, ' '))] = decodeURIComponent(rv.replace(/\+/g, ' ')); }
      catch (e) { out[rk] = rv; }
    });
    return out;
  }

  /* ════════════════════════════════════════════════════════════════════════
     3. CHIAVE DI CORRELAZIONE (solo per la configurazione A)
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Identifica lo STESSO hit osservato su canali diversi.
   *
   * REGOLA: includi solo cio che entrambi i canali vedono nello stesso modo.
   * NON includere i parametri: l'hook vede quelli passati dal codice, la rete
   * vede quelli con i default di configurazione GIA mergiati. Sono insiemi
   * diversi, e includerli impedirebbe qualsiasi correlazione.
   *
   * Buona chiave:  ID account + nome evento + identificativo utente
   * Cattiva chiave: qualsiasi cosa che dipenda dal payload completo
   */
  function dedupeKey(accountId, nomeEvento, userId) {
    return ID + '|' + (accountId || '?') + '|' + (nomeEvento || '?') + '|' + (userId || '');
  }

  /**
   * Consegna l'evento. Due strade, secondo la configurazione scelta:
   *
   *   A) dedupe: correla hook e rete entro 1200ms in un unico evento
   *   B/C) emit diretto: nessuna correlazione
   */
  function offer(channel, raw) {
    if (!raw) return;
    state.hits++;

    // --- Configurazione A: correlazione
    var key = raw.__key;
    delete raw.__key;
    raw.source = channel;
    UAD.dedupe.offer(ID, {
      channel: channel,        // 'hook' | 'network' | 'datalayer' | 'polling'
      key: key,
      raw: raw,
      timestamp: raw.timestamp
    });

    // --- Configurazioni B e C: sostituisci le righe sopra con
    // raw.source = channel;
    // UAD.emit(ID, raw);
  }

  /* ════════════════════════════════════════════════════════════════════════
     4. COSTRUZIONE DELL'EVENTO
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Modello dati atteso da UAD.emit():
   *
   * {
   *   name:              string   nome mostrato. Se null, l'emitter applica la
   *                               sua catena di fallback: mai "n/d".
   *   categorizedFields: object   { "Categoria": [{key, value, src}] }
   *   products:          array?   [{ name, SKU, fields: [{key,value,src}] }]
   *   source:            string   impostato da offer()
   *   status:            string?  'ok' | 'partial' | 'error'
   *   timestamp:         number
   *   rawDebugString:    string?  payload grezzo, mostrato in "Payload grezzo"
   *   meta:              object?  { warning, ...qualsiasi cosa }
   * }
   *
   * SULLE CATEGORIE
   * Sono libere: il pannello crea un sottogruppo per ognuna, nell'ordine in cui
   * le inserisci. Poche categorie con nomi che rispecchiano il vocabolario del
   * tool valgono piu di venti micro-gruppi.
   *
   * SU meta.warning
   * Se metti una stringa qui, il pannello la mostra in evidenza sopra i campi.
   * Serve per le diagnosi: "questo dato manca e probabilmente non arrivera al
   * vendor". E' cio che rende un debugger utile invece di un visualizzatore.
   */
  function buildFromNetwork(rec) {
    var cats = {};
    var params = parseParams(rec.urlObj ? rec.urlObj.search : '');

    // Corpo della request: net-hooks lo ha gia normalizzato e reso sicuro.
    // Puo essere stringa, oggetto, o un placeholder se troppo grande.
    if (typeof rec.body === 'string' && rec.body.indexOf('=') !== -1) {
      var bodyParams = parseParams(rec.body);
      Object.keys(bodyParams).forEach(function (k) { params[k] = bodyParams[k]; });
    } else if (rec.body && typeof rec.body === 'object') {
      flatten(rec.body, cats, 'Body', '', 0);
    }

    // Metadati della richiesta: sempre utili in diagnosi.
    pushRow(cats, 'Richiesta', 'endpoint', rec.urlObj.hostname + rec.urlObj.pathname, null);
    pushRow(cats, 'Richiesta', 'metodo', rec.method, null);
    pushRow(cats, 'Richiesta', 'canale', rec.via, null);   // fetch|xhr|beacon|img.src|...
    if (rec.status !== null && rec.status !== undefined) {
      pushRow(cats, 'Richiesta', 'HTTP status', rec.status, null);
    }

    // Parametri: raggruppali secondo il vocabolario del tool, non alla cieca.
    var nomeEvento = params.event || params.en || params.ev || null;

    Object.keys(params).forEach(function (k) {
      if (k === 'event' || k === 'en' || k === 'ev') return;   // e' il nome
      // ESEMPIO di raggruppamento: adattalo al tuo tool.
      if (/^(uid|cid|sid|user_id)$/.test(k)) {
        pushRow(cats, 'Identity', k, params[k], k);
      } else if (/^(consent|gdpr|npa)/.test(k)) {
        pushRow(cats, 'Consent', k, params[k], k);
      } else {
        pushRow(cats, 'Parametri', k, params[k], k);
      }
    });

    return {
      name: nomeEvento,
      categorizedFields: cats,
      timestamp: rec.ts,
      rawDebugString: rec.url +
        (typeof rec.body === 'string' ? '\n\n[body]\n' + rec.body : '') +
        (rec.bodyTruncated ? '\n\n[body troncato]' : ''),
      meta: {
        via: rec.via,
        httpStatus: rec.status
      },
      __key: dedupeKey(state.accountId, nomeEvento, params.uid)
    };
  }

  function buildFromHook(nomeEvento, params) {
    var cats = {};

    // Dall'hook conosci i NOMI ORIGINALI delle variabili: compila `src`.
    // E' l'unico canale che puo farlo, ed e' cio che rende il tooltip ℹ️ e la
    // ricerca per nome-variabile possibili.
    flatten(params || {}, cats, 'Parametri', '', 0);

    return {
      name: nomeEvento,
      categorizedFields: cats,
      timestamp: Date.now(),
      meta: { observedVia: 'nomeFunzione()' },
      __key: dedupeKey(state.accountId, nomeEvento, null)
    };
  }

  /* ════════════════════════════════════════════════════════════════════════
     5. HOOK
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * Wrappa una funzione globale del tool.
   *
   * TRE REGOLE ASSOLUTE:
   *   1. la chiamata originale viene SEMPRE eseguita, con il suo valore di
   *      ritorno intatto
   *   2. tutta la nostra logica sta dentro UAD.safe(): un nostro bug non deve
   *      mai propagarsi al codice della pagina
   *   3. il flag __uadWrapped previene il doppio wrapping quando la global
   *      viene riassegnata
   */
  function wrapGlobalFn(fn) {
    if (typeof fn !== 'function' || fn.__uadWrapped) return fn;

    var wrapped = function () {
      var args = arguments;

      UAD.safe(ID + '.hook', function () {
        // Il gate: un tool disattivato dai Settings non deve emettere nulla.
        if (!UAD.isEnabled(ID)) return;

        // ESEMPIO: adattalo alla firma del tuo tool.
        var cmd = args[0];

        if (cmd === 'init' || cmd === 'config') {
          // Config: memorizzala, non emettere un evento.
          if (typeof args[1] === 'string') state.accountId = args[1];
          return;
        }
        if (cmd === 'track' || cmd === 'event') {
          var nome = args[1];
          if (typeof nome !== 'string' || !nome) return;
          offer('hook', buildFromHook(nome, args[2]));
        }
      })();

      // SEMPRE, fuori dal blocco protetto.
      return fn.apply(this, args);
    };
    wrapped.__uadWrapped = true;

    UAD.log(ID + ': funzione globale wrappata');
    return wrapped;
  }

  /* ════════════════════════════════════════════════════════════════════════
     6. IL CONNETTORE
     ════════════════════════════════════════════════════════════════════════ */

  var connector = {
    id: ID,
    label: 'Mio Tool',        // mostrato sulla tab
    colorTheme: '#6366f1',    // colore di tab, badge e chiavi

    /**
     * Il tool e' presente su questa pagina?
     *
     * Chiamata piu volte: subito, poi a 300ms, 1s, 2.5s, 5s, 10s, 20s, al
     * window.load, a ogni cambio settings e a ogni nuova view SPA.
     * I tool arrivano tardi in modo sistematico: consenso cookie accettato dopo
     * 15 secondi, lazy loading, A/B test che inietta script.
     *
     * SEMPRE PER FORMA, MAI PER ESISTENZA (vedi errore 1 in testa al file).
     */
    detect: function (win) {
      try {
        // Strato 1: la global esiste ED e' della forma attesa.
        if (typeof win.mioToolSdk === 'function') return true;

        // Strato 2: una traccia indiretta. Un cookie del tool, una chiave in
        // localStorage, un elemento nel DOM. Utile quando la global non esiste
        // (es. tag manager che costruisce la request internamente).
        if (/mioToolId=/.test(document.cookie)) return true;

        // Strato 3: ULTIMO E IMPORTANTE. Se abbiamo gia visto una request, il
        // tool c'e' anche senza alcuna global. E' cosi che ga4.js funziona sui
        // siti dove GTM costruisce le hit senza esporre gtag.
        return state.hits > 0;
      } catch (e) {
        return false;
      }
    },

    /**
     * Chiamata UNA volta, quando detect() ha risposto true.
     * Installa gli hook. Deve essere idempotente.
     */
    attach: function () {
      if (state.attached) return;
      state.attached = true;

      // watchGlobal intercetta la comparsa della global con defineProperty,
      // PRIMA che la pagina la assegni: nessun polling, nessun timing issue.
      // Notifica anche le RIASSEGNAZIONI: diversi tag manager sostituiscono la
      // global piu volte durante il caricamento, e senza questo il nostro hook
      // verrebbe silenziosamente rimpiazzato.
      UAD.watchGlobal('mioToolSdk', function (v) {
        UAD.safe(ID + '.onGlobal', function () {
          if (typeof v !== 'function' || v.__uadWrapped) return;
          try { window.mioToolSdk = wrapGlobalFn(v); }
          catch (e) { UAD.error(ID + '.assign', e); }
        })();
      }, {
        // Il test di FORMA: senza questo, una property dichiarata da un'altra
        // estensione con valore undefined farebbe scattare l'hook a vuoto.
        test: function (v) { return typeof v === 'function'; }
      });

      // Gia presente al momento dell'attach.
      try {
        if (typeof window.mioToolSdk === 'function' && !window.mioToolSdk.__uadWrapped) {
          window.mioToolSdk = wrapGlobalFn(window.mioToolSdk);
        }
      } catch (e) { UAD.error(ID + '.attach', e); }

      // Se devi wrappare un METODO di un oggetto (es. sdk.track) che puo essere
      // riassegnato dopo di te, usa watchProp:
      //
      // UAD.watchProp(window.mioToolSdk, 'track', function (nuovoValore) {
      //   if (typeof nuovoValore === 'function' && !nuovoValore.__uadWrapped) {
      //     setTimeout(function () { /* ri-wrappa */ }, 0);
      //   }
      // }, { test: function (v) { return typeof v === 'function'; } });

      UAD.log(ID + ' attach completato');
    },

    /** Opzionale: chiamata quando l'utente disattiva il tool dai Settings.
     *  NON rimuovere i wrapper: se altro codice ha wrappato dopo di te,
     *  romperesti la catena. Il gate isEnabled() li rende inerti, e un reload
     *  della pagina riporta lo stato pulito. */
    deactivate: function () {
      UAD.log(ID + ' disattivato: gli hook restano installati ma inerti');
    },

    /**
     * Questa request di rete riguarda il mio tool?
     *
     * Chiamata per OGNI request osservata sui 5 canali (fetch, XHR, sendBeacon,
     * img.src, setAttribute). Deve essere veloce e non lanciare mai.
     *
     * MATCH SUL PATH, MAI SULL'HOSTNAME (vedi errore 2 in testa al file).
     */
    matches: function (url, method, body, rec) {
      try {
        var u = rec && rec.urlObj;
        if (!u) return false;

        var path = u.pathname;
        var query = u.search || '';

        // Il path e' l'indizio piu stabile: sopravvive ai CNAME first-party.
        if (!/\/mio-endpoint/.test(path)) return false;

        // Un parametro caratteristico distingue endpoint simili di vendor
        // diversi, ed e' la prova che si tratta davvero del tuo tool.
        if (/[?&]mioParam=/.test(query)) return true;
        if (typeof body === 'string' && /(^|&)mioParam=/.test(body)) return true;

        // Per i tool con payload JSON, la FORMA del body e' la prova migliore:
        // e' cosi che adobe-aep.js riconosce le hit dietro qualsiasi dominio.
        // if (typeof body === 'string' && /"mioCampoObbligatorio"\s*:/.test(body)) return true;

        return false;
      } catch (e) {
        return false;
      }
    },

    /**
     * Trasforma la request in uno o piu eventi.
     *
     * ATTENZIONE AL BATCHING: molti tool inviano N eventi in una sola request
     * (righe separate da newline, oppure un array JSON). Chi non splitta vede
     * un evento invece di cinque. Controlla la documentazione del tuo tool.
     */
    parseNetwork: function (rec) {
      UAD.safe(ID + '.parseNetwork', function () {

        // ESEMPIO di batch su array JSON:
        // var body = rec.body;
        // if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
        // if (body && Array.isArray(body.events)) {
        //   for (var i = 0; i < body.events.length; i++) {
        //     var raw = buildFromNetworkEvent(body.events[i], rec, i, body.events.length);
        //     offer('network', raw);
        //   }
        //   return;
        // }

        offer('network', buildFromNetwork(rec));
      })();
    }
  };

  /* ════════════════════════════════════════════════════════════════════════
     7. REGISTRAZIONE
     Il secondo argomento e' lo stato di DEFAULT al primo avvio.
       true  = tool day 1, acceso subito
       false = tool aggiuntivo o sperimentale, l'utente lo accende dai Settings
     Il connettore si auto-dichiara nei settings: nessuna modifica a
     namespace.js e' necessaria.
     ════════════════════════════════════════════════════════════════════════ */

  UAD.register(connector, false);
})();