// node:latest (>=22.4) ships a native `localStorage` whose stub shadows
// happy-dom's implementation when no --localstorage-file is configured —
// `clear()` is not even a function there, and every storage-touching test
// dies in CI while passing on an older local node. Guarantee a working
// Web-Storage on the test window regardless of the node underneath.
function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  try {
    const storage = window[name];
    storage.setItem('__probe__', '1');
    storage.removeItem('__probe__');
    if (typeof storage.clear === 'function') {
      return;
    }
  } catch {
    // fall through to the replacement
  }
  const map = new Map<string, string>();
  const replacement = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(window, name, { value: replacement, configurable: true });
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');
