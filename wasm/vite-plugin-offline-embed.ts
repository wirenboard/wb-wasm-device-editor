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

const METRIKA_RE = /<!-- Yandex\.Metrika counter -->[\s\S]*?<!-- \/Yandex\.Metrika counter -->\s*/;

// Shared between the runtime loader template and the emit step — keep in sync.
const BLOB_ID = {
  wasm: 'offline-wasm-gz',
  data: 'offline-data-gz',
  moduleJs: 'offline-module-js-gz',
} as const;

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
    closeBundle() {
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

      const blobs = [
        `<script type="application/gzip+base64" id="${BLOB_ID.wasm}">${readGzipBase64(path.join(publicDir, 'module.wasm'))}</script>`,
        `<script type="application/gzip+base64" id="${BLOB_ID.data}">${readGzipBase64(path.join(publicDir, 'module.data'))}</script>`,
        `<script type="application/gzip+base64" id="${BLOB_ID.moduleJs}">${readGzipBase64(path.join(publicDir, 'module.js'))}</script>`,
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
