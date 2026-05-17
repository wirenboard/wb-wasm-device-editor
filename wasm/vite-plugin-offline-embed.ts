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
// Also embeds release-versions.yaml + every stable .wbfw/.compfw blob, and
// wraps Module.httpGetText/httpGetBinary so firmware update works offline.

const METRIKA_RE = /<!-- Yandex\.Metrika counter -->[\s\S]*?<!-- \/Yandex\.Metrika counter -->\s*/;

// Shared between the runtime loader template and the emit step — keep in sync.
const BLOB_ID = {
  wasm: 'offline-wasm-gz',
  data: 'offline-data-gz',
  moduleJs: 'offline-module-js-gz',
  firmware: 'offline-firmware',
} as const;

const FW_BASE_URL = 'https://fw-releases.wirenboard.com/';
const FW_RELEASE_YAML_PATH = 'fw/by-signature/release-versions.yaml';
const FIRMWARE_CACHE_DIR = path.resolve(__dirname, '.firmware-cache');
const FW_BLOB_RE = /\.(wbfw|compfw)$/;

// Files we've already embedded inline (gzipped blobs, <style>, or <script>).
// The sibling-asset walker skips these so it doesn't waste I/O re-encoding
// 14MB of module.data/wasm just to drop the result.
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

// Pool-based concurrency: keep at most `limit` fetches in flight to avoid
// blasting the firmware server with 160 simultaneous requests.
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

// Downloads release-versions.yaml + every stable .wbfw / .compfw it points to
// (cached on disk under .firmware-cache/). Returns the data ready to embed.
async function buildFirmwareBundle(): Promise<{ yaml: string; blobs: Record<string, string> }> {
  const yamlBuf = await fetchCached(FW_RELEASE_YAML_PATH);
  const yaml = yamlBuf.toString('utf8');

  // Match every line at exactly 4 spaces of indent under a signature block:
  // "    stable: fw/by-signature/<sig>/main/<version>.wbfw"
  const paths = new Set<string>();
  for (const m of yaml.matchAll(/^ {4}stable:\s*(\S+)\s*$/gm)) {
    const p = m[1];
    if (FW_BLOB_RE.test(p)) paths.add(p);
  }
  const sorted = Array.from(paths).sort();

  console.log(`[offline-embed] firmware: fetching ${sorted.length} blobs (cache: ${FIRMWARE_CACHE_DIR})`);
  const start = Date.now();
  const datas = await mapWithConcurrency(sorted, 8, fetchCached);
  const blobs: Record<string, string> = {};
  let raw = 0;
  for (let i = 0; i < sorted.length; i++) {
    blobs[sorted[i]] = datas[i].toString('base64');
    raw += datas[i].length;
  }
  console.log(
    `[offline-embed] firmware: ${sorted.length} blobs, ${(raw / 1024 / 1024).toFixed(2)} MB raw, fetched in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
  return { yaml, blobs };
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
  function patchFirmwareEndpoints(M) {
    const node = $(${JSON.stringify(BLOB_ID.firmware)});
    if (!node) return;
    const fw = JSON.parse(node.textContent);
    const FW_BASE = ${JSON.stringify(FW_BASE_URL)};
    const YAML_URL = FW_BASE + ${JSON.stringify(FW_RELEASE_YAML_PATH)};
    const origText = M.httpGetText.bind(M);
    const origBin = M.httpGetBinary.bind(M);
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
    M.httpGetText = async function(url) {
      if (url === YAML_URL) return textPtr(fw.yaml);
      return origText(url);
    };
    M.httpGetBinary = async function(url) {
      if (url.startsWith(FW_BASE)) {
        const b64 = fw.blobs[url.slice(FW_BASE.length)];
        if (b64) return binPtr(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      }
      return origBin(url);
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
