'use strict';
// Minimal .env support (KEY=value lines, optional `export`, optional quotes,
// # comments) so the documented "copy .env.example to .env" workflow works
// without dependencies. Variables already present in the environment always
// win over the file. Shared by server.js and the helper scripts.

const fs = require('fs');

function loadDotEnv(file, env = process.env) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { return 0; }
    let loaded = 0;
    for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || env[match[1]] !== undefined) continue;
        let value = match[2];
        const quoted = value.match(/^(["'])([\s\S]*)\1$/);
        if (quoted) value = quoted[2];
        else value = value.replace(/\s+#.*$/, '');
        env[match[1]] = value;
        loaded++;
    }
    return loaded;
}

module.exports = { loadDotEnv };
