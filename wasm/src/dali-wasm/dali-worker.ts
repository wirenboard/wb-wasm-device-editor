/**
 * Hosts the DALI runtime in a web worker.
 *
 * A bus scan is thousands of DALI transactions driven by a Python event loop;
 * on the main thread that would fight React for the same microtask queue. The
 * runtime itself is in `dali-runtime.ts`, because the offline single-file build
 * cannot use a worker at all and has to run the same code inline.
 */

/// <reference lib="webworker" />

import { assetBytes as sharedAssetBytes, createDaliRuntime, type DaliRuntimeHandle } from './dali-runtime';

type InlineAsset = { b64: string; gzip: boolean };

let inlineAssets: Record<string, InlineAsset> | null = null;
let baseURI = '/';
let runtime: DaliRuntimeHandle | null = null;
const pending: any[] = [];

const post = (message: unknown) => (self as unknown as Worker).postMessage(message);

// The C++ WASM module lives on the main thread, so hardware-mode Modbus
// requests are proxied back to the page and matched up by id.
let nextPortLoadId = 1;
const portLoadCalls = new Map<number, (reply: string) => void>();

function portLoad(request: string): Promise<string> {
  const id = nextPortLoadId++;
  return new Promise<string>((resolve) => {
    portLoadCalls.set(id, resolve);
    post({ type: 'portLoad', id, request });
  });
}

function assetBytes(name: string): Promise<Uint8Array> {
  return sharedAssetBytes(name, inlineAssets, baseURI);
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message.type === 'portLoadReply') {
      portLoadCalls.get(message.id)?.(message.reply);
      portLoadCalls.delete(message.id);
      return;
    }

    if (message.type === 'boot') {
      baseURI = message.baseURI || baseURI;
      inlineAssets = message.inline ?? null;
      runtime = await createDaliRuntime({
        post,
        assetBytes,
        isOffline: () => inlineAssets !== null,
        portLoad,
      });
      await runtime.handle(message);
      // Anything sent while Pyodide was still starting waited here rather than
      // being dropped.
      for (const queued of pending.splice(0)) {
        await runtime.handle(queued);
      }
      return;
    }

    if (runtime === null) {
      pending.push(message);
      return;
    }
    await runtime.handle(message);
  } catch (error) {
    post({ type: 'error', text: String((error as Error)?.stack ?? error) });
  }
};
