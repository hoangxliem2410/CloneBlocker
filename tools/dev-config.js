/**
 * The emulator's Firebase config, generated rather than committed.
 *
 * firebase.json ships the CSP that Hosting actually serves, and that CSP must
 * not name the emulators: `connect-src http://localhost:8080` on a public
 * production site is somebody else's dev machine written into everyone's
 * security policy. It buys an attacker very little -- a browser will not make
 * an http request from an https page anyway -- but it is surface that exists
 * for no reason, and a reviewer reading the header is right to ask.
 *
 * It cannot simply be deleted either: the dashboard under test really does
 * talk to Firestore and Auth on localhost, and a CSP without them blocks it.
 * So the emulator gets its own config, derived from the real one at the moment
 * it is needed, and the production file stays clean.
 *
 * Written into the repo root on purpose. Hosting resolves `public` relative to
 * the config file's directory, so a copy in a temp directory would look for
 * the site somewhere it is not. It is gitignored.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'firebase.json');
const DEV = path.join(ROOT, 'firebase.dev.json');

// Everything the dashboard reaches for when it is pointed at emulators.
const EMULATOR_ORIGINS = [
  'http://localhost:8080', 'http://127.0.0.1:8080',   // firestore
  'http://localhost:9099', 'http://127.0.0.1:9099'    // auth
];

/**
 * Writes firebase.dev.json and returns its path.
 * @returns {string}
 */
function writeDevConfig() {
  const cfg = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  for (const block of ((cfg.hosting || {}).headers) || []) {
    for (const h of block.headers || []) {
      if (h.key.toLowerCase() !== 'content-security-policy') continue;
      h.value = h.value.split(';').map(d => {
        const name = d.trim().split(/\s+/)[0];
        // frame-src carries the auth emulator's sign-in widget; connect-src
        // carries the REST calls. Nothing else needs relaxing.
        if (name === 'connect-src') return d.trimEnd() + ' ' + EMULATOR_ORIGINS.join(' ');
        if (name === 'frame-src') {
          return d.trimEnd() + ' http://localhost:9099 http://127.0.0.1:9099';
        }
        return d;
      }).join(';');
    }
  }
  fs.writeFileSync(DEV, JSON.stringify(cfg, null, 2) + '\n');
  return DEV;
}

/** The args to hand the Firebase CLI so it uses the generated config. */
function devConfigArgs() {
  return ['--config', path.basename(writeDevConfig())];
}

module.exports = { writeDevConfig, devConfigArgs, DEV };
