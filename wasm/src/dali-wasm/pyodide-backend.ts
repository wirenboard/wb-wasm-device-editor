/**
 * The page's side of the DALI runtime.
 *
 * Normally the runtime lives in a web worker. The offline build is a single
 * HTML file opened over `file://`, where Chrome refuses to start a module worker
 * — so there the same runtime runs on the main thread instead, reached through
 * the identical message interface. Everything above this class goes through
 * `DaliBackend` and cannot tell which one it got.
 *
 * Subscriptions are held here as well as in the runtime, so a second subscriber
 * to the same filter costs no round trip and `unsubscribe` can drop every
 * handler for a topic the way homeui's mqttClient does.
 */

import type { DaliBackend, MessageHandler } from './backend';
import { createDaliRuntime, decodeInlineAsset, type DaliRuntimeHandle } from './dali-runtime';
import { readInlineAssets, type InlineAsset } from './inline-assets';
import { clearInstallation, loadInstallation, saveInstallation } from './persistence';
import { ASSET_URL } from './pyodide-assets';
import { startWorker, type WorkerHost } from './worker-host';

/** Where the DALI bus is: simulated in the browser, or a real module on WebSerial. */
export type DaliMode = 'simulated' | 'hardware';

export interface PyodideBackendOptions {
  mode?: DaliMode;
  /** The simulated installation to boot over; omitted means the last one used. */
  scenario?: unknown;
  onLog?: (text: string) => void;
}

/**
 * Run one Modbus request through the C++ WASM module over WebSerial.
 *
 * This is the same `port/Load` RPC the Modbus editor uses, so hardware mode
 * shares its serial port, its framing and its port-selection flow.
 */
async function portLoad(request: string): Promise<string> {
  try {
    return JSON.stringify(await Module.request('portLoad', JSON.parse(request)));
  } catch (error) {
    return JSON.stringify({ error: { message: String((error as Error)?.message ?? error) } });
  }
}

/**
 * Whether to run the runtime in a worker.
 *
 * A page opened over `file://` — which is how the offline single-file build is
 * used — cannot start a module worker at all, so the runtime runs on the main
 * thread there instead.
 */
export function canUseWorker(): boolean {
  return typeof Worker !== 'undefined' && window.location.protocol !== 'file:';
}

export class PyodideDaliBackend implements DaliBackend {
  readonly clientId = `wb-dali-editor-${Math.random().toString(36).slice(2, 10)}`;
  readonly ready: Promise<void>;

  #handlers = new Map<string, MessageHandler[]>();
  #resolveReady!: () => void;
  #rejectReady!: (reason: unknown) => void;
  #booted = false;
  #disposed = false;
  #onLog?: (text: string) => void;
  #send: (message: any) => void = () => {};

  #worker: WorkerHost | null = null;
  #inlineRuntime: DaliRuntimeHandle | null = null;
  #inlineQueue: any[] = [];

  scenario: unknown = null;

  constructor(options: PyodideBackendOptions = {}) {
    this.#onLog = options.onLog;
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    const stored = loadInstallation();
    const inline = readInlineAssets();
    const boot = {
      type: 'boot',
      baseURI: document.baseURI,
      mode: options.mode ?? 'simulated',
      scenario: options.scenario ?? stored?.scenario,
      config: stored?.config,
      inline,
    };

    const worker = canUseWorker()
      ? startWorker(
        (message) => this.#onMessage(message),
        (error) => this.#fail(error)
      )
      : null;

    if (worker) {
      this.#worker = worker;
      this.#send = (message) => worker.send(message);
      this.#send(boot);
    } else {
      this.#startInline(boot, inline);
    }
  }

  #startInline(boot: any, inline: Record<string, InlineAsset> | null): void {
    this.#send = (message) => {
      if (this.#inlineRuntime === null) {
        this.#inlineQueue.push(message);
        return;
      }
      this.#inlineRuntime.handle(message).catch((error) => this.#fail(error));
    };

    createDaliRuntime({
      post: (message) => this.#onMessage(message),
      assetBytes: (name) => this.#assetBytes(name, inline),
      isOffline: () => inline !== null,
      portLoad,
    })
      .then(async (runtime) => {
        this.#inlineRuntime = runtime;
        await runtime.handle(boot);
        for (const queued of this.#inlineQueue.splice(0)) {
          await runtime.handle(queued);
        }
      })
      .catch((error) => this.#fail(error));
  }

  async #assetBytes(name: string, inline: Record<string, InlineAsset> | null): Promise<Uint8Array> {
    if (inline) {
      const asset = inline[name];
      if (!asset) {
        throw new Error(`asset ${name} was not inlined`);
      }
      return decodeInlineAsset(asset);
    }
    const response = await fetch(new URL(ASSET_URL[name], document.baseURI));
    if (!response.ok) {
      throw new Error(`${name} -> HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  #fail(error: unknown): void {
    if (this.#disposed) {
      return;
    }
    if (!this.#booted) {
      // A saved installation the runtime cannot rebuild would fail every
      // subsequent load too, with no way out from inside the page.
      clearInstallation();
      this.#rejectReady(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    console.error('[dali]', error);
  }

  #onMessage(message: any): void {
    switch (message.type) {
      case 'ready':
        this.#booted = true;
        this.scenario = message.scenario;
        this.#resolveReady();
        break;

      case 'message':
        for (const handler of this.#handlers.get(message.pattern) ?? []) {
          handler(message.topic, message.payload, message.retained);
        }
        break;

      case 'config':
        saveInstallation({ config: message.config, scenario: message.scenario });
        break;

      case 'log':
        this.#onLog?.(message.text);
        // The boot panel is unmounted once the page loads, so without this the
        // daemon's own errors — an unsupported feature, a bus fault — would go
        // nowhere at all.
        if (/error|traceback|exception/i.test(message.text)) {
          console.error('[dali]', message.text);
        }
        break;

      case 'portLoad':
        // Only the main thread can reach the C++ module, so the worker asks.
        portLoad(message.request).then((reply) =>
          this.#send({ type: 'portLoadReply', id: message.id, reply })
        );
        break;

      case 'error':
        this.#fail(new Error(message.text));
        break;

      default:
        break;
    }
  }

  publish(topic: string, payload: string, retain = false, qos = 1): void {
    this.#send({ type: 'publish', topic, payload, retain, qos });
  }

  subscribe(pattern: string, handler: MessageHandler): void {
    const existing = this.#handlers.get(pattern);
    if (existing) {
      existing.push(handler);
      return;
    }
    this.#handlers.set(pattern, [handler]);
    this.#send({ type: 'subscribe', pattern });
  }

  unsubscribe(pattern: string): void {
    this.#handlers.delete(pattern);
    this.#send({ type: 'unsubscribe', pattern });
  }

  /** Pull the plug on a simulated module, so the UI's error paths can be seen. */
  setGatewayReachable(gatewayId: string, reachable: boolean): void {
    this.#send({ type: 'setReachable', gatewayId, reachable });
  }

  dispose(): void {
    this.#disposed = true;
    this.#worker?.terminate();
    this.#worker = null;
    this.#inlineRuntime = null;
    this.#handlers.clear();
    this.#send = () => {};
  }
}
