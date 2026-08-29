/**
 * Keeps a commissioned DALI installation across page reloads.
 *
 * Pyodide's filesystem lives in memory, so the config the daemon writes after a
 * bus scan is gone on the next load; this brings it back, so the installation
 * does not look untouched. The key name carries a `-hardware` suffix from when
 * a simulated installation had a slot of its own.
 */

const STORAGE_KEY = 'wb-dali-installation-hardware';

export interface StoredInstallation {
  /** The daemon's `/etc/wb-mqtt-dali.conf`, verbatim. */
  config: string;
  /** The gateways the config belongs to, as handed to the runtime. */
  scenario: unknown;
  /**
   * Group membership by device mqtt id, JSON-encoded. Groups live on the gear,
   * not in the config, and are read tens of seconds into a boot — this is what
   * lets the page open with them immediately.
   */
  groups?: string;
  /**
   * Memory-bank bytes per device (identity: GTIN, serials, versions),
   * JSON-encoded and keyed by the random address they were read from — the
   * reads that dominate every device initialization and first page open.
   */
  memory?: string;
}

export function loadInstallation(): StoredInstallation | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as StoredInstallation) : null;
  } catch {
    // A corrupt or unreadable entry must not stop the page from opening; the
    // installation simply starts fresh.
    return null;
  }
}

export function saveInstallation(installation: StoredInstallation): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(installation));
  } catch (error) {
    console.warn('DALI: could not save the installation', error);
  }
}

export function clearInstallation(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: the entry is already unreachable.
  }
}
