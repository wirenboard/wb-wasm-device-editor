/**
 * homeui's `mqttClient` service, reimplemented over the in-browser broker.
 *
 * The DALI stores use only four of its methods — `addStickySubscription` and
 * `unsubscribe`, for the commissioning progress and bus monitor topics — but
 * `MqttRpc` needs `send`, `getID`, `isConnected`, `timeout` and `cancel`, so the
 * shim covers both. The semantics that matter are copied from
 * `app/scripts/services/mqttService.js`:
 *
 * - `send` defaults to qos 1 and retained true when the flag is left undefined;
 * - `unsubscribe(topic)` drops *every* callback registered for that topic, which
 *   is what keeps `MonitorStore.toggleLogsReception` balanced;
 * - callbacks receive `{topic, payload, qos, retained}` with a string payload.
 */

import type { DaliBackend } from './backend';

export interface MqttMessage {
  topic: string;
  payload: string;
  qos: number;
  retained: boolean;
}

export type MqttCallback = (message: MqttMessage) => void;

export class BrowserMqttClient {
  #backend: DaliBackend;
  #callbacks = new Map<string, MqttCallback[]>();
  #connected = false;

  constructor(backend: DaliBackend) {
    this.#backend = backend;
    // The caller reports a boot failure; swallowing it here only keeps it from
    // surfacing a second time as an unhandled rejection.
    backend.ready.then(
      () => {
        this.#connected = true;
      },
      () => {}
    );
  }

  getID(): string {
    return this.#backend.clientId;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  send(topic: string, payload: string, retained?: boolean, qos?: number): void {
    this.#backend.publish(topic, payload, retained === undefined ? true : retained, qos ?? 1);
  }

  subscribe(topic: string, callback: MqttCallback): void {
    const existing = this.#callbacks.get(topic);
    if (existing) {
      existing.push(callback);
      return;
    }
    this.#callbacks.set(topic, [callback]);
    this.#backend.subscribe(topic, (messageTopic, payload, retained) => {
      for (const handler of this.#callbacks.get(topic) ?? []) {
        handler({ topic: messageTopic, payload, qos: 1, retained });
      }
    });
  }

  /**
   * Same as `subscribe` here. In homeui the distinction is that sticky
   * subscriptions survive a broker reconnect; a loopback broker never drops.
   */
  addStickySubscription(topic: string, callback: MqttCallback): void {
    this.subscribe(topic, callback);
  }

  unsubscribe(topic: string): void {
    this.#callbacks.delete(topic);
    this.#backend.unsubscribe(topic);
  }

  timeout(callback: () => void, delayMs: number): number {
    return window.setTimeout(callback, delayMs);
  }

  cancel(handle: number): void {
    window.clearTimeout(handle);
  }

  whenReady(): Promise<void> {
    return this.#backend.ready;
  }
}

/** The `whenMqttReady` callback `DaliStore` awaits before its first RPC. */
export function makeWhenMqttReady(client: BrowserMqttClient): () => Promise<void> {
  return () => client.whenReady();
}
