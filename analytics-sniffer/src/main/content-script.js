/**
 * Universal Analytics Debugger — bootstrap del world MAIN
 * World: MAIN | ULTIMO file dell'array js nel manifest.
 *
 * Quando questo file gira, in memoria ci sono gia:
 *   namespace, serializer, emitter, session, dedupe, net-hooks,
 *   global-watcher e tutti i connettori registrati con UAD.register().
 *
 * Compiti, in ordine:
 *   1. verificare che i moduli obbligatori siano presenti
 *   2. annunciarsi al bridge (ISOLATED) e chiedere i settings
 *   3. ricevere ed eseguire i comandi dal pannello
 *   4. gestire la detection dei connettori a intervalli (alcuni tool si
 *      inizializzano con ritardo, o dopo il consenso cookie)
 *   5. esporre un pannello di diagnosi unificato: __UAD.diagnose()
 *
 * NOTA: questo file NON contiene logica di analytics. Se serve toccarlo per
 * aggiungere un tool, l'architettura a plugin ha fallito.
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) {
    try {
      console.error('[UAD] content-script: namespace.js non caricato. ' +
                    'Verifica l\'ORDINE dell\'array "js" nel manifest: ' +
                    'namespace.js deve essere il primo, content-script.js l\'ultimo.');
    } catch (e) {}
    return;
  }
  if (UAD.__bootstrapped && !window.__UAD_FORCE_REINIT) return;
  UAD.__bootstrapped = true;

  // Alcuni tool arrivano tardi: consenso cookie accettato dopo 10s, tag
  // manager caricato in lazy, A/B test che inietta script. Ricontrolliamo la
  // detection a intervalli crescenti invece di un polling costante.
  var DETECT_SCHEDULE_MS = [0, 300, 1000, 2500, 5000, 10000, 20000];

  var boot = {
    startedAt: Date.now(),
    modulesOk: false,
    settingsRequested: 0,
    detectRuns: 0,
    detected: {},          // toolId -> { at, how }
    commandsReceived: 0
  };

  // ------------------------------------------------------- 1. moduli richiesti
  var REQUIRED = ['serializer', 'emitter', 'session', 'dedupe', 'netHooks', 'globalWatcher'];

  (function checkModules() {
    var missing = REQUIRED.filter(function (m) { return !UAD[m]; });
    if (missing.length) {
      // Errore visibile: senza questi il tool non funziona e l'utente deve
      // saperlo subito, non scoprirlo da un pannello vuoto.
      UAD.error('content-script',
        'moduli mancanti: ' + missing.join(', ') +
        '. Controlla che tutti i file siano presenti e nell\'ordine corretto nel manifest.');
      boot.modulesOk = false;
      return;
    }
    boot.modulesOk = true;
    UAD.log('moduli core verificati:', REQUIRED.length + '/' + REQUIRED.length);
  })();

  // ------------------------------------------- 2. richiesta settings al bridge
  /**
   * MAIN non puo leggere chrome.storage.local: deve chiedere al bridge
   * (ISOLATED). L'ordine di esecuzione tra i due world NON e' garantito, quindi
   * ripetiamo l'annuncio qualche volta. Il bridge invia anche spontaneamente:
   * chi arriva secondo trova comunque l'altro.
   */
  function announce() {
    boot.settingsRequested++;
    try {
      window.dispatchEvent(new CustomEvent(UAD.CH.READY, {
        detail: { v: UAD.VERSION, attempt: boot.settingsRequested, url: location.href }
      }));
    } catch (e) { UAD.error('content-script.announce', e); }
  }

  announce();
  [50, 200, 600, 1500].forEach(function (ms) {
    setTimeout(function () { if (!UAD.settingsReady) announce(); }, ms);
  });

  // Diagnosi esplicita: se dopo 3s i settings non sono arrivati, il bridge non
  // sta rispondendo. Senza questo messaggio il sintomo sarebbe "non succede
  // niente e non si capisce perche".
  setTimeout(function () {
    if (!UAD.settingsReady) {
      UAD.error('content-script',
        'settings non ricevuti dopo ' + boot.settingsRequested + ' tentativi: il bridge ' +
        '(world ISOLATED) non risponde. Verifica src/bridge.js nel manifest. ' +
        'Tutti gli eventi restano nel buffer e non vengono persi.');
    }
  }, 3000);

  // --------------------------------------------------- 3. comandi dal pannello
  var COMMANDS = {
    /** Richiesta di re-detection immediata (pulsante "Rileva di nuovo"). */
    redetect: function () { runDetection('comando'); },

    /** Chiude i bucket di correlazione in attesa e svuota le code. */
    flush: function () {
      if (UAD.dedupe) UAD.dedupe.flushNow();
    },

    /** Nuova sezione manuale nel pannello, senza navigare. */
    newView: function (p) {
      if (UAD.session) UAD.session.forceNewView((p && p.reason) || 'manual');
    },

    /** Stop navigazione, parte JS. Il blocco vero e' su declarativeNetRequest
     *  nel background: qui copriamo solo cio che DNR non vede. */
    setStopNavigation: function (p) { stopNav.set(!!(p && p.enabled)); },

    /** Log verboso in console della pagina. */
    setDebug: function (p) {
      UAD.settings.debug = !!(p && p.enabled);
      UAD.log('debug', UAD.settings.debug ? 'ON' : 'OFF');
    },

    /** Snapshot diagnostico verso il pannello. */
    diagnose: function () {
      try {
        window.dispatchEvent(new CustomEvent(UAD.CH.HIT, {
          detail: UAD.serialize({ __uadDiagnostics: UAD.diagnose(true) })
        }));
      } catch (e) { UAD.error('command.diagnose', e); }
    }
  };

  window.addEventListener(UAD.CH.COMMAND, function (ev) {
    UAD.safe('content-script.onCommand', function () {
      boot.commandsReceived++;
      var msg = ev && ev.detail;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { msg = null; } }
      if (!msg || !msg.cmd) return;

      var fn = COMMANDS[msg.cmd];
      if (!fn) { UAD.error('content-script', 'comando ignoto: ' + msg.cmd); return; }
      UAD.log('comando ricevuto:', msg.cmd);
      fn(msg.payload);
    })();
  }, false);

  // ------------------------------------------------- 3b. stop navigazione (JS)
  /**
   * COPERTURA REALE, dichiarata: il pre-flight ha confermato che location.href
   * NON e' patchabile e che su questo Chrome nemmeno location.assign lo e'
   * (read-only). Quindi qui copriamo solo beforeunload, window.open, submit di
   * form e click su anchor con target. Il blocco affidabile dei redirect e'
   * declarativeNetRequest, gestito dal background.
   */
  var stopNav = (function () {
    var active = false;
    var blocked = 0;
    var origOpen = window.open;

    function onBeforeUnload(e) {
      if (!active) return;
      blocked++;
      e.preventDefault();
      e.returnValue = '';   // richiesto da Chrome per mostrare il prompt
      return '';
    }

    function onSubmit(e) {
      if (!active) return;
      blocked++;
      e.preventDefault();
      e.stopPropagation();
      UAD.log('stop navigazione: submit bloccato');
    }

    function onClick(e) {
      if (!active) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return;
      blocked++;
      e.preventDefault();
      e.stopPropagation();
      UAD.log('stop navigazione: click su link bloccato ->', href);
    }

    return {
      set: function (on) {
        if (on === active) return;
        active = on;
        if (on) {
          window.addEventListener('beforeunload', onBeforeUnload, true);
          document.addEventListener('submit', onSubmit, true);
          document.addEventListener('click', onClick, true);
          try {
            window.open = function () {
              blocked++;
              UAD.log('stop navigazione: window.open bloccato');
              return null;
            };
          } catch (e) { UAD.error('stopNav.window.open', e); }
        } else {
          window.removeEventListener('beforeunload', onBeforeUnload, true);
          document.removeEventListener('submit', onSubmit, true);
          document.removeEventListener('click', onClick, true);
          try { window.open = origOpen; } catch (e) {}
        }
        UAD.log('stop navigazione (JS):', on ? 'ATTIVO' : 'disattivo');
      },
      state: function () { return { active: active, blocked: blocked }; }
    };
  })();

  // ------------------------------------------------------- 4. detection cicli
  /**
   * Chiama detect() su ogni connettore ATTIVO non ancora rilevato.
   * Un connettore rilevato riceve attach(): da quel momento gestisce i propri
   * hook. Il core non sa cosa faccia.
   */
  function runDetection(trigger) {
    if (!UAD.settingsReady) return;
    boot.detectRuns++;

    var conns = UAD.activeConnectors();
    for (var i = 0; i < conns.length; i++) {
      var c = conns[i];
      if (boot.detected[c.id]) continue;
      if (typeof c.detect !== 'function') continue;

      var found = UAD.safe('detect:' + c.id, function () { return c.detect(window); })();
      if (!found) continue;

      boot.detected[c.id] = { at: Date.now() - boot.startedAt, how: trigger };
      UAD.log('tool RILEVATO:', c.id, '(+' + boot.detected[c.id].at + 'ms, ' + trigger + ')');

      if (typeof c.attach === 'function') {
        UAD.safe('attach:' + c.id, function () { c.attach(UAD); })();
      }
    }
  }

  function scheduleDetection() {
    DETECT_SCHEDULE_MS.forEach(function (ms) {
      setTimeout(function () { UAD.safe('runDetection', runDetection)('schedule+' + ms); }, ms);
    });
  }

  // La detection puo partire solo con i settings noti: prima non sappiamo
  // quali connettori sono attivi.
  if (UAD.settingsReady) {
    scheduleDetection();
  } else {
    window.addEventListener(UAD.CH.SETTINGS, function once() {
      window.removeEventListener(UAD.CH.SETTINGS, once, false);
      UAD.safe('content-script.scheduleDetection', scheduleDetection)();
    }, false);
  }

  // Un nuovo tool attivato dai Settings a pagina aperta deve essere rilevato
  // senza costringere a un reload.
  window.addEventListener(UAD.CH.SETTINGS, function () {
    UAD.safe('content-script.redetect', function () {
      setTimeout(function () { runDetection('settings-change'); }, 0);
    })();
  }, false);

  // Una nuova view SPA puo portare tool nuovi (code splitting, lazy loading).
  if (UAD.session) {
    UAD.session.onViewChange(function () {
      setTimeout(function () { runDetection('view-change'); }, 250);
    });
  }

  // Ultimo giro quando la pagina e' completamente caricata: i tag che
  // aspettano window.load esistono e sono frequenti.
  if (document.readyState === 'complete') {
    setTimeout(function () { runDetection('readystate'); }, 0);
  } else {
    window.addEventListener('load', function () {
      setTimeout(function () { runDetection('window.load'); }, 200);
    }, false);
  }

  // --------------------------------------------------------- 5. diagnose()
  /**
   * Snapshot completo dello stato. E' l'anti-"non succede niente e non si
   * capisce perche": un solo comando in console e vedi dov'e' il blocco.
   * __UAD.diagnose()      -> stampa una tabella
   * __UAD.diagnose(true)  -> restituisce l'oggetto (usato dal pannello)
   */
  UAD.diagnose = function (asObject) {
    function isPatched(f) {
      return typeof f === 'function' && !/\[native code\]/.test(String(f));
    }

    var conns = [];
    for (var i = 0; i < UAD.connectors.length; i++) {
      var e = UAD.connectors[i];
      var d = boot.detected[e.connector.id];
      conns.push({
        id: e.connector.id,
        label: e.connector.label || '',
        attivo: e.active,
        rilevato: d ? ('si, +' + d.at + 'ms (' + d.how + ')') : 'no'
      });
    }

    var data = {
      versione: UAD.VERSION,
      uptimeMs: Date.now() - boot.startedAt,
      moduliCore: boot.modulesOk ? 'ok' : 'MANCANTI',
      settingsRicevuti: UAD.settingsReady,
      tentativiAnnuncio: boot.settingsRequested,
      comandiRicevuti: boot.commandsReceived,
      cicliDetection: boot.detectRuns,
      connettori: conns,
      sessione: UAD.session ? UAD.session.info() : null,
      spa: UAD.session ? UAD.session.isSpa() : null,
      hookRete: {
        fetch: isPatched(window.fetch),
        xhrSend: isPatched(XMLHttpRequest.prototype.send),
        sendBeacon: isPatched(navigator.sendBeacon),
        flagGlobale: !!window.__UAD_NET_PATCHED__
      },
      statistiche: {
        rete: UAD.netHooks ? UAD.netHooks.stats() : null,
        dedupe: UAD.dedupe ? UAD.dedupe.stats() : null,
        emitter: UAD.emitter ? UAD.emitter.stats() : null,
        globalWatcher: UAD.globalWatcher ? UAD.globalWatcher.stats() : null
      },
      stopNavigazioneJS: stopNav.state(),
      buffer: {
        globals: UAD._pending.globals.length,
        requests: UAD._pending.requests.length
      }
    };

    if (asObject) return data;

    try {
      console.log('%c UAD diagnose — ' + location.hostname + ' ',
        'background:#8b5cf6;color:#fff;font-weight:700;padding:3px 8px');
      console.table(conns);
      console.log('settings ricevuti:', data.settingsRicevuti,
                  '| hook rete:', data.hookRete,
                  '| buffer:', data.buffer);
      console.log('statistiche:', data.statistiche);
      if (!data.settingsRicevuti) {
        console.log('%c-> il bridge non risponde: nessun evento raggiunge il pannello',
          'color:#dc2626;font-weight:700');
      }
      if (!conns.some(function (c) { return c.rilevato !== 'no'; })) {
        console.log('%c-> nessun tool rilevato: normale se il sito non usa i tool attivi',
          'color:#a16207');
      }
    } catch (e) {}
    return data;
  };

  UAD.log('bootstrap completato (' + (Date.now() - boot.startedAt) + 'ms)');
})();