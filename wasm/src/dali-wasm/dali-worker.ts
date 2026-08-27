/**
 * Runs wb-mqtt-dali under Pyodide, off the main thread.
 *
 * A bus scan is thousands of DALI transactions driven by a Python event loop;
 * on the main thread that would fight the React render loop for the same
 * microtask queue. In a worker the page stays responsive and the only traffic
 * across the boundary is MQTT messages.
 *
 * Pyodide's two byte assets are served from memory through a fetch shim on a
 * sentinel origin. Pyodide asks for `${indexURL}<name>` with `fetch()`, so this
 * needs no internal API and behaves identically whether the bytes came off the
 * network or out of an inlined offline bundle.
 */

/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from 'pyodide';
// Static, so vite bundles the glue instead of emitting a runtime import() that a
// module worker cannot resolve.
import createPyodideModule from 'pyodide/pyodide.asm.mjs';
import { ASSET_URL } from './pyodide-assets';

const PYODIDE_ORIGIN = 'https://pyodide.invalid/';

type InlineAsset = { b64: string; gzip: boolean };

let inlineAssets: Record<string, InlineAsset> | null = null;
let baseURI = '/';
let pyodide: PyodideInterface | null = null;
let daliBrowser: any = null;

const post = (message: unknown) => (self as unknown as Worker).postMessage(message);
const log = (text: string) => post({ type: 'log', text });

async function assetBytes(name: string): Promise<Uint8Array> {
  if (inlineAssets) {
    const asset = inlineAssets[name];
    if (!asset) {
      throw new Error(`asset ${name} was not inlined`);
    }
    const raw = Uint8Array.from(atob(asset.b64), (c) => c.charCodeAt(0));
    if (!asset.gzip) {
      return raw;
    }
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const response = await fetch(new URL(ASSET_URL[name], baseURI));
  if (!response.ok) {
    throw new Error(`${name} -> HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function installFetchShim(assets: Record<string, [Uint8Array, string]>): void {
  const realFetch = self.fetch.bind(self);
  self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = assets[url];
    if (hit) {
      return new Response(hit[0], { status: 200, headers: { 'Content-Type': hit[1] } });
    }
    if (inlineAssets) {
      // The offline build must never reach the network; failing loudly here beats
      // a page that silently only works online.
      throw new Error(`offline build tried to fetch ${url}`);
    }
    return realFetch(input, init);
  };
}

async function boot(scenario: unknown, config: string | null): Promise<void> {
  const [wasm, stdlib, lockText, pythonTar, dataTar] = await Promise.all([
    assetBytes('pyodide.asm.wasm'),
    assetBytes('python_stdlib.zip'),
    assetBytes('pyodide-lock.json').then((bytes) => new TextDecoder().decode(bytes)),
    assetBytes('wbdali-py.tar.gz'),
    assetBytes('wbdali-data.tar.gz'),
  ]);

  installFetchShim({
    [`${PYODIDE_ORIGIN}pyodide.asm.wasm`]: [wasm, 'application/wasm'],
    [`${PYODIDE_ORIGIN}python_stdlib.zip`]: [stdlib, 'application/zip'],
  });

  pyodide = await loadPyodide({
    indexURL: PYODIDE_ORIGIN,
    packageBaseUrl: PYODIDE_ORIGIN,
    lockFileContents: lockText,
    createPyodideModule,
    stdout: (line: string) => log(line),
    stderr: (line: string) => log(line),
  });

  const sitePackages = pyodide.runPython('import site; site.getsitepackages()[0]');
  await pyodide.unpackArchive(pythonTar, 'tar.gz', { extractDir: sitePackages });
  pyodide.FS.mkdirTree('/usr/share');
  await pyodide.unpackArchive(dataTar, 'tar.gz', { extractDir: '/usr/share' });

  daliBrowser = pyodide.pyimport('wbdali_browser.browser');
  daliBrowser.configure_logging('INFO');
  const applied = await daliBrowser.start(
    scenario ? JSON.stringify(scenario) : undefined,
    config ?? undefined
  );

  // The daemon rewrites its config after a scan and on other edits; the page
  // stores each version so the installation survives a reload.
  daliBrowser.watch_config((configJson: string) => {
    post({ type: 'config', config: configJson, scenario: JSON.parse(daliBrowser.snapshot_scenario()) });
  });

  post({ type: 'ready', scenario: JSON.parse(applied) });
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'boot':
        baseURI = message.baseURI || baseURI;
        inlineAssets = message.inline ?? null;
        await boot(message.scenario, message.config ?? null);
        break;

      case 'publish':
        daliBrowser.publish(message.topic, message.payload, message.retain ?? false, message.qos ?? 1);
        break;

      case 'subscribe': {
        // The pattern travels back with every message: two filters can match the
        // same topic (the RPC reply wildcard and a device topic, say), and only
        // the worker knows which subscription produced this delivery.
        const { pattern } = message;
        daliBrowser.subscribe(pattern, (topic: string, payload: string, retained: boolean) => {
          post({ type: 'message', pattern, topic, payload, retained });
        });
        break;
      }

      case 'unsubscribe':
        daliBrowser.unsubscribe(message.pattern);
        break;

      case 'setReachable':
        daliBrowser.set_gateway_reachable(message.gatewayId, message.reachable);
        break;

      case 'diagnostics':
        post({ type: 'diagnostics', data: JSON.parse(daliBrowser.diagnostics()) });
        break;

      default:
        break;
    }
  } catch (error) {
    post({ type: 'error', text: String((error as Error)?.stack ?? error) });
  }
};
