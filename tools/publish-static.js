/**
 * Snapshot the published blocklist out of Firestore and serve it as a static
 * file on Firebase Hosting. Zero dependencies.
 *
 *   node tools/publish-static.js                  snapshot + deploy once
 *   node tools/publish-static.js --interval 30    keep doing it every 30 min
 *   node tools/publish-static.js --project <id>   default clone-blocker2
 *
 * Why this exists: the extension polls the list far more often than the list
 * changes. Reading it from Firestore is one billed document read per poll and
 * the full blob over the wire (the change-probe in the service worker softens
 * the second, not the first). A static file on Hosting is the cheap shape for
 * content that is written rarely and read constantly: the CDN serves it with a
 * real ETag, an unchanged poll is a genuine 304 that never reaches any
 * database, and Firestore read quota stops being a function of user count.
 *
 * The dashboard cannot do this itself -- deploying a Hosting version needs the
 * OAuth credential the CLI holds, which a browser page must never hold. Hence
 * a tool: run it after moderating, or leave --interval running (or schedule
 * it); it probes the document's updateTime and only deploys when the list
 * actually changed, so an idle interval costs one masked read and no deploy.
 *
 * Point the extension at the file:
 *   list URL : https://<project>.web.app/blocklist.json
 *   API base : https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/documents
 * (reports still go to Firestore; only the read moves to the CDN).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { javaEnv } = require('./java-env.js');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PROJECT = argOf('project', 'clone-blocker2');
const INTERVAL_MIN = parseInt(argOf('interval', '0'), 10) || 0;

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'hosting', 'blocklist.json');
const DOC = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/blocklist/current`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cli(argv) {
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'tools', 'bin', 'firebase');
  const env = javaEnv();
  return fs.existsSync(cached)
    ? spawnSync(process.execPath, [cached, ...argv], { cwd: ROOT, stdio: 'inherit', env })
    : spawnSync('firebase', argv, { cwd: ROOT, stdio: 'inherit', shell: true, env });
}

async function currentUpdateTime() {
  const res = await fetch(DOC + '?mask.fieldPaths=rev');
  if (!res.ok) throw new Error('probe returned HTTP ' + res.status);
  return (await res.json()).updateTime || null;
}

async function snapshotAndDeploy() {
  const res = await fetch(DOC);
  if (!res.ok) throw new Error('document read returned HTTP ' + res.status);
  const doc = await res.json();
  const json = doc.fields && doc.fields.json && doc.fields.json.stringValue;
  if (!json) throw new Error('blocklist/current has no published payload');
  JSON.parse(json); // refuse to deploy a corrupt payload

  fs.writeFileSync(OUT, json);
  console.log(`[${new Date().toISOString()}] snapshot: ${json.length} bytes -> hosting/blocklist.json`);

  const r = cli(['deploy', '--only', 'hosting', '--project', PROJECT, '--non-interactive']);
  if (r.status !== 0) throw new Error('hosting deploy failed');
  console.log(`  live: https://${PROJECT}.web.app/blocklist.json`);
  return doc.updateTime || null;
}

(async () => {
  let deployedAt = await snapshotAndDeploy();

  if (!INTERVAL_MIN) return;
  console.log(`watching for changes every ${INTERVAL_MIN} min (ctrl-c to stop)`);
  for (;;) {
    await sleep(INTERVAL_MIN * 60 * 1000);
    try {
      const now = await currentUpdateTime();
      if (now && now !== deployedAt) {
        deployedAt = await snapshotAndDeploy();
      } else {
        console.log(`[${new Date().toISOString()}] unchanged (${now})`);
      }
    } catch (e) {
      // A blip must not kill a long-running watcher; the next tick retries.
      console.error(`[${new Date().toISOString()}] ${e.message}`);
    }
  }
})().catch((e) => { console.error('publish-static failed: ' + e.message); process.exit(1); });
