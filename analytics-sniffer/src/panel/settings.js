/**
 * Analytics Sniffer — pannello Impostazioni
 * Contesto: pagina di estensione (panel), ES module
 *
 * v4 — ristrutturazione dei tool in accordion.
 *
 * COSA ERA INCOERENTE
 * La sezione "Adobe — euristiche" era visibile solo se un tool Adobe aveva la
 * SPUNTA manuale. Ma con l'auto-listener attivo l'utente non spunta niente: i
 * tool compaiono da sé perché rilevati sulla pagina. Risultato: Adobe rilevato,
 * tab presente, eventi che arrivano — e l'opzione del mapper invisibile.
 *
 * COME È RISOLTO
 *   1. l'auto-listener SINCRONIZZA le spunte: attivo, i connettori day 1 sono
 *      tutti accesi e le checkbox lo riflettono. Nessuna divergenza tra quello
 *      che vedi nelle tab e quello che vedi qui.
 *   2. toccare una spunta significa prendere il controllo: l'auto-listener si
 *      spegne e viene dichiarato con un toast. Passaggio esplicito, non un
 *      effetto collaterale nascosto.
 *   3. ogni tool è un accordion: nell'header la spunta e il badge di stato,
 *      dentro le sue impostazioni specifiche. Le euristiche Adobe vivono dentro
 *      Adobe AA e Adobe Web SDK, dove ha senso cercarle, e non spariscono più.
 *
 * DECISIONE DICHIARATA
 * 'generic' ("Altri tool") resta opt-in anche con auto-listener attivo: su un
 * sito con 15 pixel quella tab è rumorosa. L'auto-listener gestisce i quattro
 * tool day 1, il resto lo attiva l'utente.
 *
 * PROBLEMA DEI PERMESSI OPZIONALI
 * chrome.permissions.request() richiede un user gesture in un contesto valido.
 * Le pagine DevTools NON sono considerate tali: il dialog spesso non compare
 * affatto, senza errori. Soluzione: una finestra di estensione (grant.html) dove
 * il clic è un gesture valido, poi ascoltiamo permissions.onAdded.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Catalogo dei tool

   Ogni voce può dichiarare le proprie impostazioni specifiche (settings): sono
   feature che vivono nell'accordion del tool a cui appartengono, invece di
   essere raccolte in una sezione generica.
   ═══════════════════════════════════════════════════════════════════════════ */

const TOOL_CATALOG = [
  {
    id: 'ga4',
    label: 'Google Analytics 4',
    color: '#e8710a',
    dayOne: true,
    note: 'Hit /g/collect, hook gtag e dataLayer. Supporta i prefissi G- e GT-. ' +
          'La rete è la fonte di verità: molte implementazioni GTM non chiamano ' +
          'mai gtag.',
    settings: []
  },
  {
    id: 'gtm',
    label: 'Google Tag Manager',
    color: '#4285f4',
    dayOne: true,
    note: 'Push nel dataLayer, container, Consent Mode v2. Mostra l\'INPUT dato ' +
          'al tag manager: un push presente qui senza la hit corrispondente in ' +
          'GA4 è la diagnosi che serve.',
    settings: []
  },
  {
    id: 'adobe-legacy',
    label: 'Adobe Analytics',
    color: '#fa0f00',
    dayOne: true,
    note: 'AppMeasurement / s_code, hit /b/ss/. Usa registerPreTrackCallback ' +
          'quando disponibile, altrimenti wrappa s.t e s.tl.',
    settings: [
      {
        feature: 'adobeMapper',
        label: '🗺️ Mapper eVar → nome umano (EDDL)',
        note: 'Alcune implementazioni tengono in un data element la traduzione ' +
              'eVar1 → page.pageInfo.site_code. Se la trova, compare una barra ' +
              'in cima alla tab con un interruttore: attivandolo, accanto a ogni ' +
              'eVar e prop vedi la mappatura. Euristica non documentata da Adobe.',
        needsReload: true
      }
    ]
  },
  {
    id: 'adobe-aep',
    label: 'Adobe Web SDK',
    color: '#c9252d',
    dayOne: true,
    note: 'Alloy, payload XDM, Edge Network. Rileva le istanze da __alloyNS, ' +
          'quindi funziona anche con nomi custom configurati in Launch.',
    settings: [
      {
        feature: 'aggressiveHeuristics',
        label: 'Polling sui data element',
        note: 'Legge l\'XDM da _satellite.getVar() quando l\'istanza Alloy non è ' +
              'esposta come variabile globale. Serve dove il Web SDK è interamente ' +
              'dentro Launch. Best-effort: su alcune installazioni non trova nulla, ' +
              'e un risultato assente non è un errore.',
        needsReload: true
      },
      {
        feature: 'adobeMapper',
        label: '🗺️ Mapper eVar → nome umano (EDDL)',
        note: 'Come per Adobe Analytics: se il mapper viene trovato, le mappature ' +
              'compaiono accanto alle eVar e prop degli eventi XDM.',
        needsReload: true,
        shared: true            // stesso flag di adobe-legacy
      }
    ]
  },
  {
    id: 'generic',
    label: 'Altri tool',
    color: '#6b7280',
    dayOne: false,             // opt-in: su un sito con molti pixel è rumoroso
    note: 'Meta, TikTok, Criteo, Hotjar e altri ~45 vendor riconosciuti dal ' +
          'pattern della request, senza parsing dedicato. Vedi i parametri grezzi. ' +
          'Resta disattivato anche con rilevamento automatico attivo.',
    settings: []
  }
];

/** I tool gestiti dall'auto-listener: i day 1. */
const AUTO_TOOLS = TOOL_CATALOG.filter(t => t.dayOne).map(t => t.id);

function toolInfo(id) {
  const found = TOOL_CATALOG.find(t => t.id === id);
  if (found) return found;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return {
    id,
    label: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    color: `hsl(${h} 65% 45%)`,
    dayOne: false,
    note: 'Connettore aggiuntivo.',
    settings: []
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Categorie di campi
   L'ordine e i gruppi rispecchiano quelli di render.js: prima il COSA (dati
   dell'evento), poi il COME (identità, consenso, configurazione).
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

   declarativeNetRequest NON è qui: Chrome non lo ammette in
   optional_permissions, quindi è obbligatorio nel manifest.
   ═══════════════════════════════════════════════════════════════════════════ */

const FEATURE_PERMISSIONS = {
  cookieInspector:  ['cookies'],
  cookieCrossCheck: ['cookies']
};

/** Chiave di storage per lo stato aperto/chiuso degli accordion dei tool. */
const ACCORDION_KEY = 'uad_settings_accordion';

/* ═══════════════════════════════════════════════════════════════════════════
   Modulo
   ═══════════════════════════════════════════════════════════════════════════ */

export function initSettings(ctx) {
  // ctx = { getSettings, patchSettings, send, toast, banner, onChange, tabId }

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    permissions: {},       // 'cookies' -> boolean
    detectedTools: [],     // tool che hanno prodotto almeno un evento
    knownCategories: [],   // categorie viste negli eventi
    accordion: {},         // toolId -> boolean (aperto)
    dragId: null,
    pendingFeature: null   // feature in attesa di permesso
  };

  /* ───────────────────────────── permessi ───────────────────────────── */

  const ALL_OPTIONAL = ['cookies'];

  async function refreshPermissions() {
    for (const p of ALL_OPTIONAL) {
      try {
        state.permissions[p] = await chrome.permissions.contains({ permissions: [p] });
      } catch (e) {
        // contains() lancia se il permesso non è dichiarato tra gli opzionali:
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
    renderAll();
  }

  try {
    chrome.permissions.onAdded.addListener(async () => {
      await refreshPermissions();
      await enablePendingFeature();
      renderAll();
      ctx.toast('Permesso concesso');
      ctx.onChange && ctx.onChange();
    });
    chrome.permissions.onRemoved.addListener(async () => {
      await refreshPermissions();
      await disableFeaturesWithoutPermission();
      renderAll();
      ctx.onChange && ctx.onChange();
    });
  } catch (e) {
    console.error('[Sniffer settings] listener permessi non disponibili', e);
  }

  /** Dopo la concessione accende la feature che l'aveva richiesta: senza questo
   *  l'utente concede il permesso e deve ricliccare il toggle. */
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

  /* ─────────────────── auto-listener e sincronizzazione ─────────────────── */

  function autoOn() {
    return ctx.getSettings().autoListener !== false;
  }

  /**
   * Con l'auto-listener attivo tutti i tool day 1 devono essere accesi: è ciò che
   * rende coerente "i tool compaiono da soli" con quello che si vede nelle
   * spunte. Senza questa sincronizzazione, un tool rilevato mostrava la tab ma
   * la checkbox restava vuota, e le sue impostazioni erano irraggiungibili.
   */
  async function syncAutoTools() {
    if (!autoOn()) return false;

    const s = ctx.getSettings();
    const patch = { tools: {} };
    let changed = false;

    for (const id of AUTO_TOOLS) {
      if (s.tools?.[id] !== true) { patch.tools[id] = true; changed = true; }
    }
    if (changed) await ctx.patchSettings(patch);
    return changed;
  }

  /**
   * Toccare una spunta significa prendere il controllo manuale: l'auto-listener
   * si spegne. È un passaggio esplicito e dichiarato, non un effetto collaterale
   * silenzioso — senza il toast, l'utente non capirebbe perché un tool che prima
   * compariva da sé ora non compare più.
   */
  async function onToolToggle(id, checked) {
    const wasAuto = autoOn();

    const patch = { tools: { [id]: checked } };
    if (wasAuto) patch.autoListener = false;

    await ctx.patchSettings(patch);

    // Un tool appena attivato viene rilevato senza reload: il content script
    // rifà la detection al cambio settings.
    if (checked) ctx.send({ type: 'uad:command', cmd: 'redetect' });

    if (wasAuto) {
      ctx.toast('Rilevamento automatico disattivato: da ora vale la tua selezione');
    }

    renderAll();
    ctx.onChange && ctx.onChange();
  }

  /* ─────────────────── accordion: stato persistito ─────────────────── */

  async function loadAccordion() {
    try {
      const r = await chrome.storage.local.get([ACCORDION_KEY]);
      const saved = r[ACCORDION_KEY];
      if (saved && typeof saved === 'object') state.accordion = saved;
    } catch (e) {
      console.error('[Sniffer settings] load accordion', e);
    }
  }

  async function saveAccordion() {
    try { await chrome.storage.local.set({ [ACCORDION_KEY]: state.accordion }); }
    catch (e) { console.error('[Sniffer settings] save accordion', e); }
  }

  /**
   * Un tool nasce aperto solo se ha impostazioni proprie E è stato rilevato:
   * aprire tutto renderebbe la lista illeggibile, aprire niente nasconderebbe
   * le opzioni pertinenti al sito che si sta guardando.
   */
  function accordionOpen(id, hasSettings) {
    if (id in state.accordion) return state.accordion[id] === true;
    return hasSettings && state.detectedTools.includes(id);
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
    const tplEl = document.getElementById('tpl-tool-accordion');
    if (!tplEl) { console.error('[Sniffer settings] template tpl-tool-accordion mancante'); return; }

    wrap.textContent = '';

    for (const id of orderedToolIds()) {
      const info = toolInfo(id);
      const li = tplEl.content.firstElementChild.cloneNode(true);

      li.dataset.toolId = id;
      li.style.setProperty('--tool-color', info.color);

      const enabled = s.tools?.[id] === true;
      const detected = state.detectedTools.includes(id);

      /* ── header: spunta, nome, badge, caret ── */

      const cb = li.querySelector('[data-tool-toggle]');
      cb.checked = enabled;
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        onToolToggle(id, cb.checked);
      });

      const lbl = li.querySelector('[data-tool-label]');
      lbl.textContent = info.label;

      // Tre stati distinti: rilevato (sta vedendo dati), in ascolto (attivo ma
      // silenzioso), spento. Risponde a "l'ho attivato, perché non vedo nulla?".
      const badge = li.querySelector('[data-tool-state]');
      if (detected && enabled) {
        badge.textContent = 'rilevato';
        badge.dataset.state = 'detected';
        badge.title = 'Ha prodotto almeno un evento su questa pagina';
        badge.hidden = false;
      } else if (detected && !enabled) {
        badge.textContent = 'eventi in memoria';
        badge.dataset.state = 'stale';
        badge.title = 'Ha eventi già raccolti ma non sta più intercettando: ' +
                      'la tab resta consultabile finché il rilevamento automatico è attivo';
        badge.hidden = false;
      } else if (enabled) {
        badge.textContent = 'in ascolto';
        badge.dataset.state = 'listening';
        badge.title = 'Attivo, ma non ha ancora prodotto eventi su questa pagina';
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }

      /* ── corpo: nota e impostazioni specifiche ── */

      const noteEl = li.querySelector('[data-tool-note]');
      noteEl.textContent = info.note || '';

      const settingsWrap = li.querySelector('[data-tool-settings]');
      const hasSettings = Array.isArray(info.settings) && info.settings.length > 0;

      if (hasSettings) {
        for (const opt of info.settings) {
          settingsWrap.appendChild(buildToolSetting(opt, enabled, info));
        }
      }

      /* ── accordion ── */

      const head = li.querySelector('[data-tool-head]');
      const body = li.querySelector('[data-tool-body]');
      const caret = li.querySelector('[data-tool-caret]');

      // Un tool senza impostazioni proprie non ha nulla da espandere oltre la
      // nota: il caret resta, ma il conteggio nell'header lo dichiara.
      const optCount = li.querySelector('[data-tool-optcount]');
      if (hasSettings) {
        optCount.textContent = info.settings.length === 1
          ? '1 opzione' : info.settings.length + ' opzioni';
        optCount.hidden = false;
      } else {
        optCount.hidden = true;
      }

      const open = accordionOpen(id, hasSettings);
      head.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      if (caret) caret.textContent = '▸';

      head.addEventListener('click', (e) => {
        // Il click sulla checkbox non deve aprire l'accordion.
        if (e.target.closest('[data-tool-toggle]')) return;
        if (e.target.closest('[data-tool-grip]')) return;
        const next = body.hidden;
        body.hidden = !next;
        head.setAttribute('aria-expanded', String(next));
        state.accordion[id] = next;
        saveAccordion();
      });

      bindDrag(li);
      wrap.appendChild(li);
    }
  }

  /**
   * Costruisce una singola impostazione dentro l'accordion di un tool.
   *
   * @param {object}  opt        voce di TOOL_CATALOG[].settings
   * @param {boolean} toolActive il tool a cui appartiene è attivo?
   * @param {object}  info       il tool
   */
  function buildToolSetting(opt, toolActive, info) {
    const s = ctx.getSettings();
    const tplEl = document.getElementById('tpl-tool-setting');
    if (!tplEl) return document.createElement('div');

    const el = tplEl.content.firstElementChild.cloneNode(true);
    const cb = el.querySelector('[data-feature]');
    const lbl = el.querySelector('[data-setting-label]');
    const note = el.querySelector('[data-setting-note]');

    cb.dataset.feature = opt.feature;
    cb.checked = s.features?.[opt.feature] === true;
    lbl.textContent = opt.label;

    let noteText = opt.note || '';

    // Un'impostazione di un tool spento non ha effetto: lo diciamo invece di
    // lasciarla apparentemente funzionante.
    if (!toolActive) {
      el.dataset.inactive = 'true';
      noteText += ' — ⚠ ' + info.label + ' è disattivato: attivalo perché questa ' +
                  'funzione abbia effetto';
    }

    // Feature condivisa tra due tool: chiarirlo evita di credere che siano
    // interruttori indipendenti.
    if (opt.shared) {
      noteText += ' Questa impostazione è condivisa con gli altri tool Adobe.';
    }

    note.textContent = noteText;

    cb.addEventListener('change', async () => {
      await ctx.patchSettings({ features: { [opt.feature]: cb.checked } });

      // Le euristiche modificano il comportamento dei connettori: serve una
      // nuova detection, e per applicarle da inizio caricamento un reload.
      ctx.send({ type: 'uad:command', cmd: 'redetect' });

      if (cb.checked && opt.needsReload) {
        ctx.toast('Ricarica la pagina per applicarla dall\'inizio del caricamento');
      }

      renderAll();
      ctx.onChange && ctx.onChange();
    });

    return el;
  }

  /**
   * Drag-to-reorder con API HTML5 nativa. Serve perché l'ordine di selezione da
   * solo produce un effetto sorprendente: disattivando e riattivando GA4, quello
   * finisce in fondo alle tab.
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
      $$('#settings-tools .uad-tool-acc').forEach(x => x.classList.remove('is-drop-target'));
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

        // Marca le categorie mai viste in questa sessione: aiuta a capire quali
        // sono pertinenti al sito corrente.
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
      // Criterio COSA aperto / COME chiuso: i primi due gruppi aperti, il terzo
      // chiuso. È lo stesso criterio dei DEFAULTS in namespace.js.
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

  /* ─────────────────── funzioni globali (non di un tool) ─────────────────── */

  function renderGlobalFeatures() {
    const s = ctx.getSettings();

    // Solo le checkbox fuori dagli accordion dei tool: quelle dentro sono
    // gestite da buildToolSetting.
    const globals = $$('#settings-global [data-feature]');

    for (const cb of globals) {
      const f = cb.dataset.feature;
      const enabled = s.features?.[f] === true;
      const ok = hasPermissionsFor(f);

      cb.checked = enabled && ok;

      const label = cb.closest('.uad-switch');
      if (!label) continue;
      const note = label.querySelector('.uad-switch__note');
      if (!note) continue;

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
  }

  function bindGlobalFeatures() {
    for (const cb of $$('#settings-global [data-feature]')) {
      const f = cb.dataset.feature;

      cb.addEventListener('change', async () => {
        if (cb.checked && FEATURE_PERMISSIONS[f] && !hasPermissionsFor(f)) {
          // Riportiamo il toggle indietro: sarà la finestra dei permessi a
          // decidere l'esito. Lasciarlo spuntato farebbe sembrare attiva una
          // feature che non lo è.
          cb.checked = false;
          state.pendingFeature = f;
          requestPermissions(f);
          ctx.toast('Concedi il permesso nella finestra appena aperta');
          return;
        }

        await ctx.patchSettings({ features: { [f]: cb.checked } });
        if (!cb.checked && FEATURE_PERMISSIONS[f]) await revokePermissions(f);

        renderGlobalFeatures();
        ctx.onChange && ctx.onChange();
      });
    }
  }

  /* ───────────────────────────── avanzate ───────────────────────────── */

  function bindAdvanced() {
    const auto = $('#opt-autoListener');
    if (auto) {
      auto.addEventListener('change', async () => {
        await ctx.patchSettings({ autoListener: auto.checked });

        if (auto.checked) {
          // Riaccendiamo i tool day 1: è il senso di "gestisci tu".
          await syncAutoTools();
          ctx.send({ type: 'uad:command', cmd: 'redetect' });
          ctx.toast('Rilevamento automatico attivo: i tool trovati compariranno da soli');
        } else {
          ctx.toast('Selezione manuale: compaiono solo i tool spuntati');
        }

        renderAll();
        ctx.onChange && ctx.onChange();
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
          // Causa più frequente: pagina aperta prima dell'installazione. I
          // content script si iniettano solo al caricamento del documento.
          const s = ctx.getSettings();
          out.textContent = JSON.stringify({
            errore: r.error || 'content script non raggiungibile',
            suggerimento: 'Ricarica la pagina ispezionata: i content script si ' +
                          'iniettano solo al caricamento del documento.',
            permessiOpzionali: state.permissions,
            rilevamentoAutomatico: autoOn(),
            toolAttivi: Object.keys(s.tools || {}).filter(k => s.tools[k]),
            toolRilevati: state.detectedTools,
            funzioniAttive: Object.keys(s.features || {}).filter(k => s.features[k])
          }, null, 2);
        }
      });
    }

    const reset = $('#btn-settings-reset');
    if (reset) {
      reset.addEventListener('click', async () => {
        if (!confirm('Ripristinare tutte le impostazioni ai valori predefiniti?')) return;
        // Oggetto vuoto: il merge coi DEFAULTS nel world MAIN ricostruisce tutto.
        // I default vivono in namespace.js, unica fonte di verità.
        await ctx.patchSettings({}, true);
        for (const f of Object.keys(FEATURE_PERMISSIONS)) await revokePermissions(f);
        await refreshPermissions();
        state.accordion = {};
        saveAccordion();
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
    renderGlobalFeatures();

    const auto = $('#opt-autoListener');
    if (auto) auto.checked = autoOn();

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

    // Ridisegniamo solo se il drawer è aperto: nessun lavoro a vuoto.
    if (!$('#settings-drawer').hidden) {
      if (changed) renderTools();
      if (catChanged) renderCategories();
    }
  }

  /* ───────────────────────────── avvio ───────────────────────────── */

  (async function boot() {
    await refreshPermissions();
    await disableFeaturesWithoutPermission();
    await loadAccordion();
    // Con l'auto-listener attivo le spunte devono riflettere lo stato reale
    // PRIMA del primo render, altrimenti si vede un frame incoerente.
    await syncAutoTools();
    bindGlobalFeatures();
    bindCategoryActions();
    bindAdvanced();
    renderAll();
  })();

  return {
    render: renderAll,
    notifyDetected,
    hasPermissionsFor,
    requestPermissions,
    refreshPermissions: async () => { await refreshPermissions(); renderAll(); }
  };
}