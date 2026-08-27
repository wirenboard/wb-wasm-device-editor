/**
 * Keeps a commissioned DALI installation across page reloads.
 *
 * Pyodide's filesystem lives in memory, so the config the daemon writes after a
 * bus scan is gone on the next load. Two things have to come back together: the
 * daemon's config, and the simulated bus itself — the short addresses
 * commissioning programmed into the control gear. Restoring only the config
 * would describe addressed devices on a bus that had gone factory-fresh again.
 */

const STORAGE_KEY = 'wb-dali-installation';

export interface StoredInstallation {
  /** The daemon's `/etc/wb-mqtt-dali.conf`, verbatim. */
  config: string;
  /** The simulated installation, with the short addresses it currently holds. */
  scenario: unknown;
}

export function loadInstallation(): StoredInstallation | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as StoredInstallation) : null;
  } catch {
    // A corrupt or unreadable entry must not stop the page from opening; the
    // installation simply starts from the default scenario.
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
