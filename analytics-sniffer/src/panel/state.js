/**
 * Analytics Sniffer — stato della UI degli accordion
 * Contesto: pagina di estensione (panel), ES module
 *
 * v4 — aggiunto clearGroupOverrides(): cancella le deviazioni manuali sui
 *      sotto-accordion quando cambia il DEFAULT nei Settings.
 *
 * PERCHE SERVE
 * Lo stato memorizza solo le DEVIAZIONI dell'utente rispetto al default. Se apri
 * a mano la sezione "Consent" su tre eventi e poi imposti "Consent: chiusa" nei
 * Settings, quelle tre deviazioni sarebbero più forti del nuovo default e i
 * gruppi resterebbero aperti: l'impostazione sembrerebbe non funzionare.
 * Cancellando le deviazioni sulle categorie toccate, il nuovo default si applica
 * subito — e da quel momento puoi ancora aprire e chiudere ogni singolo gruppo a
 * mano. È un default per evitare cluttering, non un blocco permanente.
 *
 * PRINCIPIO CENTRALE
 * I dati (store.events) e lo stato di apertura sono strutture SEPARATE. Il
 * render legge sempre da qui: è l'unico motivo per cui l'arrivo di un nuovo
 * evento, o il toggle di un'opzione, non richiude ciò che l'utente aveva aperto.
 *
 * TRE LIVELLI, TRE PREFISSI
 *   v:<viewId>              macro-accordion, una view di pagina
 *   e:<eventId>             micro-accordion, un singolo evento
 *   g:<eventId>:<categoria> sottogruppo di campi
 * I prefissi permettono di agire su un intero livello senza conoscere la
 * struttura dei dati.
 *
 * SNAPSHOT A PILA, NON SINGOLO
 * Ricerca e filtri possono attivarsi in qualsiasi ordine e sovrapporsi. Con un
 * solo slot di backup, attivare la ricerca dentro un filtro attivo e poi chiudere
 * il filtro ripristinerebbe lo stato sbagliato. Una pila con chiavi nominate
 * risolve: ogni consumatore ha il suo livello.
 *
 * PERSISTENZA
 * Il pannello DevTools viene creato UNA volta e riusato, quindi lo stato in
 * memoria sopravvive ai reload della pagina ispezionata. NON sopravvive alla
 * chiusura di DevTools: per quello serve lo storage, con un tetto rigido perché
 * su 2000 eventi × 3 livelli le chiavi diventerebbero migliaia.
 */

'use strict';

const STORAGE_PREFIX = 'uad_uistate_';
const PERSIST_DEBOUNCE_MS = 400;

/** Oltre questa soglia non persistiamo: è uno stato di comodo, non un dato. */
const PERSIST_MAX_KEYS = 1200;

/** Oltre questa soglia la garbage collection scatta anche senza richiesta. */
const GC_THRESHOLD = 4000;

export function createState(opts = {}) {
  // Mutabile: panel.js crea l'istanza prima di conoscere il tabId.
  let tabId = opts.tabId ?? null;
  const persist = opts.persist !== false;

  /* ═════════════════════════════ stato ═════════════════════════════ */

  const st = {
    /**
     * id -> boolean. SOLO le deviazioni esplicite dell'utente.
     * Un id assente significa "usa il default del suo livello": così lo stato
     * resta piccolo e i default possono cambiare senza riscrivere nulla.
     */
    open: Object.create(null),

    /** Pila di snapshot nominati: 'search', 'filters', ... */
    snapshots: new Map(),

    /** Default per livello, sovrascrivibili dai settings. */
    defaults: {
      view:  true,     // le view sono aperte: è il contenitore
      event: false,    // gli eventi chiusi: 50 eventi aperti sono illeggibili
      group: true      // i gruppi aperti, salvo default per categoria
    },

    /** Quando ricerca o filtri sono attivi, i rami con match si aprono. */
    forceExpand: false,

    persistTimer: null,
    listeners: new Set()
  };

  /* ═════════════════════════ helper sui livelli ═════════════════════════ */

  function levelOf(id) {
    const c = String(id).charAt(0);
    if (c === 'v') return 'view';
    if (c === 'e') return 'event';
    if (c === 'g') return 'group';
    return 'event';
  }

  /** Estrae la categoria da un id di gruppo: g:<eventId>:<categoria> */
  function categoryOf(id) {
    const s = String(id);
    if (s.charAt(0) !== 'g') return null;
    // La categoria è tutto ciò che segue il SECONDO due punti: l'eventId può
    // contenerne (toolId|seq|timestamp|viewId), la categoria no.
    const first = s.indexOf(':');
    if (first === -1) return null;
    const second = s.indexOf(':', first + 1);
    if (second === -1) return null;
    return s.slice(second + 1);
  }

  function defaultFor(id) {
    // Con ricerca o filtri attivi tutto si apre: l'utente vuole vedere i match,
    // non cliccare 40 accordion.
    if (st.forceExpand) return true;
    return st.defaults[levelOf(id)];
  }

  /* ═════════════════════════════ API base ═════════════════════════════ */

  /**
   * Stato effettivo: deviazione esplicita dell'utente, oppure il default.
   * @param {string}  id
   * @param {boolean} [override] default alternativo per questo id, usato dai
   *                             gruppi il cui stato iniziale arriva dai Settings
   */
  function isOpen(id, override) {
    if (id in st.open) return st.open[id];
    if (typeof override === 'boolean' && !st.forceExpand) return override;
    return defaultFor(id);
  }

  function setOpen(id, value, override) {
    const v = !!value;
    const dflt = (typeof override === 'boolean' && !st.forceExpand)
      ? override
      : defaultFor(id);

    // Se lo stato coincide col default, rimuoviamo la chiave invece di
    // memorizzarla: mantiene l'oggetto minimo e fa seguire i default futuri.
    if (v === dflt) {
      if (id in st.open) { delete st.open[id]; schedulePersist(); notify(); }
      return v;
    }
    if (st.open[id] === v) return v;
    st.open[id] = v;
    schedulePersist();
    notify();
    return v;
  }

  /**
   * @returns {boolean} il NUOVO stato, così il chiamante può applicarlo al DOM
   *   immediatamente senza attendere il re-render.
   */
  function toggle(id, override) {
    return setOpen(id, !isOpen(id, override), override);
  }

  /* ══════════════════════ operazioni su più elementi ══════════════════════ */

  /**
   * Chiude tutto. Non basta svuotare st.open: i default riaprirebbero view e
   * gruppi. Serve una deviazione esplicita su ogni id noto.
   * @param {string[]} knownIds  id attualmente presenti nel DOM o nei dati
   * @param {string}   [level]   'view' | 'event' | 'group' — se assente, tutti
   */
  function collapseAll(knownIds, level) {
    for (const id of knownIds) {
      if (level && levelOf(id) !== level) continue;
      if (defaultFor(id) === false) delete st.open[id];
      else st.open[id] = false;
    }
    schedulePersist();
    notify();
  }

  function expandAll(knownIds, level) {
    for (const id of knownIds) {
      if (level && levelOf(id) !== level) continue;
      if (defaultFor(id) === true) delete st.open[id];
      else st.open[id] = true;
    }
    schedulePersist();
    notify();
  }

  /**
   * Cancella le deviazioni manuali sui SOTTOGRUPPI, così il default appena
   * impostato nei Settings si applica anche agli eventi già a schermo.
   *
   * Senza questo, l'impostazione sembrerebbe non funzionare: le sezioni aperte a
   * mano resterebbero aperte, perché una deviazione esplicita è più forte del
   * default.
   *
   * NON tocca view ed eventi: l'utente sta configurando le sezioni dei campi, e
   * chiudergli l'evento che stava leggendo sarebbe sconcertante.
   *
   * @param {string[]|null} categories  categorie da resettare. null = tutte.
   * @returns {number} deviazioni rimosse
   */
  function clearGroupOverrides(categories) {
    const wanted = Array.isArray(categories) && categories.length
      ? new Set(categories)
      : null;

    let removed = 0;

    for (const id of Object.keys(st.open)) {
      if (levelOf(id) !== 'group') continue;
      if (wanted) {
        const cat = categoryOf(id);
        if (!cat || !wanted.has(cat)) continue;
      }
      delete st.open[id];
      removed++;
    }

    // Anche gli snapshot vanno potati: se una ricerca è attiva, al suo termine
    // ripristinerebbe le deviazioni che abbiamo appena rimosso.
    for (const [, snap] of st.snapshots) {
      for (const id of Object.keys(snap.open)) {
        if (levelOf(id) !== 'group') continue;
        if (wanted) {
          const cat = categoryOf(id);
          if (!cat || !wanted.has(cat)) continue;
        }
        delete snap.open[id];
      }
    }

    if (removed) { schedulePersist(); notify(); }
    return removed;
  }

  /**
   * Apre la catena di antenati di un elemento. Usata dal salto sui risultati di
   * ricerca: un match dentro un evento chiuso dentro una view chiusa non sarebbe
   * raggiungibile.
   * @param {{viewId?:string, eventId?:string, category?:string}} path
   */
  function expandPath(path = {}) {
    if (path.viewId)  st.open['v:' + path.viewId] = true;
    if (path.eventId) st.open['e:' + path.eventId] = true;
    if (path.eventId && path.category) {
      st.open[`g:${path.eventId}:${path.category}`] = true;
    }
    schedulePersist();
    notify();
  }

  /* ═══════════════════════ snapshot / restore ═══════════════════════ */

  /**
   * Fotografa lo stato prima di un'operazione che lo altera (ricerca, filtri).
   * IDEMPOTENTE: chiamarla due volte con la stessa chiave non sovrascrive la
   * fotografia originale. Senza questo, digitando nella ricerca ogni battuta
   * salverebbe lo stato GIÀ espanso e il ripristino finale non riporterebbe
   * nulla.
   */
  function snapshot(key) {
    if (st.snapshots.has(key)) return false;
    st.snapshots.set(key, {
      open: { ...st.open },
      forceExpand: st.forceExpand
    });
    return true;
  }

  /** Ripristina esattamente lo stato precedente. */
  function restore(key) {
    const snap = st.snapshots.get(key);
    if (!snap) return false;
    st.snapshots.delete(key);

    st.open = { ...snap.open };
    // Se un altro consumatore ha ancora uno snapshot aperto, il suo stato di
    // partenza è più vecchio del nostro: forceExpand resta attivo finché rimane
    // almeno un consumatore.
    st.forceExpand = st.snapshots.size > 0 ? st.forceExpand : snap.forceExpand;

    schedulePersist();
    notify();
    return true;
  }

  function hasSnapshot(key) { return st.snapshots.has(key); }

  function dropSnapshot(key) { return st.snapshots.delete(key); }

  /* ═══════════════════════════ forceExpand ═══════════════════════════ */

  /**
   * Attiva o disattiva l'espansione automatica dei rami con match.
   * @param {boolean} on
   * @param {string}  reason  chiave del consumatore ('search' | 'filters')
   */
  function setForceExpand(on, reason) {
    if (on) {
      snapshot(reason);
      if (!st.forceExpand) { st.forceExpand = true; notify(); }
      return;
    }
    // Disattiviamo solo quando nessun consumatore lo richiede più.
    restore(reason);
    if (st.snapshots.size === 0 && st.forceExpand) {
      st.forceExpand = false;
      notify();
    }
  }

  /* ═════════════════════════ garbage collection ═════════════════════════ */

  /**
   * Rimuove le chiavi di elementi che non esistono più. Senza questo, con il
   * ring buffer del background e una sessione lunga, st.open crescerebbe
   * indefinitamente accumulando id di eventi scartati.
   * @param {Set<string>|string[]} validIds
   * @returns {number} chiavi rimosse
   */
  function gc(validIds) {
    const valid = validIds instanceof Set ? validIds : new Set(validIds);
    let removed = 0;

    for (const id of Object.keys(st.open)) {
      if (valid.has(id)) continue;
      delete st.open[id];
      removed++;
    }

    // Gli snapshot vengono potati allo stesso modo: uno snapshot pieno di id
    // morti ripristinerebbe uno stato inconsistente.
    for (const [, snap] of st.snapshots) {
      for (const id of Object.keys(snap.open)) {
        if (!valid.has(id)) delete snap.open[id];
      }
    }

    if (removed) schedulePersist();
    return removed;
  }

  function size() { return Object.keys(st.open).length; }

  function maybeAutoGc(validIds) {
    if (size() < GC_THRESHOLD) return 0;
    return gc(validIds);
  }

  /* ═══════════════════════════ persistenza ═══════════════════════════ */

  function storageKey() {
    return STORAGE_PREFIX + (tabId ?? 'unknown');
  }

  function schedulePersist() {
    if (!persist || tabId === null) return;
    if (st.persistTimer) return;
    st.persistTimer = setTimeout(() => {
      st.persistTimer = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function persistNow() {
    if (!persist || tabId === null) return;
    const keys = Object.keys(st.open);

    // Oltre il tetto non salviamo nulla: è uno stato di comodo, e riempire lo
    // storage con migliaia di booleani danneggerebbe ciò che conta davvero,
    // cioè gli eventi raccolti.
    if (keys.length > PERSIST_MAX_KEYS) {
      try { await chrome.storage.local.remove([storageKey()]); }
      catch (e) { console.error('[Sniffer state] remove', e); }
      return;
    }

    try {
      await chrome.storage.local.set({
        [storageKey()]: { open: st.open, savedAt: Date.now() }
      });
    } catch (e) {
      console.error('[Sniffer state] persistNow', e);
    }
  }

  /**
   * Ripristina lo stato salvato. Va chiamata PRIMA del primo render: altrimenti
   * il primo frame mostra i default e poi salta allo stato salvato.
   */
  async function hydrate() {
    if (!persist || tabId === null) return false;
    try {
      const r = await chrome.storage.local.get([storageKey()]);
      const saved = r[storageKey()];
      if (!saved || !saved.open || typeof saved.open !== 'object') return false;

      // Merge, non sostituzione: chi ha già interagito prima dell'hydrate
      // (possibile, è asincrono) non deve perdere le sue scelte.
      for (const [k, v] of Object.entries(saved.open)) {
        if (!(k in st.open) && typeof v === 'boolean') st.open[k] = v;
      }
      notify();
      return true;
    } catch (e) {
      console.error('[Sniffer state] hydrate', e);
      return false;
    }
  }

  async function clearPersisted() {
    st.open = Object.create(null);
    st.snapshots.clear();
    st.forceExpand = false;
    if (persist && tabId !== null) {
      try { await chrome.storage.local.remove([storageKey()]); }
      catch (e) { console.error('[Sniffer state] clearPersisted', e); }
    }
    notify();
  }

  /* ═══════════════════════════ notifiche ═══════════════════════════ */

  let notifyQueued = false;

  /** Coalescing: collapseAll su 500 id deve produrre UN render, non 500. */
  function notify() {
    if (notifyQueued || !st.listeners.size) return;
    notifyQueued = true;
    Promise.resolve().then(() => {
      notifyQueued = false;
      for (const fn of st.listeners) {
        try { fn(); } catch (e) { console.error('[Sniffer state] listener', e); }
      }
    });
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    st.listeners.add(fn);
    return () => st.listeners.delete(fn);
  }

  /* ═══════════════════════════ configurazione ═══════════════════════════ */

  /** Applica i default dai settings (es. ui.collapseByDefault). */
  function applySettings(settings) {
    const collapse = settings?.ui?.collapseByDefault === true;
    const next = {
      view:  !collapse,
      event: false,
      // Il default per i gruppi resta true: lo stato per categoria arriva dal
      // parametro `override` di isOpen(), passato da render.js.
      group: !collapse
    };
    if (next.view === st.defaults.view && next.group === st.defaults.group) return;
    st.defaults = next;
    notify();
  }

  /**
   * Il tabId arriva dopo la creazione dell'istanza: la chiave di storage lo
   * richiede, e panel.js crea lo stato prima di averlo determinato.
   */
  function setTabId(id) {
    if (typeof id !== 'number' || id === tabId) return;
    tabId = id;
  }

  /* ═════════════════════════════ id helper ═════════════════════════════ */

  const ids = {
    view:  (viewId) => 'v:' + viewId,
    event: (eventId) => 'e:' + eventId,
    group: (eventId, category) => `g:${eventId}:${category}`
  };

  /* ═════════════════════════════ export ═════════════════════════════ */

  return {
    // lettura e scrittura
    isOpen, setOpen, toggle,

    // operazioni multiple
    collapseAll, expandAll, expandPath, clearGroupOverrides,

    // snapshot per ricerca e filtri
    snapshot, restore, hasSnapshot, dropSnapshot, setForceExpand,
    get forceExpand() { return st.forceExpand; },

    // manutenzione
    gc, maybeAutoGc, size,

    // persistenza
    hydrate, persistNow, clearPersisted,

    // integrazione
    subscribe, applySettings, setTabId, ids,

    // diagnostica
    debug: () => ({
      keys: size(),
      groupOverrides: Object.keys(st.open).filter(k => levelOf(k) === 'group').length,
      forceExpand: st.forceExpand,
      defaults: { ...st.defaults },
      snapshots: Array.from(st.snapshots.keys()),
      tabId,
      persisted: persist && tabId !== null
    })
  };
}