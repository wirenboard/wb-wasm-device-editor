/**
 * homeui's `daliProxy`, reimplemented over the in-browser broker.
 *
 * The wire format is MQTT-RPC 1.0 as `app/scripts/services/rpc.js` speaks it:
 * publish `{id, params}` to `/rpc/v1/wb-mqtt-dali/Editor/<Method>/<clientId>`,
 * read the reply from the same topic plus `/reply`, correlate by `id`. One
 * sticky subscription with a `+` wildcard covers every method's replies.
 *
 * Rejection values are shaped the way the stores expect: `formatError` renders
 * an RPC `error` object as `message: data(code)`, and a plain `{data, message}`
 * as just the message.
 */

import type { DaliBackend } from './backend';

const RPC_TIMEOUT_MS = 60000;

export const EDITOR_METHODS = [
  'GetList',
  'GetGateway',
  'SetGateway',
  'GetBus',
  'SetBus',
  'ScanBus',
  'StopScanBus',
  'GetDevice',
  'SetDevice',
  'GetGroup',
  'SetGroup',
  'IdentifyDevice',
  'ResetDeviceSettings',
  'ResetDevice',
] as const;

export type EditorMethod = (typeof EDITOR_METHODS)[number];

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
}

export class DaliRpcProxy {
  #backend: DaliBackend;
  #prefix: string;
  #pending = new Map<number, PendingCall>();
  #nextCallId = 1;
  #subscribed = false;

  constructor(backend: DaliBackend, target = 'wb-mqtt-dali/Editor') {
    this.#backend = backend;
    this.#prefix = `/rpc/v1/${target}/`;
  }

  #ensureSubscribed(): void {
    if (this.#subscribed) {
      return;
    }
    this.#subscribed = true;
    this.#backend.subscribe(`${this.#prefix}+/${this.#backend.clientId}/reply`, (_topic, payload) => {
      this.#onReply(payload);
    });
  }

  #onReply(payload: string): void {
    let reply: { id?: number; result?: unknown; error?: unknown };
    try {
      reply = JSON.parse(payload);
    } catch {
      console.error('DALI RPC: unparseable reply', payload);
      return;
    }
    if (reply.id === undefined) {
      return;
    }
    const call = this.#pending.get(reply.id);
    if (!call) {
      return;
    }
    this.#pending.delete(reply.id);
    window.clearTimeout(call.timer);
    if (reply.error) {
      call.reject(reply.error);
    } else {
      call.resolve(reply.result);
    }
  }

  call<T = unknown>(method: EditorMethod | string, params?: object): Promise<T> {
    this.#ensureSubscribed();
    const callId = this.#nextCallId++;
    const topic = `${this.#prefix}${method}/${this.#backend.clientId}`;

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#pending.delete(callId);
        reject({ data: 'MqttTimeoutError', message: 'MQTT RPC request timed out' });
      }, RPC_TIMEOUT_MS);

      this.#pending.set(callId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.#backend.publish(topic, JSON.stringify({ id: callId, params: params ?? {} }), false, 1);
    });
  }

  /** `hasMethod` exists on homeui proxies; the DALI stores never call it. */
  // eslint-disable-next-line class-methods-use-this
  hasMethod(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/** An object with one bound method per `Editor/*` RPC, as `MqttRpc.getProxy` returns. */
export function makeDaliProxy(backend: DaliBackend): Record<string, (params?: object) => Promise<any>> {
  const proxy = new DaliRpcProxy(backend);
  const methods: Record<string, (params?: object) => Promise<any>> = {
    hasMethod: () => proxy.hasMethod(),
  };
  for (const method of EDITOR_METHODS) {
    methods[method] = (params?: object) => proxy.call(method, params);
  }
  return methods;
}
