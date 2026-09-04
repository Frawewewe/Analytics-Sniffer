/**
 * Analytics Sniffer — service worker (MV3)
 *
 * v2 — tre correzioni:
 *   1. GUARD su chrome.declarativeNetRequest. Con il permesso non concesso (o
 *      non ancora disponibile) l'API e' undefined, e ogni chiamata lanciava
 *      "Cannot read properties of undefined (reading 'updateSessionRules')".
 *      Ora ogni accesso passa da dnr(), che ritorna null se non disponibile.
 *   2. Guard su chrome.permissions: se un permesso non e' dichiarato,
 *      contains() lancia invece di ritornare false.
 *   3. Nome nei log allineato a "Analytics Sniffer".
 *
 * RUOLO
 * Unico punto in cui i dati diventano persistenti e in cui vivono i permessi
 * privilegiati (cookies, declarativeNetRequest). Sta in mezzo tra il bridge di
 * ogni tab e il pannello DevTools di ogni tab.
 *
 *   bridge --sendMessage--> [BACKGROUND] --port--> pannello   (live)
 *                                |
 *                          chrome.storage.local              (verita persistente)
 *
 * VINCOLO CENTRALE MV3
 * Il service worker viene SOSPESO da Chrome dopo pochi secondi di inattivita e
 * riavviato al messaggio successivo. Ogni dato tenuto in una variabile di
 * modulo viene perso silenziosamente al riavvio: e' la causa del bug
 * "il pageview sparisce nel nulla".
 * Quindi: chrome.storage.local e' l'UNICA fonte di verita. Le variabili in
 * memoria sono cache e buffer di scrittura, sempre ricostruibili.
 *
 * SCRITTURE BATCHATE
 * Scrivere sullo storage a ogni evento su un sito chiacchierone provoca
 * throttling da parte di Chrome e perdita di dati. Buffer + debounce 250ms.
 */

'use strict';

const LOG = '[Sniffer bg]';

const SETTINGS_KEY = 'uad_settings';
const TAB_PREFIX   = 'uad_tab_';
const META_KEY     = 'uad_meta';

const WRITE_DEBOUNCE_MS = 250;
const DEFAULT_MAX_EVENTS = 2000;
const DNR_RULE_BASE = 40000;      // range dedicato: non collide con altre regole

/* ═══════════════════════════════════════════════════════════════════════════
   Stato volatile — SEMPRE ricostruibile dallo storage.
   ═══════════════════════════════════════════════════════════════════════════ */
const panels      = new Map();   // tabId -> Port (pannello DevTools aperto)
const writeBuf    = new Map();   // tabId -> [event]
const writeTimer  = new Map();   // tabId -> timeoutId
const stopNavTabs = new Set();   // tabId con blocco navigazione attivo

/* ═══════════════════════════════════════════════════════════════════════════
   Accesso difensivo alle API opzionali
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * declarativeNetRequest puo essere undefined: permesso non concesso, oppure
 * API non disponibile su questa build. Accedervi direttamente lanciava
 * "Cannot read properties of undefined".
 */
function dnr() {
  try {
    const api = chrome.declarativeNetRequest;
    if (api && typeof api.updateSessionRules === 'function') return api;
    return null;
  } catch (e) {
    return null;
  }
}

/** chrome.cookies e' opzionale: undefined finche il permesso non e' concesso. */
function cookiesApi() {
  try {
    const api = chrome.cookies;
    if (api && typeof api.getAll === 'function') return api;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * contains() LANCIA se il permesso non e' dichiarato nel manifest, invece di
 * ritornare false. Va sempre protetto.
 */
async function hasPermission(name) {
  try {
    return await chrome.permissions.contains({ permissions: [name] });
  } catch (e) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Storage helpers
   ═══════════════════════════════════════════════════════════════════════════ */

function tabKey(tabId) { return TAB_PREFIX + tabId; }

async function getSettings() {
  try {
    const r = await chrome.storage.local.get([SETTINGS_KEY]);
    return r[SETTINGS_KEY] || {};
  } catch (e) {
    console.error(LOG, 'getSettings', e);
    return {};
  }
}

async function maxEventsPerTab() {
  const s = await getSettings();
  const n = s && s.limits && s.limits.maxEventsPerTab;
  return (typeof n === 'number' && n > 0) ? n : DEFAULT_MAX_EVENTS;
}

async function readTab(tabId) {
  try {
    const k = tabKey(tabId);
    const r = await chrome.storage.local.get([k]);
    return r[k] || { events: [], dropped: 0, updatedAt: 0 };
  } catch (e) {
    console.error(LOG, 'readTab ' + tabId, e);
    return { events: [], dropped: 0, updatedAt: 0 };
  }
}

/**
 * Applica il buffer allo storage. Ring buffer: oltre il cap si scartano i piu
 * vecchi, dichiarandolo in `dropped` invece di farli sparire in silenzio.
 */
async function flushTab(tabId) {
  const buf = writeBuf.get(tabId);
  writeBuf.delete(tabId);
  const t = writeTimer.get(tabId);
  if (t) { clearTimeout(t); writeTimer.delete(tabId); }
  if (!buf || !buf.length) return;

  try {
    const cap = await maxEventsPerTab();
    const cur = await readTab(tabId);
    let events = cur.events.concat(buf);
    let dropped = cur.dropped || 0;

    if (events.length > cap) {
      dropped += (events.length - cap);
      events = events.slice(events.length - cap);
    }

    await chrome.storage.local.set({
      [tabKey(tabId)]: { events, dropped, updatedAt: Date.now() }
    });
  } catch (e) {
    console.error(LOG, 'flushTab ' + tabId, e);
    // Rimettiamo in coda: un errore di scrittura non deve perdere eventi.
    const again = writeBuf.get(tabId) || [];
    writeBuf.set(tabId, buf.concat(again));
  }
}

function scheduleFlush(tabId) {
  if (writeTimer.has(tabId)) return;
  writeTimer.set(tabId, setTimeout(() => {
    flushTab(tabId).catch(e => console.error(LOG, 'scheduleFlush', e));
  }, WRITE_DEBOUNCE_MS));
}

function bufferEvents(tabId, events) {
  const buf = writeBuf.get(tabId) || [];
  writeBuf.set(tabId, buf.concat(events));
  scheduleFlush(tabId);
}

async function clearTab(tabId) {
  writeBuf.delete(tabId);
  const t = writeTimer.get(tabId);
  if (t) { clearTimeout(t); writeTimer.delete(tabId); }
  try { await chrome.storage.local.remove([tabKey(tabId)]); }
  catch (e) { console.error(LOG, 'clearTab', e); }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Ingestione dal bridge
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Gli eventi arrivano come stringhe JSON: il parsing avviene QUI, non nel world
 * MAIN, per non pagarlo nel thread della pagina.
 */
function parseEvents(raw) {
  const out = [];
  for (const s of raw) {
    try {
      out.push(typeof s === 'string' ? JSON.parse(s) : s);
    } catch (e) {
      console.error(LOG, 'evento non parsabile scartato', e);
    }
  }
  return out;
}

function forwardToPanel(tabId, events) {
  const port = panels.get(tabId);
  if (!port) return;
  try {
    port.postMessage({ type: 'uad:events', events });
  } catch (e) {
    // Pannello chiuso senza disconnect pulito.
    panels.delete(tabId);
    console.error(LOG, 'forwardToPanel: porta morta, rimossa', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    try {
      if (!msg || typeof msg !== 'object') return respond({ ok: false });

      const tabId = sender && sender.tab && sender.tab.id;

      switch (msg.type) {

        case 'uad:hits': {
          if (typeof tabId !== 'number') return respond({ ok: false, error: 'tabId assente' });
          const events = parseEvents(msg.events || []);
          if (!events.length) return respond({ ok: true, stored: 0 });

          // Prima al pannello (latenza minima), poi allo storage (verita).
          forwardToPanel(tabId, events);
          bufferEvents(tabId, events);
          return respond({ ok: true, stored: events.length });
        }

        /* ---- pannello: lettura, comandi, manutenzione ---- */

        case 'uad:getHistory': {
          const id = msg.tabId ?? tabId;
          await flushTab(id);                 // niente buchi tra buffer e storage
          const data = await readTab(id);
          return respond({ ok: true, ...data });
        }

        case 'uad:clear': {
          const id = msg.tabId ?? tabId;
          await clearTab(id);
          const p = panels.get(id);
          if (p) { try { p.postMessage({ type: 'uad:cleared' }); } catch (e) {} }
          return respond({ ok: true });
        }

        case 'uad:getSettings':
          return respond({ ok: true, settings: await getSettings() });

        case 'uad:setSettings': {
          // Il bridge di ogni tab ascolta storage.onChanged: la propagazione ai
          // world MAIN e' automatica, senza reload.
          await chrome.storage.local.set({ [SETTINGS_KEY]: msg.settings || {} });
          return respond({ ok: true });
        }

        case 'uad:command': {
          const id = msg.tabId ?? tabId;
          if (typeof id !== 'number') return respond({ ok: false, error: 'tabId assente' });
          try {
            const r = await chrome.tabs.sendMessage(id, {
              type: 'uad:command', cmd: msg.cmd, payload: msg.payload || null
            });
            return respond({ ok: true, result: r });
          } catch (e) {
            // Tipico: pagina senza content script (chrome://, PDF viewer, Web
            // Store) oppure pagina non ricaricata dopo l'installazione.
            return respond({
              ok: false,
              error: 'content script non raggiungibile: ' + (e.message || e)
            });
          }
        }

        case 'uad:ping':
          return respond({ ok: true, sw: true, ts: Date.now() });

        /* ---- stop navigazione (declarativeNetRequest) ---- */

        case 'uad:setStopNavigation':
          return respond(await setStopNavigation(msg.tabId ?? tabId, !!msg.enabled));

        case 'uad:getStopNavigation':
          return respond({
            ok: true,
            enabled: stopNavTabs.has(msg.tabId ?? tabId),
            available: !!dnr()
          });

        /* ---- cookie (permesso opzionale) ---- */

        case 'uad:listCookies':
          return respond(await listCookies(msg.url));

        case 'uad:clearCookies':
          return respond(await clearCookies(msg.url, msg.mode, msg.names));

        case 'uad:hasPermissions': {
          const list = Array.isArray(msg.permissions) ? msg.permissions : [];
          const results = {};
          for (const p of list) results[p] = await hasPermission(p);
          const all = list.every(p => results[p]);
          return respond({ ok: true, granted: all, detail: results });
        }

        default:
          return respond({ ok: false, error: 'tipo ignoto: ' + msg.type });
      }
    } catch (e) {
      console.error(LOG, 'onMessage ' + (msg && msg.type), e);
      try { respond({ ok: false, error: String(e.message || e) }); } catch (e2) {}
    }
  })();

  return true;   // risposta asincrona
});

/* ═══════════════════════════════════════════════════════════════════════════
   Porta long-lived con il pannello DevTools
   ═══════════════════════════════════════════════════════════════════════════ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'uad-panel') return;

  let boundTab = null;

  port.onMessage.addListener((msg) => {
    try {
      if (msg && msg.type === 'uad:bind' && typeof msg.tabId === 'number') {
        boundTab = msg.tabId;
        panels.set(boundTab, port);
        port.postMessage({ type: 'uad:bound', tabId: boundTab });
      }
    } catch (e) { console.error(LOG, 'port.onMessage', e); }
  });

  port.onDisconnect.addListener(() => {
    if (boundTab !== null && panels.get(boundTab) === port) panels.delete(boundTab);
    // Il buffer viene comunque scritto: i dati non dipendono dal pannello aperto.
    if (boundTab !== null) flushTab(boundTab).catch(() => {});
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Stop navigazione — declarativeNetRequest

   Il pre-flight ha confermato che location.href e location.assign NON sono
   patchabili da JavaScript: il blocco JS da solo lascia passare la maggior
   parte dei redirect. DNR e' l'unica copertura affidabile.
   ═══════════════════════════════════════════════════════════════════════════ */

async function setStopNavigation(tabId, enabled) {
  if (typeof tabId !== 'number') return { ok: false, error: 'tabId assente' };

  const api = dnr();
  if (!api) {
    // Onesta verso l'utente: non attiviamo una funzione a copertura parziale
    // facendole credere di essere completa.
    return {
      ok: false,
      available: false,
      error: 'declarativeNetRequest non disponibile: verifica che il permesso sia ' +
             'dichiarato nel manifest e ricarica l\'estensione'
    };
  }

  const ruleId = DNR_RULE_BASE + (tabId % 10000);

  try {
    if (enabled) {
      await api.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: { type: 'block' },
          condition: {
            tabIds: [tabId],
            resourceTypes: ['main_frame', 'sub_frame']
          }
        }]
      });
      stopNavTabs.add(tabId);
    } else {
      await api.updateSessionRules({ removeRuleIds: [ruleId] });
      stopNavTabs.delete(tabId);
    }

    // La parte JS (beforeunload, window.open, submit, click) copre cio che DNR
    // non vede. Le due difese sono complementari.
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'uad:command', cmd: 'setStopNavigation', payload: { enabled }
      });
    } catch (e) { /* pagina senza content script: DNR agisce comunque */ }

    return { ok: true, enabled, available: true };
  } catch (e) {
    console.error(LOG, 'setStopNavigation', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Cookie — permesso opzionale

   Solo qui si possono vedere i cookie HttpOnly, invisibili a document.cookie.
   ═══════════════════════════════════════════════════════════════════════════ */

const ANALYTICS_COOKIE_PATTERNS = [
  /^_ga$/, /^_ga_/, /^_gid$/, /^_gat/, /^_gcl_/, /^_gac_/, /^FPID$/, /^FPLC$/,
  /^s_cc$/, /^s_sq$/, /^s_vi$/, /^s_fid$/, /^s_nr/, /^s_ppv$/, /^gpv/, /^s_depth$/,
  /^AMCV_/, /^AMCVS_/, /^kndctr_/, /^demdex$/, /^mbox/, /^at_check$/,
  /^_fbp$/, /^_fbc$/, /^_ttp$/, /^_tt_enable_cookie$/,
  /^_uetsid/, /^_uetvid/, /^_clck$/, /^_clsk$/, /^utag_/, /^_hj/
];

function isAnalyticsCookie(name) {
  return ANALYTICS_COOKIE_PATTERNS.some(re => re.test(name));
}

async function listCookies(url) {
  const api = cookiesApi();
  if (!api) {
    return { ok: false, error: 'permesso cookies non concesso', needsPermission: true };
  }
  if (!url) return { ok: false, error: 'url assente' };

  try {
    const all = await api.getAll({ url });
    return {
      ok: true,
      cookies: all.map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        session: c.session,
        expirationDate: c.expirationDate || null,
        partitionKey: c.partitionKey || null,
        isAnalytics: isAnalyticsCookie(c.name)
      }))
    };
  } catch (e) {
    console.error(LOG, 'listCookies', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * @param {string} mode 'analytics' | 'all' | 'named'
 *
 * NOTA: partitionKey va passato a remove(), altrimenti i cookie CHIPS restano
 * e sembra che il clear non abbia funzionato.
 */
async function clearCookies(url, mode, names) {
  const api = cookiesApi();
  if (!api) {
    return { ok: false, error: 'permesso cookies non concesso', needsPermission: true };
  }
  if (!url) return { ok: false, error: 'url assente' };

  try {
    const all = await api.getAll({ url });
    const nameSet = Array.isArray(names) ? new Set(names) : null;

    const target = all.filter(c => {
      if (mode === 'all') return true;
      if (mode === 'named') return nameSet ? nameSet.has(c.name) : false;
      return isAnalyticsCookie(c.name);
    });

    let removed = 0;
    const failed = [];

    for (const c of target) {
      // L'url per remove() deve riflettere domain e secure del COOKIE, non
      // quello della pagina: altrimenti i cookie di dominio padre non vengono
      // trovati.
      const scheme = c.secure ? 'https://' : 'http://';
      const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      const removeUrl = scheme + host + c.path;

      try {
        const details = { url: removeUrl, name: c.name };
        if (c.partitionKey) details.partitionKey = c.partitionKey;
        const r = await api.remove(details);
        r ? removed++ : failed.push(c.name);
      } catch (e) {
        failed.push(c.name);
        console.error(LOG, 'remove cookie ' + c.name, e);
      }
    }

    return { ok: true, removed, attempted: target.length, failed };
  } catch (e) {
    console.error(LOG, 'clearCookies', e);
    return { ok: false, error: String(e.message || e) };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Manutenzione
   ═══════════════════════════════════════════════════════════════════════════ */

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId).catch(() => {});
  panels.delete(tabId);
  stopNavTabs.delete(tabId);

  const api = dnr();
  if (!api) return;
  const ruleId = DNR_RULE_BASE + (tabId % 10000);
  api.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
});

/**
 * Purge all'avvio del service worker. Senza questo, i dati di tab chiuse
 * mentre il worker era sospeso restano nello storage per sempre, e a un certo
 * punto l'estensione smette di funzionare in modo misterioso.
 */
async function purgeOrphanTabs() {
  try {
    const [all, tabs] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.tabs.query({})
    ]);
    const live = new Set(tabs.map(t => String(t.id)));
    const dead = Object.keys(all)
      .filter(k => k.startsWith(TAB_PREFIX))
      .filter(k => !live.has(k.slice(TAB_PREFIX.length)));

    if (dead.length) {
      await chrome.storage.local.remove(dead);
      console.log(LOG, 'purge: rimosse ' + dead.length + ' tab orfane');
    }

    const prev = all[META_KEY] || {};
    await chrome.storage.local.set({
      [META_KEY]: { lastPurge: Date.now(), swStarts: (prev.swStarts || 0) + 1 }
    });
  } catch (e) {
    console.error(LOG, 'purgeOrphanTabs', e);
  }
}

purgeOrphanTabs();

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(LOG, 'onInstalled: ' + details.reason);

  // Le regole di sessione muoiono da sole alla chiusura di Chrome, ma dopo un
  // aggiornamento e' piu sicuro azzerare il nostro range.
  const api = dnr();
  if (api) {
    try {
      const rules = await api.getSessionRules();
      const mine = rules
        .filter(r => r.id >= DNR_RULE_BASE && r.id < DNR_RULE_BASE + 10000)
        .map(r => r.id);
      if (mine.length) await api.updateSessionRules({ removeRuleIds: mine });
    } catch (e) {
      console.error(LOG, 'pulizia regole DNR', e);
    }
  }

  purgeOrphanTabs();
});

console.log(LOG, 'service worker avviato — Analytics Sniffer');