/**
 * Universal Analytics Debugger — pannello Cookie
 * Contesto: pagina di estensione (panel), ES module
 *
 * RESPONSABILITA
 *   - lista dei cookie del dominio ispezionato, HttpOnly inclusi
 *   - cancellazione a tre livelli, con clear + reload in un clic
 *   - cross-check identity: il cid nella hit corrisponde al cookie _ga?
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
 * Il livello "+ storage" svuota entrambi.
 *
 * IL VALORE DEL CROSS-CHECK
 * Il caso in cui i valori NON corrispondono e' quello che vale: significa
 * utente contato due volte, sessioni spezzate, attribuzione rotta. E' un bug
 * reale e difficilissimo da vedere a mano.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Pattern dei cookie di analytics
   Allineati a quelli del background: qui servono per il filtro della UI e per
   il raggruppamento per vendor.
   ═══════════════════════════════════════════════════════════════════════════ */

const COOKIE_GROUPS = [
  { vendor: 'Google Analytics 4', color: '#e8710a',
    patterns: [/^_ga$/, /^_ga_/, /^_gid$/, /^_gat/, /^FPID$/, /^FPLC$/] },
  { vendor: 'Google Ads',         color: '#4285f4',
    patterns: [/^_gcl_/, /^_gac_/, /^_gcl_au$/] },
  { vendor: 'Adobe Analytics',    color: '#fa0f00',
    patterns: [/^s_cc$/, /^s_sq$/, /^s_vi$/, /^s_fid$/, /^s_nr/, /^s_ppv$/, /^gpv/, /^s_depth$/] },
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
   Cross-check identity
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Estrae il client ID dal cookie _ga.
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

/** ECID dal cookie AMCV_ o kndctr_*_identity. */
function extractEcid(name, value) {
  const v = String(value || '');
  if (/^AMCV_/.test(name)) {
    // Formato: ...|MCMID|12345678901234567890|...
    const m = /MCMID\|(\d+)/.exec(v);
    if (m) return m[1];
  }
  if (/_identity$/.test(name)) {
    // Base64 di un JSON con la chiave "ECID" o "id"
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
 * Costruisce l'indice identity dai cookie: viene passato al renderer degli
 * eventi, che marca 🔗 o ⚠️ sulle righe corrispondenti.
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

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    cookies: [],
    filter: 'analytics',   // 'analytics' | 'all'
    clearMode: 'analytics',// 'analytics' | 'storage' | 'all'
    pageUrl: null,
    loading: false
  };

  /* ───────────────────────── url della pagina ───────────────────────── */

  /**
   * chrome.cookies richiede un url. Lo chiediamo alla pagina ispezionata:
   * e' l'unico modo affidabile, perche il pannello non conosce l'url corrente
   * dopo una navigazione SPA.
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
        console.error('[UAD cookies] currentPageUrl', e);
        resolve(state.pageUrl);
      }
    });
  }

  /* ─────────────────────────── caricamento ─────────────────────────── */

  async function load() {
    if (state.loading) return;
    state.loading = true;

    const url = await currentPageUrl();
    if (!url) {
      renderMessage('URL della pagina non disponibile: ricarica la pagina ispezionata.');
      state.loading = false;
      return;
    }

    $('#cookies-domain').textContent = (() => {
      try { return new URL(url).hostname; } catch { return url; }
    })();

    const r = await ctx.send({ type: 'uad:listCookies', url });
    state.loading = false;

    if (!r.ok) {
      if (r.needsPermission) {
        renderMessage('Il permesso "cookies" non è concesso.', 'Concedi permesso',
          () => ctx.requestPermissions('cookieInspector'));
        return;
      }
      renderMessage('Lettura dei cookie non riuscita: ' + (r.error || 'errore ignoto'));
      return;
    }

    state.cookies = (r.cookies || []).sort((a, b) => {
      // Analytics prima, poi alfabetico: e' cio che si cerca.
      const av = isAnalyticsCookie(a.name) ? 0 : 1;
      const bv = isAnalyticsCookie(b.name) ? 0 : 1;
      return av !== bv ? av - bv : a.name.localeCompare(b.name);
    });

    // L'indice identity va al renderer degli eventi per il cross-check.
    const idx = buildIdentityIndex(state.cookies);
    ctx.onIdentityIndex && ctx.onIdentityIndex(idx);

    render();
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

    for (const c of shown) {
      const el = document.getElementById('tpl-cookie')
        ?.content.firstElementChild.cloneNode(true);
      if (!el) continue;

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
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.copyToClipboard(c.value, 'Valore copiato'); }
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

      // Valori decodificati: cid, session, ECID mostrati in chiaro.
      const decoded = decodeCookie(c);
      if (decoded) {
        const meta = el.querySelector('.uad-cookie__meta');
        const tag = document.createElement('span');
        tag.className = 'uad-tag uad-tag--decoded';
        tag.textContent = decoded;
        tag.title = 'valore interpretato';
        meta.appendChild(tag);
      }

      el.querySelector('[data-cookie-delete]').addEventListener('click', async () => {
        const url = await currentPageUrl();
        const r = await ctx.send({ type: 'uad:clearCookies', url, mode: 'named', names: [c.name] });
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
   * Il livello "+ storage" tocca anche localStorage/sessionStorage: senza
   * questo l'identity Adobe si rigenera identica e il clear sembra inefficace.
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
          if (exc) { console.error('[UAD cookies] clearStorage', exc); resolve([]); return; }
          resolve(Array.isArray(res) ? res : []);
        });
      } catch (e) {
        console.error('[UAD cookies] clearStorage eval', e);
        resolve([]);
      }
    });
  }

  async function doClear() {
    const url = await currentPageUrl();
    if (!url) { ctx.toast('URL non disponibile'); return; }

    // Solo il livello "all" e' distruttivo: ti disconnette dal sito.
    if (state.clearMode === 'all') {
      const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
      if (!confirm(`Cancellare TUTTI i cookie di ${host}?\n\nVerrai disconnesso dal sito.`)) return;
    }

    const mode = state.clearMode === 'storage' ? 'analytics' : state.clearMode;
    const r = await ctx.send({ type: 'uad:clearCookies', url, mode });

    if (!r.ok) {
      if (r.needsPermission) {
        ctx.banner('Il permesso "cookies" non è concesso.', 'Concedi',
          () => ctx.requestPermissions('cookieClear'));
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
        catch (e) { console.error('[UAD cookies] reload', e); }
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

    // Il drawer legge i cookie solo quando viene aperto: nessuna lettura
    // inutile mentre e' chiuso.
    $('#btn-cookies')?.addEventListener('click', () => {
      if (!$('#cookies-drawer').hidden) load();
    });

    // Navigazione della pagina: se il drawer e' aperto, i cookie possono essere
    // cambiati.
    document.addEventListener('uad:cookies-refresh', () => {
      if (!$('#cookies-drawer').hidden) load();
    });
  }

  bind();

  return {
    load,
    isAnalyticsCookie,
    buildIdentityIndex,
    /** Usato dal renderer degli eventi per marcare 🔗 / ⚠️ sulle righe. */
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
    }
  };
}