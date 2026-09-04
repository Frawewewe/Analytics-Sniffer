/**
 * Analytics Sniffer — orchestratore del pannello DevTools
 * Contesto: pagina di estensione (src/panel/panel.html), ES module
 *
 * v3 — cinque modifiche:
 *   1. autoListener: con rilevamento manuale le tab dipendono SOLO dalle spunte
 *      nei Settings. Risolve il caso "GTM non riesco a disattivarlo", dove il
 *      toggle fermava lo sniffing ma la tab restava perche i suoi eventi erano
 *      gia in memoria.
 *   2. identity index caricato AUTOMATICAMENTE quando cookieCrossCheck e'
 *      attiva: prima si costruiva solo aprendo il drawer cookie, quindi il
 *      cross-check non compariva mai se non lo si apriva.
 *   3. categorie viste negli eventi inoltrate ai Settings, che le rende
 *      configurabili anche se introdotte da un connettore nuovo.
 *   4. crossCheckVersion nella firma di rendering: quando l'identity index
 *      cambia, i corpi degli eventi gia costruiti si aggiornano.
 *   5. rimosso il controllo su ui.showToolbarIcons: le icone seguono la
 *      feature corrispondente, senza doppio livello.
 *
 * FLUSSO DEI DATI
 *   background --port 'uad-panel'--> panel          eventi live
 *   background <--sendMessage------- panel          storico, comandi, settings
 *   devtools.js --__uadOnDevtoolsMessage--> panel   shown/hidden/navigated
 *
 * PRINCIPIO DI RENDERING
 * Dati (store) e stato della UI (state.js) sono strutture SEPARATE. Il render
 * legge sempre lo stato: e' l'unico motivo per cui l'arrivo di un evento o il
 * toggle di un'opzione non richiude gli accordion aperti dall'utente.
 *
 * GESTIONE DEGLI EVENTI DOM
 * Delega su contenitori stabili, non un listener per nodo: con 2000 eventi x 3
 * livelli, migliaia di closure ricreate a ogni render sarebbero un memory leak.
 */

'use strict';

import { createState }    from './state.js';
import { createRenderer } from './render.js';
import { createSearch }   from './search.js';
import { createFilters }  from './filters.js';
import { createTheme }    from './theme.js';
import { initSettings }   from './settings.js';
import { initCookies }    from './cookies.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Metadati dei tool
   Un connettore ignoto genera label e colore dal proprio id: aggiungere un
   plugin non richiede di toccare questo file.
   ═══════════════════════════════════════════════════════════════════════════ */

const TOOL_META = {
  'ga4':          { label: 'GA4',           color: '#e8710a' },
  'gtm':          { label: 'GTM',           color: '#4285f4' },
  'adobe-legacy': { label: 'Adobe AA',      color: '#fa0f00' },
  'adobe-aep':    { label: 'Adobe Web SDK', color: '#c9252d' },
  'generic':      { label: 'Altri tool',    color: '#6b7280' }
};

function toolMeta(id) {
  if (TOOL_META[id]) return TOOL_META[id];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return {
    label: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    color: `hsl(${h} 65% 45%)`
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Stato
   ═══════════════════════════════════════════════════════════════════════════ */

const store = {
  events:  [],
  byTool:  new Map(),
  seenIds: new Set(),      // storico e live si sovrappongono
  categories: new Set(),   // categorie viste: alimentano i Settings
  dropped: 0
};

const ui = {
  tabId:        null,
  activeTool:   null,
  showAll:      false,
  visible:      true,
  connected:    false,
  settings:     {},
  identityIndex: null,     // dai cookie, per il cross-check
  crossCheckVersion: 0,    // cambia quando l'index si aggiorna
  knownIds:     [],        // id accordion presenti: collapseAll e gc
  renderQueued: false,
  bootDone:     false
};

/* ═══════════════════════════════════════════════════════════════════════════
   DOM
   ═══════════════════════════════════════════════════════════════════════════ */

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ═══════════════════════════════════════════════════════════════════════════
   Toast, banner, clipboard
   ═══════════════════════════════════════════════════════════════════════════ */

let toastTimer = null;

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function banner(text, actionLabel, onAction) {
  $('#banner-text').textContent = text;
  const btn = $('#banner-action');
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.hidden = false;
    btn.onclick = () => { hideBanner(); onAction && onAction(); };
  } else {
    btn.hidden = true;
  }
  $('#banner').hidden = false;
}

function hideBanner() { $('#banner').hidden = true; }

async function copyToClipboard(text, label = 'Copiato') {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    toast(label, 1400);
  } catch (e) {
    console.error('[Sniffer panel] clipboard', e);
    toast('Copia non riuscita');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Comunicazione col background
   ═══════════════════════════════════════════════════════════════════════════ */

let port = null;

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ ...msg, tabId: msg.tabId ?? ui.tabId }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error('[Sniffer panel] sendMessage ' + msg.type + ':', err.message);
          resolve({ ok: false, error: err.message });
          return;
        }
        resolve(resp || { ok: false });
      });
    } catch (e) {
      console.error('[Sniffer panel] sendMessage throw', e);
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'uad-panel' });
    ui.connected = true;

    port.onMessage.addListener((msg) => {
      try {
        if (!msg) return;
        if (msg.type === 'uad:events')  { ingest(msg.events, true); return; }
        if (msg.type === 'uad:cleared') { resetStore(); scheduleRender(); return; }
        if (msg.type === 'uad:bound')   { hideBanner(); return; }
      } catch (e) { console.error('[Sniffer panel] port.onMessage', e); }
    });

    port.onDisconnect.addListener(() => {
      ui.connected = false;
      // Il service worker MV3 si sospende: la disconnessione e' NORMALE e non
      // va segnalata come errore. Riconnettiamo al volo.
      setTimeout(() => { if (!ui.connected) connectPort(); }, 300);
    });

    port.postMessage({ type: 'uad:bind', tabId: ui.tabId });
  } catch (e) {
    ui.connected = false;
    console.error('[Sniffer panel] connect', e);
    banner('Connessione al service worker non riuscita.', 'Riprova', connectPort);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Moduli
   ═══════════════════════════════════════════════════════════════════════════ */

const uiState = createState({ tabId: null });   // tabId assegnato nel boot

const renderer = createRenderer({
  toolMeta,
  state: uiState,
  categoryOpen: (cat) => {
    // Le categorie non configurate nascono aperte: un connettore nuovo resta
    // leggibile senza dover aggiungere nulla ai settings.
    const cs = ui.settings.categoryState || {};
    return Object.prototype.hasOwnProperty.call(cs, cat) ? cs[cat] === true : true;
  },
  crossCheck: (key, value) => {
    if (!ui.settings.features?.cookieCrossCheck) return null;
    if (!cookiesMod || !ui.identityIndex) return null;
    return cookiesMod.crossCheck(key, value, ui.identityIndex);
  }
});

const search = createSearch({
  state: uiState,
  getEvents: () => store.byTool.get(ui.activeTool) || [],
  displayValue: renderer.displayValue,
  onChange: () => scheduleRender()
});

const filters = createFilters({
  state: uiState,
  displayValue: renderer.displayValue,
  onChange: () => scheduleRender(),
  toast
});

const theme = createTheme({
  getSettings: () => ui.settings,
  patchSettings,
  toast
});

let settingsMod = null;   // creati nel boot: dipendono dai settings caricati
let cookiesMod  = null;

/* ═══════════════════════════════════════════════════════════════════════════
   Predicato di visibilita
   ═══════════════════════════════════════════════════════════════════════════ */

function matchesEvent(ev) {
  return search.matches(ev, search.query) && filters.matches(ev);
}

function isFiltering() {
  return search.isActive || filters.isActive;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Ingestione
   ═══════════════════════════════════════════════════════════════════════════ */

function eventKey(ev) {
  return `${ev.toolId}|${ev.seq}|${ev.timestamp}|${ev.viewId || ''}`;
}

function resetStore() {
  store.events = [];
  store.byTool = new Map();
  store.seenIds = new Set();
  store.categories = new Set();
  store.dropped = 0;
  search.clearNewMatches();
  uiState.gc(new Set());          // niente id validi: pulizia totale
}

function ingest(events, live) {
  if (!Array.isArray(events) || !events.length) return;
  let added = 0;
  let newCategory = false;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;

    // Risposta al comando "diagnose": non e' un evento di tracking.
    if (ev.__uadDiagnostics) { showDiagnostics(ev.__uadDiagnostics); continue; }

    const k = eventKey(ev);
    if (store.seenIds.has(k)) continue;
    store.seenIds.add(k);

    ev.__id = k;
    ev.__live = !!live;
    store.events.push(ev);

    if (!store.byTool.has(ev.toolId)) store.byTool.set(ev.toolId, []);
    store.byTool.get(ev.toolId).push(ev);

    // Le categorie viste alimentano la lista configurabile nei Settings.
    for (const cat of Object.keys(ev.categorizedFields || {})) {
      if (!store.categories.has(cat)) { store.categories.add(cat); newCategory = true; }
    }

    added++;
    if (live) search.noteLiveEvent(ev);
  }

  if (!added) return;

  // Ordine cronologico: le request con body letto in modo asincrono (Blob,
  // stream) possono arrivare fuori sequenza.
  store.events.sort((a, b) => a.timestamp - b.timestamp);
  for (const [, list] of store.byTool) list.sort((a, b) => a.timestamp - b.timestamp);

  if (!ui.activeTool) ui.activeTool = visibleTools()[0] || null;

  if (settingsMod) {
    settingsMod.notifyDetected(
      Array.from(store.byTool.keys()),
      newCategory ? Array.from(store.categories) : null
    );
  }

  scheduleRender();
}

async function loadHistory() {
  const r = await send({ type: 'uad:getHistory' });
  if (!r.ok) { console.error('[Sniffer panel] getHistory', r.error); return; }
  store.dropped = r.dropped || 0;
  ingest(r.events || [], false);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Quali tab mostrare
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Con rilevamento automatico (default) mostriamo ogni tool che ha prodotto
 * eventi, anche se poi e' stato disattivato: i dati raccolti restano
 * consultabili.
 *
 * Con rilevamento manuale mostriamo SOLO i tool spuntati nei Settings. E' cio
 * che permette di far scomparire la tab di un tool disattivato senza dover
 * svuotare i dati — il caso "GTM non riesco a disattivarlo".
 */
function visibleTools() {
  const auto = ui.settings.autoListener !== false;
  const enabled = ui.settings.tools || {};

  const withEvents = Array.from(store.byTool.keys())
    .filter(t => (store.byTool.get(t) || []).length);

  const present = auto
    ? withEvents
    : withEvents.filter(t => enabled[t] === true);

  const order = Array.isArray(ui.settings.toolOrder) ? ui.settings.toolOrder : [];
  const inOrder = order.filter(t => present.includes(t));
  const rest = present.filter(t => !inOrder.includes(t)).sort();
  return inOrder.concat(rest);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Rendering
   ═══════════════════════════════════════════════════════════════════════════ */

function scheduleRender() {
  if (ui.renderQueued) return;
  ui.renderQueued = true;
  requestAnimationFrame(() => { ui.renderQueued = false; render(); });
}

function render() {
  if (!ui.visible) return;   // pannello nascosto: nessun lavoro inutile

  const ids = visibleTools();

  // Se il tool attivo non e' piu visibile (disattivato, clear, filtro),
  // passiamo al primo disponibile.
  if (ui.activeTool && !ids.includes(ui.activeTool)) ui.activeTool = ids[0] || null;
  if (!ui.activeTool && ids.length) ui.activeTool = ids[0];

  const tools = ids.map(id => {
    const list = store.byTool.get(id) || [];
    return {
      id,
      total: list.length,
      shown: list.filter(matchesEvent).length,
      hasLive: list.some(e => e.__live),
      // Tool con eventi ma ora disattivato: la tab lo dichiara, invece di
      // mostrare dati che non si aggiornano piu senza spiegazione.
      stale: ui.settings.tools?.[id] !== true
    };
  });

  const ctx = {
    search:      search.query,
    showAll:     ui.showAll,
    showDevRefs: ui.settings.features?.devReferences === true,
    activeTool:  ui.activeTool,
    filtering:   isFiltering(),
    crossCheckVersion: ui.crossCheckVersion
  };

  renderer.renderTabs($('#tabs'), tools, ctx);

  const events = (store.byTool.get(ui.activeTool) || []).filter(matchesEvent);
  const info = renderer.renderPane($('#panes'), events, ctx);

  ui.knownIds = info.ids;
  search.setMatches(renderer.collectMatches($('#panes')));
  uiState.maybeAutoGc(new Set(info.ids));

  renderEmptyStates(tools.length > 0, info.events > 0);
}

function renderEmptyStates(hasTools, hasVisible) {
  const filtering = isFiltering();
  $('#empty-no-tools').hidden  = hasTools;
  $('#empty-no-events').hidden = !hasTools || hasVisible || filtering;
  $('#empty-no-match').hidden  = !filtering || hasVisible;
}

function showDiagnostics(data) {
  const out = $('#diagnostics-output');
  out.hidden = false;
  $('#btn-diagnose')?.setAttribute('aria-expanded', 'true');
  try { out.textContent = JSON.stringify(data, null, 2); }
  catch { out.textContent = String(data); }
  openDrawer('#settings-drawer', '#btn-settings');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Settings
   ═══════════════════════════════════════════════════════════════════════════ */

async function loadSettings() {
  const r = await send({ type: 'uad:getSettings' });
  ui.settings = (r.ok && r.settings) || {};
  applySettingsToUI();
}

/**
 * Solo cio che riguarda la toolbar: il resto lo gestisce settings.js.
 * Un solo flag per funzione controlla comportamento E icona: nessun doppio
 * livello di visibilita.
 */
function applySettingsToUI() {
  const f = ui.settings.features || {};

  $('#btn-cookies').hidden = f.cookieInspector !== true;
  $('#btn-stopnav').hidden = f.stopNavigation !== true;

  ui.showAll = ui.settings.ui?.showAllFields === true;
  $('#btn-showall').setAttribute('aria-pressed', String(ui.showAll));

  uiState.applySettings(ui.settings);

  // Il cross-check ha bisogno dell'indice identity dai cookie. Caricandolo qui,
  // i marker compaiono senza dover aprire il drawer: era il difetto della v2.
  if (f.cookieCrossCheck === true && cookiesMod && !ui.identityIndex) {
    cookiesMod.loadIdentityOnly();
  }
}

/**
 * Merge profondo locale, poi persistenza. Il background scrive su
 * chrome.storage.local e il bridge di ogni tab propaga ai world MAIN: nessun
 * reload necessario.
 * @param {boolean} replace true = sostituisce (usato dal reset)
 */
async function patchSettings(patch, replace) {
  if (replace) {
    ui.settings = patch || {};
  } else {
    const next = structuredClone(ui.settings || {});
    const deep = (dst, src) => {
      for (const k of Object.keys(src || {})) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
          dst[k] = deep(dst[k] || {}, src[k]);
        } else dst[k] = src[k];
      }
      return dst;
    };
    ui.settings = deep(next, patch);
  }

  applySettingsToUI();
  await send({ type: 'uad:setSettings', settings: ui.settings });
  scheduleRender();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Drawer
   ═══════════════════════════════════════════════════════════════════════════ */

function openDrawer(sel, btnSel) {
  $$('.uad-drawer').forEach(d => { d.hidden = true; });
  $$('.uad-btn[aria-controls]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  $(sel).hidden = false;
  if (btnSel) $(btnSel).setAttribute('aria-expanded', 'true');
}

function toggleDrawer(sel, btnSel) {
  const wasClosed = $(sel).hidden;
  $$('.uad-drawer').forEach(d => { d.hidden = true; });
  $$('.uad-btn[aria-controls]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  if (wasClosed) {
    $(sel).hidden = false;
    if (btnSel) $(btnSel).setAttribute('aria-expanded', 'true');
  }
  return wasClosed;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Delega degli eventi
   Due listener per tutto il pannello, invece di uno per nodo.
   ═══════════════════════════════════════════════════════════════════════════ */

function bindDelegation() {
  $('#panes').addEventListener('click', (e) => {
    // 1. toggle di un accordion (view, evento, gruppo)
    const toggle = e.target.closest('[data-toggle-id]');
    if (toggle) {
      const dflt = toggle.dataset.defaultOpen;
      uiState.toggle(
        toggle.dataset.toggleId,
        dflt === undefined ? undefined : dflt === 'true'
      );
      return;
    }

    // 2. click-to-copy su un valore
    const val = e.target.closest('[data-copy]');
    if (val) { copyToClipboard(val.dataset.copy); return; }

    // 3. tooltip della variabile sorgente
    const info = e.target.closest('[data-src]');
    if (info) { toast('sorgente: ' + info.dataset.src, 3200); return; }

    // 4. dev reference: copia url + timestamp
    const dr = e.target.closest('[data-devref]');
    if (dr && dr.dataset.eventId) {
      const ev = store.events.find(x => x.__id === dr.dataset.eventId);
      if (ev) {
        copyToClipboard(
          `${ev.viewUrl || ev.pageUrl}\n${new Date(ev.timestamp).toISOString()}`,
          'URL e timestamp copiati: cercali nel tab Network'
        );
      }
    }
  });

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tool-id]');
    if (!tab) return;
    ui.activeTool = tab.dataset.toolId;
    search.clearNewMatches();
    scheduleRender();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Toolbar
   ═══════════════════════════════════════════════════════════════════════════ */

function bindToolbar() {
  // Refresh e Clear sono azioni DISTINTE: nessuna ambiguita.
  $('#btn-refresh').addEventListener('click', () => {
    try { chrome.devtools.inspectedWindow.reload({}); }
    catch (e) { console.error('[Sniffer panel] reload', e); toast('Reload non disponibile'); }
  });

  $('#btn-clear').addEventListener('click', async () => {
    const r = await send({ type: 'uad:clear' });
    if (r.ok) { resetStore(); scheduleRender(); toast('Dati svuotati'); }
    else toast('Errore: ' + (r.error || ''));
  });

  $('#btn-collapse').addEventListener('click', () => {
    // collapseAll richiede la lista degli id: svuotare lo stato non basta,
    // perche i default riaprirebbero view e gruppi.
    uiState.collapseAll(ui.knownIds);
  });

  $('#btn-export').addEventListener('click', () => {
    try {
      const payload = {
        tool: 'Analytics Sniffer 0.2.0',
        exportedAt: new Date().toISOString(),
        url: store.events.length ? (store.events[store.events.length - 1].pageUrl || null) : null,
        tabId: ui.tabId,
        droppedByRingBuffer: store.dropped,
        totalEvents: store.events.length,
        activeFilters: filters.rules,
        searchQuery: search.query || null,
        events: store.events.map(({ __id, __live, ...rest }) => rest)
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sniffer-export-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Esportati ${store.events.length} eventi`);
    } catch (e) {
      console.error('[Sniffer panel] export', e);
      toast('Export non riuscito');
    }
  });

  $('#btn-showall').addEventListener('click', () => {
    ui.showAll = !ui.showAll;
    $('#btn-showall').setAttribute('aria-pressed', String(ui.showAll));
    // NOTA: non azzeriamo lo stato degli accordion. Il toggle non deve
    // richiudere cio che l'utente aveva aperto.
    patchSettings({ ui: { showAllFields: ui.showAll } });
  });

  $('#btn-reset-search').addEventListener('click', () => {
    search.reset();
    filters.reset();
  });

  // Drawer
  $('#btn-settings').addEventListener('click', () => {
    const opened = toggleDrawer('#settings-drawer', '#btn-settings');
    // Le categorie viste possono essere cambiate mentre il drawer era chiuso.
    if (opened && settingsMod) settingsMod.render();
  });
  $('#settings-close').addEventListener('click', () => { $('#settings-drawer').hidden = true; });
  $('#link-settings-1').addEventListener('click', () => {
    openDrawer('#settings-drawer', '#btn-settings');
    if (settingsMod) settingsMod.render();
  });

  $('#btn-cookies').addEventListener('click', () => {
    const opened = toggleDrawer('#cookies-drawer', '#btn-cookies');
    if (opened && cookiesMod) cookiesMod.load();
  });
  $('#cookies-close').addEventListener('click', () => { $('#cookies-drawer').hidden = true; });

  // Stop navigazione: declarativeNetRequest e' obbligatorio nel manifest
  // (Chrome non lo ammette tra i permessi opzionali), quindi nessuna richiesta.
  $('#btn-stopnav').addEventListener('click', async () => {
    const btn = $('#btn-stopnav');
    const on = btn.getAttribute('aria-pressed') !== 'true';
    const r = await send({ type: 'uad:setStopNavigation', enabled: on });

    if (!r.ok) {
      if (r.available === false) {
        banner('Blocco navigazione non disponibile: ricarica l\'estensione da ' +
               'chrome://extensions e riprova.');
      } else {
        toast('Errore: ' + (r.error || 'blocco non applicato'));
      }
      return;
    }

    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
    $('#stopnav-dot').hidden = !on;
    toast(on
      ? 'Navigazione bloccata: i redirect non partiranno'
      : 'Navigazione libera');
  });

  $('#banner-close').addEventListener('click', hideBanner);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = $$('.uad-drawer').find(d => !d.hidden);
      if (open) {
        open.hidden = true;
        $$('.uad-btn[aria-controls]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Messaggi da devtools.js
   ═══════════════════════════════════════════════════════════════════════════ */

window.__uadOnDevtoolsMessage = (msg) => {
  try {
    if (!msg) return;

    switch (msg.type) {
      case 'shown':
        ui.visible = true;
        if (typeof msg.tabId === 'number') ui.tabId = msg.tabId;
        // DevTools non emette eventi al cambio di tema: lo rileviamo qui.
        theme.refreshDevtoolsTheme();
        if (msg.first) loadHistory();
        scheduleRender();
        break;

      case 'hidden':
        // Rendering sospeso: i dati continuano ad arrivare al background.
        ui.visible = false;
        break;

      case 'navigated':
        // La nuova view arriva dal content script col suo viewId. Qui serve
        // ricaricare i cookie: dopo una navigazione possono essere cambiati, e
        // con essi l'indice identity del cross-check.
        if (cookiesMod) {
          if (!$('#cookies-drawer').hidden) cookiesMod.load();
          else if (ui.settings.features?.cookieCrossCheck) cookiesMod.loadIdentityOnly();
        }
        break;
    }
  } catch (e) { console.error('[Sniffer panel] onDevtoolsMessage', e); }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Avvio
   ═══════════════════════════════════════════════════════════════════════════ */

(async function boot() {
  ui.tabId = window.__uadInspectedTabId ??
             (chrome.devtools?.inspectedWindow?.tabId ?? null);

  if (typeof ui.tabId !== 'number') {
    banner('tabId della pagina ispezionata non disponibile: riapri DevTools.');
    console.error('[Sniffer panel] tabId assente');
    return;
  }

  uiState.setTabId(ui.tabId);

  bindToolbar();
  bindDelegation();
  connectPort();

  // 1. Settings PRIMA di tutto: tema e visibilita icone dipendono da loro.
  await loadSettings();
  theme.init(ui.settings);

  // 2. Stato accordion e filtri persistiti, PRIMA del primo render: altrimenti
  //    si vede un frame con i default e poi un salto.
  await uiState.hydrate();
  uiState.subscribe(scheduleRender);
  await filters.hydrate();

  // 3. Moduli che dipendono dai settings caricati.
  settingsMod = initSettings({
    getSettings:   () => ui.settings,
    patchSettings,
    send,
    toast,
    banner,
    tabId: ui.tabId,
    onChange: () => { applySettingsToUI(); scheduleRender(); }
  });

  cookiesMod = initCookies({
    send,
    toast,
    banner,
    copyToClipboard,
    getSettings: () => ui.settings,
    requestPermissions: (feature) => settingsMod.requestPermissions(feature),
    tabId: ui.tabId,
    onIdentityIndex: (idx) => {
      // Il cross-check nelle righe key-value usa questo indice. Incrementare
      // crossCheckVersion fa ricostruire i corpi degli eventi gia aperti.
      ui.identityIndex = idx;
      ui.crossCheckVersion++;
      scheduleRender();
    }
  });

  // 4. Se il cross-check e' attivo, l'indice serve subito: senza questo i marker
  //    comparirebbero solo dopo aver aperto il drawer cookie.
  if (ui.settings.features?.cookieCrossCheck === true) {
    cookiesMod.loadIdentityOnly();
  }

  // 5. Dati.
  await loadHistory();
  scheduleRender();

  ui.bootDone = true;

  // Se non arriva nulla, la causa piu probabile e' che la pagina fosse gia
  // aperta all'installazione: i content script si iniettano solo al load.
  setTimeout(() => {
    if (!store.events.length) {
      $('#empty-diagnostics').textContent =
        'Se il sito usa analytics ma non vedi nulla: ricarica la pagina — i content ' +
        'script si iniettano solo al caricamento del documento. Usa "Diagnostica" ' +
        'nelle Impostazioni per verificare hook e connettori rilevati.';
    }
  }, 2500);

  console.log('[Sniffer panel] pronto per tab ' + ui.tabId);
})();