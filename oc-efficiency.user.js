// ==UserScript==
// @name         Torn OC 2.0 Efficiency
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Estimates min/max/avg/daily payout per slot for OC 2.0 crimes, with a 24h API price cache.
// @author       rem4rk
// @license      MIT
// @match        https://*.torn.com/factions.php*
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

    // =====================================================================
    // TUNING — assumptions and placeholders we aren't fully sure of.
    // Adjust here (and resave) when better data shows up. The user-facing
    // "success baseline" lives in settings (default 80%) so it can be
    // changed at runtime without editing this file.
    //
    // Anything else we're unsure of should be added here too, so unknowns
    // are easy to find in one place.
    // =====================================================================
    const ASSUMPTIONS = {
        // When an antecedent in a chain crime succeeds, what fraction of
        // the time does it actually spawn the next scenario? Assuming 50%
        chainSpawnProbability: 0.5,

        // For "additional possibility of" drop groups (currently just the
        // Window of Opportunity secondary), what fraction of completions
        // grant a drop from that group at all? Items inside the group are
        // assumed uniformly distributed.
        secondaryDropProbability: 0.5,

        // Cesium-137 isn't returning a market price from the API
        cesium137FallbackValue: 500_000_000,
    };

    // Default percent assumed for a single OC succeeding. Overridable from
    // the settings panel — this is just the starting value when no user
    // setting exists yet.
    const DEFAULT_SUCCESS_BASELINE_PCT = 80;

    // `slots` is the participant count from (and matches `days` since
    // each member has a 24h planning window and slots plan sequentially).
    //
    // Chain crimes: an antecedent has `chainsTo` and no payout of its own —
    // when it succeeds it spawns the next scenario, and that follow-on's
    // payout is split equally across every participant in every crime in the
    // chain. So a No Reserve participant and a Bidding War participant get
    // the same per-head share of Bidding War's cash.
    //
    // Cash payouts here are calibrated against the Torncity wiki
    //
    // Items are valued at market price by default — the game pays out the
    // market value of items as cash when a faction picks the cash-equivalent
    // option. Counter Offer is the documented exception (uses sell value),
    // signalled with `valuation: 'sell'`.
    //
    // For probabilistic drops (e.g. "1× A or 1× B or 1× C") each option has
    // a `weight` so its expected contribution is `qty × price × weight`.
    // Weights default to 1 for always-drops.
    const OC_DATA = {
        'First Aid and Abet':       { days: 3, slots: 3, items: [
            { id: 66,  name: 'Morphine',                qty: [4, 26] },
            { id: 365, name: 'Box of Medical Supplies', qty: [1, 2] },
            // OR-branch: 50% gets Small First Aid Kits, 50% gets First Aid Kits.
            { id: 68,  name: 'Small First Aid Kit',     qty: [2, 2], weight: 0.5 },
            { id: 67,  name: 'First Aid Kit',           qty: [3, 4], weight: 0.5 },
        ] },
        'Mob Mentality':            { days: 4, slots: 4, payout: [673000, 1500000] },
        'Pet Project':              { days: 3, slots: 3, payout: [414000, 806000] },
        // Wiki leaves min/max as ??? — values here are a rough guess.
        'Thou Shalt Not Steal':     { days: 3, slots: 3, payout: [1000000, 2000000] }, // TODO: Wiki unknown
        'Cash Me If You Can':       { days: 3, slots: 3, payout: [829000, 1601000] },
        'Best of the Lot':          { days: 4, slots: 4, items: [
            // Single-item drop, 1/3 each.
            { id: 523, name: 'Mercia SLR', qty: [1, 1], weight: 1 / 3 },
            { id: 518, name: 'Echo R8',    qty: [1, 1], weight: 1 / 3 },
            { id: 520, name: 'Lolo 458',   qty: [1, 1], weight: 1 / 3 },
        ] },
        'Smoke and Wing Mirrors':   { days: 4, slots: 4, items: [
            // Single-item drop, 1/3 each.
            { id: 522, name: 'Veloria LFA',        qty: [1, 1], weight: 1 / 3 },
            { id: 517, name: 'Weston Marlin 177',  qty: [1, 1], weight: 1 / 3 },
            { id: 521, name: 'Lambrini Torobravo', qty: [1, 1], weight: 1 / 3 },
        ] },
        'Market Forces':            { days: 5, slots: 5, payout: [5095000, 8575000] },
        'Gaslight the Way':         { days: 6, slots: 6, items: [
            // Wiki lists 5 possible items with no quantity — assume 1 of one,
            // uniformly distributed.
            { id: 984, name: 'Bottle of Moonshine', qty: [1, 1], weight: 1 / 5 },
            { id: 987, name: 'Can of Crocozade',    qty: [1, 1], weight: 1 / 5 },
            { id: 986, name: 'Can of Damp Valley',  qty: [1, 1], weight: 1 / 5 },
            { id: 985, name: 'Can of Goose Juice',  qty: [1, 1], weight: 1 / 5 },
            { id: 151, name: 'Pixie Sticks',        qty: [1, 1], weight: 1 / 5 },
        ] },
        'Snow Blind':               { days: 4, slots: 4, payout: [5575000, 10565000] },
        // Wiki gives only the max ($8,976,000) — min still unknown.
        'Plucking the Lotus Petal': { days: 4, slots: 4, payout: [7000000, 8976000] }, // TODO: Wiki min unknown
        'Stage Fright':             { days: 6, slots: 6, items: [
            { id: 206, name: 'Xanax', qty: [10, 30] },
        ] },
        'Guardian Angels':          { days: 3, slots: 3, payout: [6296000, 8883000] },
        'Honey Trap':               { days: 3, slots: 3, payout: [15753000, 25671000] },
        // Wiki doesn't enumerate Counter Offer items but says the reward
        // uses sell value (not market). Without an item list we keep a
        // coarse cash placeholder; Wiki estimates the total at ≥$24M.
        'Counter Offer':            { days: 5, slots: 5, payout: [24000000, 40000000] }, // TODO: items not enumerated; cash placeholder
        'No Reserve':               { days: 3, slots: 3, chainsTo: 'Bidding War' },
        'Bidding War':              { days: 6, slots: 6, payout: [71291000, 133980000] },
        'Leave No Trace':           { days: 3, slots: 3, payout: [9660000, 13474000] },
        'Sneaky Git Grab':          { days: 4, slots: 4, payout: [21384000, 38757000] },
        'Blast from the Past':      { days: 6, slots: 6, payout: [98321000, 202382000] },
        'Window of Opportunity':    { days: 5, slots: 5, items: (() => {
            // Primary: 1× Painting OR 1× Cutlass, 50/50.
            // Secondary group: Wiki says "additional possibility of" one of
            // five — drop probability is unknown so it's gated on
            // ASSUMPTIONS.secondaryDropProbability and uniformly distributed
            // across the five candidates.
            const sec = ASSUMPTIONS.secondaryDropProbability / 5;
            return [
                { id: 1508, name: 'Priceless Painting',         qty: [1, 1], weight: 0.5 },
                { id: 615,  name: 'Naval Cutlass',              qty: [1, 1], weight: 0.5 },
                { id: 454,  name: 'Vairocana Buddha Sculpture', qty: [8, 8], weight: sec },
                { id: 458,  name: 'Shabti Sculpture',           qty: [2, 2], weight: sec },
                { id: 456,  name: 'Companion Script : Ubay',    qty: [2, 2], weight: sec },
                { id: 453,  name: 'Ganesha Sculpture',          qty: [1, 1], weight: sec },
                { id: 538,  name: 'Medieval Helmet',            qty: [4, 4], weight: sec },
            ];
        })() },
        'Break the Bank':           { days: 6, slots: 6, payout: [195135000, 395980000] },
        'Clinical Precision':       { days: 4, slots: 4, payout: [61363000, 122565000] },
        'Stacking the Deck':        { days: 4, slots: 4, chainsTo: 'Ace in the Hole' },
        'Ace in the Hole':          { days: 5, slots: 5, payout: [280005000, 579919000] },
        'Manifest Cruelty':         { days: 4, slots: 4, chainsTo: 'Gone Fission' },
        'Gone Fission':             { days: 5, slots: 5, chainsTo: 'Crane Reaction' },
        'Crane Reaction':           { days: 6, slots: 6, items: [
            // Cesium-137 has no live market or sell price yet (too new),
            // so we fall back to ASSUMPTIONS.cesium137FallbackValue until
            // the item starts trading.
            { id: 336, name: 'Cesium-137', qty: [1, 3], priceFallback: ASSUMPTIONS.cesium137FallbackValue },
        ] },
    };

    // Lookup from a normalized title to the canonical OC_DATA key, used by
    // resolveChain so callers can pass a DOM title in any whitespace/case.
    const OC_NAMES_BY_NORM = Object.fromEntries(
        Object.keys(OC_DATA).map(k => [normalizeTitle(k), k]),
    );

    // Walk the chainsTo links forward to the terminal, and Object.entries
    // backwards to find any antecedents, returning the full chain (root → ...
    // → terminal). Standalone crimes return [name].
    function resolveChain(name) {
        const canonical = OC_NAMES_BY_NORM[normalizeTitle(name)];
        if (!canonical) return [name];

        const forward = [canonical];
        let cur = OC_DATA[canonical];
        while (cur && cur.chainsTo) {
            const childCanon = OC_NAMES_BY_NORM[normalizeTitle(cur.chainsTo)];
            if (!childCanon || forward.includes(childCanon)) break; // cycle guard
            forward.push(childCanon);
            cur = OC_DATA[childCanon];
        }

        const backward = [];
        let target = canonical;
        while (true) {
            const parent = Object.entries(OC_DATA).find(([, v]) =>
                v.chainsTo && OC_NAMES_BY_NORM[normalizeTitle(v.chainsTo)] === target,
            );
            if (!parent || backward.includes(parent[0])) break;
            backward.unshift(parent[0]);
            target = parent[0];
        }
        return [...backward, ...forward];
    }

    // Whitespace/badge wrappers around the rendered title can break exact-key
    // lookups, so resolve via a normalized map instead. Also strip diacritics
    // because Torn occasionally renders accents (e.g. "Guardian Ángels") that
    // don't appear in our static OC_DATA keys.
    function normalizeTitle(s) {
        return (s || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }
    const OC_DATA_BY_TITLE = Object.fromEntries(
        Object.entries(OC_DATA).map(([k, v]) => [normalizeTitle(k), v]),
    );

    // --- Settings ---
    const SETTINGS_KEY = 'ocSettings';
    const DEFAULT_SETTINGS = {
        apiKey: '',
        factionPayout: 90,
        successBaseline: DEFAULT_SUCCESS_BASELINE_PCT,
        marketCache: {},
        lastMarketSync: 0,
    };

    function normalizeSettings(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const payout = Number(s.factionPayout);
        const baseline = Number(s.successBaseline);
        const sync = Number(s.lastMarketSync);
        // Cache values used to be raw numbers (market price only). They're
        // now {market, sell} objects — wipe legacy entries so we resync.
        let marketCache = s.marketCache && typeof s.marketCache === 'object' ? s.marketCache : {};
        const sample = Object.values(marketCache)[0];
        if (sample !== undefined && (typeof sample !== 'object' || sample === null)) {
            marketCache = {};
        }
        return {
            apiKey: typeof s.apiKey === 'string' ? s.apiKey : DEFAULT_SETTINGS.apiKey,
            factionPayout: Number.isFinite(payout) ? payout : DEFAULT_SETTINGS.factionPayout,
            successBaseline: Number.isFinite(baseline) && baseline >= 0 && baseline <= 100
                ? baseline
                : DEFAULT_SUCCESS_BASELINE_PCT,
            marketCache,
            lastMarketSync: marketCache === s.marketCache && Number.isFinite(sync) ? sync : 0,
        };
    }

    let settings = normalizeSettings(GM_getValue(SETTINGS_KEY, DEFAULT_SETTINGS));

    function saveSettings(patch) {
        settings = normalizeSettings({ ...settings, ...patch });
        GM_setValue(SETTINGS_KEY, settings);
    }

    // --- CSS module class detection ---
    // Generic prefixes like "wrapper" / "panel" can collide with unrelated
    // React components. We (a) check hashed (CSS-module) selectors first,
    // (b) anchor matches on real class-token boundaries (otherwise a class
    // like `crimeWrapper___xxx` would falsely match prefix `wrapper`), and
    // (c) skip a global cache so a wrong first match can't poison the
    // session.
    function findClass(prefix) {
        // [class*=...] matches substrings, so we still verify each candidate
        // by splitting className into actual tokens.
        const candidates = document.querySelectorAll(`[class*="${prefix}___"]`);
        for (const el of candidates) {
            const cn = typeof el.className === 'string'
                ? el.className
                : (el.className?.baseVal || '');
            const hit = cn.split(/\s+/).find(t => t.startsWith(`${prefix}___`));
            if (hit) return hit;
        }

        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules || []) {
                    if (rule.selectorText) {
                        // Require a `.` before the prefix so we don't match
                        // mid-token (e.g. `.crimeWrapper___xxx`).
                        const m = rule.selectorText.match(new RegExp(`\\.(${prefix}___\\w+)`));
                        if (m) return m[1];
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
                                const v = i?.value;
                                if (!v) return;
                                // Treat 0/null as "no price" — some items have a
                                // market_price of 0 because they're vendor-only,
                                // and we want to fall back to sell rather than
                                // value those at $0.
                                const m = v.market_price;
                                const s = v.sell_price;
                                const market = typeof m === 'number' && m > 0 ? m : null;
                                const sell = typeof s === 'number' && s > 0 ? s : null;
                                if (market != null || sell != null) {
                                    merged[i.id] = { market, sell };
                                }
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

        const noticeHtml = settings.apiKey ? '' : `
            <div style="${fText('#ffb300', '10px', 'normal')} background:#1a1208 !important; border:1px solid #5a3a00 !important; padding:6px; margin-bottom:8px; line-height:1.35;">
                Add a Torn API key to fetch market prices for item-reward crimes (Stage Fright, Crane Reaction, Gone Fission). Cash-reward crimes work without one.
            </div>
        `;

        const panel = document.createElement('div');
        panel.id = 'oc-persistent-panel';
        panel.setAttribute('style', 'position:fixed; bottom:20px; left:20px; z-index:999999; background:#000 !important; border:2px solid #37bcd6 !important; padding:12px; width:220px; box-shadow: 5px 5px 20px #000;');
        panel.innerHTML = `
            <div style="${fText('#37bcd6', '11px')} border-bottom:1px solid #37bcd6; margin-bottom:8px;">OC EFFICIENCY</div>
            ${noticeHtml}
            <div style="${fText('#fff', '12px')} margin-bottom:4px;">CURRENT CUT: <span id="oc-cut-display" style="color:#0f0 !important;">${settings.factionPayout}%</span></div>
            <div style="${fText('#fff', '12px')} margin-bottom:10px;">SUCCESS BASELINE: <span id="oc-success-display" style="color:#0f0 !important;">${settings.successBaseline}%</span></div>
            <button id="oc-btn-payout" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; margin-bottom:5px; cursor:pointer;">Adjust Payout %</button>
            <button id="oc-btn-success" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; margin-bottom:5px; cursor:pointer;">Adjust Success %</button>
            <button id="oc-btn-sync" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; margin-bottom:5px; cursor:pointer;">Force Market Sync</button>
            <button id="oc-btn-api" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; cursor:pointer;">${settings.apiKey ? 'Update API Key' : 'Set API Key'}</button>
        `;
        document.body.appendChild(panel);

        document.getElementById('oc-btn-payout').onclick = promptPayout;
        document.getElementById('oc-btn-success').onclick = promptSuccessBaseline;
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

    function promptSuccessBaseline() {
        const v = prompt(
            `Enter the assumed per-crime success rate (0–100).\n\nThis is what we multiply payouts by to estimate expected earnings. Chain antecedents are discounted further by ${(ASSUMPTIONS.chainSpawnProbability * 100).toFixed(0)}% per spawn.`,
            String(settings.successBaseline),
        );
        if (v == null) return;
        const num = parseFloat(v);
        if (Number.isFinite(num) && num >= 0 && num <= 100) {
            saveSettings({ successBaseline: num });
            const display = document.getElementById('oc-success-display');
            if (display) display.textContent = `${num}%`;
            redrawStats();
        }
    }

    function promptApiKey() {
        const v = prompt(
            'Enter your Torn API key.\n\nNeeded to fetch market prices for item-reward crimes (Stage Fright, Crane Reaction, Gone Fission). Cash-reward crimes work without one.',
            settings.apiKey,
        );
        if (v == null) return;
        const trimmed = v.trim();
        if (trimmed) {
            saveSettings({ apiKey: trimmed });
            // Re-inject so the notice and button label update.
            document.getElementById('oc-persistent-panel')?.remove();
            syncMarketPrices(true);
            scheduleUpdate(true);
        }
    }

    // --- Time-until-execution parsing ---
    // Each active OC card has an element whose aria-label is a structured
    // time string like "2 days 22 hours 6 minutes 55 seconds". That's the
    // queue countdown — assuming every remaining slot consumes its full 24h
    // planning window, that's roughly when this OC will pay out. Per-slot
    // caps render as "24 hours" (no minutes/seconds), which we exclude so we
    // don't confuse them with the queue timer.
    function parseRemainingDays(crimeEl) {
        for (const el of crimeEl.querySelectorAll('[aria-label]')) {
            const lbl = (el.getAttribute('aria-label') || '').trim();
            const m = lbl.match(/^(?:(\d+)\s*days?\s*)?(?:(\d+)\s*hours?\s*)?(?:(\d+)\s*minutes?\s*)?(?:(\d+)\s*seconds?\s*)?$/i);
            if (!m) continue;
            const d = Number(m[1] || 0);
            const h = Number(m[2] || 0);
            const mi = Number(m[3] || 0);
            const s = Number(m[4] || 0);
            // Per-slot 24h caps don't include minutes/seconds; require finer
            // granularity to be confident this is the queue timer.
            if (mi === 0 && s === 0) continue;
            const days = d + h / 24 + mi / 1440 + s / 86400;
            if (days > 0) return days;
        }
        return null;
    }

    function formatRemaining(days) {
        if (days >= 1) return `${days.toFixed(1)}d`;
        const hours = days * 24;
        if (hours >= 1) return `${hours.toFixed(1)}h`;
        return `${Math.round(hours * 60)}m`;
    }

    // --- Stats rendering ---
    let loggedDraw = false;
    function drawStats() {
        // OC cards are identified by a unique [data-oc-id] attribute on the
        // outer wrapper — far more reliable than guessing among the multiple
        // `wrapper___xxx` CSS-module classes Torn uses on this page.
        const titleClass = findClass('panelTitle');
        const panelClass = findClass('panel');
        const successClass = findClass('successChance');
        const joinButtonClass = findClass('joinButton');

        const cards = document.querySelectorAll('[data-oc-id]');

        if (!loggedDraw && cards.length > 0) {
            loggedDraw = true;
            const titles = Array.from(cards).map(c =>
                titleClass ? c.querySelector(`.${titleClass}`)?.innerText : null
            );
            const matched = titles.filter(t => OC_DATA_BY_TITLE[normalizeTitle(t)]).length;
            console.log(`[OC] drawStats: ${cards.length} cards, ${matched} matched OC_DATA. classes:`, { titleClass, panelClass, successClass, joinButtonClass });
            console.log('[OC] titles:', titles);
        }

        if (!titleClass || !panelClass) return;

        const factionRate = settings.factionPayout / 100;
        const market = settings.marketCache;

        cards.forEach(crime => {
            const title = crime.querySelector(`.${titleClass}`)?.innerText;
            const config = OC_DATA_BY_TITLE[normalizeTitle(title)];
            const target = crime.querySelector(`.${panelClass}`);
            if (!config || !target || crime.querySelector('.ev-display-final')) return;

            // Walk the chain to find which crime actually pays out and how
            // wide the participant pool is. Non-chain crimes resolve to
            // [name] with pool=slots and hops=1.
            const chainNames = resolveChain(title) || [title];
            const chainConfigs = chainNames.map(n => OC_DATA_BY_TITLE[normalizeTitle(n)]).filter(Boolean);
            const terminal = chainConfigs[chainConfigs.length - 1];
            if (!terminal) return;

            // --- Compute the breakdown step by step, keeping each intermediate
            //     value so the details panel can show its work.

            // 1. Raw payout from the terminal crime in the chain. Cash comes
            //    from terminal.payout; items are summed at the per-crime
            //    valuation (market by default, sell for Counter Offer-style
            //    crimes), with optional per-item weights for probabilistic
            //    OR-branches and a quantity range.
            const valuation = terminal.valuation || 'market';
            const itemBreakdown = [];
            let rawLow = 0;
            let rawHigh = 0;
            if (terminal.payout) {
                rawLow = terminal.payout[0];
                rawHigh = terminal.payout[1];
            }
            if (terminal.items) {
                terminal.items.forEach(it => {
                    const cached = market[it.id];
                    // Default valuation is market, with sell as a fallback for
                    // items that have no market price (vendor-only loot like
                    // sculptures and Naval Cutlass). Sell-explicit crimes
                    // (Counter Offer) never fall back. As a last resort we
                    // use the per-item priceFallback for items that haven't
                    // started trading yet (e.g. Cesium-137).
                    let price = null;
                    let priceFromFallback = false;
                    if (cached) {
                        if (valuation === 'sell') {
                            price = cached.sell;
                        } else {
                            price = cached.market ?? cached.sell;
                        }
                    }
                    if (price == null && it.priceFallback != null) {
                        price = it.priceFallback;
                        priceFromFallback = true;
                    }
                    const weight = it.weight ?? 1;
                    const itemLow = (price ?? 0) * it.qty[0] * weight;
                    const itemHigh = (price ?? 0) * it.qty[1] * weight;
                    rawLow += itemLow;
                    rawHigh += itemHigh;
                    itemBreakdown.push({
                        id: it.id,
                        name: it.name || `item #${it.id}`,
                        qtyLow: it.qty[0],
                        qtyHigh: it.qty[1],
                        weight,
                        price,
                        priceFromFallback,
                        subtotalLow: itemLow,
                        subtotalHigh: itemHigh,
                    });
                });
            }

            // 2. Pool: every slot in every crime in the chain shares one head.
            const pool = chainConfigs.reduce((s, c) => s + (c.slots || 1), 0);

            // 3. Hops: each unfinished crime adds a per-crime success factor
            //    since the chain only pays out if every step succeeds.
            //    Terminal = 1 hop (its own success); antecedent = 2; root of
            //    a 3-hop chain = 3. Antecedents also need to spawn the next
            //    crime (n-1 spawn events for an n-step chain).
            const successRate = settings.successBaseline / 100;
            const spawnRate = ASSUMPTIONS.chainSpawnProbability;
            const hops = chainConfigs.length - chainConfigs.findIndex(c => c === config);
            const successFactor = (successRate ** hops) * (spawnRate ** (hops - 1));

            // 4. Apply faction cut, then success factor, then divide by pool.
            const factionLow = rawLow * factionRate;
            const factionHigh = rawHigh * factionRate;
            const adjLow = factionLow * successFactor;
            const adjHigh = factionHigh * successFactor;
            const min = adjLow / pool;
            const max = adjHigh / pool;
            const avg = (min + max) / 2;

            // 5. DAILY denominator depends on whether you can still join. Cards
            //    with a join button represent a real "if I take this slot now,
            //    here's my $/day until payout" decision — use the queue
            //    countdown. Cards without one are full and not actionable, so
            //    show the nominal-length rate for consistent comparison.
            const hasJoin = joinButtonClass && crime.querySelector(`.${joinButtonClass}`);
            const remainingDays = hasJoin ? parseRemainingDays(crime) : null;
            const usingRemaining = remainingDays != null && remainingDays > 0;
            const daysForRate = usingRemaining ? remainingDays : config.days;
            const daily = avg / daysForRate;
            const dailyLabel = usingRemaining
                ? `DAILY (${formatRemaining(remainingDays)} left)`
                : `DAILY (${config.days}d nominal)`;

            // --- Assemble the details breakdown
            const fmt = (n) => `$${Math.floor(n).toLocaleString()}`;
            const fmtRange = (a, b) => `${fmt(a)} – ${fmt(b)}`;
            const qtyRange = (a, b) => a === b ? `${a}` : `${a}–${b}`;

            const chainPoolLine = chainNames.length > 1
                ? chainNames.map((n, i) => `${n} (${chainConfigs[i].slots})`).join(' → ') + ` = ${pool} slots`
                : `${pool} slots (${title}, standalone)`;

            const crimeLine = chainNames.length > 1
                ? `${title} — chain antecedent, ${hops - 1} hop${hops > 2 ? 's' : ''} to payout`
                : title;

            // Item rows: name, qty range, price (market or sell), optional
            // chance weight, and weighted subtotal range. Items with no
            // cached price show that explicitly so it's clear why a $0
            // contribution arose.
            const itemRowsHtml = itemBreakdown.map(it => {
                let priceCell;
                if (it.price == null) {
                    priceCell = '<em style="color:#888">price not cached</em>';
                } else if (it.priceFromFallback) {
                    priceCell = `${fmt(it.price)} <span style="color:#888">(fallback)</span>`;
                } else {
                    priceCell = fmt(it.price);
                }
                const subCell = it.price != null ? fmtRange(it.subtotalLow, it.subtotalHigh) : '—';
                const weightLabel = it.weight !== 1
                    ? ` <span style="color:#888">(× ${(it.weight * 100).toFixed(it.weight < 0.1 ? 1 : 0)}% chance)</span>`
                    : '';
                return `<span style="${fText('#fff', '11px', 'normal')}">${qtyRange(it.qtyLow, it.qtyHigh)} × ${it.name}${weightLabel} @ ${priceCell} = ${subCell}</span>`;
            }).join('<br>');

            const successDetail = hops > 1
                ? `${(successRate * 100).toFixed(0)}%^${hops} × ${(spawnRate * 100).toFixed(0)}%^${hops - 1} = ${(successFactor * 100).toFixed(1)}% (every chain step succeeds and spawns)`
                : `${(successFactor * 100).toFixed(1)}% (per-crime baseline)`;

            const lblStyle = `${fText('#888', '10px', 'normal')} text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap;`;
            const valStyle = `${fText('#fff', '11px', 'normal')}`;

            const detailRow = (label, value) =>
                `<span style="${lblStyle}">${label}</span><span style="${valStyle}">${value}</span>`;

            const row = document.createElement('div');
            row.className = 'ev-display-final';
            row.setAttribute('style', 'background:#000 !important; border:1px solid #37bcd6 !important; margin:4px 8px; padding:6px 10px; border-radius:3px; max-width:640px;');
            row.innerHTML = `
                <div class="ev-summary" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                    <span style="${fText('#37bcd6', '11px')}">${dailyLabel}:</span>
                    <span style="${fText('#ffb300', '13px')}">${fmt(daily)}</span>
                    <button type="button" class="ev-toggle" style="background:#111; color:#37bcd6; border:1px solid #37bcd6; width:18px; height:18px; line-height:1; border-radius:50%; cursor:pointer; padding:0; font-family: 'Courier New', monospace; font-weight:bold; font-size:11px; margin-left:auto;">?</button>
                </div>
                <div class="ev-details" style="display:none; border-top:1px solid #333; margin-top:6px; padding-top:6px;">
                    <div style="display:grid; grid-template-columns: max-content 1fr; gap:3px 14px; align-items:baseline;">
                        ${detailRow('Crime', crimeLine)}
                        ${detailRow('Chain pool', chainPoolLine)}
                        ${terminal.payout ? detailRow(
                            chainNames.length > 1 ? `Terminal cash` : 'Raw payout',
                            `${fmtRange(terminal.payout[0], terminal.payout[1])}${chainNames.length > 1 ? ` (from ${chainNames[chainNames.length - 1]})` : ''}`,
                        ) : ''}
                        ${terminal.items ? detailRow(`Items (${valuation} value)`, itemRowsHtml) : ''}
                        ${terminal.items ? detailRow('Raw value', fmtRange(rawLow, rawHigh)) : ''}
                        ${detailRow('Faction cut', `${(factionRate * 100).toFixed(1)}% → ${fmtRange(factionLow, factionHigh)}`)}
                        ${detailRow('Success', successDetail)}
                        ${detailRow('After success', fmtRange(adjLow, adjHigh))}
                        ${detailRow('Per slot', `${fmtRange(min, max)} <span style="color:#888">(÷ ${pool})</span>`)}
                        <span style="${fText('#00ff00', '11px')}">AVG</span>
                        <span style="${fText('#00ff00', '11px')}">${fmt(avg)}</span>
                        <span style="${fText('#ffb300', '11px')}">DAILY</span>
                        <span style="${fText('#ffb300', '11px')}">${fmt(daily)} <span style="color:#888; font-weight:normal">(÷ ${usingRemaining ? formatRemaining(remainingDays) + ' remaining' : config.days + 'd nominal'})</span></span>
                    </div>
                </div>
            `;

            const details = row.querySelector('.ev-details');
            row.querySelector('.ev-toggle').addEventListener('click', () => {
                details.style.display = details.style.display === 'none' ? 'block' : 'none';
            });

            // Insert above the slots row. The slots area is a sibling of the
            // scenario header inside the OC card's contentLayer, so we anchor
            // off the scenario element. Fall back to appending into the panel
            // if the structure ever changes.
            const scenarioClass = findClass('scenario');
            const scenarioEl = scenarioClass ? crime.querySelector(`.${scenarioClass}`) : null;
            if (scenarioEl?.parentElement) {
                scenarioEl.parentElement.insertBefore(row, scenarioEl.nextElementSibling);
            } else {
                target.appendChild(row);
            }
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
        document.querySelectorAll('.ev-display-final').forEach(el => el.remove());
    }

    let loggedGate = false;
    function doUpdate() {
        if (isUpdating) return;
        isUpdating = true;
        try {
            const onYourFaction = window.location.search.includes('step=your');
            const onCrimesTab = window.location.hash.includes('tab=crimes');
            if (!loggedGate) {
                loggedGate = true;
                console.log(`[OC] gate: step=your=${onYourFaction}, tab=crimes=${onCrimesTab}, hash="${window.location.hash}"`);
            }
            if (!onYourFaction || !onCrimesTab) {
                // Wrong page (different faction subtab or different faction-page
                // step) — tear down so the panel doesn't bleed across tabs.
                removeOcUi();
                return;
            }
            // Cash-reward crimes still work without an API key; only the
            // item-reward ones (Stage Fright, Crane Reaction, Gone Fission)
            // need market prices. The panel itself explains this when no key
            // is set, so we render unconditionally.
            if (settings.apiKey) syncMarketPrices();
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
    GM_registerMenuCommand('OC: Set success baseline %', promptSuccessBaseline);
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
