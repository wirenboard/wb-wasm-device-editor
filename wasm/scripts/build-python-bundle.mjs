#!/usr/bin/env node
/**
 * Pack the Python that runs inside Pyodide into two tarballs.
 *
 *   .python-bundle/wbdali-py.tar.gz     unpacked into site-packages
 *   .python-bundle/wbdali-data.tar.gz   unpacked into /usr/share
 *
 * Input is `wasm/python/`: `vendor/` (verbatim upstream sources, produced by
 * scripts/fetch-python-sources.sh), `runtime/` and `shims/`. The only thing this
 * script fetches is the jsonschema stack, which the daemon needs to validate
 * device parameters and which is not pure Python — `rpds-py` is a Rust
 * extension, so the wheels have to be the ones Pyodide itself was built
 * against. Taking them from the installed pyodide's own lock file is what keeps
 * the ABI matched; they are cached, so a rebuild is offline.
 *
 * Run before vite (see the `prebuild` / `predev` scripts in package.json).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.resolve(HERE, '..');
const PYTHON = path.join(WASM, 'python');
const VENDOR = path.join(PYTHON, 'vendor');
const CACHE = path.join(WASM, '.python-cache');
const WHEELS = path.join(CACHE, 'wheels');
const STAGE = path.join(CACHE, 'stage');
const OUT = path.join(WASM, '.python-bundle');

// jsonschema's lock entry also lists pyrsistent and six; jsonschema 4.x does not
// import either at runtime.
const WHEEL_PACKAGES = [
  'jsonschema',
  'attrs',
  'referencing',
  'rpds-py',
  'jsonschema-specifications',
  'typing-extensions',
];

const TAR_FLAGS = ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner'];

function fail(message) {
  console.error(`[python-bundle] ${message}`);
  process.exit(2);
}

function copyTree(source, target, skip = () => false) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source).sort()) {
      if (skip(path.join(source, entry), entry)) continue;
      copyTree(path.join(source, entry), path.join(target, entry), skip);
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

const skipJunk = (_p, name) => name === '__pycache__' || name.endsWith('.pyc');

async function fetchWheels() {
  const pyodideDir = path.join(WASM, 'node_modules/pyodide');
  if (!fs.existsSync(pyodideDir)) {
    fail('the pyodide package is not installed; run npm install');
  }
  const version = JSON.parse(fs.readFileSync(path.join(pyodideDir, 'package.json'), 'utf8')).version;
  const lock = JSON.parse(fs.readFileSync(path.join(pyodideDir, 'pyodide-lock.json'), 'utf8'));
  const cdn = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

  fs.mkdirSync(WHEELS, { recursive: true });
  const files = [];
  for (const name of WHEEL_PACKAGES) {
    const pkg = lock.packages[name];
    if (!pkg) fail(`${name} is not in pyodide-lock.json (pyodide ${version})`);
    const dest = path.join(WHEELS, pkg.file_name);
    files.push(dest);
    if (!fs.existsSync(dest)) {
      const response = await fetch(cdn + pkg.file_name);
      if (!response.ok) fail(`${cdn}${pkg.file_name} -> HTTP ${response.status}`);
      fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
      console.log(`[python-bundle] fetched ${pkg.file_name}`);
    }
    // The lock file pins each wheel's sha256 and Pyodide's own loader checks
    // it; bytes going into the shipped bundle deserve the same scrutiny —
    // fresh from the CDN and cache hits alike.
    const digest = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (pkg.sha256 && digest !== pkg.sha256) {
      fail(`${pkg.file_name}: sha256 mismatch (expected ${pkg.sha256}, got ${digest}) — delete .python-cache/wheels and retry`);
    }
  }
  return files;
}

async function main() {
  // `python/vendor` is gitignored, so it is absent on a fresh checkout and in
  // CI, and stale on a reused workspace once the branches it tracks move.
  // The fetch script compares its stamp with the branch tips and returns at
  // once when nothing changed, so `npm run build` stays self-contained.
  execFileSync('bash', [path.join(WASM, '../scripts/fetch-python-sources.sh'), VENDOR], {
    cwd: path.join(WASM, '..'),
    stdio: 'inherit',
  });

  const wheels = await fetchWheels();

  const site = path.join(STAGE, 'site-packages');
  const data = path.join(STAGE, 'data');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(path.join(data, 'wb-mqtt-dali'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const wheel of wheels) {
    execFileSync('unzip', ['-qo', wheel, '-d', site]);
  }

  // `wb` is a PEP 420 namespace package, so there is no wb/__init__.py to copy.
  copyTree(path.join(VENDOR, 'wb'), path.join(site, 'wb'), skipJunk);
  copyTree(path.join(VENDOR, 'mqttrpc'), path.join(site, 'mqttrpc'), (p, name) =>
    // client.py is the only file that pulls in paho's network client and threads.
    skipJunk(p, name) || name === 'client.py');
  copyTree(path.join(VENDOR, 'jsonrpc'), path.join(site, 'jsonrpc'), (p, name) =>
    skipJunk(p, name) || name === 'tests' || name === 'backend');
  copyTree(path.join(VENDOR, 'paho'), path.join(site, 'paho'), skipJunk);
  copyTree(path.join(VENDOR, 'dali'), path.join(site, 'dali'), (p, name) => {
    if (skipJunk(p, name)) return true;
    const rel = path.relative(path.join(VENDOR, 'dali'), p);
    // dali/tests/fakes.py is the control gear model the bus simulator drives, so
    // the package stays — but not its pytest suites, and not fakes_serial.py,
    // which imports the serial driver that was stripped from the vendored copy.
    return rel.startsWith('tests') && (name.startsWith('test_') || name === 'fakes_serial.py');
  });

  copyTree(path.join(PYTHON, 'shims'), site, skipJunk);
  copyTree(path.join(PYTHON, 'runtime'), site, skipJunk);

  copyTree(path.join(VENDOR, 'schemas'), path.join(data, 'wb-mqtt-dali/schemas'), skipJunk);
  fs.copyFileSync(path.join(VENDOR, 'products.csv'), path.join(data, 'wb-mqtt-dali/products.csv'));

  execFileSync('tar', [...TAR_FLAGS, '-czf', path.join(OUT, 'wbdali-py.tar.gz'), '-C', site, '.']);
  execFileSync('tar', [...TAR_FLAGS, '-czf', path.join(OUT, 'wbdali-data.tar.gz'), '-C', data, '.']);

  for (const name of ['wbdali-py.tar.gz', 'wbdali-data.tar.gz']) {
    const size = fs.statSync(path.join(OUT, name)).size;
    console.log(`[python-bundle] ${name} ${(size / 1024).toFixed(1)} KiB`);
  }
}

await main();
