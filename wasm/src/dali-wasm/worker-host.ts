/**
 * Starts the DALI runtime in a web worker.
 *
 * This exists as its own module so the offline build can alias it away. Vite's
 * worker plugin rewrites `new Worker(new URL(...))` during transform, before
 * any dead-code elimination, so guarding the call at runtime is not enough to
 * stop it emitting a 13 MB worker chunk — a chunk that
 * `vite-plugin-singlefile` does not inline and a `file://` page could not start
 * anyway. See `worker-host.offline.ts`.
 */

export interface WorkerHost {
  send(message: any): void;
  terminate(): void;
}

export function startWorker(
  onMessage: (message: any) => void,
  onError: (error: Error) => void
): WorkerHost | null {
  const worker = new Worker(new URL('./dali-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => onMessage(event.data);
  worker.onerror = (event) => onError(new Error(event.message || 'the DALI worker failed to start'));
  return {
    send: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
  };
}
