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

describe('SerialPort never rejects into Asyncify', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('clears the stale Asyncify reply before suspending the C++ caller', async () => {
    // The unwind pass returns the PREVIOUS value; ReadChunk copies it into a
    // buffer sized for this call, so a longer stale chunk overflows the heap.
    (globalThis as any).Asyncify = { handleSleepReturnValue: new Uint8Array(109) };
    const serial = makeSerial(makePort());
    await serial.readChunk(4, 10);
    expect((globalThis as any).Asyncify.handleSleepReturnValue).toBe(0);
    delete (globalThis as any).Asyncify;
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
