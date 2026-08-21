/**
 * One-command provisioning for the Firebase backend. Zero dependencies.
 *
 *   node tools/firebase-setup.js [--project clone-blocker2]
 *                                [--location asia-southeast1]
 *                                [--email admin@example.com]
 *                                [--with-google --google-client-id ID --google-client-secret SECRET]
 *                                [--deploy]
 *
 * Two standalone commands maintain the admin allowlist in firestore.rules,
 * which is what makes a second sign-in method usable at all -- a Google
 * sign-in mints a different uid than the password account:
 *
 *   node tools/firebase-setup.js --list-admins
 *   node tools/firebase-setup.js --add-admin <uid> [--dry-run] [--rules FILE]
 *
 * Or let the first Google sign-in take the project, which needs no uid at all:
 *
 *   node tools/firebase-setup.js --open-claim     allow an account to be made
 *   ... sign in with Google at /admin/ -- that account becomes the admin ...
 *   node tools/firebase-setup.js --close-claim    shut it again
 *   node tools/firebase-setup.js --claim-status   who has it, is it still open
 *
 * --add-admin redeploys the rules once the new file has been read back and
 * re-parsed. --dry-run prints what it would write and touches nothing;
 * --rules points both commands at a scratch copy instead of the repo's file
 * (and never deploys, since a scratch file is not what production runs).
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
 *   5. enable Google sign-in ONLY with --with-google (off by default)
 *   6. create the admin user (random password -> .env) if missing
 *   7. disable public sign-up, so the admin stays the only account
 *   8. put the admin's UID in the firestore.rules allowlist
 *   9. with --deploy: firebase deploy --only firestore,hosting
 *  10. seed the public blocklist/current document if missing
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

// The two allowlist commands, and the escape hatches that let them be tested
// without touching what production runs.
const ADD_ADMIN = argOf('add-admin', null);
const LIST_ADMINS = args.includes('--list-admins');
const WITH_GOOGLE = args.includes('--with-google');
const CLAIM_STATUS = args.includes('--claim-status');
const OPEN_CLAIM = args.includes('--open-claim');
const CLOSE_CLAIM = args.includes('--close-claim');
const DRY_RUN = args.includes('--dry-run');
const RULES_ARG = argOf('rules', null);
const RULES_PATH = path.resolve(ROOT, RULES_ARG || 'firestore.rules');

// Google sign-in needs an OAuth client. The flags win; the environment is
// there so a CI run does not put a secret in a command line.
const GOOGLE_CLIENT_ID = argOf('google-client-id', process.env.GOOGLE_OAUTH_CLIENT_ID || '');
const GOOGLE_CLIENT_SECRET =
  argOf('google-client-secret', process.env.GOOGLE_OAUTH_CLIENT_SECRET || '');

// Public constants from firebase-tools (lib/api.js). Not secrets.
const OAUTH_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findCli() {
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'tools', 'bin', 'firebase');
  if (fs.existsSync(cached)) return cached;
  return null; // fall back to `firebase` on PATH via shell
}

// -- the admin allowlist in firestore.rules ---------------------------------
//
// The rules language has no data store this tool could write to, so the list
// of admin uids is a literal inside adminUids() and maintaining it means
// rewriting text. firestore.rules documents the exact shape these functions
// rely on -- `return [`, one quoted uid per line, a line holding only `];` --
// so the two halves of that contract sit next to their reasons.
//
// Everything below refuses rather than guesses. A rules file this cannot
// parse is a rules file it must not rewrite: half-written rules either lock
// the owner out of the dashboard or open the database to everyone, and both
// are worse than an error message.
const ADMIN_BLOCK =
  /(function adminUids\(\)[^\n]*\n[ \t]*return \[[ \t]*\r?\n)([\s\S]*?)(\r?\n([ \t]*)\];)/;

// A uid goes into a single-quoted literal, so anything that could end that
// literal early would change what the rules mean. Firebase uids are drawn
// from this alphabet anyway; a "uid" that is not is a typo or an attack.
const UID_RE = /^[A-Za-z0-9_-]{6,128}$/;

function parseAdmins(text) {
  const m = text.match(ADMIN_BLOCK);
  if (!m) return null;
  const uids = [];
  for (const line of m[2].split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const one = t.match(/^'([^'\\]*)',?$/);
    if (!one || !UID_RE.test(one[1])) return null;
    uids.push(one[1]);
  }
  return uids;
}

/** The whole block re-rendered, so nothing depends on where the commas sat. */
function renderAdmins(text, uids) {
  const m = text.match(ADMIN_BLOCK);
  if (!m) return null;
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const indent = m[4] + '  ';
  const body = uids
    .map((u, i) => indent + "'" + u + "'" + (i < uids.length - 1 ? ',' : ''))
    .join(nl);
  return text.replace(ADMIN_BLOCK, (all, head, mid, tail) => head + body + tail);
}

const sameList = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Write the list back and prove the file on disk still says what it should.
 *
 * The re-read is not ceremony: the whole point of --add-admin is that a
 * deploy follows it, and deploying a rules file nobody re-parsed is how a
 * project loses its admin. If the readback disagrees with what was intended,
 * the original bytes go back and the caller never gets to deploy.
 */
function saveAdmins(file, uids) {
  const before = fs.readFileSync(file, 'utf8');
  const next = renderAdmins(before, uids);
  if (next === null) throw new Error('could not locate adminUids() in ' + file);
  if (!sameList(parseAdmins(next), uids)) {
    throw new Error('refusing to write: the rewritten rules did not parse back as the list');
  }
  fs.writeFileSync(file, next);
  const back = fs.readFileSync(file, 'utf8');
  if (back !== next || !sameList(parseAdmins(back), uids)) {
    fs.writeFileSync(file, before);
    throw new Error('rules file did not read back as written -- original restored, nothing deployed');
  }
}

function deployRules() {
  const cli = findCli();
  const cmd = cli ? process.execPath : 'firebase';
  const base = cli ? [cli] : [];
  const r = spawnSync(cmd,
    [...base, 'deploy', '--only', 'firestore:rules', '--project', PROJECT, '--non-interactive'],
    { cwd: ROOT, stdio: 'inherit', shell: !cli });
  if (r.status !== 0) throw new Error('rules deploy failed');
}

/**
 * The uid list of the ruleset production is actually serving, which is not
 * necessarily the one in the working tree -- an un-deployed edit looks
 * identical on disk and does nothing at all to the live database.
 */
async function deployedAdmins() {
  const tok = await accessToken();
  const rel = await api(tok, 'GET',
    `https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`);
  const name = rel.json && rel.json.rulesetName;
  if (!name) throw new Error('no released ruleset (' + rel.status + ')');
  const rs = await api(tok, 'GET', `https://firebaserules.googleapis.com/v1/${name}`);
  const files = (rs.json && rs.json.source && rs.json.source.files) || [];
  const file = files.find(f => /firestore\.rules$/.test(f.name || '')) || files[0];
  if (!file) throw new Error('released ruleset carries no source');
  // A project deployed before the list existed still serves the single
  // pinned-uid form, and reporting THAT uid is the useful answer -- "a shape
  // I do not parse" would leave the owner guessing who can moderate today.
  const pinned = (file.content.match(/request\.auth\.uid == '([^']+)'/) || [])[1] || null;
  return { uids: parseAdmins(file.content), pinned, ruleset: name.split('/').pop() };
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

// -- the two allowlist commands ---------------------------------------------

// Repo files read better relative; a scratch file outside the repo reads as
// a pile of `..` segments, so it keeps its own name.
function shortPath(p) {
  const rel = path.relative(ROOT, p);
  return !rel || rel.startsWith('..') ? p : rel;
}

async function listAdminsCommand() {
  const rel = shortPath(RULES_PATH);
  const uids = parseAdmins(fs.readFileSync(RULES_PATH, 'utf8'));
  if (uids === null) {
    throw new Error('could not read the admin list out of ' + rel
      + ' -- see the shape contract in the comment above adminUids()');
  }
  console.log(`admins in ${rel} (${uids.length}):`);
  for (const u of uids) console.log('  ' + u);

  // A scratch file has no deployed counterpart to compare against.
  if (RULES_ARG) return;
  console.log('');
  try {
    const live = await deployedAdmins();
    if (live.uids === null) {
      console.log(`deployed (${live.ruleset}): not a list yet -- `
        + (live.pinned ? 'one pinned uid, ' + live.pinned : 'no uid this could read'));
      console.log('  the list above goes live on the next');
      console.log('    firebase deploy --only firestore:rules --project ' + PROJECT);
    } else if (sameList(live.uids, uids)) {
      console.log(`deployed (${live.ruleset}): the same list, live in ${PROJECT}`);
    } else {
      console.log(`deployed (${live.ruleset}) DIFFERS -- live list:`);
      for (const u of live.uids) console.log('  ' + u);
      console.log('  the working tree is ahead of production; deploy with');
      console.log('    firebase deploy --only firestore:rules --project ' + PROJECT);
    }
  } catch (e) {
    console.log('deployed  : could not be read (' + e.message + ')');
    console.log('  the list above is what the working tree would deploy.');
  }
}

async function addAdminCommand(uid) {
  if (!UID_RE.test(uid)) {
    throw new Error('not a Firebase uid: ' + JSON.stringify(uid)
      + ' -- letters, digits, dash and underscore, 6 to 128 of them');
  }
  const rel = shortPath(RULES_PATH);
  const text = fs.readFileSync(RULES_PATH, 'utf8');
  const before = parseAdmins(text);
  if (before === null) {
    throw new Error('could not read the admin list out of ' + rel
      + ' -- see the shape contract in the comment above adminUids()');
  }
  console.log('file      : ' + rel);
  console.log('before    : [' + before.join(', ') + ']');

  if (before.includes(uid)) {
    console.log('after     : unchanged -- ' + uid + ' is already an admin');
    console.log('');
    console.log('  nothing written, nothing deployed.');
    return;
  }
  const after = before.concat([uid]);
  console.log('after     : [' + after.join(', ') + ']');

  if (DRY_RUN) {
    const next = renderAdmins(text, after);
    console.log('');
    console.log('  --dry-run: nothing written, nothing deployed. It would become:');
    for (const line of next.match(ADMIN_BLOCK)[0].split(/\r?\n/)) console.log('  | ' + line);
    return;
  }

  saveAdmins(RULES_PATH, after);
  console.log('rules     : written, read back and re-parsed clean');

  if (RULES_ARG) {
    console.log('');
    console.log('  --rules pointed at a scratch file, so nothing was deployed.');
    return;
  }
  deployRules();
  console.log('');
  console.log('  ' + uid + ' can now moderate at https://' + PROJECT + '.web.app/admin/');
}

(async () => {
  // A flag that takes a value and did not get one would otherwise vanish --
  // `--add-admin` with the uid left off would fall straight through to a full
  // provisioning run against production, which is not remotely what the
  // person typing it meant.
  for (const flag of ['add-admin', 'rules', 'project', 'email', 'location',
                      'google-client-id', 'google-client-secret']) {
    if (args.includes('--' + flag) && argOf(flag, null) === null) {
      throw new Error('--' + flag + ' needs a value');
    }
  }

  // -- the claim window ------------------------------------------------------
  //
  // Signing in with Google is how the owner becomes an admin without ever
  // learning their own uid: the first account to sign in creates
  // admin/allowlist with itself inside, and the rules honour it from then on.
  //
  // For that to be possible the account has to be creatable, and sign-up is
  // disabled by default -- deliberately, because an open project is an open
  // project. So the window is a thing you open on purpose and close again,
  // and --claim-status answers the only question that matters while it is
  // open: has anybody taken it yet.
  async function setSignup(disabled) {
    const tok = await accessToken();
    const r = await api(tok, 'PATCH',
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=client.permissions`,
      { client: { permissions: { disabledUserSignup: disabled, disabledUserDeletion: false } } });
    if (r.status >= 400) {
      console.error(`could not ${disabled ? 'close' : 'open'} the claim window: HTTP ${r.status}`);
      process.exit(1);
    }
    if (disabled) {
      console.log('claim window CLOSED -- no new account can be created in this project.');
    } else {
      console.log('claim window OPEN.');
      console.log('');
      console.log(`  Sign in at https://${PROJECT}.web.app/admin/ with Google, NOW.`);
      console.log('  The first account to sign in becomes the admin. Until that happens,');
      console.log('  anyone who reaches that page could take it instead -- so do it now,');
      console.log('  then run:  node tools/firebase-setup.js --close-claim');
    }
  }

  /** Has anybody claimed it, and is the window still open? */
  async function claimStatusCommand() {
    const tok = await accessToken();
    const doc = await api(tok, 'GET',
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/admin/allowlist`);
    const cfg = await api(tok, 'GET',
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`);
    const open = !(((cfg.json || {}).client || {}).permissions || {}).disabledUserSignup;

    if (doc.status === 404) {
      console.log('claimed   : NO -- nobody is an admin by sign-in yet');
    } else if (doc.status === 200) {
      const f = (doc.json || {}).fields || {};
      const uids = (((f.uids || {}).arrayValue || {}).values || []).map(v => v.stringValue);
      console.log('claimed   : YES');
      console.log('by        : ' + ((f.claimedBy || {}).stringValue || 'unknown') +
        '  at ' + ((f.claimedAt || {}).stringValue || 'unknown'));
      console.log('admin uids: ' + uids.join(', '));
    } else {
      console.log('claimed   : could not tell (HTTP ' + doc.status + ')');
    }
    console.log('sign-up   : ' + (open ? 'OPEN -- the claim can still be taken' : 'closed'));
    if (doc.status === 200 && open) {
      console.log('');
      console.log('  It is claimed but the window is still open. Close it:');
      console.log('    node tools/firebase-setup.js --close-claim');
    }
  }

  // The allowlist commands are their own small program: one file, at most one
  // deploy, and no project call at all in the --dry-run and --rules paths, so
  // they work on a machine that cannot reach Firebase.
  if (LIST_ADMINS) { await listAdminsCommand(); return; }
  if (ADD_ADMIN !== null) { await addAdminCommand(ADD_ADMIN); return; }
  if (CLAIM_STATUS) { await claimStatusCommand(); return; }
  if (OPEN_CLAIM) { await setSignup(false); return; }
  if (CLOSE_CLAIM) { await setSignup(true); return; }

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

  // -- 5. Google sign-in -----------------------------------------------------
  //
  // Off unless asked for. Google sign-in is disabled for now (the moderation
  // account signs in with a password), and enabling a provider nobody uses
  // would only widen what this project accepts. --with-google turns the step
  // back on when that changes.
  //
  // Identity Toolkit models a provider as a
  // defaultSupportedIdpConfig, and google.com needs an OAuth client id and
  // secret: the sign-in popup is a Google OAuth consent flow, and consent is
  // granted to a client, not to a Firebase project.
  //
  // A project provisioned through the console usually already has one (the
  // auto-created "Web client"), and the create call adopts it, but that
  // client is not readable through any public API -- so if the call comes
  // back wanting credentials, this prints the exact page to finish it on and
  // lets the rest of the run continue. Half a provisioned project plus one
  // clear instruction beats a failed run that also skipped the rules and the
  // seed.
  if (!WITH_GOOGLE) {
    console.log('google    : skipped -- password sign-in only (--with-google to enable)');
  } else {
    const base = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/defaultSupportedIdpConfigs`;
    const creds = GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
      ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
      : {};
    const existing = await api(tok, 'GET', base + '/google.com');
    let done = false, why = '';

    if (existing.status < 400 && existing.json) {
      if (existing.json.enabled && !GOOGLE_CLIENT_ID) {
        console.log('google    : sign-in already enabled');
        done = true;
      } else {
        const mask = ['enabled'].concat(Object.keys(creds)).join(',');
        const r = await api(tok, 'PATCH', base + '/google.com?updateMask=' + mask,
          Object.assign({ enabled: true }, creds));
        done = r.status < 400;
        why = r.text;
        if (done) console.log('google    : sign-in enabled');
      }
    } else {
      const r = await api(tok, 'POST', base + '?idpId=google.com',
        Object.assign({ enabled: true }, creds));
      done = r.status < 400;
      why = r.text;
      if (done) {
        console.log('google    : sign-in enabled'
          + (creds.clientId ? '' : " (project's existing OAuth client)"));
      }
    }

    if (!done) {
      console.log('google    : NOT enabled -- ' + String(why).slice(0, 200));
      console.log('  Google sign-in needs an OAuth client id and secret. Either');
      console.log('  re-run with --google-client-id / --google-client-secret, or');
      console.log('  turn it on by hand (one click, it creates the client for you):');
      console.log(`    https://console.firebase.google.com/project/${PROJECT}/authentication/providers`);
      console.log('  The credentials themselves live at');
      console.log(`    https://console.cloud.google.com/apis/credentials?project=${PROJECT}`);
      console.log('  Everything else below still ran.');
    }
  }

  // -- 6. Admin user ---------------------------------------------------------
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

  // -- 7. Close the door -----------------------------------------------------
  {
    const r = await api(tok, 'PATCH',
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=client.permissions`,
      { client: { permissions: { disabledUserSignup: true, disabledUserDeletion: false } } });
    if (r.status >= 400) console.log('signup    : could not disable (' + r.status + ') -- do it in the console');
    else console.log('signup    : public sign-up disabled');
  }

  // -- 8. Put the admin UID in the rules allowlist ---------------------------
  //
  // The same list --add-admin maintains, not a parallel path: one writer for
  // that literal means one shape to get right, and this step is just the
  // first uid to go in.
  //
  // A freshly created admin account means a freshly provisioned project, and
  // the checked-in rules carry the ORIGINAL project's admin uid. Inheriting
  // it would hand a stranger moderation rights over a fork's database, so a
  // new account replaces the list rather than joining it; an account that
  // already existed is this project's own and only ever gets appended.
  {
    if (!fs.existsSync(RULES_PATH)) {
      console.log('rules     : firestore.rules not found -- add uid ' + uid + ' manually');
    } else {
      const current = parseAdmins(fs.readFileSync(RULES_PATH, 'utf8'));
      if (current === null) {
        console.log('rules     : could not read the admin list -- add uid ' + uid + ' by hand');
      } else if (current.includes(uid) && !created) {
        console.log('rules     : uid already in the admin allowlist');
      } else {
        const next = created ? [uid] : current.concat([uid]);
        try {
          saveAdmins(RULES_PATH, next);
          console.log('rules     : admin allowlist is now [' + next.join(', ') + ']');
        } catch (e) {
          console.log('rules     : NOT written -- ' + e.message);
          console.log('            add uid ' + uid + ' by hand before deploying');
        }
      }
    }
  }

  // -- 9. Deploy -------------------------------------------------------------
  if (DEPLOY) {
    const cli = findCli();
    const cmd = cli ? process.execPath : 'firebase';
    const base = cli ? [cli] : [];
    const r = spawnSync(cmd,
      [...base, 'deploy', '--only', 'firestore,hosting', '--project', PROJECT, '--non-interactive'],
      { cwd: ROOT, stdio: 'inherit', shell: !cli });
    if (r.status !== 0) throw new Error('deploy failed');
  }

  // -- 10. Seed the public document ------------------------------------------
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
