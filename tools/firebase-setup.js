/**
 * One-command provisioning for the Firebase backend. Zero dependencies.
 *
 *   node tools/firebase-setup.js [--project clone-blocker2]
 *                                [--location asia-southeast1]
 *                                [--email admin@example.com]
 *                                [--deploy]
 *
 * Idempotent: every step checks before it creates, so re-running is safe.
 *
 * It authenticates with the credentials the Firebase CLI already holds
 * (`firebase login` must have been run once). The CLI's OAuth client id and
 * secret are public constants shipped inside every firebase-tools install --
 * they are not secrets, the refresh token in the user's configstore is, and
 * that never leaves this machine: it is exchanged locally for a short-lived
 * access token.
 *
 * What it does, in order:
 *   1. enable the Firestore / Identity Toolkit / Hosting / Rules APIs
 *   2. create the (default) Firestore database if the project has none
 *   3. create a web app registration if the project has none
 *   4. enable email/password sign-in
 *   5. create the admin user (random password -> .env) if missing
 *   6. disable public sign-up, so the admin stays the only account
 *   7. pin the admin's UID into firestore.rules
 *   8. with --deploy: firebase deploy --only firestore,hosting
 *   9. seed the public blocklist/current document if missing
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PROJECT = argOf('project', 'clone-blocker2');
const LOCATION = argOf('location', 'asia-southeast1');
const EMAIL = argOf('email', `admin@${PROJECT}.web.app`);
const DEPLOY = args.includes('--deploy');
const ROOT = path.join(__dirname, '..');

// Public constants from firebase-tools (lib/api.js). Not secrets.
const OAUTH_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findCli() {
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'tools', 'bin', 'firebase');
  if (fs.existsSync(cached)) return cached;
  return null; // fall back to `firebase` on PATH via shell
}

async function accessToken() {
  const store = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  let refresh;
  try { refresh = JSON.parse(fs.readFileSync(store, 'utf8')).tokens.refresh_token; }
  catch (e) { throw new Error('no Firebase CLI credentials -- run `firebase login` first'); }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET
    })
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token exchange failed: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function api(tok, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: 'Bearer ' + tok,
      'content-type': 'application/json',
      'x-goog-user-project': PROJECT
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

async function waitOp(tok, opName, base) {
  for (let i = 0; i < 60; i++) {
    const r = await api(tok, 'GET', base + '/' + opName);
    if (r.json && r.json.done) {
      if (r.json.error) throw new Error('operation failed: ' + JSON.stringify(r.json.error));
      return r.json.response;
    }
    await sleep(2000);
  }
  throw new Error('operation timed out: ' + opName);
}

(async () => {
  const tok = await accessToken();
  console.log(`project: ${PROJECT}`);

  // -- 1. APIs ---------------------------------------------------------------
  {
    const r = await api(tok, 'POST',
      `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services:batchEnable`,
      { serviceIds: [
        'firestore.googleapis.com',
        'identitytoolkit.googleapis.com',
        'firebasehosting.googleapis.com',
        'firebaserules.googleapis.com'
      ] });
    if (r.status >= 400) throw new Error('enable APIs: ' + r.text.slice(0, 300));
    if (r.json && r.json.name) {
      await waitOp(tok, r.json.name.replace(/^operations\//, 'operations/'),
        'https://serviceusage.googleapis.com/v1').catch(() => {});
    }
    console.log('APIs      : enabled (firestore, identitytoolkit, hosting, rules)');
  }

  // -- 2. Firestore database -------------------------------------------------
  {
    const list = await api(tok, 'GET', `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases`);
    const dbs = (list.json && list.json.databases) || [];
    if (dbs.length) {
      console.log('firestore : exists (' + dbs[0].locationId + ')');
    } else {
      const r = await api(tok, 'POST',
        `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases?databaseId=(default)`,
        { type: 'FIRESTORE_NATIVE', locationId: LOCATION });
      if (r.status >= 400) throw new Error('create database: ' + r.text.slice(0, 300));
      if (r.json && r.json.name && r.json.name.includes('/operations/')) {
        await waitOp(tok, r.json.name.split('/operations/')[1],
          `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/operations`)
          .catch(() => {});
      }
      // The create returns quickly but the DB can lag a few seconds.
      await sleep(4000);
      console.log('firestore : created in ' + LOCATION);
    }
  }

  // -- 3. Web app ------------------------------------------------------------
  let apiKey = null;
  {
    const list = await api(tok, 'GET', `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps`);
    let app = ((list.json && list.json.apps) || [])[0];
    if (!app) {
      const r = await api(tok, 'POST',
        `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps`,
        { displayName: 'CloneBlocker Admin' });
      if (r.status >= 400) throw new Error('create web app: ' + r.text.slice(0, 300));
      await waitOp(tok, r.json.name, 'https://firebase.googleapis.com/v1beta1').catch(() => {});
      await sleep(2000);
      const again = await api(tok, 'GET', `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps`);
      app = ((again.json && again.json.apps) || [])[0];
      console.log('web app   : created');
    } else {
      console.log('web app   : exists');
    }
    if (app) {
      const cfg = await api(tok, 'GET', `https://firebase.googleapis.com/v1beta1/${app.name}/config`);
      apiKey = cfg.json && cfg.json.apiKey;
    }
  }

  // -- 4. Email/password sign-in --------------------------------------------
  {
    const patch = () => api(tok, 'PATCH',
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=signIn.email`,
      { signIn: { email: { enabled: true, passwordRequired: true } } });
    let r = await patch();
    if (r.status === 404 || (r.text && r.text.includes('CONFIGURATION_NOT_FOUND'))) {
      // Auth has never been initialised on this project. initializeAuth
      // provisions it; then the provider patch goes through.
      await api(tok, 'POST',
        `https://identitytoolkit.googleapis.com/v2/projects/${PROJECT}/identityPlatform:initializeAuth`, {});
      await sleep(2000);
      r = await patch();
    }
    if (r.status >= 400) throw new Error('enable email sign-in: ' + r.text.slice(0, 300));
    console.log('auth      : email/password sign-in enabled');
  }

  // -- 5. Admin user ---------------------------------------------------------
  let uid = null, password = null, created = false;
  {
    const look = await api(tok, 'POST',
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`,
      { email: [EMAIL] });
    const existing = look.json && look.json.users && look.json.users[0];
    if (existing) {
      uid = existing.localId;
      console.log(`admin     : exists (${EMAIL}, uid ${uid})`);
    } else {
      password = crypto.randomBytes(15).toString('base64url');
      const r = await api(tok, 'POST',
        `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
        { email: EMAIL, password, emailVerified: true });
      if (r.status >= 400 || !r.json.localId) throw new Error('create admin: ' + r.text.slice(0, 300));
      uid = r.json.localId;
      created = true;
      console.log(`admin     : created (${EMAIL}, uid ${uid})`);
    }
  }

  // -- 6. Close the door -----------------------------------------------------
  {
    const r = await api(tok, 'PATCH',
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=client.permissions`,
      { client: { permissions: { disabledUserSignup: true, disabledUserDeletion: false } } });
    if (r.status >= 400) console.log('signup    : could not disable (' + r.status + ') -- do it in the console');
    else console.log('signup    : public sign-up disabled');
  }

  // -- 7. Pin the admin UID in the rules ------------------------------------
  {
    const rulesPath = path.join(ROOT, 'firestore.rules');
    if (fs.existsSync(rulesPath)) {
      let rules = fs.readFileSync(rulesPath, 'utf8');
      const next = rules.replace(/(request\.auth\.uid == ')[^']*(')/, `$1${uid}$2`);
      if (next !== rules) {
        fs.writeFileSync(rulesPath, next);
        console.log('rules     : admin UID pinned');
      } else {
        console.log('rules     : UID already pinned');
      }
    } else {
      console.log('rules     : firestore.rules not found -- pin uid ' + uid + ' manually');
    }
  }

  // -- 8. Deploy -------------------------------------------------------------
  if (DEPLOY) {
    const cli = findCli();
    const cmd = cli ? process.execPath : 'firebase';
    const base = cli ? [cli] : [];
    const r = spawnSync(cmd,
      [...base, 'deploy', '--only', 'firestore,hosting', '--project', PROJECT, '--non-interactive'],
      { cwd: ROOT, stdio: 'inherit', shell: !cli });
    if (r.status !== 0) throw new Error('deploy failed');
  }

  // -- 9. Seed the public document ------------------------------------------
  {
    const docUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/blocklist/current`;
    const get = await api(tok, 'GET', docUrl);
    if (get.status === 404) {
      const empty = { v: 1, updatedAt: new Date().toISOString(), ids: [], usernames: [], pending: [], targets: [], docIdOverrides: {} };
      const r = await api(tok, 'PATCH', docUrl, {
        fields: {
          json: { stringValue: JSON.stringify(empty) },
          updatedAt: { timestampValue: new Date().toISOString() }
        }
      });
      if (r.status >= 400) console.log('seed      : failed (' + r.status + ') -- publish from the dashboard instead');
      else console.log('seed      : empty blocklist/current written');
    } else {
      console.log('seed      : blocklist/current already exists');
    }
  }

  // -- credentials to .env (never to the repo) -------------------------------
  if (created) {
    const envPath = path.join(ROOT, '.env');
    let env = '';
    try { env = fs.readFileSync(envPath, 'utf8'); } catch (e) { /* new file */ }
    if (!/^FIREBASE_ADMIN_EMAIL=/m.test(env)) {
      env += (env.endsWith('\n') || env === '' ? '' : '\n') +
        `FIREBASE_ADMIN_EMAIL=${EMAIL}\nFIREBASE_ADMIN_PASSWORD=${password}\n`;
      fs.writeFileSync(envPath, env);
    }
    console.log('');
    console.log('  admin sign-in (saved to .env, which is gitignored):');
    console.log('    email    : ' + EMAIL);
    console.log('    password : ' + password);
    console.log('  Note: this email is a placeholder, so password-reset emails will');
    console.log('  not deliver. Change it in the Firebase console if you want resets.');
  }

  console.log('');
  console.log('  blocklist URL for the extension:');
  console.log(`    https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/blocklist/current`);
  console.log('  dashboard (after deploy):');
  console.log(`    https://${PROJECT}.web.app/`);
})().catch((e) => { console.error('setup failed: ' + e.message); process.exit(1); });
