/**
 * Boots wb-mqtt-dali under Pyodide and turns messages into calls on it.
 *
 * Host-agnostic on purpose. Normally this runs in a web worker, because a bus
 * scan is thousands of DALI transactions driven by a Python event loop and on
 * the main thread that would fight React for the same microtask queue. But the
 * offline build is a single HTML file opened over `file://`, where Chrome
 * refuses to start a module worker at all, so the same runtime has to be able to
 * run on the main thread. The only difference between the two is where the bytes
 * come from and where replies go, which is what the host provides.
 */

import { loadPyodide, type PyodideInterface } from 'pyodide';
// Static, so vite bundles the glue instead of emitting a runtime import() that a
// module worker cannot resolve.
import createPyodideModule from 'pyodide/pyodide.asm.mjs';

const PYODIDE_ORIGIN = 'https://pyodide.invalid/';

export interface RuntimeHost {
  /** Deliver a message to the page. */
  post(message: any): void;
  /** Fetch one of the runtime's byte assets by name. */
  assetBytes(name: string): Promise<Uint8Array>;
  /** True when every asset is inlined and reaching the network is a bug. */
  isOffline(): boolean;
  /**
   * Run one Modbus request through the C++ WASM module over WebSerial.
   *
   * Only used in hardware mode. It lives on the host because the module runs on
   * the main thread: a worker has to proxy back to the page for it.
   */
  portLoad(request: string): Promise<string>;
}

export interface DaliRuntimeHandle {
  handle(message: any): Promise<void>;
}

/**
 * Serve Pyodide's two byte assets from memory.
 *
 * Pyodide asks for `${indexURL}<name>` with `fetch()`, so a shim on a sentinel
 * origin needs no internal API and behaves the same whether the bytes came off
 * the network or out of an inlined offline bundle.
 */
function installFetchShim(scope: any, assets: Record<string, [Uint8Array, string]>, isOffline: () => boolean): void {
  const realFetch = scope.fetch.bind(scope);
  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = assets[url];
    if (hit) {
      return new Response(hit[0] as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': hit[1] },
      });
    }
    if (isOffline()) {
      // Failing loudly beats a page that silently only works online.
      throw new Error(`offline build tried to fetch ${url}`);
    }
    return realFetch(input, init);
  };
}

export async function createDaliRuntime(host: RuntimeHost): Promise<DaliRuntimeHandle> {
  const log = (text: string) => host.post({ type: 'log', text });

  const [wasm, stdlib, lockText, pythonTar, dataTar] = await Promise.all([
    host.assetBytes('pyodide.asm.wasm'),
    host.assetBytes('python_stdlib.zip'),
    host.assetBytes('pyodide-lock.json').then((bytes) => new TextDecoder().decode(bytes)),
    host.assetBytes('wbdali-py.tar.gz'),
    host.assetBytes('wbdali-data.tar.gz'),
  ]);

  installFetchShim(
    globalThis,
    {
      [`${PYODIDE_ORIGIN}pyodide.asm.wasm`]: [wasm, 'application/wasm'],
      [`${PYODIDE_ORIGIN}python_stdlib.zip`]: [stdlib, 'application/zip'],
    },
    () => host.isOffline()
  );

  const pyodide: PyodideInterface = await loadPyodide({
    indexURL: PYODIDE_ORIGIN,
    packageBaseUrl: PYODIDE_ORIGIN,
    lockFileContents: lockText,
    createPyodideModule,
    stdout: log,
    stderr: log,
  });

  const sitePackages = pyodide.runPython('import site; site.getsitepackages()[0]');
  await pyodide.unpackArchive(pythonTar, 'tar.gz', { extractDir: sitePackages });
  pyodide.FS.mkdirTree('/usr/share');
  await pyodide.unpackArchive(dataTar, 'tar.gz', { extractDir: '/usr/share' });

  const dali: any = pyodide.pyimport('wbdali_browser.browser');
  dali.configure_logging('INFO');

  return {
    async handle(message: any): Promise<void> {
      switch (message.type) {
        case 'boot': {
          const applied = await dali.start(
            JSON.stringify(message.scenario),
            message.config ?? undefined,
            message.groups ?? undefined,
            (request: string) => host.portLoad(request)
          );

          // The daemon rewrites its config after a scan and on other edits; the
          // page stores each version so the installation survives a reload.
          // Group membership rides along: it is not in the config, and it is
          // what lets the next session's page open with groups immediately.
          dali.watch_config((config: string, groups: string) => {
            host.post({
              type: 'config',
              config,
              scenario: JSON.parse(dali.snapshot_scenario()),
              groups,
            });
          });

          host.post({ type: 'ready', scenario: JSON.parse(applied) });
          break;
        }

        case 'publish':
          dali.publish(message.topic, message.payload, message.retain ?? false, message.qos ?? 1);
          break;

        case 'subscribe': {
          // The pattern travels back with every message: two filters can match
          // the same topic (the RPC reply wildcard and a device topic, say), and
          // only this side knows which subscription produced the delivery.
          const { pattern } = message;
          dali.subscribe(pattern, (topic: string, payload: string, retained: boolean) => {
            host.post({ type: 'message', pattern, topic, payload, retained });
          });
          break;
        }

        case 'unsubscribe':
          dali.unsubscribe(message.pattern);
          break;

        case 'stop':
          // A worker is thrown away wholesale, but an inline runtime outlives
          // the page that started it: without this its poll loops keep running,
          // and its config watcher keeps writing over the next one's.
          await dali.stop();
          break;

        default:
          break;
      }
    },
  };
}

/** Decode one inlined asset from the offline bundle. */
export async function decodeInlineAsset(asset: { b64: string; gzip: boolean }): Promise<Uint8Array> {
  const raw = Uint8Array.from(atob(asset.b64), (c) => c.charCodeAt(0));
  if (!asset.gzip) {
    return raw;
  }
  const stream = new Blob([raw as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
