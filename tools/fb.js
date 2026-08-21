// The standalone Firebase CLI installs itself as a Node script under
// ~/.cache/firebase/tools/bin, which is never on PATH -- so `npm run
// emulators` would break on exactly the machines the installer targets.
// Prefer that copy (run through the Node already executing us), else fall
// back to a PATH-installed `firebase` (shell:true so Windows finds the .cmd).
const path = require('path');
const cached = path.join(require('os').homedir(), '.cache', 'firebase', 'tools', 'bin', 'firebase');
const args = process.argv.slice(2);
const { javaEnv } = require('./java-env.js');
const env = javaEnv();
const r = require('fs').existsSync(cached)
  ? require('child_process').spawnSync(process.execPath, [cached, ...args], { stdio: 'inherit', env })
  : require('child_process').spawnSync('firebase', args, { stdio: 'inherit', shell: true, env });
process.exit(r.status == null ? 1 : r.status);
