/**
 * An environment whose `java` is at least JDK 21, which firebase-tools now
 * requires for its emulators.
 *
 * The machine's PATH java may be older (Temurin 17 here). Rather than ask the
 * user to juggle JAVA_HOME, look through the usual Windows install roots for
 * any modern JDK and prepend its bin to PATH for the child process only.
 * Shared by every tool that spawns an emulator -- it lived inline in
 * e2e-test.js first, and the copies drifted within a day of existing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function major(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  const m = /version "(\d+)/.exec((r.stdout || '') + (r.stderr || ''));
  return m ? parseInt(m[1], 10) : 0;
}

function javaEnv() {
  if (major('java') >= 21) return process.env;
  const roots = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    // Android Studio bundles a modern JBR; it is a real JDK.
    'C:\\Program Files\\Android\\Android Studio'
  ];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (e) { continue; }
    // Newest name first, so jdk-25 beats jdk-21 when both are present.
    for (const name of entries.sort().reverse()) {
      for (const sub of [path.join(root, name, 'bin'), path.join(root, name, 'jbr', 'bin')]) {
        if (fs.existsSync(path.join(sub, 'java.exe')) && major(path.join(sub, 'java.exe')) >= 21) {
          return Object.assign({}, process.env, { PATH: sub + path.delimiter + process.env.PATH });
        }
      }
    }
    // The root itself may be the install (Android Studio/jbr/bin).
    const direct = path.join(root, 'jbr', 'bin');
    if (fs.existsSync(path.join(direct, 'java.exe')) && major(path.join(direct, 'java.exe')) >= 21) {
      return Object.assign({}, process.env, { PATH: direct + path.delimiter + process.env.PATH });
    }
  }
  return process.env; // let the CLI print its own diagnosis
}

module.exports = { javaEnv };
