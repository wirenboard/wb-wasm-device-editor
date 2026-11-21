/**
 * The byte assets the Pyodide worker needs, as URLs vite hashes and emits.
 *
 * The offline single-file build swaps this module for `pyodide-assets.offline.ts`
 * (see the alias in vite.config.ts): `vite-plugin-singlefile` sets
 * `assetsInlineLimit` to infinity, so every `?url` here would become a base64
 * data: URI *inside* the already-base64 inline worker — encoded twice, for no
 * reason.
 */

import lockUrl from 'pyodide/pyodide-lock.json?url';
import wasmUrl from 'pyodide/pyodide.asm.wasm?url';
import stdlibUrl from 'pyodide/python_stdlib.zip?url';
import dataTarUrl from '../../.python-bundle/wbdali-data.tar.gz?url';
import pythonTarUrl from '../../.python-bundle/wbdali-py.tar.gz?url';

export const ASSET_URL: Record<string, string> = {
  'pyodide.asm.wasm': wasmUrl,
  'python_stdlib.zip': stdlibUrl,
  'pyodide-lock.json': lockUrl,
  'wbdali-py.tar.gz': pythonTarUrl,
  'wbdali-data.tar.gz': dataTarUrl,
};
