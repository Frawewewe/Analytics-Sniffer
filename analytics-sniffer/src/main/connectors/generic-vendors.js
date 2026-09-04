/**
 * Universal Analytics Debugger — connettore generico multi-vendor
 * World: MAIN | Carica dopo il core, prima di content-script.js
 *
 * SCOPO E LIMITI DICHIARATI
 * Un connettore unico che riconosce i vendor noti dal PATTERN DELLA REQUEST e
 * ne mostra i parametri grezzi, senza parsing semantico dedicato.
 * Risponde alla domanda "cosa sta sparando questa pagina?" senza dover
 * scrivere 35 connettori.
 *
 * COSA NON FA — volutamente:
 *   - non decodifica i formati proprietari (es. il campo `cd` di Meta, o gli
 *     eventi custom di TikTok): mostra i parametri cosi come arrivano
 *   - non correla hook e rete: non aggancia hook per nessun vendor, quindi
 *     ogni evento e' un'osservazione di rete pura
 *   - non pretende completezza: un vendor sconosciuto non compare
 *
 * Se un vendor diventa importante per il tuo lavoro, si promuove a connettore
 * dedicato copiando _template.js. Questo resta la rete a strascico.
 *
 * DEFAULT OFF
 * Su un sito con 15 pixel questa tab diventa rumorosa. E' spenta di default e
 * si attiva dai Settings quando serve.
 */
(function () {
  'use strict';

  var UAD = window.__UAD;
  if (!UAD) { try { console.error('[UAD] generic-vendors: namespace assente'); } catch (e) {} return; }

  var ID = 'generic';

  /* ════════════════════════════════════════════════════════════════════════
     Catalogo vendor
     Ogni regola: { name, host, path, param, exclude, eventParam, idParam }
       host       RegExp sull'hostname (indizio, non prova)
       path       RegExp sul pathname
       param      RegExp su una chiave di query (per distinguere endpoint simili)
       eventParam elenco di chiavi che contengono il nome evento
       idParam    elenco di chiavi che contengono l'ID account/pixel
     Il match richiede host OPPURE (path AND param): un vendor su CNAME
     first-party viene comunque riconosciuto dal path.
     ════════════════════════════════════════════════════════════════════════ */

  var VENDORS = [
    // --- Social / advertising
    { name: 'Meta Pixel', color: '#0866ff',
      host: /(^|\.)facebook\.com$|(^|\.)facebook\.net$/, path: /\/tr\/?$/,
      eventParam: ['ev'], idParam: ['id'] },
    { name: 'TikTok Pixel', color: '#000000',
      host: /(^|\.)tiktok\.com$|analytics\.tiktok\.com$/, path: /\/(track|api\/v\d)/,
      eventParam: ['event'], idParam: ['sdkid', 'pixel_code'] },
    { name: 'LinkedIn Insight', color: '#0a66c2',
      host: /(^|\.)linkedin\.com$|px\.ads\.linkedin\.com$/, path: /\/(collect|conversion)/,
      eventParam: ['conversionId'], idParam: ['pid'] },
    { name: 'Pinterest Tag', color: '#e60023',
      host: /(^|\.)pinterest\.com$|ct\.pinterest\.com$/, path: /\/(v3|user|event)/,
      eventParam: ['event'], idParam: ['tid'] },
    { name: 'Snapchat Pixel', color: '#fffc00',
      host: /(^|\.)snapchat\.com$|tr\.snapchat\.com$/, path: /\/(cm|p|gtm)/,
      eventParam: ['ev'], idParam: ['pid'] },
    { name: 'X / Twitter Pixel', color: '#000000',
      host: /(^|\.)twitter\.com$|(^|\.)x\.com$|analytics\.twitter\.com$|t\.co$/,
      path: /\/(i\/adsct|adsct)/, eventParam: ['events'], idParam: ['txn_id', 'p_id'] },
    { name: 'Reddit Pixel', color: '#ff4500',
      host: /(^|\.)reddit\.com$|(^|\.)redditstatic\.com$/, path: /\/(pixel|events)/,
      eventParam: ['event'], idParam: ['id'] },

    // --- Google (oltre GA4/GTM, gestiti da connettori dedicati)
    { name: 'Google Ads Conversion', color: '#4285f4',
      host: /googleadservices\.com$|(^|\.)google\.com$|googlesyndication\.com$/,
      path: /\/pagead\/(conversion|viewthroughconversion|landing)/,
      eventParam: ['label'], idParam: ['id', 'cv'] },
    { name: 'Floodlight (DV360/CM360)', color: '#34a853',
      host: /doubleclick\.net$|fls\.doubleclick\.net$/, path: /\/activityi|\/activity/,
      eventParam: ['type', 'cat'], idParam: ['src'] },
    { name: 'Universal Analytics (legacy)', color: '#f9ab00',
      host: /google-analytics\.com$/, path: /\/(collect|r\/collect|j\/collect)$/,
      param: /^tid$/, exclude: /[?&]v=2(&|$)/,
      eventParam: ['ea', 'ec', 't'], idParam: ['tid'] },
    { name: 'DoubleClick', color: '#4285f4',
      host: /doubleclick\.net$|(^|\.)g\.doubleclick\.net$/, path: /\/pagead|\/ddm/,
      idParam: ['dc_iu'] },

    // --- Session replay / heatmap / UX
    { name: 'Hotjar', color: '#fd3a5c',
      host: /(^|\.)hotjar\.com$|(^|\.)hotjar\.io$/, path: /\/(client|api)/,
      idParam: ['site_id'] },
    { name: 'Contentsquare', color: '#4f46e5',
      host: /contentsquare\.net$|(^|\.)content-square\.com$|c\.contentsquare\.net$/,
      path: /\/(uxa|log|pageview)/, idParam: ['pid'] },
    { name: 'Microsoft Clarity', color: '#0078d4',
      host: /clarity\.ms$/, path: /\/collect|\/tag/, idParam: ['id'] },
    { name: 'FullStory', color: '#0a1e2c',
      host: /(^|\.)fullstory\.com$|(^|\.)fullstory\.org$/, path: /\/(rec|s\/settings)/,
      idParam: ['OrgId'] },
    { name: 'Quantum Metric', color: '#00b8a9',
      host: /quantummetric\.com$/, path: /\/(qm|api)/ },
    { name: 'Glassbox', color: '#f97316',
      host: /glassboxdigital\.io$|glassbox\.com$/, path: /\/(collect|dc)/ },
    { name: 'Mouseflow', color: '#5b21b6',
      host: /mouseflow\.com$/, path: /\/(a|websites)/ },

    // --- Product analytics / CDP
    { name: 'Segment', color: '#52bd94',
      host: /segment\.(io|com)$|api\.segment\.io$/, path: /\/v\d\/(t|p|i|g|a|b)$|\/(track|page|identify|group|alias)$/,
      eventParam: ['event'], idParam: ['writeKey'] },
    { name: 'Amplitude', color: '#1e61f0',
      host: /amplitude\.com$|api\.amplitude\.com$|api2\.amplitude\.com$/, path: /\/(2\/httpapi|batch|collect)/,
      idParam: ['api_key'] },
    { name: 'Mixpanel', color: '#7856ff',
      host: /mixpanel\.com$|api-js\.mixpanel\.com$/, path: /\/(track|engage|decide)/,
      idParam: ['token'] },
    { name: 'Heap', color: '#ff5c35',
      host: /heap(analytics)?\.com$|heapanalytics\.com$/, path: /\/(h|api)/,
      idParam: ['a'] },
    { name: 'Tealium', color: '#0891b2',
      host: /tiqcdn\.com$|tealiumiq\.com$|collect\.tealiumiq\.com$/, path: /\/(utag|event|vdata)/,
      eventParam: ['tealium_event'], idParam: ['tealium_account'] },
    { name: 'mParticle', color: '#1f2937',
      host: /mparticle\.com$|nativesdks\.mparticle\.com$/, path: /\/v\d\//, idParam: ['apiKey'] },
    { name: 'Snowplow', color: '#6638b6',
      host: /snowplowanalytics\.com$/, path: /\/(com\.snowplowanalytics|i|tp2)$/,
      eventParam: ['e', 'se_ac'] },
    { name: 'Matomo / Piwik', color: '#3152a0',
      host: /matomo\.(cloud|org)$|piwik\.(pro|org)$/, path: /\/(matomo|piwik|ppms)\.php$/,
      eventParam: ['action_name', 'e_a'], idParam: ['idsite'] },
    { name: 'Plausible', color: '#5850ec',
      host: /plausible\.io$/, path: /\/api\/event$/, eventParam: ['n'], idParam: ['d'] },

    // --- Retail / affiliate / retargeting
    { name: 'Criteo', color: '#f26522',
      host: /criteo\.(com|net)$|sslwidget\.criteo\.com$|dis\.criteo\.com$/,
      path: /\/(event|dis|delivery)/, eventParam: ['ev'], idParam: ['a'] },
    { name: 'RTB House', color: '#ef4444',
      host: /rtbhouse\.com$|creativecdn\.com$/, path: /\/(b|tags)/ },
    { name: 'Awin', color: '#f59e0b',
      host: /awin1\.com$|dwin1\.com$/, path: /\/(sread|cread|pread)/, idParam: ['tt'] },
    { name: 'TradeDoubler', color: '#0ea5e9',
      host: /tradedoubler\.com$|tradedoubler\.net$/, path: /\/(report|wt)/ },
    { name: 'Bing / Microsoft Ads (UET)', color: '#008373',
      host: /bing\.com$|bat\.bing\.(com|net)$/, path: /\/(action|bat)/,
      eventParam: ['evt'], idParam: ['ti'] },

    // --- Email / marketing automation
    { name: 'Klaviyo', color: '#f5b400',
      host: /klaviyo\.com$|a\.klaviyo\.com$/, path: /\/(onsite|api|client)/, idParam: ['company_id'] },
    { name: 'Braze', color: '#8b5cf6',
      host: /braze\.(com|eu)$|sdk\.iad-\d+\.braze\.com$/, path: /\/api\/v\d/ },
    { name: 'Salesforce Interaction Studio', color: '#00a1e0',
      host: /evergage\.com$|salesforce\.com$/, path: /\/(api|event)/ },
    { name: 'HubSpot', color: '#ff7a59',
      host: /hs-analytics\.net$|hubspot\.com$|track\.hubspot\.com$/, path: /\/(__ptq\.gif|v\d)/,
      idParam: ['portalId'] },
    { name: 'Marketo (Munchkin)', color: '#5c4c9f',
      host: /marketo\.(net|com)$|munchkin\.marketo\.net$/, path: /\/(webevents|munchkin)/ },

    // --- Consent / privacy
    { name: 'OneTrust', color: '#4f5eff',
      host: /onetrust\.(com|io)$|cdn\.cookielaw\.org$|geolocation\.onetrust\.com$/,
      path: /\/(consent|scripttemplates|geo)/ },
    { name: 'Cookiebot', color: '#1e40af',
      host: /cookiebot\.com$|consent\.cookiebot\.com$/, path: /\/(uc\.js|consentconfig|logconsent)/ },
    { name: 'Usercentrics', color: '#0f172a',
      host: /usercentrics\.eu$|usercentrics\.com$/, path: /\/(latest|settings|consent)/ },
    { name: 'Didomi', color: '#00b2a9',
      host: /didomi\.io$/, path: /\/(consents|api)/ },

    // --- A/B testing / personalizzazione
    { name: 'Adobe Target', color: '#fa0f00',
      host: /tt\.omtrdc\.net$/, path: /\/(m2|rest|v\d)/, idParam: ['client'] },
    { name: 'Optimizely', color: '#0037ff',
      host: /optimizely\.com$|logx\.optimizely\.com$/, path: /\/(v1\/events|log)/ },
    { name: 'VWO', color: '#f43f5e',
      host: /visualwebsiteoptimizer\.com$|vwo\.com$/, path: /\/(j\.php|track|server-side)/ },
    { name: 'AB Tasty', color: '#7c3aed',
      host: /abtasty\.com$|ariane\.abtasty\.com$/, path: /\/(v\d|tag)/ },
    { name: 'Dynamic Yield', color: '#0ea5e9',
      host: /dynamicyield\.com$|st-eu\.dynamicyield\.com$/, path: /\/(api|dy)/ },

    // --- Attribution / MMP
    { name: 'AppsFlyer', color: '#20c997',
      host: /appsflyer\.com$|banners\.appsflyer\.com$/, path: /\/(api|onelink)/ },
    { name: 'Branch', color: '#1a73e8',
      host: /branch\.io$|api\.branch\.io$|api2\.branch\.io$/, path: /\/v\d\//, idParam: ['branch_key'] },
    { name: 'Adjust', color: '#1e293b',
      host: /adjust\.com$|app\.adjust\.com$/, path: /\/(session|event)/ }
  ];

  /* ════════════════════════════════════════════════════════════════════════
     Matching
     ════════════════════════════════════════════════════════════════════════ */

  var cache = {};   // url -> nome vendor | false (evita ri-matching identico)

  function identify(rec) {
    var u = rec.urlObj;
    if (!u) return null;

    var key = u.hostname + u.pathname + (u.search ? u.search.slice(0, 60) : '');
    if (key in cache) return cache[key];

    var host = u.hostname, path = u.pathname, search = u.search || '';
    var result = null;

    for (var i = 0; i < VENDORS.length; i++) {
      var v = VENDORS[i];

      if (v.exclude && v.exclude.test(search)) continue;

      var hostOk = v.host ? v.host.test(host) : false;
      var pathOk = v.path ? v.path.test(path) : false;
      var paramOk = v.param ? paramPresent(search, v.param) : true;

      // hostname noto -> basta il path (o niente path definito).
      if (hostOk && (pathOk || !v.path) && paramOk) { result = v; break; }
      // CNAME first-party -> serve path E un parametro caratteristico.
      if (!hostOk && pathOk && v.param && paramOk) { result = v; break; }
    }

    cache[key] = result;
    if (Object.keys(cache).length > 400) cache = {};
    return result;
  }

  function paramPresent(search, re) {
    if (!search) return false;
    var parts = search.replace(/^\?/, '').split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      var k = eq === -1 ? parts[i] : parts[i].slice(0, eq);
      if (re.test(k)) return true;
    }
    return false;
  }

  /* ════════════════════════════════════════════════════════════════════════
     Parsing dei parametri
     ════════════════════════════════════════════════════════════════════════ */

  function pushRow(cats, cat, key, value, src) {
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push({ key: key, value: value, src: src || null });
  }

  function decodeVal(s) {
    try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); }
    catch (e) { return String(s); }
  }

  /** Alcuni vendor annidano JSON in un parametro (Meta `cd`, Criteo, Segment). */
  function tryParseJson(v) {
    if (typeof v !== 'string') return null;
    var t = v.trim();
    if (t.length < 2) return null;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  function flattenInto(obj, cats, cat, prefix, depth) {
    depth = depth || 0;
    if (depth > 6 || !obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      var path = prefix ? (prefix + '.' + k) : k;
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) {
        if (!v.length) { pushRow(cats, cat, path, '[]', path); return; }
        for (var i = 0; i < Math.min(v.length, 30); i++) {
          if (v[i] && typeof v[i] === 'object') flattenInto(v[i], cats, cat, path + '[' + i + ']', depth + 1);
          else pushRow(cats, cat, path + '[' + i + ']', v[i], path);
        }
        return;
      }
      if (typeof v === 'object') { flattenInto(v, cats, cat, path, depth + 1); return; }
      pushRow(cats, cat, path, v, path);
    });
  }

  function parseQueryInto(search, cats, vendor, out) {
    if (!search) return;
    var parts = search.replace(/^\?/, '').split('&');

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var eq = p.indexOf('=');
      var k = decodeVal(eq === -1 ? p : p.slice(0, eq));
      var v = eq === -1 ? '' : decodeVal(p.slice(eq + 1));

      // Nome evento e ID account vanno in evidenza.
      if (vendor.eventParam && vendor.eventParam.indexOf(k) !== -1 && v) {
        out.eventName = out.eventName || v;
        pushRow(cats, 'Evento', k, v, k);
        continue;
      }
      if (vendor.idParam && vendor.idParam.indexOf(k) !== -1 && v) {
        out.accountId = out.accountId || v;
        pushRow(cats, 'Account', k, v, k);
        continue;
      }

      // JSON annidato: lo espandiamo invece di mostrare una stringa illeggibile.
      var j = tryParseJson(v);
      if (j) { flattenInto(j, cats, 'Parametri: ' + k, '', 0); continue; }

      // Notazione a bracket usata da Meta e altri: cd[content_ids][0]
      var m = /^([a-zA-Z0-9_]+)((\[[^\]]*\])+)$/.exec(k);
      if (m) {
        var inner = m[2].replace(/\]\[/g, '.').replace(/[\[\]]/g, '');
        pushRow(cats, 'Parametri: ' + m[1], inner, v, k);
        continue;
      }

      pushRow(cats, 'Parametri', k, v, k);
    }
  }

  function parseBodyInto(body, cats, vendor, out) {
    if (!body) return;

    if (typeof body === 'object') { flattenInto(body, cats, 'Body', '', 0); return; }
    if (typeof body !== 'string' || !body) return;

    var j = tryParseJson(body);
    if (j) {
      // Molti vendor inviano un array di eventi: ognuno merita la sua sezione.
      if (Array.isArray(j)) {
        for (var i = 0; i < Math.min(j.length, 20); i++) {
          flattenInto(j[i], cats, 'Body [' + i + ']', '', 0);
        }
      } else {
        flattenInto(j, cats, 'Body', '', 0);
        if (!out.eventName && typeof j.event === 'string') out.eventName = j.event;
        if (!out.eventName && typeof j.eventName === 'string') out.eventName = j.eventName;
        if (!out.eventName && typeof j.type === 'string') out.eventName = j.type;
      }
      return;
    }

    // Body urlencoded
    if (body.indexOf('=') !== -1) {
      parseQueryInto('?' + body, cats, vendor, out);
      return;
    }
    pushRow(cats, 'Body', 'contenuto', body.slice(0, 2000), null);
  }

  /* ════════════════════════════════════════════════════════════════════════
     Costruzione dell'evento
     ════════════════════════════════════════════════════════════════════════ */

  var state = { attached: false, hits: 0, seen: {} };

  function parseNetwork(rec) {
    var vendor = identify(rec);
    if (!vendor) return;

    var cats = {};
    var out = { eventName: null, accountId: null };
    var u = rec.urlObj;

    pushRow(cats, 'Richiesta', 'vendor', vendor.name, null);
    pushRow(cats, 'Richiesta', 'endpoint', u.hostname + u.pathname, null);
    pushRow(cats, 'Richiesta', 'metodo', rec.method, null);
    pushRow(cats, 'Richiesta', 'canale', rec.via, null);
    if (rec.status !== null && rec.status !== undefined) {
      pushRow(cats, 'Richiesta', 'HTTP status', rec.status, null);
    }
    if (rec.durationMs !== null && rec.durationMs !== undefined) {
      pushRow(cats, 'Richiesta', 'durata', rec.durationMs + 'ms', null);
    }

    parseQueryInto(u.search, cats, vendor, out);
    parseBodyInto(rec.body, cats, vendor, out);

    // Un hostname non riconosciuto ma path corrispondente indica un proxy
    // first-party: informazione rilevante, perche spiega perche il pixel non
    // viene bloccato dagli ad blocker.
    if (vendor.host && !vendor.host.test(u.hostname)) {
      pushRow(cats, 'Richiesta', 'proxy first-party',
        'servito da ' + u.hostname + ' invece del dominio del vendor', null);
    }

    state.hits++;
    state.seen[vendor.name] = (state.seen[vendor.name] || 0) + 1;

    var name = vendor.name + (out.eventName ? ' · ' + out.eventName : '');

    // Nessuna correlazione: non agganciamo hook per questi vendor, quindi ogni
    // request e' un'osservazione autonoma. Emissione diretta.
    UAD.emit(ID, {
      name: name,
      categorizedFields: cats,
      source: 'network',
      timestamp: rec.ts,
      rawDebugString: rec.url +
        (rec.body && typeof rec.body === 'string' ? '\n\n[body]\n' + rec.body.slice(0, 4000) : '') +
        (rec.bodyTruncated ? '\n\n[body troncato]' : ''),
      meta: {
        vendor: vendor.name,
        vendorColor: vendor.color,
        accountId: out.accountId || undefined,
        httpStatus: rec.status,
        via: rec.via
      }
    });
  }

  /* ════════════════════════════════════════════════════════════════════════
     Connettore
     ════════════════════════════════════════════════════════════════════════ */

  var connector = {
    id: ID,
    label: 'Altri tool',
    colorTheme: '#6b7280',

    /**
     * Non esistono global affidabili per 35 vendor diversi: la detection e'
     * puramente reattiva. La tab compare alla prima request riconosciuta.
     * Nessun costo se il sito non ha pixel.
     */
    detect: function () {
      return state.hits > 0;
    },

    attach: function () {
      if (state.attached) return;
      state.attached = true;
      // Nessun hook: solo osservazione di rete. E' anche la ragione per cui
      // questo connettore non puo alterare in alcun modo il comportamento
      // della pagina.
      UAD.log(ID + ' attach completato (solo rete, ' + VENDORS.length + ' vendor noti)');
    },

    matches: function (url, method, body, rec) {
      try { return !!identify(rec); }
      catch (e) { return false; }
    },

    parseNetwork: function (rec) {
      UAD.safe(ID + '.parseNetwork', parseNetwork)(rec);
    },

    /** Esposto per la diagnostica: quali vendor ha visto e quante volte. */
    __stats: function () {
      return { hits: state.hits, vendors: state.seen, catalogSize: VENDORS.length };
    }
  };

  // default OFF: su un sito con 15 pixel questa tab e' rumorosa.
  UAD.register(connector, false);
})();