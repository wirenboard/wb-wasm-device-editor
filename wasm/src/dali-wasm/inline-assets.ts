/**
 * Reads the byte assets the offline build inlined into the page.
 *
 * `vite-plugin-offline-embed` writes each one into a
 * `<script type="application/gzip+base64">` block; this is the reader for the
 * DALI runtime's share of them. Returns null in the normal build, where the
 * assets are ordinary hashed files fetched over HTTP.
 */

export interface InlineAsset {
  b64: string;
  gzip: boolean;
}

/** Blob element ids, kept in step with vite-plugin-offline-embed.ts. */
const INLINE_ASSET_IDS: Record<string, { id: string; gzip: boolean }> = {
  'pyodide.asm.wasm': { id: 'offline-pyodide-wasm-gz', gzip: true },
  'python_stdlib.zip': { id: 'offline-pyodide-stdlib', gzip: false },
  'pyodide-lock.json': { id: 'offline-pyodide-lock-gz', gzip: true },
  'wbdali-py.tar.gz': { id: 'offline-wbdali-py', gzip: false },
  'wbdali-data.tar.gz': { id: 'offline-wbdali-data', gzip: false },
};

export function readInlineAssets(): Record<string, InlineAsset> | null {
  const assets: Record<string, InlineAsset> = {};
  for (const [name, { id, gzip }] of Object.entries(INLINE_ASSET_IDS)) {
    const element = document.getElementById(id);
    if (!element?.textContent) {
      return null;
    }
    assets[name] = { b64: element.textContent.trim(), gzip };
  }
  return assets;
}
