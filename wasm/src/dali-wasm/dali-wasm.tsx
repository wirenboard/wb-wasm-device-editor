import { useEffect, useMemo, useState } from 'react';
import DaliPage from '@/pages/settings/configs/dali';
import { authStore, UserRole } from '@/stores/auth';
import { DaliStore } from '@/stores/dali';
import { BootProgress } from './components/boot-progress';
import { makeDaliProxy } from './dali-proxy';
import { BrowserMqttClient, makeWhenMqttReady } from './mqtt-client';
import { PyodideDaliBackend } from './pyodide-backend';
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
  const [bootLog, setBootLog] = useState<string[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [isBooted, setBooted] = useState(false);

  const { store, backend } = useMemo(() => {
    // `PageLayout` hides its children behind an access check, and the standalone
    // editor has no /auth endpoint to answer it: there is one local user, who is
    // the administrator.
    authStore.userRole = UserRole.Admin;

    const daliBackend = new PyodideDaliBackend({
      onLog: (text) => setBootLog((lines) => [...lines.slice(-200), text]),
    });
    const mqttClient = new BrowserMqttClient(daliBackend);
    return {
      backend: daliBackend,
      store: new DaliStore(makeWhenMqttReady(mqttClient), makeDaliProxy(daliBackend), mqttClient),
    };
  }, []);

  useEffect(() => {
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

  if (bootError || !isBooted) {
    return <BootProgress error={bootError} log={bootLog} />;
  }

  return <DaliPage store={store} />;
};
