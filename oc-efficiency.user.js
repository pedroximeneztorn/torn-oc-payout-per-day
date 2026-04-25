// ==UserScript==
// @name         Torn OC 2.0 Efficiency
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Estimates min/max/avg/daily payout per slot for OC 2.0 crimes, with a 24h API price cache.
// @author       rem4rk
// @license      MIT
// @match        https://*.torn.com/factions.php?step=your*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration & data ---
    const CACHE_DURATION = 24 * 60 * 60 * 1000;
    const CATEGORIES = ['Drug', 'Material', 'Special', 'Supply Pack'];
    const SUCCESS_BASELINE = 0.8;

    const OC_DATA = {
        'First Aid and Abet':       { days: 3, payout: [2000000, 3000000] },
        'Mob Mentality':            { days: 4, payout: [673000, 1500000] },
        'Pet Project':              { days: 3, payout: [414000, 806000] },
        'Thou Shalt Not Steal':     { days: 3, payout: [1000000, 2000000] },
        'Cash Me If You Can':       { days: 3, payout: [829000, 1601000] },
        'Best of the Lot':          { days: 4, payout: [12000000, 18000000] },
        'Smoke and Wing Mirrors':   { days: 4, payout: [20000000, 30000000] },
        'Market Forces':            { days: 5, payout: [5095000, 8575000] },
        'Gaslight the Way':         { days: 6, payout: [3000000, 5000000] },
        'Snow Blind':               { days: 4, payout: [5575000, 10565000] },
        'Plucking the Lotus Petal': { days: 4, payout: [7000000, 9000000] },
        'Stage Fright':             { days: 6, items: [{ id: 206, qty: [10, 30] }] },
        'Guardian Angels':          { days: 3, payout: [10000000, 14000000] },
        'Honey Trap':               { days: 3, payout: [7000000, 11000000] },
        'Counter Offer':            { days: 5, payout: [12000000, 18000000] },
        'No Reserve':               { days: 3, payout: [9000000, 13000000] },
        'Bidding War':              { days: 6, payout: [15000000, 21000000] },
        'Leave No Trace':           { days: 3, payout: [8000000, 12000000] },
        'Sneaky Git Grab':          { days: 4, payout: [11000000, 17000000] },
        'Crane Reaction':           { days: 5, items: [{ id: 370, qty: [2, 5] }] },
        'Blast from the Past':      { days: 6, payout: [40000000, 50000000] },
        'Window of Opportunity':    { days: 5, payout: [30000000, 40000000] },
        'Break the Bank':           { days: 6, payout: [50000000, 70000000] },
        'Stacking the Deck':        { days: 4, payout: [35000000, 45000000] },
        'Manifest Cruelty':         { days: 4, payout: [33000000, 43000000] },
        'Ace in the Hole':          { days: 5, payout: [50000000, 60000000] },
        'Gone Fission':             { days: 5, items: [{ id: 818, qty: [1, 1] }] },
    };

    // Whitespace/badge wrappers around the rendered title can break exact-key
    // lookups, so resolve via a normalized map instead.
    function normalizeTitle(s) {
        return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    const OC_DATA_BY_TITLE = Object.fromEntries(
        Object.entries(OC_DATA).map(([k, v]) => [normalizeTitle(k), v]),
    );

    // --- Settings ---
    const SETTINGS_KEY = 'ocSettings';
    const DEFAULT_SETTINGS = {
        apiKey: '',
        factionPayout: 90,
        marketCache: {},
        lastMarketSync: 0,
    };

    function normalizeSettings(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const payout = Number(s.factionPayout);
        const sync = Number(s.lastMarketSync);
        return {
            apiKey: typeof s.apiKey === 'string' ? s.apiKey : DEFAULT_SETTINGS.apiKey,
            factionPayout: Number.isFinite(payout) ? payout : DEFAULT_SETTINGS.factionPayout,
            marketCache: s.marketCache && typeof s.marketCache === 'object' ? s.marketCache : {},
            lastMarketSync: Number.isFinite(sync) ? sync : 0,
        };
    }

    let settings = normalizeSettings(GM_getValue(SETTINGS_KEY, DEFAULT_SETTINGS));

    function saveSettings(patch) {
        settings = normalizeSettings({ ...settings, ...patch });
        GM_setValue(SETTINGS_KEY, settings);
    }

    // --- CSS module class detection ---
    // Generic prefixes like "wrapper" / "panel" can collide with unrelated React
    // components, so we (a) check hashed (CSS-module) selectors first and only
    // fall back to plain class names, and (b) skip the global cache so a wrong
    // first match can't poison the rest of the session.
    function findClass(prefix) {
        const el = document.querySelector(`[class*="${prefix}___"]`);
        if (el) {
            const match = el.className.match(new RegExp(`${prefix}___\\w+`));
            if (match) return match[0];
        }

        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules || []) {
                    if (rule.selectorText && rule.selectorText.includes(`${prefix}___`)) {
                        const m = rule.selectorText.match(new RegExp(`${prefix}___\\w+`));
                        if (m) return m[0];
                    }
                }
            } catch (e) {
                // Cross-origin stylesheets throw on access
            }
        }

        if (document.querySelector(`.${prefix}`)) return prefix;

        return null;
    }

    // --- Style helper ---
    const fText = (color, size = '12px', bold = 'bold') => `
        color: ${color} !important;
        font-size: ${size} !important;
        font-weight: ${bold} !important;
        text-shadow: 1px 1px 0px #000, -1px -1px 0px #000 !important;
        background: transparent !important;
        font-family: 'Courier New', monospace !important;
    `;

    // --- API & caching ---
    let syncInFlight = false;
    let pendingForceSync = false;

    function syncMarketPrices(force = false) {
        if (!settings.apiKey) {
            console.log('[OC] No API key — skipping sync.');
            return;
        }
        if (syncInFlight) {
            // The in-flight batch captured the previous apiKey in its URLs, so
            // a force-sync after a key change must run once it finishes.
            if (force) {
                pendingForceSync = true;
                console.log('[OC] Sync in flight — queued force-sync.');
            } else {
                console.log('[OC] Sync already in flight — skipping.');
            }
            return;
        }

        const fresh = Date.now() - settings.lastMarketSync < CACHE_DURATION
            && Object.keys(settings.marketCache).length > 0;
        if (!force && fresh) {
            console.log('[OC] Market cache fresh (<24h).');
            return;
        }

        console.log('[OC] Syncing market prices via Torn API...');
        syncInFlight = true;
        const merged = {};
        let pending = CATEGORIES.length;
        let failures = 0;

        const finalize = () => {
            syncInFlight = false;
            if (Object.keys(merged).length > 0) {
                // Only stamp lastMarketSync when every category succeeded —
                // partial failures should retry on the next page load instead
                // of poisoning the cache for 24h.
                const patch = { marketCache: { ...settings.marketCache, ...merged } };
                if (failures === 0) patch.lastMarketSync = Date.now();
                saveSettings(patch);
                console.log(`[OC] Market cache updated (failures=${failures}), redrawing.`);
                redrawStats();
            } else {
                console.log('[OC] Sync produced no data; cache unchanged.');
            }
            if (pendingForceSync) {
                pendingForceSync = false;
                syncMarketPrices(true);
            }
        };

        CATEGORIES.forEach(cat => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.torn.com/v2/torn/items?key=${encodeURIComponent(settings.apiKey)}&cat=${encodeURIComponent(cat)}`,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.error) {
                            failures++;
                            console.log(`[OC] API error for ${cat}:`, data.error);
                        } else if (Array.isArray(data.items)) {
                            data.items.forEach(i => {
                                const price = i?.value?.market_price;
                                if (typeof price === 'number') merged[i.id] = price;
                            });
                            console.log(`[OC] Got ${data.items.length} items for ${cat}.`);
                        } else {
                            failures++;
                            console.log(`[OC] Unexpected response shape for ${cat}.`);
                        }
                    } catch (e) {
                        failures++;
                        console.log(`[OC] Parse error for ${cat}:`, e);
                    }
                    if (--pending === 0) finalize();
                },
                onerror: (err) => {
                    failures++;
                    console.log(`[OC] HTTP error for ${cat}:`, err);
                    if (--pending === 0) finalize();
                },
            });
        });
    }

    // --- UI ---
    function injectControlPanel() {
        if (document.getElementById('oc-persistent-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'oc-persistent-panel';
        panel.setAttribute('style', 'position:fixed; bottom:20px; left:20px; z-index:999999; background:#000 !important; border:2px solid #37bcd6 !important; padding:12px; width:190px; box-shadow: 5px 5px 20px #000;');
        panel.innerHTML = `
            <div style="${fText('#37bcd6', '11px')} border-bottom:1px solid #37bcd6; margin-bottom:8px;">OC EFFICIENCY</div>
            <div style="${fText('#fff', '12px')} margin-bottom:10px;">CURRENT CUT: <span id="oc-cut-display" style="color:#0f0 !important;">${settings.factionPayout}%</span></div>
            <button id="oc-btn-payout" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; margin-bottom:5px; cursor:pointer;">Adjust Payout %</button>
            <button id="oc-btn-sync" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; margin-bottom:5px; cursor:pointer;">Force Market Sync</button>
            <button id="oc-btn-api" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; cursor:pointer;">Update API Key</button>
        `;
        document.body.appendChild(panel);

        document.getElementById('oc-btn-payout').onclick = promptPayout;
        document.getElementById('oc-btn-sync').onclick = () => syncMarketPrices(true);
        document.getElementById('oc-btn-api').onclick = promptApiKey;
    }

    function promptPayout() {
        const v = prompt('Enter Faction Payout % (e.g. 90):', String(settings.factionPayout));
        if (v == null) return;
        const num = parseFloat(v);
        if (Number.isFinite(num) && num >= 0 && num <= 100) {
            saveSettings({ factionPayout: num });
            const display = document.getElementById('oc-cut-display');
            if (display) display.textContent = `${num}%`;
            redrawStats();
        }
    }

    function promptApiKey() {
        const v = prompt('Enter API Key:', settings.apiKey);
        if (v == null) return;
        const trimmed = v.trim();
        if (trimmed) {
            saveSettings({ apiKey: trimmed });
            syncMarketPrices(true);
        }
    }

    function showApiKeyModal() {
        if (document.getElementById('oc-api-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'oc-api-modal';
        modal.setAttribute('style', 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.95); z-index:2000000; display:flex; align-items:center; justify-content:center;');
        modal.innerHTML = `<div style="background:#111; padding:30px; border:2px solid #37bcd6; text-align:center;">
            <h2 style="${fText('#37bcd6', '18px')}">API KEY REQUIRED</h2>
            <input type="text" id="oc-api-input" style="width:250px; padding:10px; margin:20px 0; background:#000; color:#fff; border:1px solid #444;">
            <br><button id="oc-api-save" style="background:#37bcd6; color:#000; padding:10px 30px; font-weight:bold; cursor:pointer;">SAVE & START</button>
        </div>`;
        document.body.appendChild(modal);
        document.getElementById('oc-api-save').onclick = () => {
            const val = document.getElementById('oc-api-input').value.trim();
            if (val) {
                saveSettings({ apiKey: val });
                modal.remove();
                syncMarketPrices(true);
            }
        };
    }

    // --- Stats rendering ---
    function drawStats() {
        // The class prefixes here ('wrapper', 'panel', 'panelTitle') are
        // generic enough that findClass() can match unrelated React components
        // elsewhere on the page. We don't scope the lookup to a known crimes
        // container yet (don't have a stable selector for one), but the
        // OC_DATA_BY_TITLE check below acts as an implicit verifier: a wrong
        // wrapper class still produces no draws, since unrelated panels won't
        // have a recognized OC title. TODO: scope this to the crimes container
        // once we have a reliable anchor.
        const wrapperClass = findClass('wrapper');
        const titleClass = findClass('panelTitle');
        const panelClass = findClass('panel');
        const successClass = findClass('successChance');
        if (!wrapperClass || !titleClass || !panelClass) return;

        const factionRate = settings.factionPayout / 100;
        const market = settings.marketCache;

        document.querySelectorAll(`.${wrapperClass}`).forEach(crime => {
            const title = crime.querySelector(`.${titleClass}`)?.innerText;
            const config = OC_DATA_BY_TITLE[normalizeTitle(title)];
            const target = crime.querySelector(`.${panelClass}`);
            if (!config || !target || crime.querySelector('.ev-display-final')) return;

            let [low, high] = config.payout || [0, 0];
            if (config.items) {
                config.items.forEach(it => {
                    const price = market[it.id] || 0;
                    low += price * it.qty[0];
                    high += price * it.qty[1];
                });
            }

            const slots = successClass
                ? (crime.querySelectorAll(`.${successClass}`).length || 1)
                : 1;
            const calc = (val) => (val * SUCCESS_BASELINE * factionRate) / slots;
            const min = calc(low);
            const max = calc(high);
            const avg = (min + max) / 2;
            const daily = avg / config.days;

            const box = document.createElement('div');
            box.className = 'ev-display-final';
            box.setAttribute('style', 'position:absolute; top:8px; right:45px; background:#000 !important; border:2px solid #37bcd6 !important; padding:10px; width:180px; z-index:99999; border-radius:4px; box-shadow: 0 0 15px #000;');
            box.innerHTML = `
                <div style="${fText('#37bcd6', '10px')} border-bottom:1px solid #333; margin-bottom:6px; text-align:center;">EST. SHARE (${Math.round(factionRate * 100)}%)</div>
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span style="${fText('#ccc', '11px', 'normal')}">MIN:</span>
                    <span style="${fText('#ffffff', '12px')}">$${Math.floor(min).toLocaleString()}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span style="${fText('#ccc', '11px', 'normal')}">MAX:</span>
                    <span style="${fText('#ffffff', '12px')}">$${Math.floor(max).toLocaleString()}</span>
                </div>
                <div style="display:flex; justify-content:space-between; border-top:1px solid #444; padding-top:5px; margin-bottom:2px;">
                    <span style="${fText('#00ff00', '12px')}">AVG:</span>
                    <span style="${fText('#00ff00', '13px')}">$${Math.floor(avg).toLocaleString()}</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="${fText('#ffb300', '12px')}">DAILY:</span>
                    <span style="${fText('#ffb300', '13px')}">$${Math.floor(daily).toLocaleString()}</span>
                </div>
            `;
            target.appendChild(box);
        });
    }

    function redrawStats() {
        document.querySelectorAll('.ev-display-final').forEach(el => el.remove());
        scheduleUpdate(true);
    }

    // --- DOM update batching (re-entry guard + RAF coalescing) ---
    const enqueueUpdate = typeof window.requestAnimationFrame === 'function'
        ? (cb) => window.requestAnimationFrame(cb)
        : (cb) => setTimeout(cb, 50);
    let isUpdating = false;
    let updateScheduled = false;

    function scheduleUpdate(runImmediately = false) {
        if (runImmediately) {
            updateScheduled = false;
            doUpdate();
            return;
        }
        if (updateScheduled) return;
        updateScheduled = true;
        enqueueUpdate(() => {
            updateScheduled = false;
            doUpdate();
        });
    }

    function removeOcUi() {
        document.getElementById('oc-persistent-panel')?.remove();
        document.getElementById('oc-api-modal')?.remove();
        document.querySelectorAll('.ev-display-final').forEach(el => el.remove());
    }

    function doUpdate() {
        if (isUpdating) return;
        isUpdating = true;
        try {
            const onCrimesTab = window.location.hash.includes('tab=crimes');
            if (!onCrimesTab) {
                // SPA navigation away from the crimes tab — tear down our UI
                // so panels and modals don't bleed onto unrelated faction tabs.
                removeOcUi();
                return;
            }
            if (!settings.apiKey) {
                showApiKeyModal();
                return;
            }
            // Sync only when the user is actually on the crimes tab — there's
            // no point fetching prices while they're on Members/War/etc.
            // syncMarketPrices() is a no-op if the cache is still fresh.
            syncMarketPrices();
            injectControlPanel();
            drawStats();
        } finally {
            isUpdating = false;
        }
    }

    // --- Init ---
    console.log('[OC] Script v4.0 initialized.');

    GM_registerMenuCommand('OC: Set API key', promptApiKey);
    GM_registerMenuCommand('OC: Set faction payout %', promptPayout);
    GM_registerMenuCommand('OC: Force market sync', () => syncMarketPrices(true));

    function start() {
        // Modal gating, API sync, and panel injection all happen inside
        // doUpdate() so they only run on tab=crimes — not on
        // members/war/armoury/etc.
        const observer = new MutationObserver(() => scheduleUpdate());
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleUpdate();
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
})();
