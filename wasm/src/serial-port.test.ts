import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// serial.js ships as a classic script for the Emscripten module, so it has no
// exports; evaluate it the same way the page does and take the class out.
const source = readFileSync(path.resolve(__dirname, '../public/serial.js'), 'utf8');
const SerialPort = new Function(`${source}\nreturn SerialPort;`)() as any;

const info = { usbVendorId: 0x1a86, usbProductId: 0x7523 };

function makePort(overrides: any = {}) {
  const port: any = {
    getInfo: () => info,
    open: vi.fn(async () => { port.isOpened = true; }),
    close: vi.fn(async () => { port.isOpened = false; }),
    readable: { locked: false, getReader: () => ({ read: async () => ({ value: new Uint8Array([1]) }), cancel: async () => {}, releaseLock: () => {} }) },
    writable: { locked: false, getWriter: () => ({ write: async () => {}, abort: async () => {}, releaseLock: () => {} }) },
    ...overrides,
  };
  return port;
}

function makeSerial(port: any) {
  const serial = new SerialPort();
  serial.api = { getPorts: async () => [port], requestPort: async () => port };
  serial.port = port;
  serial.isOpen = true;
  serial.pending = new Uint8Array();
  serial.options = { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 2 };
  return serial;
}

/** A port whose reads are resolved by the test, so a read can be left in
 * flight exactly as a timed-out caller leaves it. */
function makeControlledPort(cancelSettles = true) {
  const waiting: Array<(v: any) => void> = [];
  const queued: any[] = [];
  const state = { cancels: 0, releases: 0 };
  const reader = {
    read: () => (queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => { waiting.push(resolve); })),
    cancel: () => { state.cancels += 1; return cancelSettles ? Promise.resolve() : new Promise(() => {}); },
    releaseLock: () => { state.releases += 1; },
  };
  const push = (result: any) => { if (waiting.length) waiting.shift()!(result); else queued.push(result); };
  const port = makePort({ readable: { locked: false, getReader: () => reader } });
  return {
    port,
    state,
    inFlight: () => waiting.length,
    deliver: (bytes: number[]) => push({ value: new Uint8Array(bytes), done: false }),
    finish: () => push({ value: undefined, done: true }),
  };
}

describe('SerialPort never rejects into Asyncify', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('never hands back more bytes than the caller asked for', async () => {
    // ReadChunk copies the reply into a buffer sized for this call, so a longer
    // chunk overflows the heap; the surplus must stay queued instead.
    const ctl = makeControlledPort();
    const serial = makeSerial(ctl.port);
    ctl.deliver(Array.from({ length: 109 }, (_, i) => i & 0xff));
    const head = await serial.readChunk(20, 5);
    expect(head).toBeInstanceOf(Uint8Array);
    expect(head.length).toBe(20);
    expect(serial.pending.length).toBe(89);
    expect([...(await serial.readChunk(89, 5))]).toEqual([...Array(89).keys()].map((i) => (i + 20) & 0xff));
  });

  it('treats a locked readable as a dead port instead of throwing', async () => {
    const port = makePort({
      readable: { locked: true, getReader: () => { throw new TypeError('ReadableStream is locked'); } },
    });
    const serial = makeSerial(port);
    const chunk = await serial.readChunk(8, 10);
    expect(chunk).toBeInstanceOf(Uint8Array);
    expect(chunk.length).toBe(0);
    expect(serial.isOpen).toBe(false);
  });

  it('resolves and releases the lock when the writer rejects', async () => {
    let released = false;
    const port = makePort({
      writable: {
        locked: false,
        getWriter: () => ({
          write: async () => { throw new Error('The device has been lost.'); },
          abort: async () => {},
          releaseLock: () => { released = true; },
        }),
      },
    });
    const serial = makeSerial(port);
    await expect(serial.write(new Uint8Array([1, 2]))).resolves.toBeUndefined();
    expect(released).toBe(true);
    expect(serial.isOpen).toBe(false);
    expect(serial.writer).toBe(null);
  });

  it('treats a locked writable as a dead port instead of throwing', async () => {
    const port = makePort({
      writable: { locked: true, getWriter: () => { throw new TypeError('WritableStream is locked'); } },
    });
    const serial = makeSerial(port);
    await expect(serial.write(new Uint8Array([1]))).resolves.toBeUndefined();
    expect(serial.isOpen).toBe(false);
  });

  it('opens a port whose stream a failed request left locked', async () => {
    const port = makePort();
    const serial = makeSerial(port);
    let cancelled = false;
    serial.reader = { cancel: async () => { cancelled = true; port.readable.locked = false; }, releaseLock: () => {} };
    port.readable.locked = true;
    await serial.open();
    expect(cancelled).toBe(true);
    expect(port.close).toHaveBeenCalled();
    expect(port.open).toHaveBeenCalled();
    expect(serial.isOpen).toBe(true);
    expect(serial.reader).toBe(null);
  });

  it('resolves when the port itself is gone', async () => {
    const serial = makeSerial(makePort());
    serial.port = null;
    await expect(serial.readChunk(4, 10)).resolves.toEqual(new Uint8Array());
    await expect(serial.discardPending()).resolves.toBeUndefined();
    await expect(serial.close()).resolves.toBeUndefined();
  });

  it('survives a close() that rejects', async () => {
    const port = makePort({ close: vi.fn(async () => { throw new Error('closed already'); }) });
    const serial = makeSerial(port);
    await expect(serial.close()).resolves.toBeUndefined();
    expect(serial.isOpen).toBe(false);
  });
});

describe('SerialPort keeps one reader and loses no bytes', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('delivers a read that landed after the caller stopped waiting', async () => {
    const ctl = makeControlledPort();
    const serial = makeSerial(ctl.port);
    expect((await serial.readChunk(8, 5)).length).toBe(0);
    // The read is still outstanding: cancelling it here is what used to throw
    // away bytes that arrived a moment later.
    expect(ctl.inFlight()).toBe(1);
    expect(ctl.state.cancels).toBe(0);
    ctl.deliver([1, 2, 3]);
    expect([...(await serial.readChunk(8, 5))]).toEqual([1, 2, 3]);
  });

  it('loses no bytes when a frame lands across a timeout', async () => {
    const frame = [0x40, 0x03, 0x02, 0x00, 0x57, 0xc5, 0xb5];
    const ctl = makeControlledPort();
    const serial = makeSerial(ctl.port);
    expect((await serial.readChunk(3, 5)).length).toBe(0);
    ctl.deliver(frame);
    const head = await serial.readChunk(3, 5);
    const tail = await serial.readChunk(16, 5);
    expect([...head, ...tail]).toEqual(frame);
  });

  it('takes one reader for many reads instead of one per call', async () => {
    const ctl = makeControlledPort();
    const serial = makeSerial(ctl.port);
    for (let i = 0; i < 3; i += 1) {
      ctl.deliver([i]);
      expect([...(await serial.readChunk(1, 5))]).toEqual([i]);
    }
    expect(ctl.state.cancels).toBe(0);
    expect(ctl.state.releases).toBe(0);
    expect(serial.reader).not.toBe(null);
  });

  it('drops what has already arrived without waiting for what has not', async () => {
    const ctl = makeControlledPort();
    const serial = makeSerial(ctl.port);
    ctl.deliver([9, 9, 9]);
    const started = Date.now();
    await serial.discardPending();
    // No timer: a 5 ms wait here cost a full second in a hidden tab.
    expect(Date.now() - started).toBeLessThan(50);
    expect(serial.pending.length).toBe(0);
    expect((await serial.readChunk(8, 5)).length).toBe(0);
  });

  it('resolves close() promptly when cancel() never settles', async () => {
    const ctl = makeControlledPort(false);
    const serial = makeSerial(ctl.port);
    await serial.readChunk(4, 5);
    const started = Date.now();
    await expect(serial.close()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(900);
    expect(serial.reader).toBe(null);
    expect(serial.inflight).toBe(null);
    expect(serial.isOpen).toBe(false);
  });

  it('marks the port dead when the stream closes under it', async () => {
    const ctl = makeControlledPort();
    const serial = makeSerial(ctl.port);
    const waiting = serial.readChunk(8, 50);
    ctl.finish();
    expect((await waiting).length).toBe(0);
    expect(serial.isOpen).toBe(false);
    expect(serial.reader).toBe(null);
  });
});
