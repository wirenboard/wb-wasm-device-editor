/**
 * homeui's `services/mqtt-client`, backed by the in-browser broker.
 *
 * homeui builds its DALI page on module singletons now: `daliProxy` and the
 * stores import `mqttClient` rather than taking it injected. Substituting this
 * one module (see `redirectHomeuiMqttClient` in vite.config.ts) is therefore
 * the whole seam — homeui's own RPC proxy and stores run unchanged, talking
 * MQTT-RPC to the wb-mqtt-dali instance in the Pyodide worker instead of to a
 * broker over websockets.
 *
 * The surface is the one homeui's `rpc.ts` and DALI stores actually use. What
 * they do not use is left out rather than faked: `connect`, `reconnect` and
 * `disconnect` have no meaning for a loopback client that is always up.
 */

import type { DaliBackend } from './backend';

export interface MqttMessage {
  topic: string;
  payload: string;
  qos: number;
  retained: boolean;
}

export type MqttCallback = (message: MqttMessage) => void;

interface CancellablePromise extends Promise<void> {
  _cancel: () => void;
}

class BrowserMqttClient {
  #backend: DaliBackend | null = null;
  #callbacks = new Map<string, MqttCallback[]>();
  #pending: Array<() => void> = [];
  #connected = false;
  #clientId = `wb-dali-editor-${Math.random().toString(36).slice(2, 10)}`;

  // Which patterns this client has already registered on which backend. The
  // live backend survives view switches, so `attach` runs again on every
  // return to the DALI view — re-subscribing a pattern the backend already
  // has would stack a second delivery closure and every message would start
  // arriving twice (then three times, and so on).
  #registeredOn: DaliBackend | null = null;
  #registered = new Set<string>();

  /**
   * Point the client at a running DALI runtime.
   *
   * The module is a singleton because homeui's is, but the runtime it talks to
   * comes and goes with the DALI view — so anything published before one exists
   * is held rather than dropped.
   */
  attach(backend: DaliBackend): void {
    this.#backend = backend;
    this.#clientId = backend.clientId;
    for (const [pattern] of this.#callbacks) {
      this.#register(pattern);
    }
    backend.ready.then(
      () => {
        this.#connected = true;
        this.#pending.splice(0).forEach((send) => send());
      },
      () => {
        this.#connected = false;
      }
    );
  }

  detach(backend: DaliBackend): void {
    if (this.#backend !== backend) {
      return;
    }
    this.#backend = null;
    this.#connected = false;
    this.#pending.length = 0;
  }

  getID(): string {
    return this.#clientId;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  send(destination: string, payload?: string | null, retained?: boolean, qos?: 0 | 1 | 2): void {
    const publish = () =>
      this.#backend?.publish(destination, payload ?? '', retained === undefined ? true : retained, qos ?? 1);
    if (this.#connected) {
      publish();
      return;
    }
    this.#pending.push(publish);
  }

  subscribe(topic: string, callback: MqttCallback): void {
    const existing = this.#callbacks.get(topic);
    if (existing) {
      existing.push(callback);
      return;
    }
    this.#callbacks.set(topic, [callback]);
    this.#register(topic);
  }

  /** Register a pattern on the backend exactly once per backend. */
  #register(pattern: string): void {
    const backend = this.#backend;
    if (!backend) {
      return;
    }
    if (this.#registeredOn !== backend) {
      this.#registeredOn = backend;
      this.#registered.clear();
    }
    if (this.#registered.has(pattern)) {
      return;
    }
    this.#registered.add(pattern);
    backend.subscribe(pattern, (topic, payload, retained) => this.#deliver(pattern, topic, payload, retained));
  }

  /**
   * Same as `subscribe` here.
   *
   * In homeui the distinction is that sticky subscriptions are re-established
   * after a broker reconnect; a loopback client never drops.
   */
  addStickySubscription(topic: string, callback: MqttCallback): void {
    this.subscribe(topic, callback);
  }

  /** Drops every callback for the topic, as homeui's does. */
  unsubscribe(topic: string): void {
    this.#callbacks.delete(topic);
    this.#registered.delete(topic);
    this.#backend?.unsubscribe(topic);
  }

  whenReady(): Promise<void> {
    return this.whenConnected();
  }

  whenConnected(): Promise<void> {
    return this.#backend ? this.#backend.ready : new Promise<void>(() => {});
  }

  timeout(callback: () => void, delay: number): CancellablePromise {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const promise = this.whenReady().then(() => {
      if (cancelled) {
        return undefined;
      }
      return new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve();
          callback();
        }, delay);
      });
    }) as CancellablePromise;
    promise._cancel = () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
    return promise;
  }

  // eslint-disable-next-line class-methods-use-this
  cancel(promise: CancellablePromise): void {
    promise?._cancel?.();
  }

  #deliver(pattern: string, topic: string, payload: string, retained: boolean): void {
    for (const callback of this.#callbacks.get(pattern) ?? []) {
      callback({ topic, payload, qos: 1, retained });
    }
  }
}

// Exported for tests; the app uses the singleton below, matching homeui's.
export { BrowserMqttClient };

export const mqttClient = new BrowserMqttClient();
