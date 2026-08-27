/**
 * Keeps a commissioned DALI installation across page reloads.
 *
 * Pyodide's filesystem lives in memory, so the config the daemon writes after a
 * bus scan is gone on the next load. Two things have to come back together: the
 * daemon's config, and the simulated bus itself — the short addresses
 * commissioning programmed into the control gear. Restoring only the config
 * would describe addressed devices on a bus that had gone factory-fresh again.
 */

const MODE_KEY = 'wb-dali-mode';

/**
 * One slot per transport. A simulated installation restored onto real hardware
 * would have the daemon poll short addresses that only ever existed in the
 * simulation; the reverse leaves the config describing devices the simulated
 * bus does not have.
 */
function storageKey(mode: 'simulated' | 'hardware'): string {
  return `wb-dali-installation-${mode}`;
}

export interface StoredInstallation {
  /** The daemon's `/etc/wb-mqtt-dali.conf`, verbatim. */
  config: string;
  /** The simulated installation, with the short addresses it currently holds. */
  scenario: unknown;
}

export function loadInstallation(mode: 'simulated' | 'hardware'): StoredInstallation | null {
  try {
    const stored = window.localStorage.getItem(storageKey(mode));
    return stored ? (JSON.parse(stored) as StoredInstallation) : null;
  } catch {
    // A corrupt or unreadable entry must not stop the page from opening; the
    // installation simply starts from the default scenario.
    return null;
  }
}

export function saveInstallation(
  mode: 'simulated' | 'hardware',
  installation: StoredInstallation
): void {
  try {
    window.localStorage.setItem(storageKey(mode), JSON.stringify(installation));
  } catch (error) {
    console.warn('DALI: could not save the installation', error);
  }
}

export function clearInstallation(mode: 'simulated' | 'hardware'): void {
  try {
    window.localStorage.removeItem(storageKey(mode));
  } catch {
    // Nothing to do: the entry is already unreachable.
  }
}

/**
 * The transport the operator last chose, or null if they never have.
 *
 * The difference matters: with no stored choice the default comes from whether
 * the Modbus scan found a gateway, and "never chose" must not look like
 * "chose simulated".
 */
export function loadMode(): 'simulated' | 'hardware' | null {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    return stored === 'hardware' || stored === 'simulated' ? stored : null;
  } catch {
    return null;
  }
}

export function saveMode(mode: 'simulated' | 'hardware'): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch (error) {
    console.warn('DALI: could not save the transport mode', error);
  }
}
