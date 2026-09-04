/**
 * Universal Analytics Debugger — gestione del tema
 * Contesto: pagina di estensione (panel), ES module
 *
 * TRE STATI, NON DUE
 *   system  segue il tema del sistema operativo (default)
 *   light   forzato chiaro
 *   dark    forzato scuro
 * Il ciclo del pulsante e' system -> light -> dark -> system.
 *
 * PERCHE ANCHE devtools.panels.themeName
 * Chrome DevTools ha un proprio tema, indipendente da quello del sistema: si
 * puo avere Windows in chiaro e DevTools in scuro. Un pannello che segue solo
 * prefers-color-scheme risulterebbe bianco accecante dentro un DevTools nero.
 * In modalita 'system' diamo la precedenza al tema di DevTools, e usiamo
 * prefers-color-scheme solo come fallback.
 *
 * PERCHE data-theme SUL TAG html
 * panel.css definisce le variabili su :root e html[data-theme='...'].
 * Scrivere l'attributo sul tag html e' l'unico modo per far cambiare tema senza
 * ricalcolare nulla in JavaScript: e' la CSS a risolvere tutto.
 */

'use strict';

const ORDER = ['system', 'light', 'dark'];

const META = {
  system: { icon: '◐', label: 'Tema: sistema',  title: 'Tema: automatico (segue DevTools). Clicca per forzare chiaro.' },
  light:  { icon: '○', label: 'Tema: chiaro',   title: 'Tema: chiaro. Clicca per forzare scuro.' },
  dark:   { icon: '●', label: 'Tema: scuro',    title: 'Tema: scuro. Clicca per tornare automatico.' }
};

export function createTheme(deps = {}) {
  // deps = { getSettings, patchSettings, toast }

  const patchSettings = deps.patchSettings || (async () => {});
  const getSettings = deps.getSettings || (() => ({}));

  const el = {
    btn:  document.getElementById('btn-theme'),
    icon: document.getElementById('theme-icon')
  };

  const st = {
    /** Preferenza dell'utente: 'system' | 'light' | 'dark' */
    preference: 'system',
    /** Tema effettivamente applicato: 'light' | 'dark' */
    resolved: 'light',
    /** Tema di DevTools, se leggibile: 'light' | 'dark' | null */
    devtools: null,
    mediaQuery: null,
    listeners: new Set()
  };

  /* ═════════════════════════ lettura del contesto ═════════════════════════ */

  /**
   * chrome.devtools.panels.themeName vale 'default' o 'dark'.
   * Non e' disponibile in tutti i contesti (es. pannello aperto fuori da
   * DevTools durante lo sviluppo), quindi ogni accesso e' protetto.
   */
  function readDevtoolsTheme() {
    try {
      const name = chrome?.devtools?.panels?.themeName;
      if (name === 'dark') return 'dark';
      if (name === 'default') return 'light';
      return null;
    } catch (e) {
      return null;
    }
  }

  function readSystemTheme() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  /**
   * Risolve la preferenza in un tema concreto.
   * In 'system' vince DevTools: e' il contenitore visibile del pannello, e una
   * discrepanza tra i due sarebbe fastidiosa a ogni sguardo.
   */
  function resolve(preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    return st.devtools || readSystemTheme();
  }

  /* ═════════════════════════════ applicazione ═════════════════════════════ */

  function apply() {
    const next = resolve(st.preference);
    const changed = next !== st.resolved;
    st.resolved = next;

    // L'attributo porta la PREFERENZA, non il tema risolto: 'system' deve
    // restare 'system' perche la media query in panel.css possa agire.
    // Quando DevTools e' scuro ma il sistema e' chiaro, forziamo 'dark'
    // esplicitamente: la media query da sola sbaglierebbe.
    const attr = (st.preference === 'system' && st.devtools)
      ? st.devtools
      : st.preference;

    document.documentElement.dataset.theme = attr;
    document.documentElement.dataset.themePreference = st.preference;

    updateButton();

    if (changed) {
      for (const fn of st.listeners) {
        try { fn(st.resolved, st.preference); }
        catch (e) { console.error('[UAD theme] listener', e); }
      }
    }
  }

  function updateButton() {
    if (!el.btn) return;
    const meta = META[st.preference] || META.system;

    if (el.icon) el.icon.textContent = meta.icon;
    el.btn.setAttribute('aria-label', meta.label);

    // In 'system' il tooltip dice anche COSA sta seguendo: senza questo,
    // l'icona ◐ non spiega perche il pannello e' scuro.
    if (st.preference === 'system') {
      const src = st.devtools ? 'DevTools' : 'sistema';
      el.btn.title = `Tema: automatico (segue ${src}: ${st.resolved}). ` +
                     'Clicca per forzare chiaro.';
    } else {
      el.btn.title = meta.title;
    }
  }

  /* ═════════════════════════════ interazione ═════════════════════════════ */

  function cycle() {
    const i = ORDER.indexOf(st.preference);
    const next = ORDER[(i + 1) % ORDER.length];
    set(next);
  }

  async function set(preference) {
    if (!ORDER.includes(preference)) return;
    if (preference === st.preference) return;

    st.preference = preference;
    apply();

    // Persistenza nei settings: il tema sopravvive alla chiusura di DevTools.
    try { await patchSettings({ ui: { theme: preference } }); }
    catch (e) { console.error('[UAD theme] patchSettings', e); }
  }

  /* ═════════════════════════════ osservatori ═════════════════════════════ */

  function watchSystem() {
    try {
      st.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (st.preference === 'system') apply(); };
      // addEventListener e' il metodo moderno; addListener resta per sicurezza
      // su build vecchie, dove il primo non esiste.
      if (typeof st.mediaQuery.addEventListener === 'function') {
        st.mediaQuery.addEventListener('change', handler);
      } else if (typeof st.mediaQuery.addListener === 'function') {
        st.mediaQuery.addListener(handler);
      }
    } catch (e) {
      console.error('[UAD theme] watchSystem', e);
    }
  }

  /**
   * DevTools non emette alcun evento al cambio di tema: l'unico modo di
   * accorgersene e' controllare quando il pannello torna visibile.
   * panel.js chiama questa funzione su 'shown'.
   */
  function refreshDevtoolsTheme() {
    const next = readDevtoolsTheme();
    if (next === st.devtools) return false;
    st.devtools = next;
    if (st.preference === 'system') apply();
    return true;
  }

  /* ═════════════════════════════ avvio ═════════════════════════════ */

  function bind() {
    if (el.btn) el.btn.addEventListener('click', cycle);

    // Scorciatoia: utile quando si passa da una stanza luminosa a una buia.
    document.addEventListener('keydown', (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '');
      if (inField) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        cycle();
      }
    });
  }

  /**
   * Applica la preferenza salvata. Va chiamata il piu presto possibile: se il
   * pannello disegna con i default e poi cambia tema, si vede un lampo bianco.
   */
  function init(settings) {
    const pref = settings?.ui?.theme;
    st.preference = ORDER.includes(pref) ? pref : 'system';
    st.devtools = readDevtoolsTheme();
    apply();
  }

  st.devtools = readDevtoolsTheme();
  st.preference = 'system';
  apply();
  watchSystem();
  bind();

  /* ═════════════════════════════ export ═════════════════════════════ */

  return {
    init,
    set,
    cycle,
    refreshDevtoolsTheme,

    get preference() { return st.preference; },
    get resolved() { return st.resolved; },

    /** Notifica i cambi di tema effettivo: utile se in futuro servisse
     *  ridisegnare qualcosa in canvas, che la CSS non raggiunge. */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      st.listeners.add(fn);
      return () => st.listeners.delete(fn);
    },

    debug: () => ({
      preference: st.preference,
      resolved: st.resolved,
      devtoolsTheme: st.devtools,
      systemTheme: readSystemTheme()
    })
  };
}