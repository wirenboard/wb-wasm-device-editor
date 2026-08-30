import { describe, expect, it, vi } from 'vitest';
import type { DaliBackend } from './backend';
import { BrowserMqttClient } from './mqtt-client';

type Handler = (topic: string, payload: string, retained: boolean) => void;

function stubBackend(clientId = 'stub') {
  const handlers = new Map<string, Handler[]>();
  let resolveReady: () => void = () => {};
  const backend = {
    clientId,
    ready: new Promise<void>((resolve) => { resolveReady = resolve; }),
    publish: vi.fn(),
    subscribe: vi.fn((pattern: string, handler: Handler) => {
      handlers.set(pattern, [...(handlers.get(pattern) ?? []), handler]);
    }),
    unsubscribe: vi.fn((pattern: string) => handlers.delete(pattern)),
  } as unknown as DaliBackend & { publish: ReturnType<typeof vi.fn> };
  const emit = (pattern: string, topic: string, payload: string) =>
    (handlers.get(pattern) ?? []).forEach((handler) => handler(topic, payload, false));
  return { backend, emit, resolveReady: () => resolveReady(), handlers };
}

describe('BrowserMqttClient', () => {
  it('holds a publish until the backend is ready, then flushes it', async () => {
    const client = new BrowserMqttClient();
    const { backend, resolveReady } = stubBackend();
    client.attach(backend);
    client.send('/devices/x/on', '1');
    expect(backend.publish).not.toHaveBeenCalled();
    resolveReady();
    await backend.ready;
    await Promise.resolve();
    client.send('/devices/x/on', '2');
    expect(backend.publish).toHaveBeenCalledTimes(2);
  });

  it('detach drops pending publishes', async () => {
    const client = new BrowserMqttClient();
    const { backend, resolveReady } = stubBackend();
    client.attach(backend);
    client.send('/devices/x/on', '1');
    client.detach(backend);
    resolveReady();
    await backend.ready;
    await Promise.resolve();
    expect(backend.publish).not.toHaveBeenCalled();
  });

  it('re-attaching the same backend does not stack duplicate deliveries', () => {
    const client = new BrowserMqttClient();
    const { backend, emit } = stubBackend();
    const seen = vi.fn();
    client.attach(backend);
    client.subscribe('/devices/+/controls/#', seen);
    // A round trip to the editor and back re-attaches the surviving backend.
    client.detach(backend);
    client.attach(backend);
    client.attach(backend);
    emit('/devices/+/controls/#', '/devices/a/controls/b', '42');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('re-establishes subscriptions on a NEW backend', () => {
    const client = new BrowserMqttClient();
    const first = stubBackend('first');
    const second = stubBackend('second');
    client.attach(first.backend);
    client.subscribe('/rpc/#', vi.fn());
    client.detach(first.backend);
    client.attach(second.backend);
    expect(second.backend.subscribe).toHaveBeenCalledWith('/rpc/#', expect.any(Function));
  });

  it('a cancelled timeout never fires its callback', async () => {
    const client = new BrowserMqttClient();
    const { backend, resolveReady } = stubBackend();
    client.attach(backend);
    resolveReady();
    const callback = vi.fn();
    const pending = client.timeout(callback, 5);
    client.cancel(pending);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callback).not.toHaveBeenCalled();
  });
});
