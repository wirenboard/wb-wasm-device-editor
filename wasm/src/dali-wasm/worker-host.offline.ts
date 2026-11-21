/**
 * Stands in for `worker-host.ts` in the offline single-file build.
 *
 * A page opened over `file://` cannot start a module worker at all, so the
 * runtime runs on the main thread there. Returning null says so; nothing in
 * this module references `Worker`, which is what keeps the worker chunk out of
 * the build.
 */

import type { WorkerHost } from './worker-host';

export function startWorker(): WorkerHost | null {
  return null;
}
