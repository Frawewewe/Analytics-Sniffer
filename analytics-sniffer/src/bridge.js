/**
 * Universal Analytics Debugger — ponte MAIN <-> background
 * World: ISOLATED | run_at: document_start
 *
 * PERCHE ESISTE
 * Il content script in world MAIN vede le global della pagina (window.gtag,
 * window.s, window.alloy) ma NON puo usare chrome.runtime in modo affidabile.
 * Un content script in world ISOLATED puo usare chrome.runtime ma NON vede le
 * global della pagina. Sono due contesti JS separati sullo stesso documento.
 *
 * L'unico ponte naturale sono i CustomEvent su window: sono visibili da
 * entrambi i world, perche il DOM e' condiviso.
 *
 *   MAIN  --CustomEvent(__UAD_HIT__)-->  BRIDGE  --sendMessage-->  background
 *   MAIN  <--CustomEvent(__UAD_SETTINGS__)--  BRIDGE  <--onMessage--  background
 *
 * Il payload attraversa il ponte SEMPRE come stringa JSON: passare oggetti vivi
 * tra world produce cloning failures e dead objects su payload reali.
 *
 * QUESTO FILE NON DEVE MAI:
 *   - toccare il DOM della pagina
 *   - leggere variabili della pagina (non le vede)
 *   - assumere che il background sia sveglio (MV3 lo sospende)
 */
(function () {
  'use strict';

  if (window.__UAD_BRIDGE__) return;
  window.__UAD_BRIDGE__ = true;

  var CH = {
    HIT:      '__UAD_HIT__',
    READY:    '__UAD_READY__',
    SETTINGS: '__UAD_SETTINGS__',
    COMMAND:  '__UAD_COMMAND__'
  };

  var SETTINGS_KEY = 'uad_settings';

  // Il service worker MV3 viene sospeso dopo pochi secondi di inattivita.
  // Al primo messaggio dopo la sospensione, Chrome lo risveglia: la chiamata
  // puo fallire una volta e riuscire al secondo tentativo.
  var SEND_RETRY_MS = 60;
  var SEND_MAX_RETRY = 2;

  // Gli eventi arrivano a raffica durante il page load. Inviarli uno per uno
  // sovraccarica il canale e fa perdere messaggi: li raggruppiamo.
  var BATCH_MS = 80;
  var BATCH_MAX = 40;
  var QUEUE_CAP = 2000;

  var state = {
    settingsSent: 0,
    hitsForwarded: 0,
    hitsDropped: 0,
    sendErrors: 0,
    commandsForwarded: 0,
    contextInvalidated: false
  };

  var queue = [];
  var batchTimer = null;

  // ------------------------------------------------------------------- utils

  /** Il contesto dell'estensione muore quando l'estensione viene ricaricata o
   *  aggiornata mentre la pagina e' aperta. Da quel momento ogni chiamata a
   *  chrome.* lancia. Va rilevato e dichiarato, non ignorato. */
  function contextAlive() {
    if (state.contextInvalidated) return false;
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      state.contextInvalidated = true;
      return false;
    }
  }

  function markInvalidated(where, err) {
    if (state.contextInvalidated) return;
    state.contextInvalidated = true;
    try {
      console.error('[UAD bridge] contesto estensione invalidato in ' + where +
                    ': ricarica la pagina per riattivare il debugger.', err || '');
    } catch (e) {}
  }

  /** Invio con retry: il primo tentativo puo cadere se il service worker
   *  e' sospeso. chrome.runtime.lastError va SEMPRE letto, altrimenti Chrome
   *  logga "Unchecked runtime.lastError" a ogni messaggio. */
  function send(msg, attempt) {
    attempt = attempt || 0;
    if (!contextAlive()) return;

    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        var err = chrome.runtime.lastError;
        if (!err) return;

        var m = String(err.message || err);
        if (/Extension context invalidated|Receiving end does not exist/i.test(m)) {
          if (/invalidated/i.test(m)) { markInvalidated('sendMessage', m); return; }
          // Service worker addormentato: riprova.
          if (attempt < SEND_MAX_RETRY) {
            setTimeout(function () { send(msg, attempt + 1); }, SEND_RETRY_MS * (attempt + 1));
            return;
          }
        }
        state.sendErrors++;
        try { console.error('[UAD bridge] sendMessage:', m); } catch (e) {}
      });
    } catch (e) {
      markInvalidated('sendMessage (throw)', e);
    }
  }

  // ------------------------------------------------------------ batching hit

  function flushQueue() {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (!queue.length) return;

    var batch = queue.splice(0, BATCH_MAX);
    state.hitsForwarded += batch.length;
    send({ type: 'uad:hits', events: batch, url: location.href, ts: Date.now() });

    // Se la coda non e' vuota continuiamo subito: durante il page load
    // possono arrivare centinaia di eventi in poche centinaia di ms.
    if (queue.length) batchTimer = setTimeout(flushQueue, 0);
  }

  function enqueue(json) {
    if (queue.length >= QUEUE_CAP) {
      // Scartiamo il piu vecchio: gli eventi recenti sono quelli che l'utente
      // sta guardando. Lo dichiariamo nei contatori, mai in silenzio.
      queue.shift();
      state.hitsDropped++;
      if (state.hitsDropped === 1) {
        try { console.error('[UAD bridge] coda piena (' + QUEUE_CAP + '): eventi piu vecchi scartati'); } catch (e) {}
      }
    }
    queue.push(json);

    if (queue.length >= BATCH_MAX) { flushQueue(); return; }
    if (!batchTimer) batchTimer = setTimeout(flushQueue, BATCH_MS);
  }

  // ------------------------------------------------ MAIN -> background (hit)

  window.addEventListener(CH.HIT, function (ev) {
    try {
      var d = ev && ev.detail;
      if (typeof d !== 'string') {
        // Il contratto e' "sempre stringa JSON". Se arriva un oggetto lo
        // stringifichiamo difensivamente, ma e' un errore da correggere a monte.
        try { d = JSON.stringify(d); }
        catch (e) { console.error('[UAD bridge] hit non serializzabile scartata', e); return; }
      }
      enqueue(d);
    } catch (e) {
      try { console.error('[UAD bridge] onHit', e); } catch (e2) {}
    }
  }, false);

  // ------------------------------------------- background -> MAIN (settings)

  function pushSettingsToMain(settings) {
    try {
      state.settingsSent++;
      window.dispatchEvent(new CustomEvent(CH.SETTINGS, {
        detail: JSON.stringify(settings || {})
      }));
    } catch (e) {
      try { console.error('[UAD bridge] pushSettingsToMain', e); } catch (e2) {}
    }
  }

  /**
   * Legge i settings da chrome.storage.local e li consegna a MAIN.
   * Il world MAIN non puo leggere lo storage: finche non riceve i settings
   * tiene tutto in buffer e non emette nulla.
   */
  function loadAndPushSettings() {
    if (!contextAlive()) {
      // Senza contesto MAIN resterebbe bloccato per sempre in attesa: meglio
      // consegnare un oggetto vuoto, che il merge coi DEFAULTS rende usabile.
      pushSettingsToMain({});
      return;
    }
    try {
      chrome.storage.local.get([SETTINGS_KEY], function (res) {
        var err = chrome.runtime.lastError;
        if (err) {
          try { console.error('[UAD bridge] storage.get:', err.message); } catch (e) {}
          pushSettingsToMain({});
          return;
        }
        pushSettingsToMain((res && res[SETTINGS_KEY]) || {});
      });
    } catch (e) {
      markInvalidated('storage.get', e);
      pushSettingsToMain({});
    }
  }

  // MAIN si annuncia: rispondiamo con i settings. Puo annunciarsi piu volte,
  // e va bene: applySettings e' idempotente.
  window.addEventListener(CH.READY, function () {
    loadAndPushSettings();
  }, false);

  // Invio spontaneo: l'ordine di esecuzione tra i due world non e' garantito.
  // Se il bridge parte per primo, MAIN non ha ancora ascoltatori e il messaggio
  // va perso; per questo MAIN ripete l'annuncio e noi ritentiamo.
  loadAndPushSettings();
  [0, 100, 400].forEach(function (ms) {
    setTimeout(loadAndPushSettings, ms);
  });

  // Settings modificati dal pannello: propagazione live, senza reload.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      pushSettingsToMain(changes[SETTINGS_KEY].newValue || {});
    });
  } catch (e) {
    try { console.error('[UAD bridge] storage.onChanged non disponibile', e); } catch (e2) {}
  }

  // -------------------------------------------- background -> MAIN (comandi)

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      try {
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
          case 'uad:command':
            // Comando dal pannello verso la pagina (redetect, flush,
            // stop navigazione, debug, diagnose).
            state.commandsForwarded++;
            window.dispatchEvent(new CustomEvent(CH.COMMAND, {
              detail: JSON.stringify({ cmd: msg.cmd, payload: msg.payload || null })
            }));
            respond({ ok: true });
            return true;

          case 'uad:settings':
            // Push diretto dei settings, senza passare dallo storage.
            pushSettingsToMain(msg.settings || {});
            respond({ ok: true });
            return true;

          case 'uad:ping':
            // Il pannello verifica se la pagina ha il bridge attivo.
            respond({
              ok: true,
              bridge: true,
              url: location.href,
              stats: {
                hitsForwarded: state.hitsForwarded,
                hitsDropped: state.hitsDropped,
                queued: queue.length,
                settingsSent: state.settingsSent,
                sendErrors: state.sendErrors,
                contextInvalidated: state.contextInvalidated
              }
            });
            return true;

          case 'uad:flushNow':
            flushQueue();
            respond({ ok: true, flushed: state.hitsForwarded });
            return true;
        }
      } catch (e) {
        try { console.error('[UAD bridge] onMessage', e); } catch (e2) {}
        try { respond({ ok: false, error: String(e && e.message) }); } catch (e3) {}
      }
    });
  } catch (e) {
    try { console.error('[UAD bridge] onMessage non registrabile', e); } catch (e2) {}
  }

  // ------------------------------------------------------------ chiusura pagina

  /**
   * pagehide copre anche il passaggio a bfcache, dove unload non scatta.
   * Senza questo flush gli eventi degli ultimi istanti - tipicamente i
   * purchase con redirect al gateway di pagamento - morirebbero in coda.
   */
  window.addEventListener('pagehide', function () {
    try { flushQueue(); } catch (e) {}
  }, false);

  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      try { flushQueue(); } catch (e) {}
    }
  }, false);

  // Diagnostica accessibile dalla console della pagina: e' nel world ISOLATED,
  // quindi NON collide con __UAD (world MAIN). Nomi diversi, contesti diversi.
  window.__UAD_BRIDGE_STATS__ = function () {
    return {
      hitsForwarded: state.hitsForwarded,
      hitsDropped: state.hitsDropped,
      queued: queue.length,
      settingsSent: state.settingsSent,
      commandsForwarded: state.commandsForwarded,
      sendErrors: state.sendErrors,
      contextInvalidated: state.contextInvalidated,
      contextAlive: contextAlive()
    };
  };
})();