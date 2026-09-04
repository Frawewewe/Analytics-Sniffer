/**
 * Analytics Sniffer — pannello Impostazioni
 * Contesto: pagina di estensione (panel), ES module
 *
 * v3 — cinque modifiche:
 *   1. autoListener: interruttore fra rilevamento automatico e selezione
 *      manuale dei tool. Risolve il caso "GTM non riesco a disattivarlo", dove
 *      il toggle fermava lo sniffing ma la tab restava.
 *   2. lista delle categorie di campi con stato iniziale configurabile.
 *   3. rimossa la sezione "Icone in barra": era una duplicazione. Un solo
 *      toggle per funzione, che controlla anche la sua icona.
 *   4. rimosso cookieClear come voce separata: e' dentro il drawer cookie.
 *   5. la Diagnostica e' un toggle: primo clic apre, secondo chiude.
 *
 * PROBLEMA CENTRALE — i permessi opzionali dal pannello DevTools
 * chrome.permissions.request() richiede un user gesture in un contesto valido.
 * Le pagine DevTools NON sono considerate tali: il dialog spesso non compare
 * affatto, senza alcun errore. Sintomo: clicchi il toggle e non succede niente.
 * SOLUZIONE: una finestra di estensione (grant.html) dove il clic e' un gesture
 * valido. Poi ascoltiamo permissions.onAdded e aggiorniamo la UI da soli.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Catalogo dei tool
   Serve a mostrare anche i tool NON ancora rilevati: l'utente deve poterli
   attivare prima che compaiano. Un connettore ignoto genera etichetta e nota
   dal proprio id, senza richiedere modifiche qui.
   ═══════════════════════════════════════════════════════════════════════════ */

const TOOL_CATALOG = [
  { id: 'ga4',          label: 'Google Analytics 4',  color: '#e8710a',
    note: 'hit /g/collect, hook gtag e dataLayer · supporta G- e GT-' },
  { id: 'gtm',          label: 'Google Tag Manager',  color: '#4285f4',
    note: 'push nel dataLayer, container, Consent Mode v2' },
  { id: 'adobe-legacy', label: 'Adobe Analytics',     color: '#fa0f00',
    note: 'AppMeasurement / s_code, hit /b/ss/' },
  { id: 'adobe-aep',    label: 'Adobe Web SDK',       color: '#c9252d',
    note: 'Alloy / XDM, hit Edge Network' },
  { id: 'generic',      label: 'Altri tool',          color: '#6b7280',
    note: 'Meta, TikTok, Criteo e altri ~45 vendor, senza parsing dedicato' }
];

/** Tool Adobe: la sezione euristiche compare solo se almeno uno e' attivo. */
const ADOBE_TOOLS = ['adobe-legacy', 'adobe-aep'];

function toolInfo(id) {
  const found = TOOL_CATALOG.find(t => t.id === id);
  if (found) return found;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return {
    id,
    label: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    color: `hsl(${h} 65% 45%)`,
    note: 'connettore aggiuntivo'
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Categorie di campi
   L'ordine e i gruppi rispecchiano quelli di render.js: prima il COSA (dati
   dell'evento), poi il COME (identita, consenso, configurazione).
   ═══════════════════════════════════════════════════════════════════════════ */

const CATEGORY_GROUPS = [
  {
    label: 'Dati dell\'evento',
    items: ['Event Params', 'Parametri', 'dataLayer', 'Ecommerce', 'Evento',
            'eVars', 'Props', 'Events', 'Commerce', 'Data (non-XDM)', 'XDM custom',
            'Hierarchy', 'List Props', 'List Vars']
  },
  {
    label: 'Contesto e diagnostica',
    items: ['Web / Page', 'Web / Link', 'Context Data', 'Diagnostica',
            'Non inviate (fuori da linkTrackVars)']
  },
  {
    label: 'Identità, consenso, configurazione',
    items: ['User Properties', 'Identity', 'Identity & Session', 'Consent',
            'Account', 'Container', 'GTM', 'Config', 'Core', 'Richiesta',
            'Body', 'Altri parametri']
  }
];

/* ═══════════════════════════════════════════════════════════════════════════
   Feature che richiedono permessi opzionali

   declarativeNetRequest NON e' qui: Chrome non lo ammette in
   optional_permissions, quindi e' obbligatorio nel manifest e Stop navigazione
   funziona senza richiesta.
   ═══════════════════════════════════════════════════════════════════════════ */

const FEATURE_PERMISSIONS = {
  cookieInspector:  ['cookies'],
  cookieCrossCheck: ['cookies']
};

/** Feature che si applicano appieno solo dopo un reload della pagina. */
const NEEDS_RELOAD = {
  aggressiveHeuristics: true,
  adobeMapper: true
};

/* ═══════════════════════════════════════════════════════════════════════════
   Modulo
   ═══════════════════════════════════════════════════════════════════════════ */

export function initSettings(ctx) {
  // ctx = { getSettings, patchSettings, send, toast, banner, onChange, tabId }

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    permissions: {},      // 'cookies' -> boolean
    detectedTools: [],    // tool che hanno prodotto almeno un evento
    knownCategories: [],  // categorie viste negli eventi, anche non in catalogo
    dragId: null,
    pendingFeature: null  // feature in attesa di permesso
  };

  /* ───────────────────────────── permessi ───────────────────────────── */

  const ALL_OPTIONAL = ['cookies'];

  async function refreshPermissions() {
    for (const p of ALL_OPTIONAL) {
      try {
        state.permissions[p] = await chrome.permissions.contains({ permissions: [p] });
      } catch (e) {
        // contains() lancia se il permesso non e' dichiarato tra gli opzionali:
        // significa "non concedibile", non "errore".
        state.permissions[p] = false;
      }
    }
  }

  function hasPermissionsFor(feature) {
    const need = FEATURE_PERMISSIONS[feature];
    if (!need) return true;
    return need.every(p => state.permissions[p] === true);
  }

  function requestPermissions(feature) {
    const need = FEATURE_PERMISSIONS[feature];
    if (!need) return;
    try {
      chrome.windows.create({
        url: chrome.runtime.getURL('grant.html') +
             '?p=' + encodeURIComponent(need.join(',')) +
             '&f=' + encodeURIComponent(feature),
        type: 'popup',
        width: 420,
        height: 320
      });
    } catch (e) {
      console.error('[Sniffer settings] apertura finestra permessi', e);
      ctx.toast('Impossibile aprire la finestra dei permessi');
    }
  }

  async function revokePermissions(feature) {
    const need = FEATURE_PERMISSIONS[feature];
    if (!need) return;

    // Non revochiamo un permesso ancora usato da un'altra feature attiva:
    // cookieInspector e cookieCrossCheck condividono 'cookies'.
    const s = ctx.getSettings();
    const others = Object.keys(FEATURE_PERMISSIONS).filter(f => f !== feature);
    const stillNeeded = others.some(f =>
      s.features?.[f] === true &&
      FEATURE_PERMISSIONS[f].some(p => need.includes(p))
    );
    if (stillNeeded) return;

    try { await chrome.permissions.remove({ permissions: need }); }
    catch (e) { console.error('[Sniffer settings] revoca permessi', e); }
    await refreshPermissions();
    renderFeatures();
  }

  try {
    chrome.permissions.onAdded.addListener(async () => {
      await refreshPermissions();
      await enablePendingFeature();
      renderFeatures();
      ctx.toast('Permesso concesso');
      ctx.onChange && ctx.onChange();
    });
    chrome.permissions.onRemoved.addListener(async () => {
      await refreshPermissions();
      await disableFeaturesWithoutPermission();
      renderFeatures();
      ctx.onChange && ctx.onChange();
    });
  } catch (e) {
    console.error('[Sniffer settings] listener permessi non disponibili', e);
  }

  /**
   * Dopo la concessione accende la feature che l'aveva richiesta: senza questo
   * l'utente concede il permesso e deve ricliccare il toggle.
   */
  async function enablePendingFeature() {
    const f = state.pendingFeature;
    if (!f) return;
    state.pendingFeature = null;
    if (!hasPermissionsFor(f)) return;
    await ctx.patchSettings({ features: { [f]: true } });
  }

  /** Coerenza: una feature senza permesso non deve restare accesa nei settings. */
  async function disableFeaturesWithoutPermission() {
    const s = ctx.getSettings();
    const patch = { features: {} };
    let changed = false;
    for (const f of Object.keys(FEATURE_PERMISSIONS)) {
      if (s.features?.[f] === true && !hasPermissionsFor(f)) {
        patch.features[f] = false;
        changed = true;
      }
    }
    if (changed) await ctx.patchSettings(patch);
  }

  /* ─────────────────────────── lista dei tool ─────────────────────────── */

  function orderedToolIds() {
    const s = ctx.getSettings();
    const order = Array.isArray(s.toolOrder) ? s.toolOrder.slice() : [];
    const known = TOOL_CATALOG.map(t => t.id);
    const fromSettings = Object.keys(s.tools || {});
    const all = [...new Set([...order, ...known, ...fromSettings, ...state.detectedTools])];
    // Esclude i connettori finti usati dalla suite di test.
    return all.filter(id => id && !id.startsWith('__t_'));
  }

  function renderTools() {
    const wrap = $('#settings-tools');
    if (!wrap) return;

    const s = ctx.getSettings();
    const auto = s.autoListener !== false;
    const tplEl = document.getElementById('tpl-tool-item');
    if (!tplEl) { console.error('[Sniffer settings] template tpl-tool-item mancante'); return; }

    wrap.textContent = '';

    for (const id of orderedToolIds()) {
      const info = toolInfo(id);
      const li = tplEl.content.firstElementChild.cloneNode(true);

      li.dataset.toolId = id;
      li.style.setProperty('--tool-color', info.color);

      const cb = li.querySelector('[data-tool-toggle]');
      cb.checked = s.tools?.[id] === true;
      cb.addEventListener('change', async () => {
        await ctx.patchSettings({ tools: { [id]: cb.checked } });
        // Un tool appena attivato viene rilevato senza reload: il content script
        // rifa la detection al cambio settings.
        if (cb.checked) ctx.send({ type: 'uad:command', cmd: 'redetect' });
        renderTools();
        syncAdobeSection();
        ctx.onChange && ctx.onChange();
      });

      const lbl = li.querySelector('[data-tool-label]');
      lbl.textContent = info.label;
      lbl.title = info.note || '';

      // Tre stati distinti: rilevato (sta vedendo dati), in ascolto (attivo ma
      // silenzioso), spento. Risponde a "l'ho attivato, perche non vedo nulla?".
      const badge = li.querySelector('[data-tool-state]');
      const detected = state.detectedTools.includes(id);
      const enabled = s.tools?.[id] === true;

      if (detected && enabled) {
        badge.textContent = 'rilevato';
        badge.dataset.state = 'detected';
        badge.title = 'Ha prodotto almeno un evento su questa pagina';
        badge.hidden = false;
      } else if (detected && !enabled) {
        // Caso reale: il tool ha eventi in memoria ma ora e' spento. Con
        // rilevamento automatico la tab resterebbe visibile.
        badge.textContent = auto ? 'tab visibile' : 'nascosto';
        badge.dataset.state = 'stale';
        badge.title = auto
          ? 'Ha eventi già raccolti: la tab resta visibile finché il rilevamento ' +
            'automatico è attivo. Disattivalo per nasconderla.'
          : 'Eventi già raccolti, ma la tab è nascosta perché il tool è spento';
        badge.hidden = false;
      } else if (enabled) {
        badge.textContent = 'in ascolto';
        badge.dataset.state = 'listening';
        badge.title = 'Attivo, ma non ha ancora prodotto eventi su questa pagina';
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }

      bindDrag(li);
      wrap.appendChild(li);
    }
  }

  /**
   * Drag-to-reorder con API HTML5 nativa. Serve perche l'ordine di selezione da
   * solo produce un effetto sorprendente: disattivando e riattivando GA4,
   * quello finisce in fondo alle tab.
   */
  function bindDrag(li) {
    li.addEventListener('dragstart', (e) => {
      state.dragId = li.dataset.toolId;
      li.classList.add('is-dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', state.dragId);
      } catch (err) {}
    });

    li.addEventListener('dragend', () => {
      li.classList.remove('is-dragging');
      $$('#settings-tools .uad-tool-item').forEach(x => x.classList.remove('is-drop-target'));
      state.dragId = null;
    });

    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!state.dragId || state.dragId === li.dataset.toolId) return;
      li.classList.add('is-drop-target');
    });

    li.addEventListener('dragleave', () => li.classList.remove('is-drop-target'));

    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('is-drop-target');
      const from = state.dragId;
      const to = li.dataset.toolId;
      if (!from || from === to) return;

      const ids = orderedToolIds();
      const fi = ids.indexOf(from);
      const ti = ids.indexOf(to);
      if (fi === -1 || ti === -1) return;
      ids.splice(fi, 1);
      ids.splice(ti, 0, from);

      await ctx.patchSettings({ toolOrder: ids });
      renderTools();
      ctx.onChange && ctx.onChange();
    });
  }

  /* ─────────────────────── categorie dei campi ─────────────────────── */

  function renderCategories() {
    const wrap = $('#settings-categories');
    if (!wrap) return;

    const s = ctx.getSettings();
    const cs = s.categoryState || {};
    const tplEl = document.getElementById('tpl-cat-item');
    if (!tplEl) { console.error('[Sniffer settings] template tpl-cat-item mancante'); return; }

    wrap.textContent = '';

    // Categorie viste negli eventi ma non in nessun gruppo: un connettore nuovo
    // le introduce, e devono essere configurabili senza modificare il codice.
    const inGroups = new Set(CATEGORY_GROUPS.flatMap(g => g.items));
    const extra = state.knownCategories.filter(c => !inGroups.has(c));

    const groups = extra.length
      ? CATEGORY_GROUPS.concat([{ label: 'Altre', items: extra.sort() }])
      : CATEGORY_GROUPS;

    for (const group of groups) {
      const h = document.createElement('p');
      h.className = 'uad-catlist__group';
      h.textContent = group.label;
      wrap.appendChild(h);

      for (const cat of group.items) {
        const item = tplEl.content.firstElementChild.cloneNode(true);
        const cb = item.querySelector('[data-cat-toggle]');
        const name = item.querySelector('[data-cat-name]');

        // Le categorie non configurate nascono aperte.
        cb.checked = Object.prototype.hasOwnProperty.call(cs, cat) ? cs[cat] === true : true;
        cb.dataset.category = cat;
        name.textContent = cat;

        // Marca le categorie mai viste in questa sessione: aiuta a capire
        // quali sono pertinenti al sito corrente.
        if (state.knownCategories.length && !state.knownCategories.includes(cat)) {
          item.dataset.unseen = 'true';
          item.title = 'Non presente negli eventi raccolti su questa pagina';
        }

        cb.addEventListener('change', async () => {
          await ctx.patchSettings({ categoryState: { [cat]: cb.checked } });
          ctx.onChange && ctx.onChange();
        });

        wrap.appendChild(item);
      }
    }
  }

  function bindCategoryActions() {
    const setAll = async (value) => {
      const patch = {};
      for (const g of CATEGORY_GROUPS) for (const c of g.items) patch[c] = value;
      for (const c of state.knownCategories) patch[c] = value;
      await ctx.patchSettings({ categoryState: patch });
      renderCategories();
      ctx.onChange && ctx.onChange();
    };

    $('#btn-cat-all')?.addEventListener('click', () => setAll(true));
    $('#btn-cat-none')?.addEventListener('click', () => setAll(false));

    $('#btn-cat-reset')?.addEventListener('click', async () => {
      // I default vivono in namespace.js, unica fonte di verita: li recuperiamo
      // dalla pagina invece di duplicarli qui, dove si sfaserebbero.
      const r = await ctx.send({ type: 'uad:command', cmd: 'getDefaults' });
      if (r.ok) {
        ctx.toast('Default richiesti alla pagina');
        return;
      }
      // Fallback: applichiamo il criterio COSA aperto / COME chiuso.
      const patch = {};
      CATEGORY_GROUPS.forEach((g, i) => {
        for (const c of g.items) patch[c] = (i < 2);
      });
      await ctx.patchSettings({ categoryState: patch });
      renderCategories();
      ctx.onChange && ctx.onChange();
      ctx.toast('Sezioni ripristinate');
    });
  }

  /* ───────────────────────────── feature ───────────────────────────── */

  function renderFeatures() {
    const s = ctx.getSettings();

    for (const cb of $$('[data-feature]')) {
      const f = cb.dataset.feature;
      const enabled = s.features?.[f] === true;
      const ok = hasPermissionsFor(f);

      cb.checked = enabled && ok;

      const label = cb.closest('.uad-switch');
      if (!label) continue;
      const note = label.querySelector('.uad-switch__note');
      if (!note) continue;

      // Il testo dell'HTML resta la base: aggiungiamo solo lo stato.
      if (!note.dataset.baseText) note.dataset.baseText = note.textContent.trim();
      const base = note.dataset.baseText;

      if (FEATURE_PERMISSIONS[f] && !ok) {
        note.textContent = base + ' — ⚠ permesso non concesso';
        label.dataset.permission = 'missing';
      } else {
        note.textContent = base;
        delete label.dataset.permission;
      }
    }

    syncAdobeSection();
  }

  /** La sezione euristiche Adobe compare solo se un tool Adobe e' attivo. */
  function syncAdobeSection() {
    const sec = $('#section-adobe');
    if (!sec) return;
    const s = ctx.getSettings();
    const anyAdobe = ADOBE_TOOLS.some(t => s.tools?.[t] === true);
    sec.hidden = !anyAdobe;
  }

  function bindFeatures() {
    for (const cb of $$('[data-feature]')) {
      const f = cb.dataset.feature;

      cb.addEventListener('change', async () => {
        if (cb.checked && FEATURE_PERMISSIONS[f] && !hasPermissionsFor(f)) {
          // Riportiamo il toggle indietro: sara la finestra dei permessi a
          // decidere l'esito. Lasciarlo spuntato farebbe sembrare attiva una
          // feature che non lo e'.
          cb.checked = false;
          state.pendingFeature = f;
          requestPermissions(f);
          ctx.toast('Concedi il permesso nella finestra appena aperta');
          return;
        }

        await ctx.patchSettings({ features: { [f]: cb.checked } });

        if (!cb.checked && FEATURE_PERMISSIONS[f]) await revokePermissions(f);

        // Le euristiche modificano il comportamento dei connettori: serve una
        // nuova detection, e per applicarle da inizio caricamento un reload.
        if (f === 'aggressiveHeuristics' || f === 'adobeMapper') {
          ctx.send({ type: 'uad:command', cmd: 'redetect' });
        }
        if (cb.checked && NEEDS_RELOAD[f]) {
          ctx.toast('Ricarica la pagina per applicarla dall\'inizio del caricamento');
        }

        renderFeatures();
        ctx.onChange && ctx.onChange();
      });
    }
  }

  /* ───────────────────────────── avanzate ───────────────────────────── */

  function bindAdvanced() {
    // Rilevamento automatico dei tool.
    const auto = $('#opt-autoListener');
    if (auto) {
      auto.addEventListener('change', async () => {
        await ctx.patchSettings({ autoListener: auto.checked });
        renderTools();
        ctx.onChange && ctx.onChange();
        ctx.toast(auto.checked
          ? 'Rilevamento automatico attivo: i tool trovati compariranno da soli'
          : 'Selezione manuale: compaiono solo i tool spuntati');
      });
    }

    const collapse = $('#opt-collapseByDefault');
    if (collapse) {
      collapse.addEventListener('change', async () => {
        await ctx.patchSettings({ ui: { collapseByDefault: collapse.checked } });
        ctx.onChange && ctx.onChange();
      });
    }

    const maxEv = $('#limit-maxEvents');
    if (maxEv) {
      maxEv.addEventListener('change', async () => {
        let n = parseInt(maxEv.value, 10);
        if (!isFinite(n)) n = 2000;
        n = Math.min(20000, Math.max(100, n));
        maxEv.value = String(n);
        await ctx.patchSettings({ limits: { maxEventsPerTab: n } });
        ctx.toast('Limite aggiornato: ' + n + ' eventi per tab');
      });
    }

    const dbg = $('#opt-debug');
    if (dbg) {
      dbg.addEventListener('change', async () => {
        await ctx.patchSettings({ debug: dbg.checked });
        ctx.send({ type: 'uad:command', cmd: 'setDebug', payload: { enabled: dbg.checked } });
        if (dbg.checked) ctx.toast('Log attivo nella console della pagina ispezionata');
      });
    }

    // Diagnostica: toggle. Primo clic apre, secondo chiude.
    const diag = $('#btn-diagnose');
    if (diag) {
      diag.addEventListener('click', async () => {
        const out = $('#diagnostics-output');

        if (!out.hidden) {
          out.hidden = true;
          diag.setAttribute('aria-expanded', 'false');
          return;
        }

        out.hidden = false;
        diag.setAttribute('aria-expanded', 'true');
        out.textContent = 'Richiesta in corso…';

        const r = await ctx.send({ type: 'uad:command', cmd: 'diagnose' });

        if (!r.ok) {
          // Causa piu frequente: pagina aperta prima dell'installazione. I
          // content script si iniettano solo al caricamento del documento.
          const s = ctx.getSettings();
          out.textContent = JSON.stringify({
            errore: r.error || 'content script non raggiungibile',
            suggerimento: 'Ricarica la pagina ispezionata: i content script si ' +
                          'iniettano solo al caricamento del documento.',
            permessiOpzionali: state.permissions,
            rilevamentoAutomatico: s.autoListener !== false,
            toolAttivi: Object.keys(s.tools || {}).filter(k => s.tools[k]),
            toolRilevati: state.detectedTools,
            funzioniAttive: Object.keys(s.features || {}).filter(k => s.features[k])
          }, null, 2);
        }
        // In caso di successo la risposta arriva come evento sul canale HIT:
        // panel.js la scrive qui.
      });
    }

    const reset = $('#btn-settings-reset');
    if (reset) {
      reset.addEventListener('click', async () => {
        if (!confirm('Ripristinare tutte le impostazioni ai valori predefiniti?')) return;
        // Oggetto vuoto: il merge coi DEFAULTS nel world MAIN ricostruisce
        // tutto. I default vivono in namespace.js, unica fonte di verita.
        await ctx.patchSettings({}, true);
        for (const f of Object.keys(FEATURE_PERMISSIONS)) await revokePermissions(f);
        await refreshPermissions();
        renderAll();
        ctx.toast('Impostazioni ripristinate');
        ctx.onChange && ctx.onChange();
      });
    }
  }

  /* ─────────────────────────────── API ─────────────────────────────── */

  function renderAll() {
    const s = ctx.getSettings();

    renderTools();
    renderCategories();
    renderFeatures();
    syncAdobeSection();

    const auto = $('#opt-autoListener');
    if (auto) auto.checked = s.autoListener !== false;

    const collapse = $('#opt-collapseByDefault');
    if (collapse) collapse.checked = s.ui?.collapseByDefault === true;

    const maxEv = $('#limit-maxEvents');
    if (maxEv) maxEv.value = String(s.limits?.maxEventsPerTab ?? 2000);

    const dbg = $('#opt-debug');
    if (dbg) dbg.checked = s.debug === true;
  }

  /** Chiamata da panel.js quando arrivano eventi: aggiorna badge e categorie. */
  function notifyDetected(toolIds, categories) {
    let changed = false;

    if (Array.isArray(toolIds)) {
      for (const id of toolIds) {
        if (!id || state.detectedTools.includes(id)) continue;
        state.detectedTools.push(id);
        changed = true;
      }
    }

    let catChanged = false;
    if (Array.isArray(categories)) {
      for (const c of categories) {
        if (!c || state.knownCategories.includes(c)) continue;
        state.knownCategories.push(c);
        catChanged = true;
      }
    }

    // Ridisegniamo solo se il drawer e' aperto: nessun lavoro a vuoto.
    if (!$('#settings-drawer').hidden) {
      if (changed) renderTools();
      if (catChanged) renderCategories();
    }
  }

  /* ───────────────────────────── avvio ───────────────────────────── */

  (async function boot() {
    await refreshPermissions();
    await disableFeaturesWithoutPermission();
    bindFeatures();
    bindCategoryActions();
    bindAdvanced();
    renderAll();
  })();

  return {
    render: renderAll,
    notifyDetected,
    hasPermissionsFor,
    requestPermissions,
    refreshPermissions: async () => { await refreshPermissions(); renderFeatures(); }
  };
}