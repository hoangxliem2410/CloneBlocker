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
  // i18n.js goes ahead of protocol.js, not merely somewhere before the scripts
  // that paint: protocol.js resolves the tag labels through CB_T, so loading it
  // first would freeze the one vocabulary every screen shares into English.
  report(!!iso && (iso.js || []).slice(0, 2).join(',') ===
    'src/common/i18n.js,src/common/protocol.js',
    'i18n.js then protocol.js lead the isolated bundle',
    iso ? (iso.js || []).slice(0, 2).join(', ') : 'no isolated entry');

  report(manifest.default_locale === 'en' &&
    fs.existsSync(path.join(ROOT, '_locales', manifest.default_locale, 'messages.json')),
    'default_locale is en and _locales/en/messages.json exists',
    manifest.default_locale || 'unset');

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
// a mode picker replaced it -- which was itself replaced, see 7b. It is the
// kind of vocabulary that creeps back one label at a time, so this fails the
// build if it does.
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

// ---- 7b. the retired passive/active mode ---------------------------------
//
// What the extension is allowed to block used to be one setting called `mode`,
// with the values 'passive' and 'active'. It is now two independent switches,
// blockSeen and blockFromList, because the pair the radio could not express --
// work through the ranked list but leave what I scroll past alone -- is a
// perfectly reasonable thing to want.
//
// Two ways that could rot. A page could go on reading the dead setting and
// silently show the wrong state, or somebody could reintroduce the words as a
// label and leave the product with two vocabularies for one thing. So:
//
//   1. nothing under src/ may read `mode`, compare against its values or call
//      CB_MODE_OF, except the back-compat readers in protocol.js and
//      service-worker.js -- which exist precisely to keep old installs working
//      and must not be tidied away;
//   2. no page script may hardcode 'passive' or 'active' as a mode string, and
//      no page may keep the radio buttons that used to write it.
//
// Comments are stripped before any of this. An explanation of where the old
// setting went is worth keeping, and a check that punished it would only get
// the explanation deleted.
{
  const stripJsComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const htmlPages = (dir, acc) => {
    acc = acc || [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) htmlPages(p, acc); }
      else if (e.name.endsWith('.html')) acc.push(p);
    }
    return acc;
  };

  // `mode` as a settings key, however it is spelled. `hideMode` is a different
  // setting and stays: the word boundary keeps them apart without a list of
  // exceptions.
  const MODE_KEY = /\.mode\b|\[\s*['"]mode['"]\s*\]/;
  // Its values, in the shapes a value actually turns up in: assigned, compared,
  // or handed over as a property. Deliberately not a bare /'active'/ -- that is
  // also the CSS class on a selected chip, and a check that cried wolf about
  // styling would be switched off within the week.
  const MODE_VALUE =
    /(?:\bmode\s*(?:=|===?|!==?|:)\s*|[!=]==?\s*|\?\s*|:\s*)(['"])(?:passive|active)\1/;
  const MODE_READER = /\bCB_MODE_OF\b|\bmodeOf\s*\(/;
  // The flag that predates modes entirely and means what blockFromList off
  // means. protocol.js reads it so nobody's old install changes behaviour
  // under them; nothing else should know the name at all.
  const LEGACY_FLAG = /\bacceptServerTargets\b/;

  const ALLOWED = ['src/common/protocol.js', 'src/background/service-worker.js'];

  const offenders = [];
  for (const file of jsFiles(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWED.includes(rel)) continue;
    stripJsComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/).forEach((line, i) => {
      if (MODE_KEY.test(line) || MODE_VALUE.test(line) ||
          MODE_READER.test(line) || LEGACY_FLAG.test(line)) {
        offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 50)}`);
      }
    });
  }
  report(offenders.length === 0,
    'the removed `mode` setting is read nowhere but the back-compat readers',
    offenders.join('; '));

  // The words themselves, in the files that put text on a screen. This is what
  // stops the vocabulary creeping back one label at a time: a 'passive' or
  // 'active' string in a page script is a mode string whatever it is doing
  // there, because the two switches have no such values to spell.
  const PAGE_SCRIPTS = ['src/popup/popup.js', 'src/options/options.js',
                        'src/activity/activity.js', 'src/content/report-ui.js',
                        'src/content/dom-blocker.js', 'src/content/main.js'];
  const said = [];
  for (const rel of PAGE_SCRIPTS) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { report(false, 'exists ' + rel); continue; }
    stripJsComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/).forEach((line, i) => {
      if (MODE_VALUE.test(line)) said.push(`${rel}:${i + 1} ${line.trim().slice(0, 50)}`);
    });
  }
  // And the controls that used to write it. The pages are built around two
  // tick boxes now; a stray radio would be a second way to set the same thing.
  for (const file of htmlPages(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/id="mode(Passive|Active)"|name="mode"/.test(line)) {
        said.push(`${rel}:${i + 1} ${line.trim().slice(0, 50)}`);
      }
    });
  }
  report(said.length === 0,
    'no page hardcodes a passive/active mode string or picker',
    said.join('; '));
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

// ---- 10. the two locales -------------------------------------------------
//
// chrome.i18n fails soft in every direction that matters here. A key present in
// en and missing from vi silently serves English to a Vietnamese reader; a key
// present in vi and missing from en is dead weight nothing can ever ask for; an
// empty message renders as the key, which is the fallback working as designed
// but not what anyone wanted to ship. None of the three is visible in a diff of
// two 250-key files, and all three are trivial to test.
{
  const LOCALES = ['en', 'vi'];
  const loaded = {};
  for (const l of LOCALES) {
    const file = path.join(ROOT, '_locales', l, 'messages.json');
    try {
      const buf = fs.readFileSync(file);
      // A BOM makes the file valid JSON to some parsers and not to Chrome's.
      report(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF),
        `_locales/${l}/messages.json is UTF-8 with no BOM`);
      loaded[l] = JSON.parse(buf.toString('utf8'));
      report(true, `_locales/${l}/messages.json parses (${Object.keys(loaded[l]).length} keys)`);
    } catch (e) {
      report(false, `_locales/${l}/messages.json parses`, e.message);
    }
  }

  const en = loaded.en, vi = loaded.vi;
  if (en && vi) {
    const missingVi = Object.keys(en).filter(k => !(k in vi));
    const missingEn = Object.keys(vi).filter(k => !(k in en));
    const shared = Object.keys(en).filter(k => k in vi).length;
    // The count is as much the point of this line as the pass is: two files
    // that agree on nothing agree perfectly, and only the number tells the
    // difference between that and 250 keys in step.
    report(missingVi.length === 0 && missingEn.length === 0,
      `every key exists in both locales (${shared})`,
      [missingVi.length ? 'absent from vi: ' + missingVi.join(', ') : '',
       missingEn.length ? 'absent from en: ' + missingEn.join(', ') : ''].filter(Boolean).join('; '));

    const empty = [], undescribed = [], mismatched = [];
    const placeholdersOf = (s) => [...String(s).matchAll(/\$(\d)/g)].map(m => m[1]).sort().join('');
    for (const l of LOCALES) {
      for (const [key, entry] of Object.entries(loaded[l])) {
        if (!entry || !String(entry.message || '').trim()) empty.push(`${l}:${key}`);
        // Not decoration. A translator seeing "failed" with no context cannot
        // tell a tile caption from a verb, and produces confident nonsense.
        if (!entry || !String(entry.description || '').trim()) undescribed.push(`${l}:${key}`);
      }
    }
    for (const key of Object.keys(en)) {
      if (!(key in vi)) continue;
      if (placeholdersOf(en[key].message) !== placeholdersOf(vi[key].message)) mismatched.push(key);
    }
    report(empty.length === 0, 'every message has text', empty.join(', '));
    report(undescribed.length === 0, 'every message has a description', undescribed.join(', '));
    // A translation that drops a $1 loses the number the sentence was about.
    report(mismatched.length === 0,
      'both locales use the same placeholders in each message', mismatched.join(', '));
  }

  // ---- 11. no orphaned keys, in either direction -------------------------
  if (en) {
    const used = new Set();
    const walkFiles = (dir, exts, acc) => {
      acc = acc || [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.')) walkFiles(f, exts, acc); }
        else if (exts.some(x => e.name.endsWith(x))) acc.push(f);
      }
      return acc;
    };
    // Every quoted string in the sources that happens to spell a key. Looser
    // than the call sites below on purpose, because plenty of keys reach CB_T
    // through a variable -- `T(listed ? 'popup_reportAgainButton' : …)` names
    // both of them and calls neither directly.
    const mentioned = new Set();
    const sources = walkFiles(path.join(ROOT, 'src'), ['.js', '.html']);
    for (const file of sources) {
      // Comments come out first. A note explaining what `popup_reportButton`
      // does is documentation, not a call, and a check that failed the build
      // over one would only get the explanation deleted.
      const text = fs.readFileSync(file, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      // CB_T('key') and the T('key') alias each page binds it to.
      for (const m of text.matchAll(/\b(?:CB_T|T)\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/data-i18n(?:-placeholder|-title|-label)?="([A-Za-z0-9_]+)"/g)) {
        used.add(m[1]);
      }
      for (const m of text.matchAll(/'([A-Za-z0-9_]+)'/g)) mentioned.add(m[1]);
    }
    for (const m of fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')
      .matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);

    const unknown = [...used].filter(k => !(k in en));
    report(unknown.length === 0,
      `every key the UI asks for exists in en (${used.size} used)`,
      unknown.join(', '));

    // Keys nothing names literally, because they are built from a value at
    // run time. Each one is a family, and the family is what has to be listed.
    const DYNAMIC = [
      /^tag_/              // 'tag_' + tag, built in protocol.js from TAGS
    ];
    const unused = Object.keys(en)
      .filter(k => !used.has(k) && !mentioned.has(k) && !DYNAMIC.some(re => re.test(k)));
    // A warning, not a failure: a key may legitimately land one commit before
    // the screen that uses it, and failing the build over that only teaches
    // people to delete strings they were about to need.
    if (unused.length) console.log(`warn  ${unused.length} key(s) in en are referenced nowhere` +
      `  — ${unused.join(', ')}`);
  }

  // ---- 12. no hardcoded UI strings left in the page markup --------------
  //
  // The pages carry data-i18n attributes and, outside them, no words at all.
  // That is the whole point: a string typed straight into the HTML looks
  // perfectly fine in English, and is simply never translated. So anything the
  // scanner finds outside a data-i18n element fails the build.
  //
  // <title> is the one place text is left in: it holds the product name, which
  // is never translated, and an empty title is what the tab shows before the
  // scripts run. It carries data-i18n like everything else, so it is exempt by
  // the same rule rather than by a special case.
  {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr']);
    // What the markup is allowed to hold on its own. Nothing in here is a word
    // in any language: em dash placeholders standing in for a value that has
    // not loaded yet, the separators between chips, and bare digits -- a
    // number reads the same in Vietnamese as in English, and failing the build
    // over one would only teach people to wrap it in a key that translates to
    // itself. The moment a letter appears the text is translatable again and
    // this stops covering it.
    const ORNAMENT = /^[\s\d—–·…×\/:,.()%+-]*$/;

    // Found rather than listed: a page added to the extension is a page that
    // has to obey this, and a list written here would simply not know about it.
    const pages = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); }
        else if (e.name.endsWith('.html')) pages.push(p);
      }
    })(path.join(ROOT, 'src'));

    for (const file of pages) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!doctype[^>]*>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ');

      const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
      const offenders = [];
      let at = 0, m, depth = 0, translatedAt = 0;
      const consider = (text) => {
        if (translatedAt || ORNAMENT.test(text)) return;
        offenders.push(text.trim().slice(0, 40));
      };
      while ((m = TAG.exec(src))) {
        consider(src.slice(at, m.index));
        at = m.index + m[0].length;
        const closing = !!m[1], name = m[2].toLowerCase();
        const selfClosing = /\/\s*$/.test(m[3]) || VOID.has(name);
        if (selfClosing) continue;
        if (closing) {
          depth--;
          if (translatedAt && depth < translatedAt) translatedAt = 0;
        } else {
          depth++;
          // An element that declares its OWN language is deliberately not in
          // the page's language and must not be translated: a language picker
          // lists each language as its own speakers write it, which is the one
          // place "English" and "Tiếng Việt" are correct in every locale.
          // `lang` is the honest marker for that rather than a bespoke opt-out
          // attribute -- it is exactly what the attribute already means, and a
          // screen reader reads it the same way.
          if (!translatedAt && (/\bdata-i18n=/.test(m[3]) || /\slang="/.test(m[3]))) {
            translatedAt = depth;
          }
        }
      }
      consider(src.slice(at));

      // Text in an attribute is still text: a tooltip, the grey prompt in an
      // empty box, the words a screen reader says instead of an icon. The
      // pages carry data-i18n-title, data-i18n-placeholder and data-i18n-label
      // for exactly those, so a literal one is a string that can never be
      // translated -- and it hides better than a bare text node does, because
      // it looks perfectly right in English and never appears in a screenshot.
      //
      // The leading space is what keeps data-i18n-title="..." out of this: the
      // character before that `title` is a hyphen, not whitespace.
      for (const m of src.matchAll(/\s(title|placeholder|alt|aria-label)="([^"]*)"/g)) {
        if (ORNAMENT.test(m[2])) continue;
        offenders.push(m[1] + '=' + m[2].slice(0, 30));
      }

      report(offenders.length === 0,
        rel + ' has no user-visible text outside data-i18n',
        offenders.join(' | '));
    }
  }
}

// ---- 13. the hosted pages' own dictionary -------------------------------
//
// chrome.i18n does not exist outside an extension, so hosting/i18n.js is the
// same job done a second time -- and it fails in the same directions as
// _locales does, with no store review and no manifest to catch any of them. It
// is held to the same rules here, by loading the module and asking it what it
// holds rather than by listing what it ought to hold: a check that repeats the
// dictionary is a second copy of the dictionary, and drifts like one.
//
// The module is a classic script that assigns onto globalThis and never
// touches a DOM, which is exactly why Node can load the browser's file.
{
  try {
    require(path.join(ROOT, 'hosting', 'i18n.js'));
    const I18N = globalThis.CB_I18N;
    const T = globalThis.CB_T;
    if (!I18N || !T) throw new Error('CB_I18N / CB_T were not defined');
    if (!I18N.use('public')) throw new Error('no "public" surface in the dictionary');

    const codes = I18N.locales().map(l => l.code);
    const held = {};
    for (const code of codes) held[code] = I18N.keys(code);
    const every = [...new Set([].concat(...codes.map(c => held[c])))];

    const gaps = [];
    for (const code of codes) {
      for (const key of every) if (!held[code].includes(key)) gaps.push(code + ':' + key);
    }
    report(gaps.length === 0,
      `hosting/i18n.js: every key exists in every language (${every.length} x ${codes.length})`,
      gaps.join(', '));

    const empty = [], drift = [];
    const marks = (v) => [...String(v).matchAll(/\$(\d)/g)].map(m => m[1]).sort().join('');
    const first = {};
    for (const code of codes) {
      I18N.setLang(code);
      for (const key of held[code]) {
        const text = T(key);
        if (!String(text).trim()) empty.push(code + ':' + key);
        // A translation that drops a $1 loses the number the sentence was
        // about, and reads perfectly well while doing it.
        if (first[key] === undefined) first[key] = marks(text);
        else if (first[key] !== marks(text)) drift.push(key);
      }
    }
    report(empty.length === 0, 'hosting/i18n.js: every string has text', empty.join(', '));
    report(drift.length === 0,
      'hosting/i18n.js: every language keeps the same $1 placeholders',
      [...new Set(drift)].join(', '));

    // And the orphan question, asked of the page that reads this dictionary.
    const page = fs.readFileSync(path.join(ROOT, 'hosting', 'public.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const used = new Set();
    for (const m of page.matchAll(/\bCB_T\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
    const unknown = [...used].filter(k => !every.includes(k));
    report(unknown.length === 0,
      `hosting/i18n.js: every key the public page asks for exists (${used.size} used)`,
      unknown.join(', '));

    // Keys the page never names literally, because they are not looked up by
    // name: tag_* is built from the tag on a record, and `lang` is each
    // language's own name, which the module reads itself to label the toggle.
    const DYNAMIC = [/^tag_/, /^lang$/];
    const mentioned = new Set([...page.matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]));
    const unused = every.filter(k =>
      !used.has(k) && !mentioned.has(k) && !DYNAMIC.some(re => re.test(k)));
    if (unused.length) console.log(`warn  ${unused.length} key(s) in hosting/i18n.js are ` +
      `referenced nowhere  — ${unused.join(', ')}`);
  } catch (e) {
    report(false, 'hosting/i18n.js loads and agrees with itself', e.message);
  }
}

console.log('\n' + (failures ? `${failures} problem(s)` : 'all checks passed'));
process.exitCode = failures ? 1 : 0;
