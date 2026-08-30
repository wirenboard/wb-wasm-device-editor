/**
 * The two-strike memory for failed boots.
 *
 * A saved installation the runtime cannot rebuild would fail every load with
 * no way out from inside the page — but most boot failures are transient (a
 * busy port, an interrupted asset fetch), and the saved config carries state
 * worth keeping, like the names the operator gave devices. So the
 * installation is only dropped when boots fail twice in a row.
 *
 * Session storage on purpose: the strike count should not outlive the tab.
 */

const BOOT_FAILURE_KEY = 'wb-dali-boot-failed';

export function readBootFailureFlag(): boolean {
  try {
    return window.sessionStorage.getItem(BOOT_FAILURE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeBootFailureFlag(failed: boolean): void {
  try {
    if (failed) {
      window.sessionStorage.setItem(BOOT_FAILURE_KEY, '1');
    } else {
      window.sessionStorage.removeItem(BOOT_FAILURE_KEY);
    }
  } catch {
    // Session storage being unavailable only costs the two-strike memory.
  }
}

/** Records a failed boot; true when it is the second strike in a row. */
export function registerBootFailure(): boolean {
  const secondStrike = readBootFailureFlag();
  writeBootFailureFlag(true);
  return secondStrike;
}
