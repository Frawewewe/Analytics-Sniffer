/**
 * Universal Analytics Debugger — finestra di concessione dei permessi
 * Contesto: pagina di estensione in finestra popup
 *
 * PERCHE ESISTE QUESTO FILE
 * chrome.permissions.request() richiede un user gesture in un contesto valido.
 * Le pagine DevTools NON sono considerate tali: chiamata dal pannello, il
 * dialog di conferma spesso non compare affatto, senza alcun errore. Sintomo:
 * clicchi il toggle e non succede niente.
 * Qui siamo in una finestra di estensione normale: il clic e' un gesture valido
 * e il dialog compare sempre. Il pannello scopre l'esito ascoltando
 * chrome.permissions.onAdded, e questa finestra si chiude da sola.
 *
 * PARAMETRI (querystring)
 *   p = permessi separati da virgola, es. "cookies"
 *   f = id della feature che li richiede, es. "cookieInspector"
 *
 * RESPONSABILITA AGGIUNTIVA
 * Se un permesso non e' concedibile su questa versione di Chrome (il caso
 * dichiarato come incerto per declarativeNetRequest in optional_permissions),
 * questa finestra lo scopre e lo DICE, invece di lasciare il pannello in attesa
 * di un evento che non arrivera mai.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Descrizioni: cosa serve, e per fare cosa
   L'utente deve poter decidere sapendo esattamente a cosa serve il permesso.
   ═══════════════════════════════════════════════════════════════════════════ */

const PERMISSION_INFO = {
  'cookies': {
    label: 'cookies',
    why: 'Leggere e cancellare i cookie del sito ispezionato, inclusi quelli ' +
         'HttpOnly che JavaScript non può vedere.'
  },
  'declarativeNetRequest': {
    label: 'declarativeNetRequest',
    why: 'Bloccare i redirect della pagina ispezionata. È l\'unico metodo ' +
         'affidabile: location.href non è intercettabile da JavaScript.'
  },
  'declarativeNetRequestWithHostAccess': {
    label: 'declarativeNetRequestWithHostAccess',
    why: 'Applicare il blocco solo alla scheda che stai ispezionando, invece ' +
         'che a tutta la navigazione.'
  }
};

const FEATURE_INFO = {
  cookieInspector: {
    title: 'Cookie inspector',
    desc: 'Mostra i cookie del dominio ispezionato con valori decodificati ' +
          '(client ID, ECID, sessione), inclusi i cookie HttpOnly.'
  },
  cookieClear: {
    title: 'Clear cookie',
    desc: 'Cancella i cookie di analytics, o tutti quelli del dominio, con ' +
          'ricaricamento opzionale della pagina.'
  },
  cookieCrossCheck: {
    title: 'Cross-check cookie ↔ hit',
    desc: 'Segnala quando il client ID o l\'ECID nelle chiamate non ' +
          'corrispondono ai cookie: sintomo di identity split.'
  },
  stopNavigation: {
    title: 'Stop navigazione',
    desc: 'Blocca i redirect della pagina, per poter cliccare una CTA senza ' +
          'perdere il contesto raccolto.'
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Utilità
   ═══════════════════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);

function parseParams() {
  const q = new URLSearchParams(location.search);
  const raw = q.get('p') || '';
  const permissions = raw.split(',').map(s => s.trim()).filter(Boolean);
  const feature = q.get('f') || null;
  return { permissions, feature };
}

function setStatus(kind, text) {
  const el = $('status');
  if (!kind) { el.removeAttribute('data-kind'); el.textContent = ''; return; }
  el.dataset.kind = kind;
  el.textContent = text;
}

function closeSoon(ms) {
  setTimeout(() => { try { window.close(); } catch (e) {} }, ms);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Rendering
   ═══════════════════════════════════════════════════════════════════════════ */

const { permissions, feature } = parseParams();

function render() {
  // Titolo e descrizione: quando conosciamo la feature, il testo dice
  // esattamente cosa si sta attivando invece di un messaggio generico.
  const info = feature && FEATURE_INFO[feature];
  if (info) {
    $('title').textContent = 'Attiva: ' + info.title;
    $('desc').textContent = info.desc;
  } else {
    $('title').textContent = 'Permesso richiesto';
    $('desc').textContent = 'Per attivare questa funzione l\'estensione ha ' +
                            'bisogno di un permesso aggiuntivo.';
  }

  const list = $('perms');
  list.textContent = '';

  if (!permissions.length) {
    setStatus('err', 'Nessun permesso specificato: chiudi questa finestra e riprova dal pannello.');
    $('grant').disabled = true;
    return;
  }

  for (const p of permissions) {
    const meta = PERMISSION_INFO[p] || { label: p, why: 'Permesso richiesto dall\'estensione.' };
    const li = document.createElement('li');

    const code = document.createElement('code');
    code.textContent = meta.label;

    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = meta.why;

    li.append(code, why);
    list.appendChild(li);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Verifica preliminare
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Se il permesso e' GIA concesso non serve chiedere nulla: puo capitare quando
 * due feature condividono lo stesso permesso (le tre funzioni cookie).
 */
async function checkAlreadyGranted() {
  try {
    const has = await chrome.permissions.contains({ permissions });
    if (!has) return false;
    setStatus('ok', 'Permesso già concesso. Puoi chiudere questa finestra.');
    $('grant').textContent = 'Chiudi';
    $('grant').onclick = () => window.close();
    $('cancel').hidden = true;
    closeSoon(1600);
    return true;
  } catch (e) {
    // contains() lancia se il permesso non e' dichiarato in
    // optional_permissions: e' informazione utile, la gestiamo sotto.
    console.error('[UAD grant] contains()', e);
    return false;
  }
}

/**
 * Verifica che i permessi siano dichiarati come opzionali nel manifest.
 * Serve per il caso dichiarato incerto: declarativeNetRequest in
 * optional_permissions non e' supportato in modo uniforme tra versioni di
 * Chrome. Se non e' concedibile, e' meglio dirlo qui che lasciare il pannello
 * in attesa di un onAdded che non arrivera.
 */
function checkDeclared() {
  try {
    const m = chrome.runtime.getManifest();
    const declared = new Set([
      ...(m.optional_permissions || []),
      ...(m.permissions || [])
    ]);
    const missing = permissions.filter(p => !declared.has(p));
    if (missing.length) {
      setStatus('err',
        'Questi permessi non sono richiedibili su questa versione di Chrome: ' +
        missing.join(', ') + '. Puoi nascondere l\'icona corrispondente dalle ' +
        'Impostazioni del pannello.');
      $('grant').disabled = true;
      return false;
    }
    return true;
  } catch (e) {
    console.error('[UAD grant] getManifest()', e);
    return true;   // in caso di dubbio proviamo comunque
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Richiesta
   ═══════════════════════════════════════════════════════════════════════════ */

function requestPermissions() {
  // NON usiamo await prima di request(): il gesture dell'utente si perde
  // attraversando un confine asincrono, e il dialog non comparirebbe.
  // Questa e' la ragione tecnica per cui il pulsante chiama request() come
  // primissima operazione.
  try {
    chrome.permissions.request({ permissions }, (granted) => {
      const err = chrome.runtime.lastError;

      if (err) {
        console.error('[UAD grant] request()', err.message);
        setStatus('err', 'Richiesta non riuscita: ' + err.message);
        $('grant').disabled = false;
        return;
      }

      if (granted) {
        setStatus('ok', 'Permesso concesso. La funzione è ora attiva nel pannello.');
        $('grant').disabled = true;
        $('cancel').hidden = true;
        // Il pannello si aggiorna da solo tramite chrome.permissions.onAdded:
        // non serve inviargli alcun messaggio.
        closeSoon(1200);
        return;
      }

      setStatus('warn', 'Permesso negato. La funzione resta disattivata; ' +
                        'puoi nascondere la sua icona dalle Impostazioni.');
      $('grant').disabled = false;
      $('grant').textContent = 'Riprova';
    });
  } catch (e) {
    console.error('[UAD grant] request() throw', e);
    setStatus('err', 'Richiesta non supportata in questo contesto: ' + (e.message || e));
    $('grant').disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Binding
   ═══════════════════════════════════════════════════════════════════════════ */

$('grant').addEventListener('click', () => {
  setStatus(null);
  $('grant').disabled = true;
  requestPermissions();
});

$('cancel').addEventListener('click', () => {
  try { window.close(); } catch (e) {}
});

// Invio = consenti, Esc = annulla: la finestra e' una decisione binaria e deve
// essere gestibile senza mouse.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); window.close(); }
  if (e.key === 'Enter' && !$('grant').disabled) { e.preventDefault(); $('grant').click(); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   Avvio
   ═══════════════════════════════════════════════════════════════════════════ */

(async function boot() {
  render();
  if (!permissions.length) return;
  if (!checkDeclared()) return;
  await checkAlreadyGranted();
})();