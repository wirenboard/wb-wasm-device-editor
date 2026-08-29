import { lazy, Suspense, useSyncExternalStore } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { DeviceSettingsWasm } from './device-settings-wasm';
import { DALI_HASH } from './navigation';

// The DALI view pulls in Pyodide's glue and the homeui schema editors; loading
// it lazily keeps all of that out of the Modbus editor's startup path.
const DaliWasm = lazy(() => import('./dali-wasm').then((module) => ({ default: module.DaliWasm })));

function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** Picks the view the location hash asks for. */
export const App = () => {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash);

  if (hash === DALI_HASH) {
    return (
      <Suspense fallback={null}>
        <DaliWasm />
      </Suspense>
    );
  }
  // homeui master's components reach for router hooks in passing — the cell
  // history link calls useSearchParams — and crash without a Router above
  // them. This app has no URL routing; a memory router just provides the
  // context, exactly as the DALI view already does for its page.
  return (
    <MemoryRouter>
      <DeviceSettingsWasm />
    </MemoryRouter>
  );
};
