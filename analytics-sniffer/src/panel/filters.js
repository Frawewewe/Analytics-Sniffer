/**
 * Universal Analytics Debugger — filtri avanzati
 * Contesto: pagina di estensione (panel), ES module
 *
 * COSA FA
 *   - righe di condizioni: campo + operatore + valore
 *   - dalla seconda riga, chip cliccabile AND/OR per concatenare la logica
 *   - stesso comportamento di snapshot/restore della ricerca
 *   - persistenza: i filtri sopravvivono alla chiusura di DevTools
 *
 * PRECEDENZA DEGLI OPERATORI — decisione dichiarata
 * Valutiamo da SINISTRA A DESTRA senza precedenza di AND su OR.
 * "A AND B OR C" significa "(A AND B) OR C", non "A AND (B OR C)".
 * E' la scelta di Notion e degli altri filtri a chip: senza parentesi visibili,
 * una precedenza implicita produrrebbe risultati che l'utente non riesce a
 * prevedere leggendo le righe dall'alto.
 *
 * SEMANTICA DI "NON CONTIENE" — il punto piu delicato
 * Un evento ha molti valori per lo stesso campo (decine di chiavi, decine di
 * valori). "contiene X" e' vero se ALMENO UNO corrisponde. Ma "non contiene X"
 * deve essere vero solo se NESSUNO corrisponde: usare la stessa logica di
 * "almeno uno" renderebbe il filtro inutile, perche su un evento con 40 campi
 * ce n'e' sempre uno che non contiene la stringa cercata.
 */

'use strict';

const SNAPSHOT_KEY = 'filters';
const DEBOUNCE_MS = 160;
const STORAGE_KEY = 'uad_filters';
const MAX_ROWS = 10;

/* ═══════════════════════════════════════════════════════════════════════════
   Campi disponibili
   ═══════════════════════════════════════════════════════════════════════════ */

const FIELDS = {
  eventName: { label: 'Nome evento', multi: false },
  key:       { label: 'Chiave',      multi: true },
  value:     { label: 'Valore',      multi: true },
  url:       { label: 'URL',         multi: true },
  category:  { label: 'Categoria',   multi: true },
  source:    { label: 'Canale',      multi: false },
  src:       { label: 'Variabile sorgente', multi: true },
  status:    { label: 'Stato',       multi: false },
  tool:      { label: 'Tool',        multi: false }
};

const OPERATORS = {
  contains:    { label: 'contiene',       negated: false },
  equals:      { label: 'è uguale a',     negated: false },
  notContains: { label: 'non contiene',   negated: true },
  notEquals:   { label: 'è diverso da',   negated: true },
  startsWith:  { label: 'inizia con',     negated: false },
  endsWith:    { label: 'finisce con',    negated: false },
  regex:       { label: 'regex',          negated: false },
  isEmpty:     { label: 'è vuoto',        negated: false, noValue: true },
  isNotEmpty:  { label: 'non è vuoto',    negated: false, noValue: true }
};

export function createFilters(deps) {
  // deps = { state, getEvents, onChange, displayValue, toast }

  const { state, onChange } = deps;
  const displayValue = deps.displayValue || (v => String(v ?? ''));
  const toast = deps.toast || (() => {});

  const $ = (s) => document.querySelector(s);

  const el = {
    panel:  $('#filters-panel'),
    rows:   $('#filters-rows'),
    add:    $('#btn-filter-add'),
    reset:  $('#btn-filter-reset'),
    toggle: $('#btn-filters'),
    count:  $('#filters-count')
  };

  const st = {
    rules: [],       // [{ logic, field, operator, value }]
    debounce: null,
    /** Cache delle RegExp: compilarle a ogni evento sarebbe costoso. */
    regexCache: new Map()
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
          for (const p of ev.products) {
            for (const r of (p.fields || [])) out.push(r.key);
          }
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
   * Il punto centrale: gli operatori NEGATI richiedono che TUTTI i valori
   * soddisfino la condizione; gli altri che ne basti UNO.
   */
  function testRule(ev, rule) {
    const vals = fieldValues(ev, rule.field);
    const op = OPERATORS[rule.operator] || OPERATORS.contains;

    if (!vals.length) {
      // Campo assente: "non contiene" e' vero, "contiene" e' falso.
      // Coerente con l'intuizione: filtrare "url non contiene checkout" deve
      // includere gli eventi senza url.
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

  /* ═══════════════════════════ costruzione riga ═══════════════════════════ */

  function buildRow(rule, index) {
    const tplEl = document.getElementById('tpl-filter-row');
    if (!tplEl) { console.error('[UAD filters] template tpl-filter-row mancante'); return null; }
    const row = tplEl.content.firstElementChild.cloneNode(true);

    row.dataset.index = String(index);

    // Chip logico: nascosto sulla prima riga, dove non c'e' nulla da concatenare.
    const logic = row.querySelector('[data-logic]');
    logic.hidden = index === 0;
    logic.dataset.logic = rule.logic || 'AND';
    logic.textContent = logic.dataset.logic;

    const fieldSel = row.querySelector('[data-field]');
    fillSelect(fieldSel, FIELDS, rule.field || 'value');

    const opSel = row.querySelector('[data-operator]');
    fillSelect(opSel, OPERATORS, rule.operator || 'contains');

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

    // Il pattern regex invalido va segnalato subito, non scoperto dai
    // risultati vuoti.
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

    updateBadge();
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
    // Il toggle mostra lo stato attivo anche a pannello filtri chiuso.
    el.toggle.classList.toggle('has-filters', n > 0);
  }

  /* ═══════════════════════════ rendering righe ═══════════════════════════ */

  function renderRows() {
    el.rows.textContent = '';
    const list = st.rules.length ? st.rules : [{ logic: 'AND', field: 'value', operator: 'contains', value: '' }];
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
    const row = buildRow({ logic: 'AND', field: 'value', operator: 'contains', value: '' },
                         el.rows.children.length);
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
      console.error('[UAD filters] persist', e);
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

      if (st.rules.some(isRuleUsable)) {
        // Filtri ripristinati: il pannello si apre da solo, altrimenti l'utente
        // vedrebbe risultati filtrati senza capire perche.
        el.panel.hidden = false;
        el.toggle.setAttribute('aria-expanded', 'true');
        state.setForceExpand(true, SNAPSHOT_KEY);
      }
      return true;
    } catch (e) {
      console.error('[UAD filters] hydrate', e);
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
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(st.debounce); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; commit(); }
    });

    el.add && el.add.addEventListener('click', addRow);

    el.reset && el.reset.addEventListener('click', () => {
      st.rules = [];
      st.regexCache.clear();
      renderRows();
      state.setForceExpand(false, SNAPSHOT_KEY);
      updateBadge();
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
  }

  bind();

  /* ═══════════════════════════ export ═══════════════════════════ */

  return {
    matches,
    get isActive() { return st.rules.some(isRuleUsable); },
    get count() { return st.rules.filter(isRuleUsable).length; },
    get rules() { return st.rules.filter(isRuleUsable).map(r => ({ ...r })); },

    hydrate,

    /** Azzera tutto: usata dal pulsante "Azzera ricerca e filtri". */
    reset() {
      st.rules = [];
      st.regexCache.clear();
      renderRows();
      state.setForceExpand(false, SNAPSHOT_KEY);
      updateBadge();
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
      regexCached: st.regexCache.size
    })
  };
}