/**
 * Analytics Sniffer — rendering degli accordion
 * Contesto: pagina di estensione (panel), ES module
 *
 * v5 — mappatura EDDL inline accanto alle chiavi eVar/prop.
 *
 * Il pannello fornisce mapperFor(varName), che restituisce tre valori distinti:
 *   null            non applicabile — toggle spento, tab non Adobe, oppure la
 *                   chiave non è una variabile Adobe
 *   stringa vuota   variabile riconosciuta ma ASSENTE dal mapper
 *   stringa         la mappatura
 *
 * Il caso intermedio esiste per una ragione precisa: se una eVar non è nel
 * mapper e non mostrassimo nulla, l'utente penserebbe che il toggle non funzioni
 * su quella riga. Mostrando "non mappata" attenuato, distingue "assente dal
 * mapper" da "mapper spento".
 *
 * PRINCIPIO: RENDERING PURO
 * Questo modulo NON prende decisioni e NON registra listener. Riceve dati più
 * stato e produce DOM. Gli handler li aggancia panel.js per DELEGA su
 * contenitori stabili: con 2000 eventi × 3 livelli, un listener per nodo
 * significherebbe migliaia di closure ricreate a ogni render.
 *
 * SICUREZZA
 * Solo textContent, mai innerHTML. I valori del dataLayer possono contenere HTML
 * arbitrario. L'unica costruzione di nodi è quella dei <mark> per
 * l'evidenziazione, fatta programmaticamente.
 *
 * PERFORMANCE
 * Le righe di un gruppo si costruiscono SEMPRE, anche a gruppo chiuso: aprire un
 * gruppo diventa `hidden = false`, che panel.js applica direttamente al DOM. Il
 * gate pesante resta a livello di evento, il cui corpo è lazy.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   1. ORDINE DELLE CATEGORIE — COSA prima, COME dopo
   ═══════════════════════════════════════════════════════════════════════════

   Chi apre un evento vuole sapere PRIMA cosa è stato misurato (nome evento,
   parametri, prodotti, eVars), e solo DOPO come è stato spedito (identity,
   consenso, configurazione, endpoint).

   Le categorie non elencate finiscono nella fascia UNKNOWN, cioè subito prima
   del blocco tecnico: un connettore nuovo resta leggibile senza modifiche qui.

   NOTA: questo array governa solo l'ORDINE. Lo stato iniziale (aperta/chiusa)
   arriva dai Settings via deps.categoryOpen().
   ═══════════════════════════════════════════════════════════════════════════ */

const CATEGORY_ORDER = [
  /* ── il cuore dell'evento ────────────────────────────────────────────── */
  'Evento',
  'Event Params',
  'Parametri',
  'dataLayer',
  'Ecommerce',
  'Items',
  'eVars',
  'Props',
  'Events',
  'List Props',
  'List Vars',
  'Hierarchy',
  'Commerce',
  'Data (non-XDM)',
  'XDM custom',

  /* ── contesto della pagina ───────────────────────────────────────────── */
  'Web / Page',
  'Web / Link',
  'Context Data',

  /* ── diagnostica: va vista, ma dopo i dati ───────────────────────────── */
  'Diagnostica',
  'Non inviate (fuori da linkTrackVars)',

  /* ── il COME: identità, consenso, configurazione ─────────────────────── */
  'User Properties',              // ← inizio fascia UNKNOWN
  'Identity',
  'Identity & Session',
  'Consent',
  'Account',
  'Container',
  'GTM',
  'Config',
  'Core',
  'Richiesta',
  'Body',
  'Altri parametri'
];

const CATEGORY_RANK = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));

/** Le categorie ignote vanno prima del blocco tecnico, non in fondo. */
const UNKNOWN_RANK = CATEGORY_ORDER.indexOf('User Properties');

function sortCategories(names) {
  return names.slice().sort((a, b) => {
    const ra = CATEGORY_RANK.has(a) ? CATEGORY_RANK.get(a) : UNKNOWN_RANK;
    const rb = CATEGORY_RANK.has(b) ? CATEGORY_RANK.get(b) : UNKNOWN_RANK;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);      // a pari rango, alfabetico: ordine stabile
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. Template
   ═══════════════════════════════════════════════════════════════════════════ */

const TPL = {};

function tpl(id) {
  if (!(id in TPL)) {
    const t = document.getElementById(id);
    TPL[id] = t ? t.content.firstElementChild : null;
    if (!t) console.error('[Sniffer render] template mancante: ' + id);
  }
  return TPL[id] ? TPL[id].cloneNode(true) : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. Formattazione
   ═══════════════════════════════════════════════════════════════════════════ */

export function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function fmtDelta(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000)  return `+${ms}ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${Math.round(ms / 60000)}m`;
}

export function shortUrl(u) {
  try {
    const url = new URL(u);
    const path = url.pathname === '/' ? '' : url.pathname;
    return (url.hostname + path + url.search) || url.href;
  } catch { return String(u || ''); }
}

export function displayValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return '[undefined]';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return '[object]'; }
  }
  return String(v);
}

export function isEmptyValue(v) {
  return v === null || v === undefined || v === '' || v === '[undefined]' ||
         (Array.isArray(v) && v.length === 0) ||
         (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. Evidenziazione dei match
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Scrive `text` in `el` evidenziando le occorrenze di `needle`.
 * Costruisce nodi <mark> programmaticamente: nessun innerHTML, nessuna
 * possibilità di injection dai valori del dataLayer.
 * @returns {number} occorrenze evidenziate
 */
export function setTextHighlighted(el, text, needle) {
  const s = String(text ?? '');
  if (!needle) { el.textContent = s; return 0; }

  const hay = s.toLowerCase();
  const nee = String(needle).toLowerCase();
  if (!nee || hay.indexOf(nee) === -1) { el.textContent = s; return 0; }

  el.textContent = '';
  let from = 0, count = 0, guard = 0;

  // Il guard evita il loop patologico su una ricerca di un solo carattere dentro
  // un valore molto lungo.
  while (guard++ < 200) {
    const at = hay.indexOf(nee, from);
    if (at === -1) break;
    if (at > from) el.appendChild(document.createTextNode(s.slice(from, at)));
    const mark = document.createElement('mark');
    mark.textContent = s.slice(at, at + nee.length);
    el.appendChild(mark);
    from = at + nee.length;
    count++;
  }
  if (from < s.length) el.appendChild(document.createTextNode(s.slice(from)));
  return count;
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. Renderer
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {object} deps
 *   toolMeta(id)          -> { label, color }
 *   state                 -> istanza di createState()
 *   categoryOpen(cat)     -> boolean: stato INIZIALE della categoria (Settings)
 *   mapperFor(varName)    -> string | '' | null   mappatura EDDL (opzionale)
 *   crossCheck(key,value) -> { ok, message } | null   (opzionale)
 */
export function createRenderer(deps) {
  const { toolMeta, state } = deps;
  const crossCheck = deps.crossCheck || (() => null);
  // Se il pannello non fornisce le funzioni, i default sono innocui: tutte le
  // categorie aperte e nessuna mappatura.
  const categoryOpen = deps.categoryOpen || (() => true);
  const mapperFor = deps.mapperFor || (() => null);

  /* ─────────────────────── raggruppamento per view ─────────────────────── */

  /**
   * Raggruppa per viewId, NON per URL: due visite alla stessa pagina devono
   * restare sezioni distinte, altrimenti tornando sulla home gli eventi si
   * accumulerebbero nel vecchio accordion.
   */
  function groupByView(events) {
    const order = [];
    const map = new Map();
    for (const ev of events) {
      const vid = ev.viewId || ev.pageSessionId || 'unknown';
      if (!map.has(vid)) { map.set(vid, []); order.push(vid); }
      map.get(vid).push(ev);
    }
    return order.map(vid => ({ viewId: vid, events: map.get(vid) }));
  }

  /* ───────────────────────────── view ───────────────────────────── */

  function renderView(group, ctx, existing) {
    const el = existing || tpl('tpl-view');
    if (!el) return null;

    const first = group.events[0];
    const vid = group.viewId;
    el.dataset.viewId = vid;

    setTextHighlighted(
      el.querySelector('[data-url]'),
      shortUrl(first.viewUrl || first.pageUrl),
      ctx.search
    );

    el.querySelector('[data-count]').textContent = String(group.events.length);
    el.querySelector('[data-time]').textContent = fmtClock(first.timestamp);
    el.querySelector('[data-spa]').hidden = !first.isSpaView;

    const head = el.querySelector('.uad-view__head');
    const body = el.querySelector('[data-body]');
    const openId = state.ids.view(vid);
    const open = state.isOpen(openId);

    head.setAttribute('aria-expanded', String(open));
    head.dataset.toggleId = openId;          // delega: panel.js legge questo
    head.dataset.level = 'view';
    body.hidden = !open;

    if (open) {
      syncEvents(body, group.events, ctx);
    } else if (!existing) {
      // Il contenuto di una view chiusa non si costruisce: su 40 view SPA
      // sarebbe lavoro buttato.
      body.textContent = '';
    }

    return el;
  }

  /* ───────────────────── riconciliazione degli eventi ───────────────────── */

  function syncEvents(container, events, ctx) {
    const existing = new Map();
    for (const child of Array.from(container.children)) {
      const id = child.dataset.eventId;
      if (id) existing.set(id, child);
      else child.remove();
    }

    let prev = null;
    for (const ev of events) {
      let el = existing.get(ev.__id);
      existing.delete(ev.__id);
      el = renderEvent(ev, ctx, el);
      if (!el) continue;

      // Inserimento nella posizione corretta senza toccare i nodi già a posto.
      const target = prev ? prev.nextSibling : container.firstChild;
      if (el !== target) container.insertBefore(el, target);
      prev = el;
    }

    for (const el of existing.values()) el.remove();
  }

  /* ───────────────────────────── evento ───────────────────────────── */

  function renderEvent(ev, ctx, existing) {
    const el = existing || tpl('tpl-event');
    if (!el) return null;

    const meta = toolMeta(ev.toolId);
    const isNew = !existing;

    if (isNew) {
      el.dataset.eventId = ev.__id;
      el.dataset.seq = ev.seq;
      el.style.setProperty('--tool-color', meta.color);
      el.querySelector('[data-tool]').textContent = meta.label;
      el.querySelector('[data-clock]').textContent = fmtClock(ev.timestamp);
      el.querySelector('[data-delta]').textContent = fmtDelta(ev.deltaMs);

      const src = el.querySelector('[data-source]');
      src.textContent = ev.source || 'unknown';
      src.dataset.channel = ev.source || 'unknown';
      src.title = describeChannel(ev.source);

      if (ev.status && ev.status !== 'ok') {
        const st = el.querySelector('[data-status]');
        st.textContent = ev.status;
        st.dataset.status = ev.status;
        st.hidden = false;
      }

      el.querySelector('[data-devref]').dataset.eventId = ev.__id;
    }

    // Il nome può contenere match di ricerca: sempre riscritto.
    setTextHighlighted(el.querySelector('[data-name]'), ev.eventName || 'hit', ctx.search);

    // La visibilità del devref dipende dai settings, quindi cambia nel tempo.
    el.querySelector('[data-devref]').hidden = !ctx.showDevRefs;

    const head = el.querySelector('.uad-event__head');
    const body = el.querySelector('[data-body]');
    const openId = state.ids.event(ev.__id);
    const open = state.isOpen(openId);

    head.setAttribute('aria-expanded', String(open));
    head.dataset.toggleId = openId;
    head.dataset.level = 'event';
    body.hidden = !open;

    if (open) {
      /**
       * Firma del contenuto: ricostruiamo solo quando cambia qualcosa che lo
       * altera davvero.
       *   showAll            mostra/nasconde i campi vuoti
       *   search             evidenziazione dei match
       *   crossCheckVersion  l'indice identity dai cookie è arrivato
       *   catVersion         lo stato iniziale delle categorie è cambiato
       *   mapperVersion      il toggle o la mappa EDDL sono cambiati
       *
       * NOTA: lo stato aperto/chiuso dei singoli GRUPPI non è nella firma, e non
       * deve esserci. I gruppi si aprono cambiando `hidden`, cosa che panel.js
       * fa direttamente: rimetterli nella firma significherebbe ricostruire 200
       * righe a ogni click su un sotto-accordion.
       */
      const sig = [
        ctx.showAll ? 1 : 0,
        ctx.search || '',
        ctx.crossCheckVersion || 0,
        ctx.catVersion || 0,
        ctx.mapperVersion || 0
      ].join('|');

      if (body.dataset.built !== sig) {
        buildEventBody(body, ev, ctx);
        body.dataset.built = sig;
      } else {
        // Il contenuto è già corretto, ma lo stato dei gruppi può essere
        // cambiato altrove (collapseAll, ricerca, ripristino da storage):
        // riallineiamo solo gli attributi, senza ricostruire nulla.
        syncGroupStates(body, ev);
      }
    }

    // Pulse: solo sugli eventi arrivati in tempo reale, mai sullo storico.
    if (ev.__live) {
      ev.__live = false;
      el.classList.add('is-pulse');
      setTimeout(() => el.classList.remove('is-pulse'), 2000);
    }

    return el;
  }

  /**
   * Riallinea aria-expanded e hidden dei gruppi allo stato corrente, senza
   * ricostruire le righe. È l'operazione che rende coerente il DOM dopo un
   * collapseAll, una ricerca o un ripristino da storage.
   */
  function syncGroupStates(body, ev) {
    const groups = body.querySelectorAll('.uad-group');
    for (const g of groups) {
      const cat = g.dataset.category;
      if (!cat) continue;
      const head = g.querySelector('.uad-group__head');
      const gBody = g.querySelector('[data-body]');
      if (!head || !gBody) continue;

      const defaultOpen = categoryOpen(cat) !== false;
      const open = state.isOpen(state.ids.group(ev.__id, cat), defaultOpen);

      head.setAttribute('aria-expanded', String(open));
      head.dataset.defaultOpen = String(defaultOpen);
      gBody.hidden = !open;
    }
  }

  /** Il badge del canale è il più importante del pannello: va spiegato. */
  function describeChannel(source) {
    switch (source) {
      case 'network':
        return 'Osservato sulla rete: è ciò che il vendor ha effettivamente ricevuto.';
      case 'hook':
        return 'Osservato solo tramite hook JavaScript: nessuna chiamata di rete ' +
               'corrispondente. Il tag potrebbe non aver sparato — consenso negato, ' +
               'trigger mancante, tag in pausa o errore JS.';
      case 'hook+network':
      case 'datalayer+network':
        return 'Osservato su entrambi i canali: hit confermata e arricchita con i ' +
               'nomi delle variabili sorgente.';
      case 'datalayer':
        return 'Push nel dataLayer: è l\'input dato al tag manager, non una hit.';
      case 'polling':
        return 'Osservato tramite polling su data element: euristica best-effort, ' +
               'il contenuto può non corrispondere all\'evento inviato.';
      default:
        return 'Canale di osservazione non determinato.';
    }
  }

  /* ─────────────────────── corpo dell'evento ─────────────────────── */

  function buildEventBody(body, ev, ctx) {
    const warn = body.querySelector('[data-warning]');
    const groups = body.querySelector('[data-groups]');
    const products = body.querySelector('[data-products]');
    const raw = body.querySelector('[data-raw]');

    groups.textContent = '';
    products.textContent = '';
    products.hidden = true;

    /* 1. Avviso in cima: "nessuna hit di rete osservata" è la diagnosi più utile
          del tool, quindi non va cercata tra i campi. */
    const warning = ev.meta && ev.meta.warning;
    if (warning) {
      warn.textContent = '⚠ ' + warning;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    /* 2. Nota sul batch: gli eventi batchati sono partiti nello stesso istante,
          quindi i delta ms tra loro non riflettono momenti di chiamata distinti.
          Va detto, o si deduce una cronologia inesistente. */
    if (ev.meta && ev.meta.batch) {
      const note = document.createElement('p');
      note.className = 'uad-event__note';
      note.textContent = `Batch ${ev.meta.batch}: inviato nella stessa richiesta ` +
                         'di altri eventi — i tempi relativi non sono significativi.';
      groups.appendChild(note);
    }

    /* 3. Categorie, in ordine COSA -> COME, con stato iniziale dai Settings. */
    const cf = ev.categorizedFields || {};
    for (const cat of sortCategories(Object.keys(cf))) {
      let rows = cf[cat] || [];
      if (!ctx.showAll) rows = rows.filter(r => !isEmptyValue(r.value));
      if (!rows.length) continue;
      const g = renderGroup(ev, cat, rows, ctx);
      if (g) groups.appendChild(g);
    }

    /* 4. Prodotti. */
    if (Array.isArray(ev.products) && ev.products.length) {
      products.hidden = false;
      ev.products.forEach((p, i) => {
        const pe = renderProduct(p, i, ctx);
        if (pe) products.appendChild(pe);
      });
    }

    /* 5. Nota del serializer: se i dati sono stati potati va dichiarato,
          altrimenti l'utente li crede completi. */
    const ser = ev.meta && ev.meta.serializer;
    if (ser && (ser.truncatedStrings || ser.droppedItems || ser.depthHits || ser.budgetExceeded)) {
      const bits = [];
      if (ser.truncatedStrings) bits.push(`${ser.truncatedStrings} valori troncati`);
      if (ser.droppedItems)     bits.push(`${ser.droppedItems} elementi omessi`);
      if (ser.depthHits)        bits.push(`${ser.depthHits} rami tagliati per profondità`);
      if (ser.budgetExceeded)   bits.push('payload oltre il limite di dimensione');
      const note = document.createElement('p');
      note.className = 'uad-event__warning';
      note.textContent = '⚠ Dati parzialmente potati: ' + bits.join(', ') + '.';
      groups.appendChild(note);
    }

    /* 6. Payload grezzo, sempre ultimo. */
    if (ev.rawDebugString) {
      raw.hidden = false;
      raw.querySelector('[data-raw-content]').textContent = ev.rawDebugString;
    } else {
      raw.hidden = true;
    }
  }

  /* ───────────────────────────── gruppo ───────────────────────────── */

  function renderGroup(ev, cat, rows, ctx) {
    const el = tpl('tpl-group');
    if (!el) return null;

    el.dataset.category = cat;
    el.querySelector('[data-name]').textContent = cat;
    el.querySelector('[data-count]').textContent = String(rows.length);

    const head = el.querySelector('.uad-group__head');
    const body = el.querySelector('[data-body]');
    const openId = state.ids.group(ev.__id, cat);

    /**
     * Lo stato iniziale arriva dai Settings: è un DEFAULT, non un vincolo. Una
     * deviazione esplicita dell'utente su questo evento vince, ed è state.js a
     * gestirlo. Il default viene passato a isOpen() perché state.js memorizza
     * solo le deviazioni: senza conoscerlo non saprebbe cosa considerare
     * "normale".
     */
    const defaultOpen = categoryOpen(cat) !== false;
    const open = state.isOpen(openId, defaultOpen);

    head.setAttribute('aria-expanded', String(open));
    head.dataset.toggleId = openId;
    head.dataset.level = 'group';
    // panel.js legge questo per calcolare il toggle corretto: senza il default,
    // il primo click su un gruppo chiuso non lo aprirebbe.
    head.dataset.defaultOpen = String(defaultOpen);
    body.hidden = !open;

    /**
     * Le righe si costruiscono SEMPRE, anche a gruppo chiuso.
     *
     * Se le costruissimo solo quando aperto, il click sul gruppo dovrebbe
     * innescare un re-render dell'intero corpo dell'evento per popolarlo — e
     * quel re-render non avviene, perché la firma del corpo non cambia.
     * Costruendole sempre, aprire un gruppo è solo `hidden = false`, che
     * panel.js applica direttamente e istantaneamente.
     */
    const wrap = el.querySelector('[data-rows]');
    for (const r of rows) {
      const row = renderRow(r, ctx);
      if (row) wrap.appendChild(row);
    }

    return el;
  }

  /* ─────────────────────────── riga key-value ─────────────────────────── */

  function renderRow(r, ctx) {
    const el = tpl('tpl-row');
    if (!el) return null;

    el.dataset.keyName = r.key;
    setTextHighlighted(el.querySelector('[data-key]'), r.key, ctx.search);

    /**
     * Mappatura EDDL, tra chiave e valore.
     *
     * mapperFor() restituisce tre valori distinti:
     *   null    non applicabile — toggle spento, tab non Adobe, o chiave che non
     *           è una variabile Adobe
     *   ''      variabile riconosciuta ma ASSENTE dal mapper
     *   stringa la mappatura
     *
     * Il caso '' produce "non mappata" attenuato: senza distinguerlo da null,
     * l'utente non saprebbe se il toggle non funziona su quella riga o se la
     * variabile semplicemente non è nel mapper.
     */
    const mapping = mapperFor(r.key);
    if (mapping !== null && mapping !== undefined) {
      const mapEl = el.querySelector('[data-map]');
      if (mapEl) {
        if (mapping === '') {
          mapEl.textContent = 'non mappata';
          mapEl.dataset.none = 'true';
          mapEl.title = r.key + ' non è presente nel mapper EDDL rilevato';
        } else {
          // La mappatura è cercabile: evidenziamo anche qui i match.
          setTextHighlighted(mapEl, mapping, ctx.search);
          delete mapEl.dataset.none;
          mapEl.title = r.key + ' → ' + mapping;
        }
        mapEl.hidden = false;
      }
    }

    const text = displayValue(r.value);
    const valEl = el.querySelector('[data-value]');
    setTextHighlighted(valEl, text, ctx.search);
    // La delega di panel.js legge da qui il valore da copiare: nessuna closure
    // per riga, nessun listener per riga.
    valEl.dataset.copy = text;

    // `src` = nome della variabile sorgente. Lo conosce solo l'hook: la rete
    // riceve i parametri già mappati e non può saperlo.
    if (r.src) {
      const info = el.querySelector('[data-info]');
      info.hidden = false;
      info.title = 'sorgente: ' + r.src;
      info.dataset.src = r.src;
    }

    // Cross-check identity: il caso ⚠️ è quello che vale — significa utente
    // contato due volte, sessioni spezzate, attribuzione rotta.
    const cc = r.crossCheck || crossCheck(r.key, r.value);
    if (cc) {
      const ccEl = el.querySelector('[data-crosscheck]');
      ccEl.hidden = false;
      ccEl.textContent = cc.ok ? '🔗' : '⚠️';
      ccEl.title = cc.message || '';
      ccEl.dataset.ok = String(!!cc.ok);
    }

    return el;
  }

  /* ─────────────────────────── prodotto ─────────────────────────── */

  function renderProduct(p, index, ctx) {
    const el = tpl('tpl-product');
    if (!el) return null;

    el.dataset.index = String(index);
    el.querySelector('[data-idx]').textContent = `#${index + 1}`;
    setTextHighlighted(
      el.querySelector('[data-name]'),
      p.name || p.SKU || p.item_id || p.id || `prodotto ${index + 1}`,
      ctx.search
    );

    const wrap = el.querySelector('[data-rows]');
    const entries = Array.isArray(p.fields)
      ? p.fields
      : Object.keys(p)
          .filter(k => k !== 'fields' && k !== 'name')
          .map(k => ({ key: k, value: p[k], src: null }));

    for (const r of entries) {
      if (!ctx.showAll && isEmptyValue(r.value)) continue;
      const row = renderRow(r, ctx);
      if (row) wrap.appendChild(row);
    }

    return el;
  }

  /* ───────────────────────────── tab ───────────────────────────── */

  function renderTabs(container, tools, ctx) {
    const existing = new Map();
    for (const child of Array.from(container.children)) {
      const id = child.dataset.toolId;
      if (id) existing.set(id, child);
      else child.remove();
    }

    let prev = null;
    for (const t of tools) {
      const meta = toolMeta(t.id);
      let el = existing.get(t.id);
      existing.delete(t.id);

      if (!el) {
        el = tpl('tpl-tab');
        if (!el) continue;
        el.dataset.toolId = t.id;
        el.style.setProperty('--tool-color', meta.color);
        el.querySelector('.uad-tab__label').textContent = meta.label;
        el.querySelector('.uad-tab__dot').style.background = meta.color;
      }

      el.querySelector('.uad-tab__count').textContent =
        ctx.filtering ? `${t.shown}/${t.total}` : String(t.total);

      const active = t.id === ctx.activeTool;
      el.setAttribute('aria-selected', String(active));
      el.classList.toggle('is-active', active);

      /**
       * Tool con eventi in memoria ma ora disattivato. Con rilevamento
       * automatico la tab resta visibile — i dati raccolti sono consultabili —
       * ma va detto che non si aggiorna più, altrimenti sembra che il tool abbia
       * smesso di funzionare senza motivo.
       */
      el.classList.toggle('is-stale', t.stale === true);
      if (t.stale) {
        el.title = meta.label + ' è disattivato nelle Impostazioni: questi sono ' +
                   'gli eventi già raccolti, non ne arriveranno di nuovi.';
      } else {
        el.removeAttribute('title');
      }

      // Il puntino live compare solo sulle tab NON attive: segnalare novità su
      // quella che stai guardando è rumore.
      el.querySelector('[data-live]').hidden = !t.hasLive || active;

      const target = prev ? prev.nextSibling : container.firstChild;
      if (el !== target) container.insertBefore(el, target);
      prev = el;
    }

    for (const el of existing.values()) el.remove();
  }

  /* ───────────────────────────── pane ───────────────────────────── */

  /**
   * @returns {{views:number, events:number, ids:string[]}}
   *   `ids` = tutti gli id di accordion presenti. Serve a collapseAll, che ha
   *   bisogno di deviazioni esplicite e non di svuotare lo stato, e alla garbage
   *   collection di state.js.
   */
  function renderPane(container, events, ctx) {
    const groups = groupByView(events);
    const ids = [];

    const existing = new Map();
    for (const child of Array.from(container.children)) {
      const id = child.dataset.viewId;
      if (id) existing.set(id, child);
      else child.remove();
    }

    let prev = null;
    for (const g of groups) {
      let el = existing.get(g.viewId);
      existing.delete(g.viewId);
      el = renderView(g, ctx, el);
      if (!el) continue;

      ids.push(state.ids.view(g.viewId));
      for (const ev of g.events) {
        ids.push(state.ids.event(ev.__id));
        for (const cat of Object.keys(ev.categorizedFields || {})) {
          ids.push(state.ids.group(ev.__id, cat));
        }
      }

      const target = prev ? prev.nextSibling : container.firstChild;
      if (el !== target) container.insertBefore(el, target);
      prev = el;
    }

    for (const el of existing.values()) el.remove();

    return { views: groups.length, events: events.length, ids };
  }

  /* ───────────────────────── match per la ricerca ───────────────────────── */

  /**
   * Elementi che contengono un match, in ordine di documento. Usati dalle frecce
   * prev/next della ricerca. I <mark> dentro gruppi chiusi vengono esclusi:
   * puntare a un match invisibile porterebbe su un nodo vuoto.
   */
  function collectMatches(container) {
    const seen = new Set();
    const out = [];
    for (const m of container.querySelectorAll('mark')) {
      const gBody = m.closest('.uad-group__body');
      if (gBody && gBody.hidden) continue;
      const host = m.closest('.uad-event') || m.closest('.uad-view');
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push(host);
    }
    return out;
  }

  return {
    renderTabs,
    renderPane,
    collectMatches,
    sortCategories,
    // esportate per panel.js, cookies.js e i test
    fmtClock, fmtDelta, shortUrl, displayValue, isEmptyValue, setTextHighlighted
  };
}