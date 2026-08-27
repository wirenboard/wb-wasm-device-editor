import { useEffect, useMemo, useState } from 'react';
import DaliPage from '@/pages/settings/configs/dali';
import { authStore, UserRole } from '@/stores/auth';
import { DaliStore } from '@/stores/dali';
import { BootProgress } from './components/boot-progress';
import { DaliShell } from './components/dali-shell';
import { PortGate } from './components/port-gate';
import { makeDaliProxy } from './dali-proxy';
import { BrowserMqttClient, makeWhenMqttReady } from './mqtt-client';
import { PyodideDaliBackend, type DaliMode } from './pyodide-backend';
import { loadMode, saveMode } from './persistence';
import './styles.css';

/**
 * The homeui DALI configuration page, backed by wb-mqtt-dali running in a
 * Pyodide worker instead of on a controller.
 *
 * `DaliPage` needs one prop and no React context: a `DaliStore` built from a
 * `whenMqttReady` promise, an RPC proxy and an MQTT client. All three are shims
 * over the in-browser broker, so the page itself is used unmodified — it loads
 * itself once `whenMqttReady` resolves.
 */
export const DaliWasm = () => {
  const [mode, setMode] = useState<DaliMode>(loadMode);
  const [hasPort, setHasPort] = useState(false);
  const [bootLog, setBootLog] = useState<string[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [isBooted, setBooted] = useState(false);

  // On real hardware the daemon must not start before a serial port exists; see
  // PortGate. In simulation there is nothing to choose.
  const needsPort = mode === 'hardware' && !hasPort;

  const { store, backend } = useMemo(() => {
    if (needsPort) {
      return { store: null, backend: null };
    }

    // `PageLayout` hides its children behind an access check, and the standalone
    // editor has no /auth endpoint to answer it: there is one local user, who is
    // the administrator.
    authStore.userRole = UserRole.Admin;

    const daliBackend = new PyodideDaliBackend({
      mode,
      onLog: (text) => setBootLog((lines) => [...lines.slice(-200), text]),
    });
    const mqttClient = new BrowserMqttClient(daliBackend);
    return {
      backend: daliBackend,
      store: new DaliStore(makeWhenMqttReady(mqttClient), makeDaliProxy(daliBackend), mqttClient),
    };
  }, [mode, needsPort]);

  useEffect(() => {
    if (!backend || !store) {
      return undefined;
    }
    let cancelled = false;
    backend.ready.then(
      () => !cancelled && setBooted(true),
      (error) => !cancelled && setBootError(String(error?.message ?? error))
    );

    return () => {
      cancelled = true;
      store.destroy();
      backend.dispose();
    };
  }, [store, backend]);

  const changeMode = (next: DaliMode) => {
    if (next === mode) {
      return;
    }
    // The transport is chosen when the daemon boots, so switching restarts it.
    saveMode(next);
    setBooted(false);
    setBootError(null);
    setBootLog([]);
    setHasPort(false);
    setMode(next);
  };

  return (
    <DaliShell mode={mode} onModeChange={changeMode}>
      {needsPort && <PortGate onSelected={() => setHasPort(true)} />}
      {!needsPort && (bootError || !isBooted) && <BootProgress error={bootError} log={bootLog} />}
      {!needsPort && !bootError && isBooted && store && <DaliPage store={store} />}
    </DaliShell>
  );
};
