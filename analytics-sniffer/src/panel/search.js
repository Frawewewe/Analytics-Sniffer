/**
 * Analytics Sniffer — ricerca
 * Contesto: pagina di estensione (panel), ES module
 *
 * v2 — la navigazione illumina la RIGA, non l'intero evento.
 *
 * COSA ERA SBAGLIATO
 * render.js restituiva l'evento contenitore invece del <mark>, e applicavamo
 * is-current-match a quel nodo: 200 righe illuminate per evidenziarne una.
 *
 * COME È RISOLTO
 * collectMatches() restituisce descrittori di singole occorrenze:
 *   { markId, target, row, event, view, eventId, viewId, category }
 * Il `target` è la riga quando esiste, l'header dell'evento se il match è nel
 * nome, l'header della view se è nell'URL. L'evidenziazione va su quello.
 *
 * Dopo l'apertura di un ramo il DOM viene ricostruito e i nodi salvati sono
 * stale: relocateMatch() ritrova l'occorrenza con markId.
 *
 * DUE REGOLE NON NEGOZIABILI
 *
 * 1. NESSUNO SCROLL AUTOMATICO sui nuovi match. Se un evento live entra nei
 *    risultati mentre l'utente legge, si mostra un badge cliccabile: il salto
 *    avviene solo su richiesta. Rubare lo scroll a chi sta leggendo un payload è
 *    il modo più rapido per rendere inutile un debugger.
 *
 * 2. SNAPSHOT PRESO UNA VOLTA SOLA. Il handler dell'input scatta a ogni carattere:
 *    senza il guard di idempotenza in state.js, ogni battuta salverebbe lo stato
 *    GIÀ espanso e il ripristino finale non riporterebbe nulla.
 */

'use strict';

const DEBOUNCE_MS = 140;
const SNAPSHOT_KEY = 'search';

/** Durata dell'evidenziazione del match corrente. */
const FLASH_MS = 1600;

export function createSearch(deps) {
  // deps = { state, getEvents, onChange, displayValue, renderer, container }

  const { state, onChange } = deps;
  const displayValue = deps.displayValue || (v => String(v ?? ''));
  const getEvents = deps.getEvents || (() => []);

  const $ = (s) => document.querySelector(s);

  const el = {
    input:    $('#search-input'),
    count:    $('#search-count'),
    prev:     $('#search-prev'),
    next:     $('#search-next'),
    clear:    $('#search-clear'),
    newMatch: $('#new-match'),
    newText:  $('#new-match-text')
  };

  const st = {
    query: '',
    matches: [],        // descrittori da render.collectMatches()
    index: -1,
    newMatches: 0,
    debounce: null,
    flashed: null,      // nodo attualmente evidenziato
    flashTimer: null
  };

  /* ═══════════════════════════════ matching ═══════════════════════════════ */

  /**
   * Un evento entra nei risultati se la query compare in: nome evento, URL, nome
   * categoria, chiave o valore di un campo, canale, variabile sorgente, o nome
   * prodotto.
   *
   * Il canale è incluso deliberatamente: cercare "hook" mostra tutti gli eventi
   * senza hit di rete corrispondente, che è una query diagnostica utile.
   */
  function matches(ev, query) {
    if (!query) return true;
    const q = query.toLowerCase();

    if (String(ev.eventName || '').toLowerCase().includes(q)) return true;
    if (String(ev.source || '').toLowerCase().includes(q)) return true;
    if (String(ev.viewUrl || ev.pageUrl || '').toLowerCase().includes(q)) return true;

    const cf = ev.categorizedFields || {};
    for (const cat of Object.keys(cf)) {
      if (cat.toLowerCase().includes(q)) return true;
      const rows = cf[cat] || [];
      for (const r of rows) {
        if (String(r.key).toLowerCase().includes(q)) return true;
        if (displayValue(r.value).toLowerCase().includes(q)) return true;
        // `src` incluso: cercare il nome di una variabile del dataLayer deve
        // trovare l'evento che la usa, anche se il nome mappato è diverso.
        if (r.src && String(r.src).toLowerCase().includes(q)) return true;
      }
    }

    if (Array.isArray(ev.products)) {
      for (const p of ev.products) {
        if (String(p.name || p.SKU || '').toLowerCase().includes(q)) return true;
        const fields = Array.isArray(p.fields) ? p.fields : [];
        for (const r of fields) {
          if (String(r.key).toLowerCase().includes(q)) return true;
          if (displayValue(r.value).toLowerCase().includes(q)) return true;
        }
      }
    }

    if (ev.meta && ev.meta.warning &&
        String(ev.meta.warning).toLowerCase().includes(q)) return true;

    return false;
  }

  /**
   * Indica quali categorie di un evento contengono match: serve a espandere SOLO
   * i gruppi rilevanti, invece di aprire tutto e sommergere l'utente.
   */
  function matchingCategories(ev, query) {
    if (!query) return [];
    const q = query.toLowerCase();
    const out = [];
    const cf = ev.categorizedFields || {};

    for (const cat of Object.keys(cf)) {
      if (cat.toLowerCase().includes(q)) { out.push(cat); continue; }
      const rows = cf[cat] || [];
      const hit = rows.some(r =>
        String(r.key).toLowerCase().includes(q) ||
        displayValue(r.value).toLowerCase().includes(q) ||
        (r.src && String(r.src).toLowerCase().includes(q))
      );
      if (hit) out.push(cat);
    }
    return out;
  }

  /* ═══════════════════════ espansione dei rami ═══════════════════════ */

  /**
   * Apre view, evento e gruppi che contengono match. Chiamata dopo ogni cambio
   * query, prima del render.
   *
   * Cap a 200 match: su un sito con migliaia di eventi, aprire tutti i rami
   * produrrebbe decine di migliaia di nodi. Le frecce prev/next aprono su
   * richiesta ciò che serve.
   */
  function expandMatchingBranches(events, query) {
    if (!query) return;

    let expanded = 0;
    for (const ev of events) {
      if (expanded >= 200) break;
      if (!matches(ev, query)) continue;

      state.expandPath({
        viewId: ev.viewId || ev.pageSessionId,
        eventId: ev.__id
      });

      for (const cat of matchingCategories(ev, query)) {
        state.expandPath({ eventId: ev.__id, category: cat });
      }
      expanded++;
    }
  }

  /* ═════════════════════════ contatore e frecce ═════════════════════════ */

  function updateCounter() {
    const active = !!st.query;
    const n = st.matches.length;

    el.count.hidden = !active;
    el.count.textContent = n
      ? `${st.index >= 0 ? st.index + 1 : 1}/${n}`
      : '0/0';

    el.prev.hidden = !active || n < 2;
    el.next.hidden = !active || n < 2;
    el.clear.hidden = !active;

    // Stato "nessun risultato": lo diciamo nel contatore invece di lasciare un
    // campo di ricerca apparentemente funzionante.
    el.count.dataset.empty = String(active && n === 0);

    // Il contatore conta OCCORRENZE, non eventi: se una stringa appare in 5 righe
    // dello stesso evento sono 5 posti da controllare. Il tooltip lo dichiara,
    // altrimenti un numero alto sembra un errore.
    if (active && n) {
      const events = new Set(st.matches.map(m => m.eventId).filter(Boolean));
      el.count.title = n + ' occorrenz' + (n === 1 ? 'a' : 'e') +
                       (events.size ? ' in ' + events.size + ' event' + (events.size === 1 ? 'o' : 'i') : '');
    } else {
      el.count.title = '';
    }
  }

  /* ═══════════════════════ evidenziazione del match ═══════════════════════ */

  function clearFlash() {
    if (st.flashTimer) { clearTimeout(st.flashTimer); st.flashTimer = null; }
    if (st.flashed) {
      st.flashed.classList.remove('is-current-match');
      st.flashed = null;
    }
  }

  /**
   * Illumina il target del match: la riga, oppure l'header se il match è nel nome
   * evento o nell'URL.
   *
   * Il <mark> corrispondente riceve anche una classe propria, così dentro una riga
   * con più occorrenze si distingue quella corrente.
   */
  function flash(desc) {
    clearFlash();
    if (!desc || !desc.target) return;

    desc.target.classList.add('is-current-match');
    st.flashed = desc.target;

    // Marca l'occorrenza esatta dentro il target.
    if (desc.markId) {
      const container = deps.container || document.getElementById('panes');
      const m = container?.querySelector(`mark[data-mark-id="${desc.markId}"]`);
      if (m) {
        document.querySelectorAll('mark.is-current').forEach(x => x.classList.remove('is-current'));
        m.classList.add('is-current');
      }
    }

    st.flashTimer = setTimeout(() => {
      clearFlash();
      document.querySelectorAll('mark.is-current').forEach(x => x.classList.remove('is-current'));
    }, FLASH_MS);
  }

  /* ═══════════════════════════ navigazione ═══════════════════════════ */

  /**
   * Salta al match successivo o precedente.
   * @param {number} delta +1 | -1
   */
  function goto(delta) {
    if (!st.matches.length) return;

    st.index = (st.index + delta + st.matches.length) % st.matches.length;
    const desc = st.matches[st.index];
    if (!desc) return;

    // Se il match è dentro un ramo che l'utente ha chiuso a mano, lo riapriamo:
    // altrimenti il salto porterebbe su un nodo invisibile.
    let reopened = false;

    if (desc.viewId) {
      const id = state.ids.view(desc.viewId);
      if (!state.isOpen(id)) { state.setOpen(id, true); reopened = true; }
    }
    if (desc.eventId) {
      const id = state.ids.event(desc.eventId);
      if (!state.isOpen(id)) { state.setOpen(id, true); reopened = true; }
    }
    if (desc.eventId && desc.category) {
      const id = state.ids.group(desc.eventId, desc.category);
      // Il default della categoria non è noto qui: passiamo true perché stiamo
      // aprendo esplicitamente, non calcolando uno stato.
      if (!state.isOpen(id, true)) { state.setOpen(id, true, true); reopened = true; }
    }

    /**
     * Se abbiamo riaperto qualcosa, il DOM viene ricostruito e il nodo salvato è
     * stale: attendiamo il render e ritroviamo l'occorrenza con markId. Se non
     * abbiamo riaperto nulla, il nodo è ancora valido e possiamo agire subito.
     */
    const act = () => {
      const container = deps.container || document.getElementById('panes');
      const live = (reopened && deps.renderer && container)
        ? (deps.renderer.relocateMatch(container, desc) || desc)
        : desc;

      if (live.target && live.target.isConnected) {
        live.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(live);
      }
      updateCounter();
    };

    if (reopened) requestAnimationFrame(() => requestAnimationFrame(act));
    else act();
  }

  /* ═════════════════════════ badge nuovi match ═════════════════════════ */

  /**
   * Chiamata da panel.js per ogni evento live. Non tocca lo scroll: incrementa
   * solo il contatore e mostra il badge.
   */
  function noteLiveEvent(ev) {
    if (!st.query) return false;
    if (!matches(ev, st.query)) return false;
    st.newMatches++;
    showNewMatchBadge();
    return true;
  }

  function showNewMatchBadge() {
    if (!st.newMatches) { el.newMatch.hidden = true; return; }
    el.newText.textContent =
      `${st.newMatches} nuovo${st.newMatches > 1 ? 'i' : ''} match`;
    el.newMatch.hidden = false;
  }

  function clearNewMatches() {
    st.newMatches = 0;
    el.newMatch.hidden = true;
  }

  /** Clic sul badge: solo qui avviene il salto. */
  function jumpToNewest() {
    const n = st.newMatches;
    clearNewMatches();
    if (!st.matches.length) return;

    // Gli eventi nuovi sono in fondo: puntiamo al primo dei nuovi arrivati, così
    // l'utente li vede in ordine invece di partire dall'ultimo.
    const target = Math.max(0, st.matches.length - n);
    st.index = target - 1;
    goto(1);
  }

  /* ═════════════════════════════ query ═════════════════════════════ */

  function setQuery(value, immediate) {
    const next = String(value ?? '').trim();
    if (next === st.query) return;

    const wasActive = !!st.query;
    st.query = next;
    st.index = -1;
    clearFlash();
    clearNewMatches();

    if (next && !wasActive) {
      // Fotografia dello stato accordion prima di alterarlo. Idempotente: le
      // battute successive non sovrascrivono.
      state.setForceExpand(true, SNAPSHOT_KEY);
    } else if (!next && wasActive) {
      // Ripristino esatto dello stato precedente all'inizio della ricerca.
      state.setForceExpand(false, SNAPSHOT_KEY);
    }

    if (next) expandMatchingBranches(getEvents(), next);

    onChange && onChange(immediate === true);
  }

  /**
   * Aggiornata dal renderer dopo ogni render: gli elementi DOM cambiano identità,
   * quindi la lista dei match va ricostruita.
   *
   * @param {Array} descriptors  da render.collectMatches()
   */
  function setMatches(descriptors) {
    st.matches = Array.isArray(descriptors) ? descriptors : [];
    if (st.index >= st.matches.length) st.index = st.matches.length - 1;
    updateCounter();
  }

  /* ═════════════════════════════ binding ═════════════════════════════ */

  function bind() {
    if (!el.input) return;

    el.input.addEventListener('input', () => {
      clearTimeout(st.debounce);
      st.debounce = setTimeout(() => setQuery(el.input.value), DEBOUNCE_MS);
    });

    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Invio applica subito la query se il debounce è ancora pendente,
        // altrimenti salta al match successivo.
        clearTimeout(st.debounce);
        const typed = el.input.value.trim();
        if (typed !== st.query) { setQuery(typed, true); return; }
        goto(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        el.input.value = '';
        clearTimeout(st.debounce);
        setQuery('', true);
        el.input.blur();
      }
    });

    el.next && el.next.addEventListener('click', () => goto(1));
    el.prev && el.prev.addEventListener('click', () => goto(-1));

    el.clear && el.clear.addEventListener('click', () => {
      el.input.value = '';
      clearTimeout(st.debounce);
      setQuery('', true);
      el.input.focus();
    });

    el.newMatch && el.newMatch.addEventListener('click', jumpToNewest);

    // Scorciatoie: il pannello vive in un iframe di DevTools, quindi
    // intercettiamo sul documento del pannello.
    document.addEventListener('keydown', (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '');

      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        el.input.focus();
        el.input.select();
        return;
      }
      if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && e.key === 'g')) {
        e.preventDefault();
        goto(e.shiftKey ? -1 : 1);
        return;
      }
      // '/' apre la ricerca solo fuori dai campi: dentro deve scrivere '/'.
      if (e.key === '/' && !inField) {
        e.preventDefault();
        el.input.focus();
      }
    });
  }

  bind();
  updateCounter();

  /* ═════════════════════════════ export ═════════════════════════════ */

  return {
    matches,                       // predicato usato anche dai contatori tab
    matchingCategories,
    get query() { return st.query; },
    get isActive() { return !!st.query; },
    get matchCount() { return st.matches.length; },
    get newMatchCount() { return st.newMatches; },

    setQuery,
    setMatches,
    goto,
    noteLiveEvent,
    clearNewMatches,

    /** Azzera tutto: usata dal pulsante "Azzera ricerca e filtri". */
    reset() {
      if (el.input) el.input.value = '';
      clearTimeout(st.debounce);
      clearFlash();
      setQuery('', true);
    },

    debug: () => ({
      query: st.query,
      matches: st.matches.length,
      index: st.index,
      newMatches: st.newMatches,
      currentTarget: st.matches[st.index]?.target?.className || null
    })
  };
}