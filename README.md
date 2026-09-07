**Analytics Sniffer**

Chrome extension (Manifest V3) with a DevTools panel to inspect analytics calls in real time on any website.

**SUPPORTED TOOLS**

Google Analytics 4 — /g/collect hits, gtag hook, G- and GT- prefixes Google Tag Manager — dataLayer pushes, containers, Consent Mode v2 Adobe Analytics — AppMeasurement / s_code, /b/ss/ hits Adobe Web SDK — Alloy, XDM payloads, Edge Network Other tools — about 45 vendors (Meta, TikTok, Criteo, Hotjar) without dedicated parsing

Plugin architecture: to add a tool, copy src/main/connectors/_template.js and declare it in the manifest. No core changes needed.

**INSTALL**

git clone https://github.com//analytics-sniffer.git

Open chrome://extensions, enable Developer mode, click "Load unpacked" and select the folder. Requires Chrome 111+.

**USAGE**

Open a site, reload the page (content scripts only inject on document load), then open DevTools and go to the "Analytics" tab.

If the panel stays empty: Settings, then Diagnostics.

**KEY FEATURES**

Redundant capture. Every tool is observed on multiple channels at once: JavaScript hooks, dataLayer pushes, and network interception across five vectors (fetch, XHR, sendBeacon, img.src, setAttribute). The network is the source of truth — it's what the vendor actually receives — while hooks add the original source variable names, which the network can't know.

Channel badge. Each event declares where it was observed. An event marked "hook" only, with no matching network call, means the code asked to track but nothing was sent: denied consent, missing trigger, paused tag, JS error. This is the tool's most useful diagnostic.

Path-based matching, not hostname. With server-side tagging and first-party CNAMEs, endpoints live on client domains. Matching relies on path, query and payload shape.

SPA support. Each pushState navigation opens its own section.

Search and filters. Search across keys, values, event names, channel and source variable names. Filters with nine operators and AND/OR chaining.

**OPTIONAL FEATURES**

Off by default, enabled from Settings.

Cookie inspector — inspect and clear cookies including HttpOnly ones. Three clear levels: analytics, analytics plus localStorage, all. Requires the cookies permission.

Cookie/hit cross-check — flags when cid, session or ECID in requests don't match the cookies. Requires the cookies permission.

Stop navigation — blocks redirects so you can click a CTA without losing context.

Dev references — copies URL and timestamp for manual lookup in the Network tab.

Adobe heuristics (visible only when an Adobe tool is active) — data element polling for XDM when the Alloy instance isn't globally exposed, and eVar-to-human-name mapping for EDDL implementations. Undocumented techniques, best-effort: on some setups they find nothing, and an absent result is not an error.

**KNOWN LIMITS**

Content scripts inject on document load: a page already open at install time won't be instrumented until reloaded.

Main frame only. Iframes are not tracked.

ECID cross-check on kndctr_*_identity cookies is heuristic: the format is undocumented and changes across Web SDK versions.

Hook-only events appear in the panel about 1.2 seconds after they occur, due to the correlation window. The displayed timestamp is the real one.

**PRIVACY**

No data leaves the browser. Everything lives in chrome.storage.local, isolated per tab, cleared when the tab closes. No telemetry, no external requests.

The <all_urls> host permission is required for the extension to work on any site.
