/**
 * Analytics Sniffer — filtri avanzati
 * Contesto: pagina di estensione (panel), ES module
 *
 * v2 — due aggiunte:
 *   1. EVIDENZIAZIONE dei match. I valori dei filtri vengono evidenziati come
 *      la ricerca, ma in verde acqua invece che viola: con ricerca e filtri
 *      attivi insieme devi poter distinguere cosa ha fatto match per cosa.
 *      L'evidenziazione avviene solo nel campo pertinente — filtrando
 *      "chiave contiene item" si illuminano le chiavi, non i valori che
 *      contengono "item".
 *   2. NAVIGAZIONE tra i risultati: contatore N/Totale e frecce, che saltano
 *      tra gli EVENTI che soddisfano le condizioni. Non tra le singole
 *      occorrenze di testo: con un filtro su 200 righe, saltare occorrenza per
 *      occorrenza sarebbe inutile.
 *
 * PRECEDENZA DEGLI OPERATORI — decisione dichiarata
 * Valutiamo da SINISTRA A DESTRA senza precedenza di AND su OR.
 * "A AND B OR C" significa "(A AND B) OR C", non "A AND (B OR C)".
 * È la scelta di Notion e degli altri filtri a chip: senza parentesi visibili,
 * una precedenza implicita produrrebbe risultati che l'utente non riesce a
 * prevedere leggendo le righe dall'alto.
 *
 * SEMANTICA DI "NON CONTIENE" — il punto più delicato
 * Un evento ha molti valori per lo stesso campo (decine di chiavi, decine di
 * valori). "contiene X" è vero se ALMENO UNO corrisponde. Ma "non contiene X"
 * deve essere vero solo se NESSUNO corrisponde: usare la stessa logica di
 * "almeno uno" renderebbe il filtro inutile, perché su un evento con 40 campi
 * ce n'è sempre uno che non contiene la stringa cercata.
 */

'use strict';

const SNAPSHOT_KEY = 'filters';
const DEBOUNCE_MS = 160;
const STORAGE_KEY = 'uad_filters';
const MAX_ROWS = 10;

/* ═══════════════════════════════════════════════════════════════════════════
   Campi disponibili

   `target` dice a render.js DOVE evidenziare: filtrando "chiave contiene item"
   si illuminano le chiavi, non i valori. Senza questa distinzione
   l'evidenziazione sarebbe fuorviante.
   ═══════════════════════════════════════════════════════════════════════════ */

const FIELDS = {
  eventName: { label: 'Nome evento',        target: 'eventName' },
  key:       { label: 'Chiave',             target: 'key' },
  value:     { label: 'Valore',             target: 'value' },
  mapping:   { label: 'Mappatura EDDL',     target: 'mapping' },
  url:       { label: 'URL',                target: 'url' },
  category:  { label: 'Categoria',          target: 'category' },
  source:    { label: 'Canale',             target: null },
  src:       { label: 'Variabile sorgente', target: 'src' },
  status:    { label: 'Stato',              target: null },
  tool:      { label: 'Tool',               target: null }
};

const OPERATORS = {
  contains:    { label: 'contiene',     negated: false, highlight: true },
  equals:      { label: 'è uguale a',   negated: false, highlight: true },
  notContains: { label: 'non contiene', negated: true,  highlight: false },
  notEquals:   { label: 'è diverso da', negated: true,  highlight: false },
  startsWith:  { label: 'inizia con',   negated: false, highlight: true },
  endsWith:    { label: 'finisce con',  negated: false, highlight: true },
  regex:       { label: 'regex',        negated: false, highlight: true },
  isEmpty:     { label: 'è vuoto',      negated: false, highlight: false, noValue: true },
  isNotEmpty:  { label: 'non è vuoto',  negated: false, highlight: false, noValue: true }
};

export function createFilters(deps) {
  // deps = { state, getEvents, onChange, displayValue, mapperFor, toast }

  const { state, onChange } = deps;
  const displayValue = deps.displayValue || (v => String(v ?? ''));
  const mapperFor = deps.mapperFor || (() => null);
  const getEvents = deps.getEvents || (() => []);
  const toast = deps.toast || (() => {});

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const el = {
    panel:  $('#filters-panel'),
    rows:   $('#filters-rows'),
    add:    $('#btn-filter-add'),
    reset:  $('#btn-filter-reset'),
    toggle: $('#btn-filters'),
    count:  $('#filters-count'),
    nav:    $('#filter-nav'),
    matchCount: $('#filter-match-count'),
    prev:   $('#filter-prev'),
    next:   $('#filter-next')
  };

  const st = {
    rules: [],           // [{ logic, field, operator, value }]
    debounce: null,
    regexCache: new Map(),
    matches: [],         // elementi DOM che soddisfano i filtri
    index: -1,
    lastFlashed: null
  };

  /* ═══════════════════════════ valutazione ═══════════════════════════ */

  /** Valori estratti da un evento per un dato campo. */
  function fieldValues(ev, field) {
    const cf = ev.categorizedFields || {};

    switch (field) {
      case 'eventName': return [ev.eventName];
      case 'source':    return [ev.source];
      case 'status':    return [ev.status || 'ok'];
      case 'tool':      return [ev.toolId];
      case 'url':       return [ev.viewUrl, ev.pageUrl];
      case 'category':  return Object.keys(cf);

      case 'key': {
        const out = [];
        for (const cat of Object.keys(cf)) for (const r of cf[cat]) out.push(r.key);
        if (Array.isArray(ev.products)) {
          for (const p of ev.products) for (const r of (p.fields || [])) out.push(r.key);
        }
        return out;
      }

      case 'value': {
        const out = [];
        for (const cat of Object.keys(cf)) for (const r of cf[cat]) out.push(displayValue(r.value));
        if (Array.isArray(ev.products)) {
          for (const p of ev.products) {
            for (const r of (p.fields || [])) out.push(displayValue(r.value));
          }
        }
        return out;
      }

      case 'src': {
        const out = [];
        for (const cat of Object.keys(cf)) {
          for (const r of cf[cat]) if (r.src) out.push(r.src);
        }
        return out;
      }

      /**
       * Mappature EDDL delle chiavi presenti nell'evento. Permette di filtrare
       * per nome umano — "mappatura contiene site_code" trova gli eventi che
       * inviano quella variabile, anche se nella hit si chiama eVar1.
       */
      case 'mapping': {
        const out = [];
        for (const cat of Object.keys(cf)) {
          for (const r of cf[cat]) {
            const m = mapperFor(r.key);
            if (m) out.push(m);
          }
        }
        return out;
      }

      default: return [];
    }
  }

  function getRegex(pattern) {
    if (st.regexCache.has(pattern)) return st.regexCache.get(pattern);
    let re = null;
    try { re = new RegExp(pattern, 'i'); }
    catch (e) { re = false; }   // false = pattern invalido, distinto da null
    st.regexCache.set(pattern, re);
    if (st.regexCache.size > 60) st.regexCache.clear();
    return re;
  }

  /** Test di un singolo valore contro un operatore. */
  function testValue(raw, operator, needle) {
    const h = String(raw ?? '').toLowerCase();
    const n = String(needle ?? '').toLowerCase();

    switch (operator) {
      case 'equals':      return h === n;
      case 'notEquals':   return h !== n;
      case 'startsWith':  return h.startsWith(n);
      case 'endsWith':    return h.endsWith(n);
      case 'notContains': return !h.includes(n);
      case 'isEmpty':     return h === '' || h === 'null' || h === '[undefined]';
      case 'isNotEmpty':  return h !== '' && h !== 'null' && h !== '[undefined]';
      case 'regex': {
        const re = getRegex(needle);
        if (re === false) return false;   // pattern invalido: nessun match
        return re.test(String(raw ?? ''));
      }
      default:            return h.includes(n);
    }
  }

  /**
   * Valuta una singola condizione su un evento.
   *
   * Il punto centrale: gli operatori NEGATI richiedono che TUTTI i valori
   * soddisfino la condizione; gli altri che ne basti UNO.
   */
  function testRule(ev, rule) {
    const vals = fieldValues(ev, rule.field);
    const op = OPERATORS[rule.operator] || OPERATORS.contains;

    if (!vals.length) {
      // Campo assente: "non contiene" è vero, "contiene" è falso. Coerente con
      // l'intuizione: filtrare "url non contiene checkout" deve includere gli
      // eventi senza url.
      if (op.negated) return true;
      if (rule.operator === 'isEmpty') return true;
      return false;
    }

    return op.negated
      ? vals.every(v => testValue(v, rule.operator, rule.value))
      : vals.some(v  => testValue(v, rule.operator, rule.value));
  }

  /**
   * Valuta tutte le condizioni. Sinistra a destra, nessuna precedenza.
   * @returns {boolean}
   */
  function matches(ev) {
    const active = st.rules.filter(isRuleUsable);
    if (!active.length) return true;

    let result = null;
    for (const rule of active) {
      const hit = testRule(ev, rule);
      if (result === null) { result = hit; continue; }
      result = (rule.logic === 'OR') ? (result || hit) : (result && hit);
    }
    return result === null ? true : result;
  }

  function isRuleUsable(rule) {
    if (!rule || !rule.field || !rule.operator) return false;
    const op = OPERATORS[rule.operator];
    if (op && op.noValue) return true;      // isEmpty / isNotEmpty
    return String(rule.value || '').trim() !== '';
  }

  /* ═══════════════════════════ evidenziazione ═══════════════════════════ */

  /**
   * Termini da evidenziare, raggruppati per target.
   * Consumato da render.js: per ogni elemento della riga cerca il proprio target
   * e evidenzia le occorrenze.
   *
   * Gli operatori negati non producono evidenziazione: "non contiene checkout"
   * significa che quella stringa NON c'è, quindi non c'è nulla da illuminare.
   * Anche isEmpty/isNotEmpty sono esclusi: non hanno un termine.
   *
   * @returns {{eventName:string[], key:string[], value:string[],
   *            mapping:string[], url:string[], category:string[], src:string[]}}
   */
  function highlightTerms() {
    const out = {
      eventName: [], key: [], value: [], mapping: [],
      url: [], category: [], src: []
    };

    for (const rule of st.rules) {
      if (!isRuleUsable(rule)) continue;
      const op = OPERATORS[rule.operator];
      if (!op || !op.highlight) continue;

      const field = FIELDS[rule.field];
      if (!field || !field.target) continue;

      const term = String(rule.value || '').trim();
      if (!term) continue;

      // La regex non è evidenziabile per sottostringa: illuminare il pattern
      // letterale sarebbe sbagliato. Il match resta comunque contato.
      if (rule.operator === 'regex') continue;

      const bucket = out[field.target];
      if (bucket && !bucket.includes(term)) bucket.push(term);
    }

    return out;
  }

  /** Ci sono termini da evidenziare? Evita lavoro inutile nel renderer. */
  function hasHighlights() {
    const t = highlightTerms();
    return Object.keys(t).some(k => t[k].length > 0);
  }

  /* ═══════════════════════════ navigazione ═══════════════════════════ */

  /**
   * Aggiornata dal renderer dopo ogni render: gli elementi DOM cambiano
   * identità, quindi la lista va ricostruita.
   */
  function setMatches(nodes) {
    st.matches = Array.isArray(nodes) ? nodes : [];
    if (st.index >= st.matches.length) st.index = st.matches.length - 1;
    updateNav();
  }

  function updateNav() {
    if (!el.nav) return;

    const active = st.rules.some(isRuleUsable);
    const n = st.matches.length;

    el.nav.hidden = !active;
    if (!active) return;

    el.matchCount.textContent = n
      ? `${st.index >= 0 ? st.index + 1 : 1}/${n}`
      : '0/0';

    // Filtri attivi senza risultati: lo diciamo nel contatore, invece di
    // lasciare frecce apparentemente funzionanti.
    el.matchCount.dataset.empty = String(n === 0);

    el.prev.disabled = n < 2;
    el.next.disabled = n < 2;
  }

  /**
   * Salta al match successivo o precedente.
   *
   * Navighiamo tra EVENTI, non tra occorrenze di testo: con un filtro che
   * corrisponde a 200 righe dentro lo stesso evento, saltare riga per riga
   * sarebbe inutile.
   *
   * @param {number} delta +1 | -1
   */
  function goto(delta) {
    if (!st.matches.length) return;

    st.index = (st.index + delta + st.matches.length) % st.matches.length;
    const target = st.matches[st.index];
    if (!target) return;

    // Se il match è dentro un ramo che l'utente ha chiuso a mano, lo riapriamo:
    // altrimenti il salto porterebbe su un nodo invisibile.
    const view = target.closest('.uad-view');
    if (view && view.dataset.viewId) {
      state.setOpen(state.ids.view(view.dataset.viewId), true);
    }
    if (target.dataset.eventId) {
      state.setOpen(state.ids.event(target.dataset.eventId), true);
    }

    // Lo scroll avviene dopo il render conseguente all'espansione: il nodo
    // salvato potrebbe essere stato sostituito.
    requestAnimationFrame(() => {
      const sel = target.dataset.eventId
        ? `[data-event-id="${cssEscape(target.dataset.eventId)}"]`
        : (view?.dataset.viewId ? `[data-view-id="${cssEscape(view.dataset.viewId)}"]` : null);

      const live = (sel && document.querySelector(sel)) || target;
      live.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(live);
    });

    updateNav();
  }

  function flash(node) {
    if (st.lastFlashed) st.lastFlashed.classList.remove('is-filter-match');
    node.classList.add('is-filter-match');
    st.lastFlashed = node;
    setTimeout(() => {
      node.classList.remove('is-filter-match');
      if (st.lastFlashed === node) st.lastFlashed = null;
    }, 1400);
  }

  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* ═══════════════════════════ costruzione riga ═══════════════════════════ */

  function buildRow(rule, index) {
    const tplEl = document.getElementById('tpl-filter-row');
    if (!tplEl) { console.error('[Sniffer filters] template tpl-filter-row mancante'); return null; }
    const row = tplEl.content.firstElementChild.cloneNode(true);

    row.dataset.index = String(index);

    // Chip logico: nascosto sulla prima riga, dove non c'è nulla da concatenare.
    const logic = row.querySelector('[data-logic]');
    logic.hidden = index === 0;
    logic.dataset.logic = rule.logic || 'AND';
    logic.textContent = logic.dataset.logic;

    fillSelect(row.querySelector('[data-field]'), FIELDS, rule.field || 'value');
    fillSelect(row.querySelector('[data-operator]'), OPERATORS, rule.operator || 'contains');

    const valInput = row.querySelector('[data-value]');
    valInput.value = rule.value || '';
    syncValueVisibility(row, rule.operator || 'contains');

    return row;
  }

  function fillSelect(sel, dict, selected) {
    sel.textContent = '';
    for (const [key, meta] of Object.entries(dict)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = meta.label;
      if (key === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  /** "è vuoto" e "non è vuoto" non hanno un valore da inserire. */
  function syncValueVisibility(row, operator) {
    const op = OPERATORS[operator];
    const input = row.querySelector('[data-value]');
    const noValue = !!(op && op.noValue);
    input.hidden = noValue;
    if (noValue) input.value = '';

    // Il pattern regex invalido va segnalato subito, non scoperto dai risultati
    // vuoti.
    if (operator === 'regex' && input.value) {
      const ok = getRegex(input.value) !== false;
      input.dataset.invalid = String(!ok);
      input.title = ok ? '' : 'espressione regolare non valida';
    } else {
      delete input.dataset.invalid;
      input.title = '';
    }
  }

  /* ═══════════════════════════ lettura del DOM ═══════════════════════════ */

  function readRows() {
    const rows = Array.from(el.rows.querySelectorAll('[data-row]'));
    return rows.map((row, i) => ({
      logic:    i === 0 ? 'AND' : (row.querySelector('[data-logic]').dataset.logic || 'AND'),
      field:    row.querySelector('[data-field]').value,
      operator: row.querySelector('[data-operator]').value,
      value:    row.querySelector('[data-value]').value.trim()
    }));
  }

  /** Applica le regole lette dal DOM, gestendo snapshot e persistenza. */
  function commit() {
    const next = readRows();
    const wasActive = st.rules.some(isRuleUsable);
    st.rules = next;
    const isActive = next.some(isRuleUsable);

    if (isActive && !wasActive) {
      state.setForceExpand(true, SNAPSHOT_KEY);
    } else if (!isActive && wasActive) {
      state.setForceExpand(false, SNAPSHOT_KEY);
    }

    // Cambiando le condizioni, l'indice corrente non ha più senso.
    st.index = -1;

    updateBadge();
    updateNav();
    persist();
    onChange && onChange();
  }

  function commitDebounced() {
    clearTimeout(st.debounce);
    st.debounce = setTimeout(commit, DEBOUNCE_MS);
  }

  function updateBadge() {
    const n = st.rules.filter(isRuleUsable).length;
    el.count.textContent = String(n);
    el.count.hidden = n === 0;
    // Il toggle mostra lo stato attivo anche a pannello filtri chiuso: senza,
    // filtri attivi più pannello chiuso darebbe risultati parziali senza
    // spiegazione.
    el.toggle.classList.toggle('has-filters', n > 0);
  }

  /* ═══════════════════════════ rendering righe ═══════════════════════════ */

  function renderRows() {
    el.rows.textContent = '';
    const list = st.rules.length
      ? st.rules
      : [{ logic: 'AND', field: 'value', operator: 'contains', value: '' }];

    list.forEach((rule, i) => {
      const row = buildRow(rule, i);
      if (row) el.rows.appendChild(row);
    });

    if (!st.rules.length) st.rules = list.slice();
  }

  function addRow() {
    if (el.rows.children.length >= MAX_ROWS) {
      toast(`Massimo ${MAX_ROWS} condizioni`);
      return;
    }
    const row = buildRow(
      { logic: 'AND', field: 'value', operator: 'contains', value: '' },
      el.rows.children.length
    );
    if (!row) return;
    el.rows.appendChild(row);
    row.querySelector('[data-value]').focus();
    // Nessun commit: una riga vuota non cambia i risultati.
  }

  function removeRow(row) {
    row.remove();
    // La prima riga non deve mai mostrare il chip logico.
    const first = el.rows.querySelector('[data-row]');
    if (first) first.querySelector('[data-logic]').hidden = true;
    reindex();
    if (!el.rows.children.length) addRow();
    commit();
  }

  function reindex() {
    Array.from(el.rows.querySelectorAll('[data-row]'))
      .forEach((row, i) => { row.dataset.index = String(i); });
  }

  /* ═══════════════════════════ persistenza ═══════════════════════════ */

  async function persist() {
    const usable = st.rules.filter(isRuleUsable);
    try {
      if (!usable.length) await chrome.storage.local.remove([STORAGE_KEY]);
      else await chrome.storage.local.set({ [STORAGE_KEY]: usable });
    } catch (e) {
      console.error('[Sniffer filters] persist', e);
    }
  }

  async function hydrate() {
    try {
      const r = await chrome.storage.local.get([STORAGE_KEY]);
      const saved = r[STORAGE_KEY];
      if (!Array.isArray(saved) || !saved.length) { renderRows(); return false; }

      st.rules = saved.filter(x => x && FIELDS[x.field] && OPERATORS[x.operator]);
      renderRows();
      updateBadge();
      updateNav();

      if (st.rules.some(isRuleUsable)) {
        // Filtri ripristinati: il pannello si apre da solo, altrimenti l'utente
        // vedrebbe risultati filtrati senza capire perché.
        el.panel.hidden = false;
        el.toggle.setAttribute('aria-expanded', 'true');
        state.setForceExpand(true, SNAPSHOT_KEY);
      }
      return true;
    } catch (e) {
      console.error('[Sniffer filters] hydrate', e);
      renderRows();
      return false;
    }
  }

  /* ═══════════════════════════ binding (delega) ═══════════════════════════ */

  function bind() {
    if (!el.rows) return;

    // Un solo listener per tutte le righe: si aggiungono e rimuovono a runtime.
    el.rows.addEventListener('click', (e) => {
      const logic = e.target.closest('[data-logic]');
      if (logic) {
        logic.dataset.logic = logic.dataset.logic === 'AND' ? 'OR' : 'AND';
        logic.textContent = logic.dataset.logic;
        commit();
        return;
      }
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        const row = rm.closest('[data-row]');
        if (row) removeRow(row);
      }
    });

    el.rows.addEventListener('change', (e) => {
      const row = e.target.closest('[data-row]');
      if (!row) return;
      if (e.target.matches('[data-operator]')) {
        syncValueVisibility(row, e.target.value);
      }
      commit();
    });

    el.rows.addEventListener('input', (e) => {
      if (!e.target.matches('[data-value]')) return;
      const row = e.target.closest('[data-row]');
      if (row) syncValueVisibility(row, row.querySelector('[data-operator]').value);
      commitDebounced();
    });

    el.rows.addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-value]')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(st.debounce);
        commit();
        // Invio applica e salta al primo risultato: è il gesto naturale dopo
        // aver scritto una condizione.
        setTimeout(() => { if (st.matches.length) { st.index = -1; goto(1); } }, 0);
      }
      if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; commit(); }
    });

    el.add && el.add.addEventListener('click', addRow);

    el.reset && el.reset.addEventListener('click', () => {
      st.rules = [];
      st.index = -1;
      st.regexCache.clear();
      renderRows();
      state.setForceExpand(false, SNAPSHOT_KEY);
      updateBadge();
      updateNav();
      persist();
      onChange && onChange();
      toast('Filtri azzerati');
    });

    el.toggle && el.toggle.addEventListener('click', () => {
      const open = el.panel.hidden;
      el.panel.hidden = !open;
      el.toggle.setAttribute('aria-expanded', String(open));
      if (open && !el.rows.children.length) renderRows();
    });

    el.next && el.next.addEventListener('click', () => goto(1));
    el.prev && el.prev.addEventListener('click', () => goto(-1));

    // Scorciatoie: Alt+freccia. Invio e F3 appartengono alla ricerca, quindi
    // servono combinazioni distinte per non sovrapporsi.
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (!st.rules.some(isRuleUsable)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); goto(1); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); goto(-1); }
    });
  }

  bind();
  updateNav();

  /* ═══════════════════════════ export ═══════════════════════════ */

  return {
    matches,
    highlightTerms,
    hasHighlights,
    setMatches,
    goto,

    get isActive() { return st.rules.some(isRuleUsable); },
    get count() { return st.rules.filter(isRuleUsable).length; },
    get matchCount() { return st.matches.length; },
    get rules() { return st.rules.filter(isRuleUsable).map(r => ({ ...r })); },

    /** Versione dei termini: entra nella firma di rendering, così i corpi degli
     *  eventi già aperti si aggiornano quando l'evidenziazione cambia. */
    get version() {
      const t = highlightTerms();
      return Object.keys(t).map(k => k + ':' + t[k].join(',')).join('|');
    },

    hydrate,

    /** Azzera tutto: usata dal pulsante "Azzera ricerca e filtri". */
    reset() {
      st.rules = [];
      st.index = -1;
      st.regexCache.clear();
      renderRows();
      state.setForceExpand(false, SNAPSHOT_KEY);
      updateBadge();
      updateNav();
      persist();
      onChange && onChange();
    },

    /** Aggiunge una condizione da fuori: usabile per "filtra per questo valore". */
    addRule(field, operator, value) {
      if (!FIELDS[field] || !OPERATORS[operator]) return false;
      st.rules = readRows().filter(isRuleUsable);
      st.rules.push({ logic: 'AND', field, operator, value: String(value ?? '') });
      renderRows();
      el.panel.hidden = false;
      el.toggle.setAttribute('aria-expanded', 'true');
      commit();
      return true;
    },

    debug: () => ({
      rules: st.rules,
      usable: st.rules.filter(isRuleUsable).length,
      matches: st.matches.length,
      index: st.index,
      terms: highlightTerms(),
      regexCached: st.regexCache.size
    })
  };
}