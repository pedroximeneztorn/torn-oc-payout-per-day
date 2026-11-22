// Tiny dev server: serves oc-efficiency.user.js with the @version line
// rewritten to a localtime stamp on every request, so Tampermonkey treats
// each "check for updates" as a fresh version and pulls the latest disk
// content. No build step, no source mutation.
//
// Usage:
//   node serve-userscript.js
// Then install once in Tampermonkey via:
//   http://localhost:3541/oc-efficiency.user.js
// After each edit, hit "Check for userscript updates" in the TM dashboard
// (or wait for the periodic check) and reload the Torn tab.

const http = require('http');
const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'oc-efficiency.user.js');
const PORT = 3541;

function buildVersion(d = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `0.0.1.${stamp}`;
}

const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !req.url.endsWith('/oc-efficiency.user.js')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found\n');
        return;
    }

    let src;
    try {
        src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Failed to read ${SCRIPT_PATH}: ${e.message}\n`);
        return;
    }

    const version = buildVersion();
    const out = src.replace(/^(\/\/ @version\s+).+$/m, `$1${version}`);

    res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(out);
    console.log(`[serve] ${req.method} ${req.url} → version ${version}`);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Serving ${SCRIPT_PATH}`);
    console.log(`  → http://localhost:${PORT}/oc-efficiency.user.js`);
});
