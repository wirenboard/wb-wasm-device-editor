import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { Plugin } from 'vite';

// Inlines public/ assets (module.wasm, module.data, module.js, script.js,
// serial.js, common.css, favicon, apple-touch-icon, in-app logo) into the
// single dist-offline/index.html that vite-plugin-singlefile produced. Big
// binary blobs are gzipped and stored as base64 inside <script
// type="application/gzip+base64"> blocks; a tiny inline loader decompresses
// them via DecompressionStream and wires them into Emscripten before
// running module.js.
//
// Also embeds the stable firmware + bootloader catalog from
// fw-releases.wirenboard.com (release-versions.yaml, every stable
// .wbfw/.compfw, plus every bootloader latest.txt + .wbfw). Module.httpGetText
// and Module.httpGetBinary are wrapped with a network-first/embed-fallback
// policy: fetch from the network with a short timeout, fall back to the
// embedded copy if the fetch fails (offline / no DNS / non-2xx).

const METRIKA_RE = /<!-- Yandex\.Metrika counter -->[\s\S]*?<!-- \/Yandex\.Metrika counter -->\s*/;

// Shared between the runtime loader template and the emit step — keep in sync.
const BLOB_ID = {
  wasm: 'offline-wasm-gz',
  data: 'offline-data-gz',
  moduleJs: 'offline-module-js-gz',
  firmware: 'offline-firmware',
} as const;

// The DALI runtime's byte assets: a Python interpreter, its stdlib and the
// wb-mqtt-dali bundle. Read back by src/dali-wasm/inline-assets.ts — keep the
// ids and the gzip flags in step with it. The two `.tar.gz` payloads and the
// stdlib `.zip` are already compressed, so they go in as plain base64.
const DALI_BLOBS = [
  { id: 'offline-pyodide-wasm-gz', file: 'node_modules/pyodide/pyodide.asm.wasm', gzip: true },
  { id: 'offline-pyodide-stdlib', file: 'node_modules/pyodide/python_stdlib.zip', gzip: false },
  { id: 'offline-pyodide-lock-gz', file: 'node_modules/pyodide/pyodide-lock.json', gzip: true },
  { id: 'offline-wbdali-py', file: '.python-bundle/wbdali-py.tar.gz', gzip: false },
  { id: 'offline-wbdali-data', file: '.python-bundle/wbdali-data.tar.gz', gzip: false },
] as const;

const FW_BASE_URL = 'https://fw-releases.wirenboard.com/';
const BUCKET_LIST_URL = 'https://fw-releases.wirenboard.com/__s3_bucket_list';
const FW_RELEASE_YAML_PATH = 'fw/by-signature/release-versions.yaml';
const FIRMWARE_CACHE_DIR = path.resolve(__dirname, '.firmware-cache');
const FW_BLOB_RE = /\.(wbfw|compfw)$/;
const BOOTLOADER_LATEST_TXT_RE = /^bootloader\/by-signature\/[^/]+\/main\/latest\.txt$/;

const ALREADY_EMBEDDED = new Set([
  'module.wasm', 'module.data', 'module.js',
  'script.js', 'serial.js',
  'common.css', 'manifest.json', 'sw.js',
]);

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

function sanitizeScriptText(text: string): string {
  return text.replace(/<\/script/gi, '<\\/script');
}

function readGzipBase64(file: string): string {
  return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).toString('base64');
}

function readBase64(file: string): string {
  return fs.readFileSync(file).toString('base64');
}

function daliRuntimeBlobs(): string[] {
  return DALI_BLOBS.map(({ id, file, gzip }) => {
    const absolute = path.resolve(__dirname, file);
    if (!fs.existsSync(absolute)) {
      throw new Error(
        `[offline-embed] ${file} is missing; run "npm run build:python" before the offline build`,
      );
    }
    const body = gzip ? readGzipBase64(absolute) : readBase64(absolute);
    return `<script type="application/gzip+base64" id="${id}">${body}</script>`;
  });
}

async function fetchCached(relPath: string): Promise<Buffer> {
  const cached = path.join(FIRMWARE_CACHE_DIR, relPath);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  const res = await fetch(FW_BASE_URL + relPath);
  if (!res.ok) throw new Error(`fetch ${relPath} → HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, data);
  return data;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// S3 v1 list-objects paginated by Marker. Yields every key under prefix.
async function* listBucket(prefix: string): AsyncGenerator<{ key: string; size: number }> {
  let marker = '';
  while (true) {
    const q = new URLSearchParams({ prefix, marker, 'max-keys': '1000' });
    const res = await fetch(`${BUCKET_LIST_URL}?${q}`);
    if (!res.ok) throw new Error(`bucket list ${prefix} → HTTP ${res.status}`);
    const xml = await res.text();
    // Tiny XML extraction — keys/sizes are simple text-only tags.
    const entries = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)];
    if (!entries.length) return;
    for (const m of entries) yield { key: m[1], size: parseInt(m[2], 10) };
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!truncated) return;
    marker = entries[entries.length - 1][1];
  }
}

interface FirmwareEmbed {
  texts: Record<string, string>;
  blobs: Record<string, string>;
}

async function buildFirmwareBundle(): Promise<FirmwareEmbed> {
  const texts: Record<string, string> = {};
  const blobs: Record<string, string> = {};

  // 1. Stable user firmware: release-versions.yaml + each "stable: <path>" blob.
  const yamlBuf = await fetchCached(FW_RELEASE_YAML_PATH);
  const yaml = yamlBuf.toString('utf8');
  texts[FW_RELEASE_YAML_PATH] = yaml;

  // Embed both stable and testing release channels — they often point to the
  // same blob (deduped by the Set) but testing occasionally has a newer build.
  const releasePaths = new Set<string>();
  for (const m of yaml.matchAll(/^ {4}(?:stable|testing):\s*(\S+)\s*$/gm)) {
    if (FW_BLOB_RE.test(m[1])) releasePaths.add(m[1]);
  }
  const stableList = Array.from(releasePaths).sort();

  // 2. Bootloaders: enumerate signatures via S3 listing → fetch latest.txt +
  //    latest.wbfw for each. The downloader requests <version>.wbfw, where
  //    <version> is the content of latest.txt, so we store the wbfw under
  //    that versioned URL key (latest.wbfw and <version>.wbfw share content).
  // The S3 listing is the one fetch the blob cache cannot answer — cache the
  // list of signatures itself, so a network flap degrades to yesterday's
  // catalog instead of failing the whole build.
  const sigsCachePath = path.join(FIRMWARE_CACHE_DIR, 'bootloader-signatures.json');
  let bootloaderSigs: string[] = [];
  try {
    for await (const { key } of listBucket('bootloader/by-signature/')) {
      if (BOOTLOADER_LATEST_TXT_RE.test(key)) {
        bootloaderSigs.push(key.split('/')[2]);
      }
    }
    fs.mkdirSync(FIRMWARE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(sigsCachePath, JSON.stringify(bootloaderSigs));
  } catch (error) {
    // Only fall back when a cached listing exists — a missing cache would
    // otherwise surface as ENOENT and bury the actual network failure.
    if (!fs.existsSync(sigsCachePath)) {
      throw error;
    }
    bootloaderSigs = JSON.parse(fs.readFileSync(sigsCachePath, 'utf8'));
    console.log(`[offline-embed] firmware: bucket listing unreachable, using cached list of ${bootloaderSigs.length} signatures`);
  }

  console.log(`[offline-embed] firmware: ${stableList.length} stable blobs + ${bootloaderSigs.length} bootloaders to fetch (cache: ${FIRMWARE_CACHE_DIR})`);
  const start = Date.now();

  const stableData = await mapWithConcurrency(stableList, 8, fetchCached);
  let raw = 0;
  for (let i = 0; i < stableList.length; i++) {
    blobs[stableList[i]] = stableData[i].toString('base64');
    raw += stableData[i].length;
  }

  let bootloaderSkipped = 0;
  await mapWithConcurrency(bootloaderSigs, 8, async (sig) => {
    const txtPath = `bootloader/by-signature/${sig}/main/latest.txt`;
    const wbfwPath = `bootloader/by-signature/${sig}/main/latest.wbfw`;
    let txtBuf: Buffer;
    let wbfwBuf: Buffer;
    try {
      [txtBuf, wbfwBuf] = await Promise.all([fetchCached(txtPath), fetchCached(wbfwPath)]);
    } catch (e) {
      // Some signatures (e.g. mge_v3) ship .bin bootloaders only — skip those.
      bootloaderSkipped++;
      return;
    }
    const version = txtBuf.toString('utf8').trim();
    texts[txtPath] = version;
    // The downloader requests this exact versioned URL:
    blobs[`bootloader/by-signature/${sig}/main/${version}.wbfw`] = wbfwBuf.toString('base64');
    raw += wbfwBuf.length + txtBuf.length;
  });
  if (bootloaderSkipped > 0) {
    console.log(`[offline-embed] firmware: skipped ${bootloaderSkipped} bootloader(s) with no .wbfw`);
  }

  console.log(
    `[offline-embed] firmware: ${stableList.length + bootloaderSigs.length} blobs, ${(raw / 1024 / 1024).toFixed(2)} MB raw, fetched in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
  return { texts, blobs };
}

// Two-phase loader. First runs synchronously during HTML parsing, before the
// deferred React entry — kicks off async decompression and exposes
// window.__OFFLINE_READY__, a Promise. The async body, after decompression,
// applies the bytes onto window.Module (already populated by inline serial.js
// + script.js) and finally injects module.js to boot Emscripten.
const LOADER_SOURCE = `
(() => {
  const $ = (id) => document.getElementById(id);
  function gzipBase64ToBytes(id) {
    return Uint8Array.from(atob($(id).textContent.trim()), (c) => c.charCodeAt(0));
  }
  async function decompress(gz) {
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  }
  function fail(msg) {
    console.error('[offline] ' + msg);
    document.body.innerHTML =
      '<div style="font-family:sans-serif;padding:2em;max-width:40em;margin:auto">' +
      '<h2>Failed to load offline bundle</h2><p>' + msg + '</p></div>';
  }
  async function fetchWithTimeout(url, timeoutMs, init) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...(init || {}), signal: ctrl.signal });
        return res.ok ? res : null;
      } finally {
        clearTimeout(t);
      }
    } catch (_) {
      return null;
    }
  }
  function patchFirmwareEndpoints(M) {
    const node = $(${JSON.stringify(BLOB_ID.firmware)});
    if (!node) return;
    const fw = JSON.parse(node.textContent);
    const FW_BASE = ${JSON.stringify(FW_BASE_URL)};
    const YAML_URL = FW_BASE + ${JSON.stringify(FW_RELEASE_YAML_PATH)};
    // One-shot online probe (HEAD on the manifest YAML, 2s timeout) cached
    // for the session so we don't burn a 3s/15s timeout on every firmware
    // fetch when opened on a fully offline machine. Mirrors the sw-ping
    // pattern in sw.js, but service workers don't run from file://.
    let onlinePromise = null;
    function probeOnline() {
      if (!onlinePromise) {
        onlinePromise = fetchWithTimeout(YAML_URL, 2000, { method: 'HEAD' }).then((r) => !!r);
      }
      return onlinePromise;
    }
    async function tryFetch(url, timeoutMs) {
      if (!(await probeOnline())) return null;
      return fetchWithTimeout(url, timeoutMs);
    }
    // Kick off the probe so the banner state is known early; once resolved,
    // expose result on window and notify React via a custom event.
    probeOnline().then((online) => {
      window.__WB_FW_OFFLINE__ = !online;
      window.dispatchEvent(new CustomEvent('wb-fw-mode-changed', { detail: { offline: !online } }));
    });
    function textPtr(s) {
      const bytes = new TextEncoder().encode(s);
      const ptr = M._malloc(bytes.length + 1);
      M.HEAPU8.set(bytes, ptr);
      M.HEAPU8[ptr + bytes.length] = 0;
      return ptr;
    }
    function binPtr(bin) {
      const ptr = M._malloc(4 + bin.length);
      M.HEAP32[ptr >> 2] = bin.length;
      M.HEAPU8.set(bin, ptr + 4);
      return ptr;
    }
    function embedKey(url) {
      return url.startsWith(FW_BASE) ? url.slice(FW_BASE.length) : null;
    }
    M.httpGetText = async function(url) {
      const res = await tryFetch(url, 3000);
      if (res) return textPtr(await res.text());
      const key = embedKey(url);
      if (key !== null && key in fw.texts) {
        M.print('[offline] using embedded ' + key);
        return textPtr(fw.texts[key]);
      }
      M.print('[offline] no embedded fallback for ' + url);
      return 0;
    };
    M.httpGetBinary = async function(url) {
      const res = await tryFetch(url, 15000);
      if (res) {
        const bin = new Uint8Array(await res.arrayBuffer());
        return binPtr(bin);
      }
      const key = embedKey(url);
      if (key !== null && fw.blobs[key]) {
        M.print('[offline] using embedded ' + key);
        return binPtr(Uint8Array.from(atob(fw.blobs[key]), (c) => c.charCodeAt(0)));
      }
      M.print('[offline] no embedded fallback for ' + url);
      return 0;
    };
  }
  window.__WB_OFFLINE__ = true;
  if (typeof DecompressionStream === 'undefined') {
    fail('Your browser does not support DecompressionStream. Use Chrome 80+, Edge 80+, Firefox 113+, or Safari 16.4+.');
    return;
  }
  window.__OFFLINE_READY__ = (async () => {
    const [wasmBuf, dataBuf, moduleJsBuf] = await Promise.all([
      decompress(gzipBase64ToBytes(${JSON.stringify(BLOB_ID.wasm)})),
      decompress(gzipBase64ToBytes(${JSON.stringify(BLOB_ID.data)})),
      decompress(gzipBase64ToBytes(${JSON.stringify(BLOB_ID.moduleJs)})),
    ]);
    const M = window.Module;
    M.wasmBinary = new Uint8Array(wasmBuf);
    M.getPreloadedPackage = () => dataBuf;
    M.locateFile = (p) => p;
    M.instantiateWasm = (imports, cb) => {
      WebAssembly.instantiate(M.wasmBinary, imports).then((r) => cb(r.instance, r.module));
      return {};
    };
    patchFirmwareEndpoints(M);
    const s = document.createElement('script');
    s.textContent = new TextDecoder().decode(moduleJsBuf);
    document.head.appendChild(s);
  })().catch((e) => fail(String(e && e.message || e)));
})();
`;

export function offlineEmbedPlugin(): Plugin {
  return {
    name: 'offline-embed',
    apply: 'build',
    enforce: 'post',
    // Strip Yandex.Metrika from the input HTML before Vite's parse5 sees it:
    // the <noscript><img> inside <head> triggers a
    // "disallowed-content-in-noscript-in-head" error that aborts HTML emission.
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace(METRIKA_RE, ''),
    },
    async closeBundle() {
      const outDir = path.resolve(__dirname, 'dist-offline');
      const htmlPath = path.join(outDir, 'index.html');
      const publicDir = path.resolve(__dirname, 'public');

      let html = fs.readFileSync(htmlPath, 'utf8');

      // common.css → inline <style> (saves a base64 decode at load time).
      // Vite rewrites href="/common.css" to "./common.css" in the output —
      // match both.
      const commonCss = fs.readFileSync(path.join(publicDir, 'common.css'), 'utf8');
      html = html.replace(
        /<link[^>]*href=["']\.?\/common\.css["'][^>]*>/,
        `<style>${commonCss}</style>`,
      );

      // No PWA on file:// — drop the manifest link entirely.
      html = html.replace(/<link[^>]*rel=["']manifest["'][^>]*>\s*/i, '');

      const scriptJs = sanitizeScriptText(
        fs.readFileSync(path.join(publicDir, 'script.js'), 'utf8'),
      );
      const serialJs = sanitizeScriptText(
        fs.readFileSync(path.join(publicDir, 'serial.js'), 'utf8'),
      );

      // serial.js + script.js run synchronously during HTML parse, BEFORE
      // the deferred React module script — React's components call
      // Module.onLoadingProgress on mount, and that method comes from script.js.
      const earlyScripts = `<script>${serialJs}</script>\n<script>${scriptJs}</script>`;
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n${earlyScripts}`);

      const firmware = await buildFirmwareBundle();
      const firmwareJson = sanitizeScriptText(JSON.stringify(firmware));

      const blobs = [
        `<script type="application/gzip+base64" id="${BLOB_ID.wasm}">${readGzipBase64(path.join(publicDir, 'module.wasm'))}</script>`,
        `<script type="application/gzip+base64" id="${BLOB_ID.data}">${readGzipBase64(path.join(publicDir, 'module.data'))}</script>`,
        `<script type="application/gzip+base64" id="${BLOB_ID.moduleJs}">${readGzipBase64(path.join(publicDir, 'module.js'))}</script>`,
        `<script type="application/json" id="${BLOB_ID.firmware}">${firmwareJson}</script>`,
        ...daliRuntimeBlobs(),
        `<script>${LOADER_SOURCE}</script>`,
      ].join('\n');
      html = html.includes('</body>')
        ? html.replace('</body>', `${blobs}\n</body>`)
        : html + blobs;

      // Strip the dev inject-scripts <script src> tags (defensive — they're
      // only injected when OFFLINE is unset, but the regex is cheap).
      html = html.replace(/<script[^>]+src=["']\/(?:serial|script|module)\.js["'][^>]*>\s*<\/script>\s*/g, '');

      // Inline sibling assets vite-plugin-singlefile didn't catch — e.g. fonts
      // referenced via url() with a fragment (.svg#glyphicons) it skips, plus
      // public/ files Vite copied verbatim (favicon, apple-touch-icon, in-app
      // logo). Match the full relative path: matching just "/logo-wide.svg"
      // also matches the suffix of "/img/logo-wide.svg" and would leave a
      // stray "/img" prefix.
      const walk = (dir: string, prefix = ''): string[] => {
        const out: string[] = [];
        for (const e of fs.readdirSync(dir)) {
          if (e === 'index.html' && !prefix) continue;
          const full = path.join(dir, e);
          const rel = prefix ? `${prefix}/${e}` : e;
          if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
          else out.push(rel);
        }
        return out;
      };
      for (const rel of walk(outDir)) {
        if (ALREADY_EMBEDDED.has(path.basename(rel))) continue;
        if (!html.includes(`./${rel}`) && !html.includes(`/${rel}`)) continue;
        const ext = path.extname(rel).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        const dataUri = `data:${mime};base64,${fs.readFileSync(path.join(outDir, rel)).toString('base64')}`;
        html = html
          .split(`./${rel}`).join(dataUri)
          .split(`/${rel}`).join(dataUri);
      }

      fs.writeFileSync(htmlPath, html);

      for (const entry of fs.readdirSync(outDir)) {
        if (entry === 'index.html') continue;
        fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
      }

      const finalSize = fs.statSync(htmlPath).size;
      console.log(`[offline-embed] ${htmlPath} → ${(finalSize / 1024 / 1024).toFixed(2)} MB`);
    },
  };
}
