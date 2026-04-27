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
    const SUCCESS_BASELINE = 0.8;

    // `slots` is the participant count from oc.md (and matches `days` since
    // each member has a 24h planning window and slots plan sequentially).
    //
    // Chain crimes: an antecedent has `chainsTo` and no payout of its own —
    // when it succeeds it spawns the next scenario, and that follow-on's
    // payout is split equally across every participant in every crime in the
    // chain. So a No Reserve participant and a Bidding War participant get
    // the same per-head share of Bidding War's cash.
    //
    // Cash payouts here are calibrated against the Torncity wiki (oc.md).
    // Several crimes actually pay items, not cash — those are flagged with
    // a TODO and currently retain rem4rk's v3.7 cash estimate as a coarse
    // placeholder until we have the item ids.
    const OC_DATA = {
        // Items only per oc.md (Morphine, First Aid Kits, Box of Medical
        // Supplies). Keeping rem4rk's cash estimate as a placeholder.
        'First Aid and Abet':       { days: 3, slots: 3, payout: [2000000, 3000000] }, // TODO: actually items
        'Mob Mentality':            { days: 4, slots: 4, payout: [673000, 1500000] },
        'Pet Project':              { days: 3, slots: 3, payout: [414000, 806000] },
        // oc.md leaves min/max as ??? — keeping rem4rk's guess.
        'Thou Shalt Not Steal':     { days: 3, slots: 3, payout: [1000000, 2000000] }, // TODO: oc.md unknown
        'Cash Me If You Can':       { days: 3, slots: 3, payout: [829000, 1601000] },
        // Items only per oc.md (1× Mercia SLR / Echo R8 / Lolo 458).
        'Best of the Lot':          { days: 4, slots: 4, payout: [12000000, 18000000] }, // TODO: actually items
        // Items only per oc.md (1× Veloria LFA / Weston Marlin / Lambrini).
        'Smoke and Wing Mirrors':   { days: 4, slots: 4, payout: [20000000, 30000000] }, // TODO: actually items
        'Market Forces':            { days: 5, slots: 5, payout: [5095000, 8575000] },
        // Items only per oc.md (Moonshine, Crocozade, Damp Valley, Goose
        // Juice, Pixie Sticks; market values listed in oc.md).
        'Gaslight the Way':         { days: 6, slots: 6, payout: [3000000, 5000000] }, // TODO: actually items
        'Snow Blind':               { days: 4, slots: 4, payout: [5575000, 10565000] },
        // oc.md gives only the max ($8,976,000) — min still unknown.
        'Plucking the Lotus Petal': { days: 4, slots: 4, payout: [7000000, 8976000] }, // TODO: oc.md min unknown
        'Stage Fright':             { days: 6, slots: 6, items: [{ id: 206, name: 'Xanax', qty: [10, 30] }] },
        'Guardian Angels':          { days: 3, slots: 3, payout: [6296000, 8883000] },
        'Honey Trap':               { days: 3, slots: 3, payout: [15753000, 25671000] },
        // Items per oc.md, valued by sell price (not market price), with the
        // total estimated to be at least $24M. Kept as cash placeholder.
        'Counter Offer':            { days: 5, slots: 5, payout: [24000000, 40000000] }, // TODO: actually items, sell-value ≥ $24M
        'No Reserve':               { days: 3, slots: 3, chainsTo: 'Bidding War' },
        'Bidding War':              { days: 6, slots: 6, payout: [71291000, 133980000] },
        'Leave No Trace':           { days: 3, slots: 3, payout: [9660000, 13474000] },
        'Sneaky Git Grab':          { days: 4, slots: 4, payout: [21384000, 38757000] },
        'Blast from the Past':      { days: 6, slots: 6, payout: [98321000, 202382000] },
        // Items per oc.md (Priceless Painting / Naval Cutlass + secondaries
        // like Vairocana Buddha Sculpture / Shabti / Companion Script /
        // Ganesha Sculpture / Medieval Helmet).
        'Window of Opportunity':    { days: 5, slots: 5, payout: [30000000, 40000000] }, // TODO: actually items
        'Break the Bank':           { days: 6, slots: 6, payout: [195135000, 395980000] },
        'Clinical Precision':       { days: 4, slots: 4, payout: [61363000, 122565000] },
        'Stacking the Deck':        { days: 4, slots: 4, chainsTo: 'Ace in the Hole' },
        'Ace in the Hole':          { days: 5, slots: 5, payout: [280005000, 579919000] },
        'Manifest Cruelty':         { days: 4, slots: 4, chainsTo: 'Gone Fission' },
        'Gone Fission':             { days: 5, slots: 5, chainsTo: 'Crane Reaction' },
        // Per oc.md the terminal item is 1–3 × Cesium-137. v3.7 had this as
        // id 370 ("Cedar Wood") with qty [2,5], both wrong. We don't have
        // Cesium-137's item id yet, so we use a sentinel id of 0 — that
        // never matches the market cache, so the breakdown will display
        // "price not cached" until the id is filled in.
        'Crane Reaction':           { days: 6, slots: 6, items: [{ id: 0, name: 'Cesium-137', qty: [1, 3] }] }, // TODO: lookup correct item id
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
            <div style="${fText('#fff', '12px')} margin-bottom:10px;">CURRENT CUT: <span id="oc-cut-display" style="color:#0f0 !important;">${settings.factionPayout}%</span></div>
            <button id="oc-btn-payout" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; margin-bottom:5px; cursor:pointer;">Adjust Payout %</button>
            <button id="oc-btn-sync" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; margin-bottom:5px; cursor:pointer;">Force Market Sync</button>
            <button id="oc-btn-api" style="width:100%; background:#222; color:#fff; border:1px solid #444; padding:5px; cursor:pointer;">${settings.apiKey ? 'Update API Key' : 'Set API Key'}</button>
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
            // wide the participant pool is. For non-chain crimes this is
            // just [name], pool=slots, hops=1 — same as before.
            const chainNames = resolveChain(title) || [title];
            const chainConfigs = chainNames.map(n => OC_DATA_BY_TITLE[normalizeTitle(n)]).filter(Boolean);
            const terminal = chainConfigs[chainConfigs.length - 1];
            if (!terminal) return;

            // --- Compute the breakdown step by step, keeping each intermediate
            //     value so the details panel can show its work.

            // 1. Raw payout from the terminal crime in the chain. Cash is
            //    taken from terminal.payout; items are summed at current
            //    market prices (per-item subtotals stashed for display).
            const itemBreakdown = [];
            let rawLow = 0;
            let rawHigh = 0;
            if (terminal.payout) {
                rawLow = terminal.payout[0];
                rawHigh = terminal.payout[1];
            }
            if (terminal.items) {
                terminal.items.forEach(it => {
                    const price = market[it.id];
                    const itemLow = (price || 0) * it.qty[0];
                    const itemHigh = (price || 0) * it.qty[1];
                    rawLow += itemLow;
                    rawHigh += itemHigh;
                    itemBreakdown.push({
                        id: it.id,
                        name: it.name || `item #${it.id}`,
                        qtyLow: it.qty[0],
                        qtyHigh: it.qty[1],
                        price,
                        subtotalLow: itemLow,
                        subtotalHigh: itemHigh,
                    });
                });
            }

            // 2. Pool: every slot in every crime in the chain shares one head.
            const pool = chainConfigs.reduce((s, c) => s + (c.slots || 1), 0);

            // 3. Hops: each unfinished crime adds a SUCCESS_BASELINE factor
            //    since the chain only pays out if every step succeeds.
            //    Terminal = 1 hop (its own success); antecedent = 2; root of
            //    a 3-hop chain = 3.
            const hops = chainConfigs.length - chainConfigs.findIndex(c => c === config);
            const successFactor = SUCCESS_BASELINE ** hops;

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

            // Item rows: name, qty range, market price, subtotal range. If a
            // price hasn't been cached yet, show "—" so the user can tell.
            const itemRowsHtml = itemBreakdown.map(it => {
                const priceCell = it.price != null ? fmt(it.price) : '<em style="color:#888">price not cached</em>';
                const subCell = it.price != null ? fmtRange(it.subtotalLow, it.subtotalHigh) : '—';
                return `<span style="${fText('#fff', '11px', 'normal')}">${qtyRange(it.qtyLow, it.qtyHigh)} × ${it.name} @ ${priceCell} = ${subCell}</span>`;
            }).join('<br>');

            const successDetail = hops > 1
                ? `${(SUCCESS_BASELINE * 100).toFixed(0)}%^${hops} = ${(successFactor * 100).toFixed(1)}% (every chain step must succeed)`
                : `${(successFactor * 100).toFixed(1)}% (assumed flat)`;

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
                        ${terminal.items ? detailRow('Items', itemRowsHtml) : ''}
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
