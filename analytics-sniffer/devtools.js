/**
 * Universal Analytics Debugger — devtools page
 *
 * RUOLO
 * Contesto invisibile che vive quanto la finestra DevTools resta aperta.
 * Tre soli compiti:
 *   1. registrare il pannello "Analytics" nella barra di DevTools
 *   2. sapere quando il pannello e' visibile (per non far lavorare a vuoto la UI)
 *   3. notificare al pannello le navigazioni REALI della tab ispezionata
 *
 * COSA NON FA — e perche
 * Non riceve eventi, non li accumula, non parla col bridge.
 * Sarebbe la scelta istintiva (questo contesto vive quanto DevTools), ma e'
 * sbagliata: gli eventi arrivano anche quando DevTools e' CHIUSO, e in quel
 * momento questo file non esiste. La persistenza sta nel background su
 * chrome.storage.local; il pannello, al primo onShown, chiede lo storico e lo
 * trova completo. Nessuna perdita, nessuna logica duplicata.
 *
 * CICLO DI VITA
 * Questo contesto viene ricreato a ogni apertura di DevTools, ma sopravvive ai
 * reload della pagina ispezionata. Il pannello invece viene creato UNA volta e
 * riusato: per questo lo stato del pannello (accordion aperti, ricerca, filtri)
 * sopravvive ai reload della pagina - requisito della specifica 6.3.
 */

'use strict';

const PANEL_TITLE = 'Analytics';
const PANEL_ICON  = 'icons/icon48.png';
const PANEL_PAGE  = 'src/panel/panel.html';

/**
 * tabId della pagina ispezionata. Serve al pannello per chiedere al background
 * i dati della tab GIUSTA: un solo background serve N pannelli.
 * Disponibile immediatamente, senza attese asincrone.
 */
const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

/**
 * Riferimento alla window del pannello. Disponibile SOLO dopo il primo
 * onShown: prima di allora il documento del pannello non esiste ancora.
 */
let panelWindow  = null;
let panelVisible = false;
let shownOnce    = false;

/**
 * Notifiche arrivate prima che il pannello esistesse. Se l'utente ricarica tre
 * volte la pagina prima di aprire il pannello, all'apertura le riceve tutte e
 * puo ricostruire le sezioni correttamente.
 */
const pendingNotices = [];
const PENDING_CAP = 20;

/** Invia un messaggio al pannello, o lo accoda se non e' ancora pronto. */
function notifyPanel(msg) {
  if (panelWindow && typeof panelWindow.__uadOnDevtoolsMessage === 'function') {
    try {
      panelWindow.__uadOnDevtoolsMessage(msg);
      return;
    } catch (e) {
      // Il pannello puo essere stato distrutto tra il check e la chiamata.
      console.error('[UAD devtools] notifyPanel', e);
      panelWindow = null;
    }
  }
  if (pendingNotices.length >= PENDING_CAP) pendingNotices.shift();
  pendingNotices.push(msg);
}

function drainPending() {
  if (!panelWindow || typeof panelWindow.__uadOnDevtoolsMessage !== 'function') return;
  while (pendingNotices.length) {
    const m = pendingNotices.shift();
    try {
      panelWindow.__uadOnDevtoolsMessage(m);
    } catch (e) {
      console.error('[UAD devtools] drainPending', e);
      // Rimettiamo in testa: il messaggio non e' stato consegnato.
      pendingNotices.unshift(m);
      break;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Creazione del pannello
   ═══════════════════════════════════════════════════════════════════════════ */

chrome.devtools.panels.create(PANEL_TITLE, PANEL_ICON, PANEL_PAGE, (panel) => {
  if (!panel) {
    console.error('[UAD devtools] creazione del pannello fallita: ' +
                  'verifica che ' + PANEL_PAGE + ' esista e sia raggiungibile.');
    return;
  }

  panel.onShown.addListener((win) => {
    panelWindow  = win;
    panelVisible = true;
    const first  = !shownOnce;
    shownOnce    = true;

    // Iniettiamo il tabId invece di far interrogare le API al pannello: parte
    // senza attese, e diventa testabile con un tabId finto.
    try { win.__uadInspectedTabId = inspectedTabId; } catch (e) {
      console.error('[UAD devtools] iniezione tabId', e);
    }

    notifyPanel({ type: 'shown', tabId: inspectedTabId, first });
    drainPending();
  });

  panel.onHidden.addListener(() => {
    panelVisible = false;
    // Il pannello puo sospendere animazioni e rendering: i dati continuano ad
    // arrivare al background, quindi nulla va perso. E' la differenza tra un
    // pannello che consuma CPU in background e uno che non lo fa.
    notifyPanel({ type: 'hidden' });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Navigazioni della tab ispezionata
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Navigazione REALE (nuovo documento). Le view SPA NON passano da qui: le
 * rileva session.js nel world MAIN via pushState, dove sono osservabili.
 * Questo evento serve al pannello per aprire una nuova sezione e segnare il
 * momento esatto del page load.
 */
chrome.devtools.network.onNavigated.addListener((url) => {
  notifyPanel({ type: 'navigated', url, ts: Date.now() });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Diagnostica
   Accessibile dalla console della devtools page: si apre con
   chrome://extensions -> Universal Analytics Debugger -> "devtools page".
   ═══════════════════════════════════════════════════════════════════════════ */

window.__UAD_DEVTOOLS_STATE__ = () => ({
  inspectedTabId,
  panelCreated:   panelWindow !== null,
  panelVisible,
  shownOnce,
  pendingNotices: pendingNotices.length
});

console.log('[UAD devtools] pannello registrato per tab ' + inspectedTabId);