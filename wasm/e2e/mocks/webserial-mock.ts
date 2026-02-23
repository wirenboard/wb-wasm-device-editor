/**
 * Returns a JS string to be injected via context.addInitScript().
 * Mocks navigator.serial (WebSerial API) so tests can run without a real device.
 */
export function getWebSerialMockScript(): string {
  return `
(() => {
  const writtenChunks = [];
  const responseQueue = [];
  let portOpen = false;
  let portSelected = false;
  let lastRequestPortFilters = null;
  let lastOpenOptions = null;

  const mockPort = {
    open(options) {
      portOpen = true;
      lastOpenOptions = options || null;
      return Promise.resolve();
    },
    close() {
      portOpen = false;
      return Promise.resolve();
    },
    getInfo() {
      return { usbVendorId: 0x0403, usbProductId: 0x6001 };
    },
    get writable() {
      if (!portOpen) return null;
      return {
        getWriter() {
          return {
            write(data) {
              writtenChunks.push(new Uint8Array(data));
              return Promise.resolve();
            },
            releaseLock() {},
          };
        },
      };
    },
    get readable() {
      if (!portOpen) return null;
      return {
        getReader() {
          let cancelled = false;
          return {
            read() {
              if (cancelled) {
                return Promise.resolve({ value: undefined, done: true });
              }
              if (responseQueue.length > 0) {
                const value = responseQueue.shift();
                return Promise.resolve({ value, done: false });
              }
              return new Promise((resolve) => {
                const check = () => {
                  if (cancelled) {
                    resolve({ value: undefined, done: true });
                    return;
                  }
                  if (responseQueue.length > 0) {
                    resolve({ value: responseQueue.shift(), done: false });
                    return;
                  }
                  setTimeout(check, 1);
                };
                setTimeout(check, 1);
              });
            },
            cancel() {
              cancelled = true;
              return Promise.resolve();
            },
            releaseLock() {},
          };
        },
      };
    },
  };

  const serialMock = {
    requestPort(options) {
      portSelected = true;
      lastRequestPortFilters = options?.filters || null;
      return Promise.resolve(mockPort);
    },
    getPorts() {
      return Promise.resolve(portSelected ? [mockPort] : []);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  Object.defineProperty(navigator, 'serial', {
    value: serialMock,
    writable: false,
    configurable: true,
  });

  window.__serialMock = {
    pushResponse(data) {
      responseQueue.push(new Uint8Array(data));
    },
    getWrittenData() {
      return writtenChunks.slice();
    },
    get isOpen() {
      return portOpen;
    },
    get isSelected() {
      return portSelected;
    },
    get lastRequestPortFilters() {
      return lastRequestPortFilters;
    },
    get lastOpenOptions() {
      return lastOpenOptions;
    },
    reset() {
      writtenChunks.length = 0;
      responseQueue.length = 0;
      portOpen = false;
      portSelected = false;
      lastRequestPortFilters = null;
      lastOpenOptions = null;
    },
  };
})();
`;
}
