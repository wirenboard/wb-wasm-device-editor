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

const BOOT_FAILURE_KEY = 'wb-dali-boot-failed';

function readBootFailureFlag(): boolean {
  try {
    return window.sessionStorage.getItem(BOOT_FAILURE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeBootFailureFlag(failed: boolean): void {
  try {
    if (failed) {
      window.sessionStorage.setItem(BOOT_FAILURE_KEY, '1');
    } else {
      window.sessionStorage.removeItem(BOOT_FAILURE_KEY);
    }
  } catch {
    // Session storage being unavailable only costs the two-strike memory.
  }
}

export interface PyodideBackendOptions {
  /** The gateways the daemon talks to — what the Modbus scan found. */
  scenario: unknown;
  onLog?: (text: string) => void;
}

/**
 * Run one Modbus request through the C++ WASM module over WebSerial.
 *
 * This is the same `port/Load` RPC the Modbus editor uses, so the DALI page
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

  constructor(options: PyodideBackendOptions) {
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
      scenario: options.scenario,
      config: stored?.config,
      groups: stored?.groups,
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
      // A saved installation the runtime cannot rebuild would fail every load
      // with no way out from inside the page — but most boot failures are
      // transient (a busy port, an interrupted asset fetch), and the saved
      // config carries state worth keeping, like the names the operator gave
      // devices. So the installation is only dropped when it fails twice in a
      // row, not on the first stumble.
      if (readBootFailureFlag()) {
        clearInstallation();
      }
      writeBootFailureFlag(true);
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
        writeBootFailureFlag(false);
        this.#resolveReady();
        break;

      case 'message':
        for (const handler of this.#handlers.get(message.pattern) ?? []) {
          handler(message.topic, message.payload, message.retained);
        }
        break;

      case 'config':
        if (!this.#disposed) {
          saveInstallation({
            config: message.config,
            scenario: message.scenario,
            groups: message.groups,
          });
        }
        break;

      case 'log':
        this.#onLog?.(message.text);
        // The boot panel is unmounted once the page loads, so without this the
        // daemon's own errors — an unsupported feature, a bus fault — would go
        // nowhere at all. Keyed on the level the log format puts first, and on
        // the first line of a traceback, rather than on words that also appear
        // in ordinary output.
        if (/^(ERROR|CRITICAL) |^Traceback \(most recent call last\)/.test(message.text)) {
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

  dispose(): void {
    this.#disposed = true;
    this.#handlers.clear();

    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    } else if (this.#inlineRuntime) {
      // Terminating a worker takes its interpreter with it; an inline runtime
      // has to be told to stop, or it keeps polling the bus for as long as the
      // page is open.
      const runtime = this.#inlineRuntime;
      this.#inlineRuntime = null;
      runtime.handle({ type: 'stop' }).catch((error) => console.error('[dali]', error));
    }

    this.#inlineQueue.length = 0;
    this.#send = () => {};
  }
}
