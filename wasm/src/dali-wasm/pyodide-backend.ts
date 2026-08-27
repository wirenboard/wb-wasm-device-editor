/**
 * The page's side of the Pyodide worker: a `DaliBackend` over `postMessage`.
 *
 * Subscriptions are held here as well as in the worker, so a second subscriber
 * to the same filter costs no round trip and `unsubscribe` can drop every
 * handler for a topic the way homeui's mqttClient does.
 */

import type { DaliBackend, MessageHandler } from './backend';

export interface PyodideBackendOptions {
  /** The simulated installation to boot over; omitted means the daemon's default. */
  scenario?: unknown;
  /** Base64 assets for the offline single-file build. */
  inline?: Record<string, { b64: string; gzip: boolean }>;
  onLog?: (text: string) => void;
}

export class PyodideDaliBackend implements DaliBackend {
  readonly clientId = `wb-dali-editor-${Math.random().toString(36).slice(2, 10)}`;
  readonly ready: Promise<void>;

  #worker: Worker;
  #handlers = new Map<string, MessageHandler[]>();
  #resolveReady!: () => void;
  #rejectReady!: (reason: unknown) => void;
  #booted = false;
  #onLog?: (text: string) => void;

  scenario: unknown = null;

  constructor(options: PyodideBackendOptions = {}) {
    this.#onLog = options.onLog;
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    this.#worker = new Worker(new URL('./dali-worker.ts', import.meta.url), { type: 'module' });
    this.#worker.onmessage = (event) => this.#onMessage(event.data);
    this.#worker.onerror = (event) => this.#rejectReady(new Error(event.message || 'worker failed'));
    this.#worker.postMessage({
      type: 'boot',
      baseURI: document.baseURI,
      scenario: options.scenario,
      inline: options.inline,
    });
  }

  #onMessage(message: any): void {
    switch (message.type) {
      case 'ready':
        this.#booted = true;
        this.scenario = message.scenario;
        this.#resolveReady();
        break;

      case 'message':
        for (const handler of this.#handlers.get(this.#patternFor(message.topic)) ?? []) {
          handler(message.topic, message.payload, message.retained);
        }
        break;

      case 'log':
        this.#onLog?.(message.text);
        break;

      case 'error':
        if (!this.#booted) {
          this.#rejectReady(new Error(message.text));
        }
        console.error('[dali worker]', message.text);
        break;

      default:
        break;
    }
  }

  /**
   * Which of our filters a delivered topic belongs to. The worker only sends a
   * message once per subscribed filter, so the first match is the right one.
   */
  #patternFor(topic: string): string {
    for (const pattern of this.#handlers.keys()) {
      if (topicMatches(pattern, topic)) {
        return pattern;
      }
    }
    return topic;
  }

  publish(topic: string, payload: string, retain = false, qos = 1): void {
    this.#worker.postMessage({ type: 'publish', topic, payload, retain, qos });
  }

  subscribe(pattern: string, handler: MessageHandler): void {
    const existing = this.#handlers.get(pattern);
    if (existing) {
      existing.push(handler);
      return;
    }
    this.#handlers.set(pattern, [handler]);
    this.#worker.postMessage({ type: 'subscribe', pattern });
  }

  unsubscribe(pattern: string): void {
    this.#handlers.delete(pattern);
    this.#worker.postMessage({ type: 'unsubscribe', pattern });
  }

  setGatewayReachable(gatewayId: string, reachable: boolean): void {
    this.#worker.postMessage({ type: 'setReachable', gatewayId, reachable });
  }

  dispose(): void {
    this.#worker.terminate();
    this.#handlers.clear();
  }
}

/** MQTT topic filter matching: `+` is one level, `#` is the rest. */
export function topicMatches(pattern: string, topic: string): boolean {
  const patternLevels = pattern.split('/');
  const topicLevels = topic.split('/');
  for (let index = 0; index < patternLevels.length; index += 1) {
    if (patternLevels[index] === '#') {
      return true;
    }
    if (index >= topicLevels.length) {
      return false;
    }
    if (patternLevels[index] !== '+' && patternLevels[index] !== topicLevels[index]) {
      return false;
    }
  }
  return patternLevels.length === topicLevels.length;
}
