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
    'cb-syntax-' + process.pid + '-' + path.basename(file, '.js') + '.mjs');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

for (const f of jsFiles(path.join(ROOT, 'src'))
  .concat(jsFiles(path.join(ROOT, 'hosting')))
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

// ---- 6. every element the popup and activity pages reach for must exist ---
//
// Same failure as the options check above, in the files people actually open.
// $('someId') on a missing element returns null and the next property access
// throws, which blanks the whole page -- and both files stay individually
// valid, so nothing else here would catch it.
for (const page of ['popup', 'activity']) {
  const jsPath = path.join(ROOT, 'src', page, page + '.js');
  const htmlPath = path.join(ROOT, 'src', page, page + '.html');
  try {
    const js = fs.readFileSync(jsPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const ids = new Set();
    for (const m of js.matchAll(/\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) ids.add(m[1]);
    for (const m of js.matchAll(/\bshow\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
    const list = [...ids];
    const missing = list.filter(f => !html.includes('id="' + f + '"'));
    report(missing.length === 0,
      page + '.js elements all exist in ' + page + '.html (' + list.length + ')',
      missing.length ? 'missing: ' + missing.join(', ') : '');
  } catch (e) {
    report(false, page + ' elements', e.message);
  }
}

// ---- 7. the retired "Layer 1 / Layer 2" framing --------------------------
//
// The product used to be described as Layer 1 (hide) and Layer 2 (real block).
// That named the implementation rather than the choice anyone was making, and
// the passive/active mode picker replaced it. It is the kind of vocabulary
// that creeps back one label at a time, so this fails the build if it does.
//
// Only what a reader can actually see is scanned: every HTML page under src/,
// plus the quoted strings in the scripts those pages run. Comments still
// explaining where the old names went are exempt on purpose -- that history is
// worth keeping, and a check that punished it would just get the explanations
// deleted.
{
  const RETIRED = /\bLayer\s*[12]\b/i;
  const offenders = [];

  const htmlFiles = (dir, acc) => {
    acc = acc || [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) htmlFiles(p, acc); }
      else if (e.name.endsWith('.html')) acc.push(p);
    }
    return acc;
  };

  for (const file of htmlFiles(path.join(ROOT, 'src'))) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (RETIRED.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }

  // The five scripts that put text on a screen: the three extension pages and
  // the two content scripts that render into the site itself. Comments come
  // out first, so what is tested is only what could reach a user.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const STRINGS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

  for (const rel of ['src/popup/popup.js', 'src/options/options.js',
                     'src/activity/activity.js', 'src/content/report-ui.js',
                     'src/content/dom-blocker.js']) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { report(false, 'exists ' + rel); continue; }
    for (const s of stripComments(fs.readFileSync(file, 'utf8')).match(STRINGS) || []) {
      if (RETIRED.test(s)) offenders.push(rel + ' -> ' + s.slice(0, 60));
    }
  }

  report(offenders.length === 0, 'the "Layer 1 / Layer 2" framing is gone from the UI',
    offenders.join('; '));
}

// ---- 8. one tag vocabulary, spelled the same in all three places ---------
//
// TAGS lives three times over -- hosting/logic.js derives verdicts from it,
// protocol.js labels them in the extension, firestore.rules refuses anything
// outside it -- and no two of those copies can import each other. Every way
// they can drift fails silently and in a different direction: a tag the rules
// reject but the dashboard offers loses the admin's write with a 403 they will
// read as a network blip; a tag the extension does not know is matched by
// nobody's blockTags and simply stops being blocked; and a reordering changes
// which tag wins a tied vote without changing a single value.
{
  const TAG_LIST = /const TAGS = \[([^\]]*)\]/;
  const tagsIn = (rel) => {
    const m = TAG_LIST.exec(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (!m) throw new Error('no TAGS array in ' + rel);
    return [...m[1].matchAll(/'([^']+)'/g)].map(q => q[1]);
  };

  let tags = null;
  try {
    const logic = tagsIn('hosting/logic.js');
    const protocol = tagsIn('src/common/protocol.js');
    // Order and all: it is the tiebreak for equally popular reasons.
    report(logic.join(',') === protocol.join(','),
      'TAGS is identical in logic.js and protocol.js (' + logic.length + ')',
      logic.join(',') === protocol.join(',') ? '' : logic.join(',') + ' vs ' + protocol.join(','));
    tags = logic;
  } catch (e) {
    report(false, 'TAGS is identical in logic.js and protocol.js', e.message);
  }

  if (tags) {
    // The rules name the vocabulary twice -- once for a report's `reason`,
    // once for a decision's `tag` -- and both have to be complete, so every
    // list in the file that looks like the vocabulary is held to it.
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const lists = [...rules.matchAll(/\[([^\]]*'clone'[^\]]*)\]/g)]
      .map(m => [...m[1].matchAll(/'([^']+)'/g)].map(q => q[1]));
    report(lists.length >= 2,
      'firestore.rules lists the vocabulary for both reason and tag',
      lists.length + ' list(s) found');
    const short = lists.map(l => tags.filter(t => !l.includes(t))).flat();
    report(lists.length >= 2 && short.length === 0,
      'firestore.rules accepts every tag (' + tags.length + ')',
      short.length ? 'missing: ' + [...new Set(short)].join(', ') : '');
  }
}

// ---- 9. the two hosted pages, and the one rule they share ---------------
//
// Hosting serves a public page at / and the dashboard at /admin/, and both are
// built out of text somebody else wrote: a reporter's summary of a post, a
// display name, a username. The dashboard has always been textContent-only,
// but on the public page that stops being a matter of taste -- it names
// people, so it is exactly the page one of those named people would try to
// get a script onto, and it is read by strangers with no reason to trust it.
// One innerHTML anywhere on either page is all it takes.
//
// Both the markup and every local script it loads are scanned, because that
// is where the assignment would actually be written. Comments come out first,
// on purpose: a comment explaining why innerHTML is not used here is the kind
// of note this rule wants kept, and a check that failed the build over it
// would only get the explanation deleted.
{
  const stripComments = (text) => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  for (const rel of ['hosting/index.html', 'hosting/admin/index.html']) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { report(false, 'exists ' + rel); continue; }
    report(true, 'exists ' + rel);

    const src = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    const scanned = [[rel, src]];
    for (const m of src.matchAll(/<script[^>]*\bsrc="([^"#]+)"/g)) {
      if (/^(https?:)?\/\//.test(m[1])) continue;
      const dep = path.resolve(dir, m[1]);
      if (!fs.existsSync(dep)) { report(false, `${rel} -> ${m[1]}`); continue; }
      scanned.push([path.relative(ROOT, dep).split(path.sep).join('/'),
        fs.readFileSync(dep, 'utf8')]);
    }

    const offenders = scanned
      .filter(([, text]) => /\binnerHTML\b/.test(stripComments(text)))
      .map(([name]) => name);
    report(offenders.length === 0,
      rel + ' and its scripts write text, never HTML (' + scanned.length + ' file(s))',
      offenders.join(', '));
  }
}

console.log('\n' + (failures ? `${failures} problem(s)` : 'all checks passed'));
process.exitCode = failures ? 1 : 0;
