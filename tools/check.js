/**
 * Static validation: syntax-checks every source file and verifies that every
 * path referenced by the manifest and the extension's HTML pages resolves.
 *
 * Fast enough to run before every commit; the browser test in e2e-test.js is
 * the slow, thorough counterpart.
 */
const { execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function report(ok, label, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

// ---- 1. syntax ------------------------------------------------------------
function jsFiles(dir, acc) {
  acc = acc || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      jsFiles(p, acc);
    } else if (e.name.endsWith('.js')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Syntax-check one file, as the thing it actually is.
 *
 * `node --check foo.js` parses as CommonJS. The MV3 service worker is declared
 * "type": "module" and uses import, and under CommonJS parsing node happily
 * accepted a file with a duplicate top-level `const` -- a hard SyntaxError that
 * would have stopped the worker loading, reported here as clean. Anything with
 * an import or export is copied to a .mjs and checked as a module.
 */
function checkSyntax(file) {
  const src = fs.readFileSync(file, 'utf8');
  const isModule = /^\s*(?:import|export)\s/m.test(src);
  if (!isModule) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return;
  }
  const tmp = path.join(os.tmpdir(),
    'tq-syntax-' + process.pid + '-' + path.basename(file, '.js') + '.mjs');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

for (const f of jsFiles(path.join(ROOT, 'src'))
  .concat(jsFiles(path.join(ROOT, 'server')))
  .concat(jsFiles(path.join(ROOT, 'tools')))) {
  try {
    checkSyntax(f);
    report(true, 'syntax ' + path.relative(ROOT, f));
  } catch (e) {
    report(false, 'syntax ' + path.relative(ROOT, f),
      String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
  }
}

// ---- 2. manifest ----------------------------------------------------------
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  report(true, 'manifest.json parses');
} catch (e) {
  report(false, 'manifest.json parses', e.message);
}

if (manifest) {
  const refs = [];
  if (manifest.background) refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(r => refs.push(r));
    (cs.css || []).forEach(r => refs.push(r));
  }
  if (manifest.action) refs.push(manifest.action.default_popup);
  if (manifest.options_page) refs.push(manifest.options_page);
  Object.values(manifest.icons || {}).forEach(r => refs.push(r));

  for (const r of refs.filter(Boolean)) {
    report(fs.existsSync(path.join(ROOT, r)), 'manifest ref ' + r);
  }

  // MAIN-world content scripts must not be granted extension APIs by mistake,
  // and the isolated bundle must load protocol.js before anything using it.
  const main = (manifest.content_scripts || []).find(c => c.world === 'MAIN');
  const iso = (manifest.content_scripts || []).find(c => c.world !== 'MAIN');
  report(!!main && main.run_at === 'document_start',
    'MAIN world script runs at document_start',
    main ? main.run_at : 'no MAIN entry');
  report(!!iso && (iso.js || [])[0] === 'src/common/protocol.js',
    'protocol.js loads first in isolated bundle',
    iso ? (iso.js || [])[0] : 'no isolated entry');

  const minChrome = parseInt(manifest.minimum_chrome_version, 10);
  report(minChrome >= 111, 'minimum_chrome_version supports world:MAIN',
    manifest.minimum_chrome_version);
}

// ---- 3. HTML asset references --------------------------------------------
for (const rel of ['src/popup/popup.html', 'src/options/options.html']) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { report(false, 'exists ' + rel); continue; }
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const re = /(?:src|href)="([^"#]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    if (/^(https?:)?\/\//.test(m[1])) continue;
    report(fs.existsSync(path.resolve(dir, m[1])), `${rel} -> ${m[1]}`);
  }
  // MV3 extension pages may not use inline script.
  report(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(src),
    `${rel} has no inline script (MV3 CSP)`);
}

// ---- 5. every settings field the options page binds must exist ------------
//
// options.js reads its fields by id and assigns straight onto the element. A
// field listed there with no matching input throws on load and takes the whole
// options page with it -- and nothing else in this file would notice, because
// both files are individually valid.
{
  const jsPath = path.join(ROOT, 'src', 'options', 'options.js');
  const htmlPath = path.join(ROOT, 'src', 'options', 'options.html');
  try {
    const js = fs.readFileSync(jsPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const fields = [];
    for (const m of js.matchAll(/const (?:TEXT|NUM|BOOL|SELECT)_FIELDS = \[([^\]]*)\]/g)) {
      for (const q of m[1].matchAll(/'([^']+)'/g)) fields.push(q[1]);
    }
    const missing = fields.filter(f => !html.includes('id="' + f + '"'));
    report(missing.length === 0,
      'options.js fields all exist in options.html (' + fields.length + ')',
      missing.length ? 'missing: ' + missing.join(', ') : '');
  } catch (e) {
    report(false, 'options settings fields', e.message);
  }
}

// ---- 6. every element the popup reaches for must exist --------------------
//
// Same failure as the options check above, in the file people actually open.
// $('someId') on a missing element returns null and the next property access
// throws, which blanks the whole popup -- and both files stay individually
// valid, so nothing else here would catch it.
{
  const jsPath = path.join(ROOT, 'src', 'popup', 'popup.js');
  const htmlPath = path.join(ROOT, 'src', 'popup', 'popup.html');
  try {
    const js = fs.readFileSync(jsPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const ids = new Set();
    for (const m of js.matchAll(/\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) ids.add(m[1]);
    for (const m of js.matchAll(/\bshow\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
    const list = [...ids];
    const missing = list.filter(f => !html.includes('id="' + f + '"'));
    report(missing.length === 0,
      'popup.js elements all exist in popup.html (' + list.length + ')',
      missing.length ? 'missing: ' + missing.join(', ') : '');
  } catch (e) {
    report(false, 'popup elements', e.message);
  }
}

console.log('\n' + (failures ? `${failures} problem(s)` : 'all checks passed'));
process.exitCode = failures ? 1 : 0;
