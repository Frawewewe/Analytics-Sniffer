/**
 * Analytics Sniffer — rendering degli accordion
 * Contesto: pagina di estensione (panel), ES module
 *
 * v7 — la navigazione punta alla RIGA, non all'intero evento.
 *
 * COSA ERA SBAGLIATO
 * collectMatches() trovava un <mark>, risaliva con closest('.uad-event') e
 * restituiva l'intero evento. Poi search.js applicava is-current-match a quel
 * nodo, illuminando 200 righe per evidenziarne una. L'informazione precisa
 * c'era — il <mark> — e la buttavamo via.
 *
 * COME È RISOLTO
 * collectMatches() e collectFilterMatches() restituiscono i <mark> stessi.
 * search.js e filters.js risalgono alla riga (.uad-row) e illuminano quella. Se
 * il match è nel nome evento o nell'URL della view, dove non esiste una riga, si
 * illumina quell'header: non c'è alternativa.
 *
 * Ogni <mark> riceve un data-mark-id progressivo, perché dopo un re-render il
 * riferimento al nodo è stale e serve un identificatore stabile per ritrovarlo.
 *
 * DUE EVIDENZIAZIONI, DUE COLORI
 * La ricerca usa <mark>, i filtri <mark data-filter>. Con entrambi attivi devi
 * poter distinguere cosa ha fatto match per cosa.
 *
 * PRINCIPIO: RENDERING PURO
 * Questo modulo NON prende decisioni e NON registra listener. Riceve dati più
 * stato e produce DOM. Gli handler li aggancia panel.js per DELEGA su contenitori
 * stabili: con 2000 eventi × 3 livelli, un listener per nodo significherebbe
 * migliaia di closure ricreate a ogni render.
 *
 * SICUREZZA
 * Solo textContent, mai innerHTML. I valori del dataLayer possono contenere HTML
 * arbitrario. L'unica costruzione di nodi è quella dei <mark>, fatta
 * programmaticamente.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   1. ORDINE DELLE CATEGORIE — COSA prima, COME dopo
   ═══════════════════════════════════════════════════════════════════════════

   Chi apre un evento vuole sapere PRIMA cosa è stato misurato (nome evento,
   parametri, prodotti, eVars), e solo DOPO come è stato spedito (identity,
   consenso, configurazione, endpoint).

   Le categorie non elencate finiscono nella fascia UNKNOWN, cioè subito prima del
   blocco tecnico: un connettore nuovo resta leggibile senza modifiche qui.

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
   4. Evidenziazione
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Contatore progressivo dei <mark>, azzerato a ogni render completo.
 *
 * Serve perché dopo un re-render il riferimento a un nodo <mark> è stale: aprire
 * un accordion per raggiungere un match ricostruisce il DOM, e il nodo salvato
 * non esiste più. Con un id stabile lo ritroviamo con querySelector.
 */
let markSeq = 0;
function resetMarkSeq() { markSeq = 0; }

/**
 * Scrive `text` in `el` evidenziando i termini richiesti.
 *
 * Costruisce nodi <mark> programmaticamente: nessun innerHTML, nessuna
 * possibilità di injection dai valori del dataLayer.
 *
 * @param {Element}  el
 * @param {string}   text
 * @param {string}   searchTerm     termine della ricerca (mark viola)
 * @param {string[]} [filterTerms]  termini dei filtri (mark verde acqua)
 * @returns {number} occorrenze evidenziate
 */
export function setTextHighlighted(el, text, searchTerm, filterTerms) {
  const s = String(text ?? '');

  const terms = [];
  if (searchTerm) terms.push({ t: String(searchTerm).toLowerCase(), filter: false });
  if (Array.isArray(filterTerms)) {
    for (const f of filterTerms) {
      if (f) terms.push({ t: String(f).toLowerCase(), filter: true });
    }
  }

  if (!terms.length) { el.textContent = s; return 0; }

  const hay = s.toLowerCase();

  /**
   * Raccogliamo tutti gli intervalli da evidenziare, poi li fondiamo.
   * Serve perché ricerca e filtri possono corrispondere a porzioni sovrapposte
   * della stessa stringa: senza la fusione, i nodi <mark> si annidverebbero e il
   * testo verrebbe duplicato.
   */
  const ranges = [];
  for (const { t, filter } of terms) {
    if (!t) continue;
    let from = 0, guard = 0;
    // Il guard evita il loop patologico su una ricerca di un solo carattere
    // dentro un valore molto lungo.
    while (guard++ < 200) {
      const at = hay.indexOf(t, from);
      if (at === -1) break;
      ranges.push({ start: at, end: at + t.length, filter });
      from = at + t.length;
    }
  }

  if (!ranges.length) { el.textContent = s; return 0; }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      // Sovrapposizione: la ricerca vince sul filtro. Chi ha digitato qualcosa in
      // quel momento si aspetta di vedere il proprio colore.
      if (!r.filter) last.filter = false;
    } else {
      merged.push({ ...r });
    }
  }

  el.textContent = '';
  let cursor = 0;

  for (const r of merged) {
    if (r.start > cursor) {
      el.appendChild(document.createTextNode(s.slice(cursor, r.start)));
    }
    const mark = document.createElement('mark');
    mark.textContent = s.slice(r.start, r.end);
    // Id stabile per la navigazione: sopravvive alla perdita del riferimento al
    // nodo dopo un re-render.
    mark.dataset.markId = String(++markSeq);
    if (r.filter) mark.dataset.filter = 'true';
    el.appendChild(mark);
    cursor = r.end;
  }
  if (cursor < s.length) el.appendChild(document.createTextNode(s.slice(cursor)));

  return merged.length;
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
  // Se il pannello non fornisce le funzioni, i default sono innocui.
  const categoryOpen = deps.categoryOpen || (() => true);
  const mapperFor = deps.mapperFor || (() => null);

  /** Termini dei filtri per un target, o null. */
  function ft(ctx, target) {
    const t = ctx.filterTerms;
    if (!t) return null;
    const list = t[target];
    return (Array.isArray(list) && list.length) ? list : null;
  }

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
      ctx.search,
      ft(ctx, 'url')
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
      // Il contenuto di una view chiusa non si costruisce: su 40 view SPA sarebbe
      // lavoro buttato.
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

    // Il nome può contenere match: sempre riscritto.
    setTextHighlighted(
      el.querySelector('[data-name]'),
      ev.eventName || 'hit',
      ctx.search,
      ft(ctx, 'eventName')
    );

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
       *   search             evidenziazione della ricerca
       *   filterVersion      evidenziazione dei filtri
       *   crossCheckVersion  l'indice identity dai cookie è arrivato
       *   catVersion         lo stato iniziale delle categorie è cambiato
       *   mapperVersion      il toggle o la mappa EDDL sono cambiati
       *
       * NOTA: lo stato aperto/chiuso dei singoli GRUPPI non è nella firma, e non
       * deve esserci. I gruppi si aprono cambiando `hidden`, cosa che panel.js fa
       * direttamente: rimetterli nella firma significherebbe ricostruire 200
       * righe a ogni click su un sotto-accordion.
       */
      const sig = [
        ctx.showAll ? 1 : 0,
        ctx.search || '',
        ctx.filterVersion || '',
        ctx.crossCheckVersion || 0,
        ctx.catVersion || 0,
        ctx.mapperVersion || 0
      ].join('|');

      if (body.dataset.built !== sig) {
        buildEventBody(body, ev, ctx);
        body.dataset.built = sig;
      } else {
        // Il contenuto è già corretto, ma lo stato dei gruppi può essere cambiato
        // altrove (collapseAll, ricerca, ripristino da storage): riallineiamo solo
        // gli attributi, senza ricostruire nulla.
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

    // Il nome della categoria può essere un match dei filtri.
    setTextHighlighted(
      el.querySelector('[data-name]'),
      cat,
      ctx.search,
      ft(ctx, 'category')
    );
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
    // panel.js legge questo per calcolare il toggle corretto: senza il default, il
    // primo click su un gruppo chiuso non lo aprirebbe.
    head.dataset.defaultOpen = String(defaultOpen);
    body.hidden = !open;

    /**
     * Le righe si costruiscono SEMPRE, anche a gruppo chiuso.
     *
     * Se le costruissimo solo quando aperto, il click sul gruppo dovrebbe
     * innescare un re-render dell'intero corpo dell'evento per popolarlo — e quel
     * re-render non avviene, perché la firma del corpo non cambia. Costruendole
     * sempre, aprire un gruppo è solo `hidden = false`, che panel.js applica
     * direttamente e istantaneamente.
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

    // La chiave si illumina se un filtro agisce sulle chiavi. Filtrando "chiave
    // contiene item", i valori che contengono "item" NON si illuminano: mostrare
    // come causa del match qualcosa che non lo è sarebbe fuorviante.
    setTextHighlighted(
      el.querySelector('[data-key]'),
      r.key,
      ctx.search,
      ft(ctx, 'key')
    );

    /**
     * Mappatura EDDL, tra chiave e valore.
     *
     * mapperFor() restituisce tre valori distinti:
     *   null    non applicabile — toggle spento, tab non Adobe, o chiave che non è
     *           una variabile Adobe
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
          setTextHighlighted(mapEl, mapping, ctx.search, ft(ctx, 'mapping'));
          delete mapEl.dataset.none;
          mapEl.title = r.key + ' → ' + mapping;
        }
        mapEl.hidden = false;
      }
    }

    const text = displayValue(r.value);
    const valEl = el.querySelector('[data-value]');
    setTextHighlighted(valEl, text, ctx.search, ft(ctx, 'value'));
    // La delega di panel.js legge da qui il valore da copiare: nessuna closure per
    // riga, nessun listener per riga.
    valEl.dataset.copy = text;

    // `src` = nome della variabile sorgente. Lo conosce solo l'hook: la rete
    // riceve i parametri già mappati e non può saperlo.
    if (r.src) {
      const info = el.querySelector('[data-info]');
      info.hidden = false;
      info.title = 'sorgente: ' + r.src;
      info.dataset.src = r.src;
      // Un filtro su `src` marca la riga: il tooltip non è visibile a colpo
      // d'occhio, quindi serve un segnale sull'icona stessa.
      const srcTerms = ft(ctx, 'src');
      if (srcTerms && srcTerms.some(t => r.src.toLowerCase().includes(t.toLowerCase()))) {
        info.dataset.filterMatch = 'true';
      }
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
      ctx.search,
      ft(ctx, 'value')
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
       * Tool con eventi in memoria ma ora disattivato. Con rilevamento automatico
       * la tab resta visibile — i dati raccolti sono consultabili — ma va detto
       * che non si aggiorna più, altrimenti sembra che il tool abbia smesso di
       * funzionare senza motivo.
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
    // Gli id dei <mark> ripartono da 1 a ogni render completo: sono validi solo
    // per il DOM corrente.
    resetMarkSeq();

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

  /* ─────────────────── raccolta dei match per la navigazione ─────────────── */

  /**
   * Descrive un <mark> in modo utilizzabile dalla navigazione.
   *
   * Restituiamo il TARGET su cui applicare l'evidenziazione — la riga, non
   * l'evento — più le informazioni per riaprire il ramo se necessario.
   *
   * @returns {{markId, target, row, event, view, eventId, viewId, key}|null}
   */
  function describeMark(mark) {
    if (!mark) return null;

    const row = mark.closest('.uad-row');
    const cookie = mark.closest('.uad-cookie');
    const event = mark.closest('.uad-event');
    const view = mark.closest('.uad-view');

    /**
     * Il target dell'evidenziazione, in ordine di specificità:
     *   1. la riga key-value che contiene il match
     *   2. l'header dell'evento, se il match è nel nome
     *   3. l'header della view, se il match è nell'URL
     * Nei casi 2 e 3 non esiste una riga: illuminare l'header è l'unica opzione
     * sensata, ed è comunque preciso perché quegli header sono di una sola riga.
     */
    let target = row || cookie;
    if (!target) {
      if (mark.closest('.uad-event__head')) target = mark.closest('.uad-event__head');
      else if (mark.closest('.uad-view__head')) target = mark.closest('.uad-view__head');
      else target = event || view;
    }
    if (!target) return null;

    return {
      markId:  mark.dataset.markId || null,
      target:  target,
      row:     row || null,
      event:   event || null,
      view:    view || null,
      eventId: event ? event.dataset.eventId : null,
      viewId:  view ? view.dataset.viewId : null,
      // La categoria del gruppo che contiene la riga: serve per riaprirlo.
      category: row ? (row.closest('.uad-group')?.dataset.category || null) : null,
      isFilter: mark.dataset.filter === 'true'
    };
  }

  /**
   * Match della RICERCA, in ordine di documento.
   *
   * Restituisce descrittori di singole occorrenze, non eventi interi: la
   * navigazione deve poter illuminare la riga precisa. I <mark> dentro gruppi
   * chiusi vengono esclusi — puntare a un match invisibile porterebbe su un nodo
   * vuoto.
   */
  function collectMatches(container) {
    const out = [];
    for (const m of container.querySelectorAll('mark:not([data-filter])')) {
      const gBody = m.closest('.uad-group__body');
      if (gBody && gBody.hidden) continue;
      const d = describeMark(m);
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * Match dei FILTRI.
   *
   * Se i filtri producono evidenziazione, restituiamo le singole occorrenze come
   * per la ricerca. Altrimenti — operatori negati, isEmpty, regex, che
   * corrispondono senza illuminare nulla — ripieghiamo sugli eventi: sono
   * comunque quelli filtrati, perché renderPane riceve la lista già filtrata da
   * panel.js.
   */
  function collectFilterMatches(container) {
    const marks = container.querySelectorAll('mark[data-filter]');

    if (marks.length) {
      const out = [];
      for (const m of marks) {
        const gBody = m.closest('.uad-group__body');
        if (gBody && gBody.hidden) continue;
        const d = describeMark(m);
        if (d) out.push(d);
      }
      if (out.length) return out;
    }

    // Fallback: nessuna evidenziazione, navighiamo tra gli eventi.
    return Array.from(container.querySelectorAll('.uad-event[data-event-id]'))
      .filter(el => {
        const vBody = el.closest('.uad-view__body');
        return !(vBody && vBody.hidden);
      })
      .map(el => ({
        markId: null,
        target: el.querySelector('.uad-event__head') || el,
        row: null,
        event: el,
        view: el.closest('.uad-view'),
        eventId: el.dataset.eventId,
        viewId: el.closest('.uad-view')?.dataset.viewId || null,
        category: null,
        isFilter: true
      }));
  }

  /**
   * Ritrova il descrittore di un match dopo un re-render.
   *
   * Aprire un accordion per raggiungere un match ricostruisce il DOM: i nodi
   * salvati sono stale. Con markId ritroviamo l'occorrenza esatta; senza,
   * ripieghiamo sull'evento.
   */
  function relocateMatch(container, desc) {
    if (!desc) return null;

    if (desc.markId) {
      const m = container.querySelector(`mark[data-mark-id="${desc.markId}"]`);
      if (m) return describeMark(m);
    }

    if (desc.eventId) {
      const ev = container.querySelector(
        `.uad-event[data-event-id="${cssEscape(desc.eventId)}"]`
      );
      if (ev) {
        return {
          ...desc,
          target: ev.querySelector('.uad-event__head') || ev,
          event: ev,
          row: null
        };
      }
    }

    return null;
  }

  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  return {
    renderTabs,
    renderPane,
    collectMatches,
    collectFilterMatches,
    relocateMatch,
    sortCategories,
    // esportate per panel.js, cookies.js e i test
    fmtClock, fmtDelta, shortUrl, displayValue, isEmptyValue, setTextHighlighted
  };
}