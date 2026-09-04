/**
 * Universal Analytics Debugger — ricerca
 * Contesto: pagina di estensione (panel), ES module
 *
 * COSA FA
 *   - matching su nomi evento, chiavi, valori, categorie, URL
 *   - contatore N/Totale con frecce prev/next e scroll automatico al salto
 *   - espansione automatica dei soli rami che contengono match
 *   - ripristino esatto dello stato accordion quando la ricerca viene svuotata
 *   - badge "nuovi match" per gli eventi live che soddisfano la query
 *
 * DUE REGOLE NON NEGOZIABILI
 *
 * 1. NESSUNO SCROLL AUTOMATICO sui nuovi match. Se un evento live entra nei
 *    risultati mentre l'utente sta leggendo, si mostra un badge cliccabile: il
 *    salto avviene solo su richiesta. Rubare lo scroll a chi sta leggendo un
 *    payload e' il modo piu rapido per rendere inutile un debugger.
 *
 * 2. SNAPSHOT PRESO UNA VOLTA SOLA. Il handler dell'input scatta a ogni
 *    carattere: senza il guard di idempotenza in state.js, ogni battuta
 *    salverebbe lo stato GIA espanso e il ripristino finale non riporterebbe
 *    nulla.
 *
 * PERCHE IL MATCHING E' QUI E NON IN render.js
 * render.js evidenzia (setTextHighlighted) ma non decide: la decisione "questo
 * evento entra nei risultati" serve anche ai contatori delle tab e al badge dei
 * nuovi match, cioe fuori dal DOM.
 */

'use strict';

const DEBOUNCE_MS = 140;
const SNAPSHOT_KEY = 'search';

/** Oltre questa soglia la ricerca lavora sul solo tool attivo. */
const CROSS_TOOL_LIMIT = 3000;

export function createSearch(deps) {
  // deps = { state, getEvents, getAllEvents, onChange, displayValue,
  //          scrollContainer, toast }

  const { state, getEvents, onChange } = deps;
  const displayValue = deps.displayValue || (v => String(v ?? ''));

  const $ = (s) => document.querySelector(s);

  const el = {
    input:   $('#search-input'),
    count:   $('#search-count'),
    prev:    $('#search-prev'),
    next:    $('#search-next'),
    clear:   $('#search-clear'),
    newMatch:$('#new-match'),
    newText: $('#new-match-text')
  };

  const st = {
    query: '',
    matches: [],        // elementi DOM, aggiornati dal renderer
    index: -1,
    newMatches: 0,
    debounce: null,
    lastFlashed: null
  };

  /* ═══════════════════════════════ matching ═══════════════════════════════ */

  /**
   * Un evento entra nei risultati se la query compare in: nome evento, URL,
   * nome categoria, chiave o valore di un campo, canale, o nome prodotto.
   * Il canale e' incluso deliberatamente: cercare "hook" mostra tutti gli
   * eventi senza hit di rete corrispondente, che e' una query diagnostica utile.
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
        // trovare l'evento che la usa, anche se il nome mappato e' diverso.
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
   * Indica quali categorie di un evento contengono match: serve a espandere
   * SOLO i gruppi rilevanti, invece di aprire tutto e sommergere l'utente.
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
   * Apre view, evento e gruppi che contengono match. Chiamata dopo ogni
   * cambio query, prima del render.
   */
  function expandMatchingBranches(events, query) {
    if (!query) return;

    // Cap: su un sito con migliaia di eventi, aprire tutti i rami produrrebbe
    // decine di migliaia di nodi. Espandiamo i primi 200 match: le frecce
    // prev/next coprono il resto aprendo su richiesta.
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
  }

  /**
   * Salta al match successivo o precedente.
   * @param {number} delta +1 | -1
   */
  function goto(delta) {
    if (!st.matches.length) return;

    st.index = (st.index + delta + st.matches.length) % st.matches.length;
    const target = st.matches[st.index];
    if (!target) return;

    // Se il match e' dentro un ramo che l'utente ha chiuso a mano, lo
    // riapriamo: altrimenti il salto porterebbe su un nodo invisibile.
    const view = target.closest('.uad-view');
    if (view && view.dataset.viewId) {
      state.setOpen(state.ids.view(view.dataset.viewId), true);
    }
    if (target.dataset.eventId) {
      state.setOpen(state.ids.event(target.dataset.eventId), true);
    }

    // Lo scroll avviene dopo il render conseguente all'espansione.
    requestAnimationFrame(() => {
      const live = document.querySelector(
        target.dataset.eventId
          ? `[data-event-id="${cssEscape(target.dataset.eventId)}"]`
          : `[data-view-id="${cssEscape(view?.dataset.viewId || '')}"]`
      ) || target;

      live.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(live);
    });

    updateCounter();
  }

  function flash(node) {
    if (st.lastFlashed) st.lastFlashed.classList.remove('is-current-match');
    node.classList.add('is-current-match');
    st.lastFlashed = node;
    setTimeout(() => {
      node.classList.remove('is-current-match');
      if (st.lastFlashed === node) st.lastFlashed = null;
    }, 1400);
  }

  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
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

    // Gli eventi nuovi sono in fondo: puntiamo al primo dei nuovi arrivati,
    // cosi l'utente li vede in ordine invece di partire dall'ultimo.
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
    clearNewMatches();

    if (next && !wasActive) {
      // Fotografia dello stato accordion prima di alterarlo. Idempotente: le
      // battute successive non sovrascrivono.
      state.setForceExpand(true, SNAPSHOT_KEY);
    } else if (!next && wasActive) {
      // Ripristino esatto dello stato precedente all'inizio della ricerca.
      state.setForceExpand(false, SNAPSHOT_KEY);
    }

    if (next) {
      const events = getEvents();
      expandMatchingBranches(events, next);
    }

    onChange && onChange(immediate === true);
  }

  /**
   * Aggiornata dal renderer dopo ogni render: gli elementi DOM cambiano
   * identita, quindi la lista dei match va ricostruita.
   */
  function setMatches(nodes) {
    st.matches = Array.isArray(nodes) ? nodes : [];
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
        // Invio applica subito la query se il debounce e' ancora pendente,
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
      setQuery('', true);
    },

    debug: () => ({
      query: st.query,
      matches: st.matches.length,
      index: st.index,
      newMatches: st.newMatches
    })
  };
}