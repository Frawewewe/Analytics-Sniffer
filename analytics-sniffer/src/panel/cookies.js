/**
 * Analytics Sniffer — pannello Cookie
 * Contesto: pagina di estensione (panel), ES module
 *
 * v2 — aggiunto loadIdentityOnly(): costruisce l'indice identity per il
 *      cross-check SENZA toccare la UI del drawer.
 *
 * PERCHE SERVE
 * Il cross-check cookie/hit marca le righe con 🔗 o ⚠️ confrontando cid,
 * sessione ed ECID con i cookie. L'indice si costruiva solo dentro load(), che
 * disegna anche la lista: quindi i marker comparivano soltanto dopo aver aperto
 * il drawer. panel.js chiamava loadIdentityOnly() — che non esisteva.
 *
 * RESPONSABILITA
 *   - lista dei cookie del dominio ispezionato, HttpOnly inclusi
 *   - cancellazione a tre livelli, con clear + reload in un clic
 *   - indice identity per il cross-check nelle righe degli eventi
 *
 * PERCHE PASSA DAL BACKGROUND
 * document.cookie non vede i cookie HttpOnly, e il pannello DevTools non ha
 * accesso diretto ai cookie della pagina ispezionata. L'unico contesto con
 * chrome.cookies e' il service worker: qui costruiamo solo la UI.
 *
 * PERCHE ESISTE IL LIVELLO "+ storage"
 * Cancellare i soli cookie spesso NON resetta l'utente: Adobe Web SDK tiene
 * l'ECID anche in localStorage (kndctr_*_identity, com.adobe.reactor.*), quindi
 * l'identity si rigenera identica e il clear sembra non aver funzionato.
 *
 * IL VALORE DEL CROSS-CHECK
 * Il caso in cui i valori NON corrispondono e' quello che vale: significa utente
 * contato due volte, sessioni spezzate, attribuzione rotta. E' un bug reale e
 * difficilissimo da vedere a mano.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Pattern dei cookie di analytics
   ═══════════════════════════════════════════════════════════════════════════ */

const COOKIE_GROUPS = [
  { vendor: 'Google Analytics 4', color: '#e8710a',
    patterns: [/^_ga$/, /^_ga_/, /^_gid$/, /^_gat/, /^FPID$/, /^FPLC$/] },
  { vendor: 'Google Ads',         color: '#4285f4',
    patterns: [/^_gcl_/, /^_gac_/, /^_gcl_au$/] },
  { vendor: 'Adobe Analytics',    color: '#fa0f00',
    patterns: [/^s_cc$/, /^s_sq$/, /^s_vi$/, /^s_fid$/, /^s_nr/, /^s_ppv$/,
               /^gpv/, /^s_depth$/] },
  { vendor: 'Adobe Identity',     color: '#c9252d',
    patterns: [/^AMCV_/, /^AMCVS_/, /^kndctr_/, /^demdex$/] },
  { vendor: 'Adobe Target',       color: '#e34850',
    patterns: [/^mbox/, /^at_check$/] },
  { vendor: 'Meta',               color: '#0866ff',
    patterns: [/^_fbp$/, /^_fbc$/] },
  { vendor: 'TikTok',             color: '#000000',
    patterns: [/^_ttp$/, /^_tt_enable_cookie$/] },
  { vendor: 'Microsoft',          color: '#0078d4',
    patterns: [/^_uetsid/, /^_uetvid/, /^_clck$/, /^_clsk$/, /^MUID$/] },
  { vendor: 'Tealium',            color: '#0891b2',
    patterns: [/^utag_/] },
  { vendor: 'Hotjar',             color: '#fd3a5c',
    patterns: [/^_hj/] },
  { vendor: 'LinkedIn',           color: '#0a66c2',
    patterns: [/^li_/, /^bcookie$/, /^lidc$/, /^UserMatchHistory$/] },
  { vendor: 'Consent',            color: '#6366f1',
    patterns: [/^OptanonConsent$/, /^OptanonAlertBoxClosed$/, /^CookieConsent$/,
               /^euconsent/, /^usprivacy$/, /^didomi_token$/] }
];

/** Chiavi di localStorage che tengono identity: il clear dei cookie non basta. */
const STORAGE_IDENTITY_PATTERNS = [
  /adobe/i, /kndctr/i, /alloy/i, /AMCV/i, /ecid/i, /mbox/i,
  /^_ga/i, /^utag/i, /demdex/i, /^com\.adobe\.reactor/i
];

function vendorOf(name) {
  for (const g of COOKIE_GROUPS) {
    if (g.patterns.some(re => re.test(name))) return g;
  }
  return null;
}

function isAnalyticsCookie(name) {
  return vendorOf(name) !== null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Estrazione degli identificativi
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Client ID dal cookie _ga.
 * Formato: GA1.1.1575638140.1779280718 -> cid = "1575638140.1779280718"
 */
function extractGaCid(value) {
  const m = /^GA\d\.\d+\.(\d+\.\d+)$/.exec(String(value || ''));
  return m ? m[1] : null;
}

/** Session ID dal cookie _ga_<ID>: GS1.1.<sid>.<sct>... */
function extractGaSession(value) {
  const m = /^GS\d\.\d+\.(\d+)\.(\d+)/.exec(String(value || ''));
  return m ? { sid: m[1], sct: m[2] } : null;
}

/**
 * ECID dal cookie AMCV_ o kndctr_*_identity.
 *
 * LIMITE DICHIARATO: il formato di kndctr_*_identity non e' documentato da Adobe
 * e cambia tra versioni del Web SDK. Tentiamo il base64, poi cerchiamo una
 * sequenza numerica lunga. Se non troviamo nulla il cross-check ECID
 * semplicemente non compare, invece di dare un falso allarme.
 */
function extractEcid(name, value) {
  const v = String(value || '');

  if (/^AMCV_/.test(name)) {
    const m = /MCMID\|(\d+)/.exec(v);
    if (m) return m[1];
  }

  if (/_identity$/.test(name)) {
    try {
      const dec = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
      const m = /"(?:ECID|id)"\s*:\s*"?(\d{15,})/.exec(dec);
      if (m) return m[1];
    } catch (e) { /* non base64: normale su alcune varianti */ }
    const m2 = /(\d{18,})/.exec(v);
    if (m2) return m2[1];
  }

  return null;
}

/**
 * Indice identity dai cookie. Viene passato al renderer degli eventi, che marca
 * 🔗 o ⚠️ sulle righe corrispondenti.
 */
function buildIdentityIndex(cookies) {
  const idx = { gaCid: null, gaSessions: {}, ecid: null, measurementIds: [] };

  for (const c of cookies) {
    if (c.name === '_ga') {
      const cid = extractGaCid(c.value);
      if (cid) idx.gaCid = cid;
      continue;
    }
    const mid = /^_ga_([A-Z0-9]+)$/.exec(c.name);
    if (mid) {
      idx.measurementIds.push('G-' + mid[1]);
      const s = extractGaSession(c.value);
      if (s) idx.gaSessions['G-' + mid[1]] = s;
      continue;
    }
    const ecid = extractEcid(c.name, c.value);
    if (ecid && !idx.ecid) idx.ecid = ecid;
  }
  return idx;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Formattazione
   ═══════════════════════════════════════════════════════════════════════════ */

function fmtExpiry(c) {
  if (c.session) return 'sessione';
  if (!c.expirationDate) return '—';
  const ms = c.expirationDate * 1000 - Date.now();
  if (ms <= 0) return 'scaduto';
  const d = Math.floor(ms / 86400000);
  if (d >= 365) return `${(d / 365).toFixed(1)} anni`;
  if (d >= 1) return `${d} giorni`;
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `${h} ore`;
  return `${Math.max(1, Math.floor(ms / 60000))} min`;
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Modulo
   ═══════════════════════════════════════════════════════════════════════════ */

export function initCookies(ctx) {
  // ctx = { send, toast, banner, copyToClipboard, getSettings,
  //         requestPermissions, onIdentityIndex, tabId }

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    cookies: [],
    filter: 'analytics',     // 'analytics' | 'all'
    clearMode: 'analytics',  // 'analytics' | 'storage' | 'all'
    pageUrl: null,
    loading: false,
    identityLoading: false
  };

  /* ───────────────────────── url della pagina ───────────────────────── */

  /**
   * chrome.cookies richiede un url. Lo chiediamo alla pagina ispezionata: e'
   * l'unico modo affidabile, perche dopo una navigazione SPA il pannello non
   * conosce l'url corrente e leggerebbe i cookie del dominio sbagliato.
   */
  function currentPageUrl() {
    return new Promise((resolve) => {
      try {
        chrome.devtools.inspectedWindow.eval('location.href', (res, exc) => {
          if (exc || typeof res !== 'string') { resolve(state.pageUrl); return; }
          state.pageUrl = res;
          resolve(res);
        });
      } catch (e) {
        console.error('[Sniffer cookies] currentPageUrl', e);
        resolve(state.pageUrl);
      }
    });
  }

  /* ─────────────────────────── caricamento ─────────────────────────── */

  /**
   * Legge i cookie dal background e pubblica l'indice identity.
   * @returns {Promise<{ok:boolean, cookies?:Array, error?:string, needsPermission?:boolean}>}
   */
  async function fetchCookies() {
    const url = await currentPageUrl();
    if (!url) return { ok: false, error: 'url della pagina non disponibile' };

    const r = await ctx.send({ type: 'uad:listCookies', url });
    if (!r.ok) return r;

    // Analytics prima, poi alfabetico: e' cio che si cerca.
    const cookies = (r.cookies || []).sort((a, b) => {
      const av = isAnalyticsCookie(a.name) ? 0 : 1;
      const bv = isAnalyticsCookie(b.name) ? 0 : 1;
      return av !== bv ? av - bv : a.name.localeCompare(b.name);
    });

    state.cookies = cookies;

    // L'indice va al renderer degli eventi per il cross-check.
    if (ctx.onIdentityIndex) ctx.onIdentityIndex(buildIdentityIndex(cookies));

    return { ok: true, cookies, url };
  }

  /**
   * Carica SOLO l'indice identity, senza toccare la UI del drawer.
   *
   * Chiamata da panel.js quando il cross-check e' attivo: al boot, quando lo
   * attivi dai Settings, e dopo ogni navigazione. Senza questo i marker 🔗/⚠️
   * comparirebbero soltanto dopo aver aperto il drawer cookie.
   *
   * Silenziosa per costruzione: se il permesso manca non mostra banner ne
   * toast. Sarebbe intrusivo interrompere l'utente per una funzione di
   * arricchimento che non ha richiesto in quel momento.
   */
  async function loadIdentityOnly() {
    if (state.identityLoading) return false;

    // Il cross-check dipende dallo stesso permesso dell'inspector: se non c'e',
    // non ha senso provare.
    const feats = (ctx.getSettings && ctx.getSettings().features) || {};
    if (feats.cookieCrossCheck !== true) return false;

    state.identityLoading = true;
    try {
      const r = await fetchCookies();
      if (!r.ok) {
        // Log, non banner: e' un caricamento in background.
        console.warn('[Sniffer cookies] indice identity non disponibile:', r.error || 'permesso mancante');
        return false;
      }
      // Se il drawer e' aperto, la lista va aggiornata con i dati appena letti.
      if (!$('#cookies-drawer').hidden) render();
      return true;
    } finally {
      state.identityLoading = false;
    }
  }

  /** Caricamento completo: legge i cookie e disegna la lista. */
  async function load() {
    if (state.loading) return;
    state.loading = true;

    try {
      const url = await currentPageUrl();
      $('#cookies-domain').textContent = (() => {
        try { return new URL(url).hostname; } catch { return url || ''; }
      })();

      const r = await fetchCookies();

      if (!r.ok) {
        if (r.needsPermission) {
          renderMessage('Il permesso "cookies" non è concesso.', 'Concedi permesso',
            () => ctx.requestPermissions('cookieInspector'));
          return;
        }
        renderMessage('Lettura dei cookie non riuscita: ' + (r.error || 'errore ignoto'));
        return;
      }

      render();
    } finally {
      state.loading = false;
    }
  }

  /* ─────────────────────────── rendering ─────────────────────────── */

  function renderMessage(text, actionLabel, onAction) {
    const list = $('#cookies-list');
    list.textContent = '';
    const p = document.createElement('p');
    p.className = 'uad-empty__text';
    p.textContent = text;
    list.appendChild(p);
    if (actionLabel) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'uad-btn uad-btn--ghost';
      b.textContent = actionLabel;
      b.addEventListener('click', onAction);
      list.appendChild(b);
    }
  }

  function render() {
    const list = $('#cookies-list');
    list.textContent = '';

    const shown = state.filter === 'all'
      ? state.cookies
      : state.cookies.filter(c => isAnalyticsCookie(c.name));

    if (!shown.length) {
      renderMessage(state.filter === 'analytics'
        ? 'Nessun cookie di analytics su questo dominio. Passa a "Tutti" per vedere gli altri.'
        : 'Nessun cookie su questo dominio.');
      return;
    }

    const tplEl = document.getElementById('tpl-cookie');
    if (!tplEl) { console.error('[Sniffer cookies] template tpl-cookie mancante'); return; }

    for (const c of shown) {
      const el = tplEl.content.firstElementChild.cloneNode(true);

      const g = vendorOf(c.name);
      el.dataset.name = c.name;
      if (g) el.style.setProperty('--vendor-color', g.color);

      const nameEl = el.querySelector('[data-cookie-name]');
      nameEl.textContent = c.name;
      if (g) nameEl.title = g.vendor;

      const valEl = el.querySelector('[data-cookie-value]');
      valEl.textContent = truncate(c.value, 120);
      valEl.addEventListener('click', () => ctx.copyToClipboard(c.value, 'Valore copiato'));
      valEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ctx.copyToClipboard(c.value, 'Valore copiato');
        }
      });

      el.querySelector('[data-cookie-domain]').textContent = c.domain;
      el.querySelector('[data-cookie-expires]').textContent = fmtExpiry(c);

      if (c.httpOnly) el.querySelector('[data-flag-httponly]').hidden = false;
      if (c.secure)   el.querySelector('[data-flag-secure]').hidden = false;
      if (c.sameSite && c.sameSite !== 'unspecified') {
        const ss = el.querySelector('[data-flag-samesite]');
        ss.textContent = 'SameSite=' + c.sameSite;
        ss.hidden = false;
      }
      if (c.partitionKey) el.querySelector('[data-flag-partitioned]').hidden = false;

      // Valore interpretato: cid, sessione, ECID in chiaro. Il valore grezzo
      // GA1.1.1575638140.1779280718 non dice nulla; "cid 1575638140.1779280718"
      // e' confrontabile a vista con la hit.
      const decoded = decodeCookie(c);
      if (decoded) {
        const tag = document.createElement('span');
        tag.className = 'uad-tag uad-tag--decoded';
        tag.textContent = decoded;
        tag.title = 'valore interpretato';
        el.querySelector('.uad-cookie__meta').appendChild(tag);
      }

      el.querySelector('[data-cookie-delete]').addEventListener('click', async () => {
        const url = await currentPageUrl();
        const r = await ctx.send({
          type: 'uad:clearCookies', url, mode: 'named', names: [c.name]
        });
        if (r.ok && r.removed) { ctx.toast('Cookie ' + c.name + ' cancellato'); load(); }
        else ctx.toast('Cancellazione non riuscita' + (r.error ? ': ' + r.error : ''));
      });

      list.appendChild(el);
    }
  }

  function decodeCookie(c) {
    if (c.name === '_ga') {
      const cid = extractGaCid(c.value);
      return cid ? 'cid ' + cid : null;
    }
    if (/^_ga_/.test(c.name)) {
      const s = extractGaSession(c.value);
      return s ? `sid ${s.sid} · sessione n.${s.sct}` : null;
    }
    const ecid = extractEcid(c.name, c.value);
    if (ecid) return 'ECID ' + ecid;
    return null;
  }

  /* ───────────────────────────── clear ───────────────────────────── */

  /**
   * Il livello "+ storage" tocca anche localStorage e sessionStorage: senza
   * questo l'identity Adobe si rigenera identica e il clear sembra inefficace.
   *
   * I pattern vengono serializzati e ricostruiti dentro la pagina, cosi l'elenco
   * vive in un solo posto invece di essere duplicato nel codice iniettato.
   */
  function clearStorageInPage() {
    const patterns = STORAGE_IDENTITY_PATTERNS.map(r => r.source).join('|');
    const code = `(function(){
      var re = new RegExp(${JSON.stringify(patterns)}, 'i');
      var removed = [];
      try {
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (re.test(k)) { localStorage.removeItem(k); removed.push('ls:' + k); }
        }
      } catch (e) {}
      try {
        for (var j = sessionStorage.length - 1; j >= 0; j--) {
          var sk = sessionStorage.key(j);
          if (re.test(sk)) { sessionStorage.removeItem(sk); removed.push('ss:' + sk); }
        }
      } catch (e) {}
      return removed;
    })()`;

    return new Promise((resolve) => {
      try {
        chrome.devtools.inspectedWindow.eval(code, (res, exc) => {
          if (exc) { console.error('[Sniffer cookies] clearStorage', exc); resolve([]); return; }
          resolve(Array.isArray(res) ? res : []);
        });
      } catch (e) {
        console.error('[Sniffer cookies] clearStorage eval', e);
        resolve([]);
      }
    });
  }

  async function doClear() {
    const url = await currentPageUrl();
    if (!url) { ctx.toast('URL non disponibile'); return; }

    // Solo il livello "all" e' distruttivo: chiedere conferma su azioni innocue
    // insegna a cliccare Ok senza leggere, e poi la conferma che conta viene
    // ignorata.
    if (state.clearMode === 'all') {
      const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
      if (!confirm(`Cancellare TUTTI i cookie di ${host}?\n\nVerrai disconnesso dal sito.`)) return;
    }

    const mode = state.clearMode === 'storage' ? 'analytics' : state.clearMode;
    const r = await ctx.send({ type: 'uad:clearCookies', url, mode });

    if (!r.ok) {
      if (r.needsPermission) {
        ctx.banner('Il permesso "cookies" non è concesso.', 'Concedi',
          () => ctx.requestPermissions('cookieInspector'));
        return;
      }
      ctx.toast('Cancellazione non riuscita: ' + (r.error || ''));
      return;
    }

    let msg = `${r.removed} cookie cancellati`;
    if (r.failed && r.failed.length) msg += ` · ${r.failed.length} non rimossi`;

    if (state.clearMode === 'storage') {
      const removed = await clearStorageInPage();
      msg += ` · ${removed.length} chiavi di storage`;
    }

    ctx.toast(msg);

    if ($('#cookies-reload').checked) {
      // Reload dopo un attimo: la conferma deve essere leggibile.
      setTimeout(() => {
        try { chrome.devtools.inspectedWindow.reload({}); }
        catch (e) { console.error('[Sniffer cookies] reload', e); }
      }, 400);
    } else {
      load();
    }
  }

  /* ─────────────────────────── binding ─────────────────────────── */

  function bind() {
    for (const b of $$('[data-cookie-filter]')) {
      b.addEventListener('click', () => {
        state.filter = b.dataset.cookieFilter;
        $$('[data-cookie-filter]').forEach(x => x.classList.toggle('is-active', x === b));
        render();
      });
    }

    for (const b of $$('[data-clear-mode]')) {
      b.addEventListener('click', () => {
        state.clearMode = b.dataset.clearMode;
        $$('[data-clear-mode]').forEach(x => x.classList.toggle('is-active', x === b));
      });
    }

    $('#cookies-refresh')?.addEventListener('click', load);
    $('#cookies-clear')?.addEventListener('click', doClear);

    // Navigazione della pagina: se il drawer e' aperto i cookie possono essere
    // cambiati. panel.js emette questo evento.
    document.addEventListener('uad:cookies-refresh', () => {
      if (!$('#cookies-drawer').hidden) load();
    });
  }

  bind();

  /* ─────────────────────────────── API ─────────────────────────────── */

  return {
    load,
    loadIdentityOnly,
    isAnalyticsCookie,
    buildIdentityIndex,

    /**
     * Confronta un valore di una hit con i cookie. Usato dal renderer per
     * marcare 🔗 o ⚠️ sulle righe.
     * @returns {{ok:boolean, message:string}|null}
     */
    crossCheck(key, value, identityIndex) {
      if (!identityIndex) return null;
      const k = String(key || '').toLowerCase();
      const v = String(value ?? '');

      if (k === 'client id' || k === 'cid') {
        if (!identityIndex.gaCid) return null;
        return identityIndex.gaCid === v
          ? { ok: true,  message: `corrisponde al cookie _ga (${v})` }
          : { ok: false, message: `diverso dal cookie _ga (${identityIndex.gaCid}): possibile identity split` };
      }

      if (k === 'session id' || k === 'sid') {
        const sids = Object.values(identityIndex.gaSessions).map(s => s.sid);
        if (!sids.length) return null;
        return sids.includes(v)
          ? { ok: true,  message: 'corrisponde alla sessione nel cookie _ga_*' }
          : { ok: false, message: `sessione non presente nei cookie _ga_* (${sids.join(', ')})` };
      }

      if (k.includes('ecid') || k === 'mid' || k === 'marketing cloud id') {
        if (!identityIndex.ecid) return null;
        return identityIndex.ecid === v
          ? { ok: true,  message: 'corrisponde all\'ECID nei cookie Adobe' }
          : { ok: false, message: `diverso dall'ECID nei cookie (${identityIndex.ecid}): identity non allineata` };
      }

      if (k === 'measurement id' || k === 'tid') {
        if (!identityIndex.measurementIds.length) return null;
        return identityIndex.measurementIds.includes(v)
          ? { ok: true,  message: 'property corrispondente ai cookie presenti' }
          : { ok: false, message: `nessun cookie _ga_ per questa property (presenti: ${identityIndex.measurementIds.join(', ')})` };
      }

      return null;
    },

    debug: () => ({
      cookies: state.cookies.length,
      filter: state.filter,
      clearMode: state.clearMode,
      pageUrl: state.pageUrl
    })
  };
}