import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { ConsolePanel } from '@/components/console-panel';
import DaliPage from '@/pages/settings/configs/dali';
import { authStore, UserRole } from '@/stores/auth';
import { consolePanelStore } from '@/stores/console-panel';
import { Alert } from '@/components/alert';
import { PageLayout } from '@/layouts/page';
import { BootProgress } from './components/boot-progress';
import { DaliShell } from './components/dali-shell';
import { PortGate } from './components/port-gate';
import { loadRememberedGateways, scenarioForGateways } from './gateways';
import { mqttClient } from './mqtt-client';
import { PyodideDaliBackend } from './pyodide-backend';
import './styles.css';

/**
 * The homeui DALI configuration page, backed by wb-mqtt-dali running in a
 * Pyodide worker instead of on a controller.
 *
 * The page takes no props: it reaches its transport through homeui's own module
 * singletons, and the one that matters — `mqttClient` — is substituted at build
 * time for a loopback client (see `redirectHomeuiMqttClient` in
 * vite.config.ts). So the page, its stores and its RPC proxy are used
 * unmodified. What this component does is start the runtime, point the client
 * at it, and supply the two pieces of app chrome the page expects around it: a
 * router, and the console panel its bus monitor docks into.
 */
export const DaliWasm = observer(() => {
  const { t } = useTranslation();
  // What the Modbus scan found. The daemon has nothing to talk to without a
  // gateway, so with none remembered — reached by URL, or with nothing plugged
  // in — the page explains itself instead of booting.
  const gateways = useMemo(loadRememberedGateways, []);
  // `null` while the silently-granted port is still being probed for — which
  // waits on the WASM module download, seconds on a slow link. Showing the
  // "choose a port" ask during that wait would put a request to act in front
  // of someone whose port is, in the common case, already granted.
  const [hasPort, setHasPort] = useState<boolean | null>(null);
  const [bootLog, setBootLog] = useState<string[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [isBooted, setBooted] = useState(false);

  const hasGateway = gateways.length > 0;

  // The daemon must not start before a serial port exists; see PortGate.
  const needsPort = hasPort !== true;
  const asksForPort = hasPort === false;

  useEffect(() => {
    if (!hasGateway || hasPort) {
      return undefined;
    }
    // The probe below waits on the WASM module, which on a cold load is a
    // multi-megabyte download — the longest silent stretch of the whole boot.
    // Narrate it rather than sit behind a spinner.
    const unsubscribe = Module.onLoadingProgress?.((progress: { percent: number }) => {
      setBootLog([`Loading the serial module… ${progress.percent}%`]);
    });
    // The scan that found the gateway already opened a port. Asking for it
    // again would put a chooser in front of someone who has just chosen.
    Module.isReady
      .then(() => Module.serial.select(false))
      .then(() => setHasPort(true))
      .catch(() => setHasPort(false));
    return () => unsubscribe?.();
  }, [hasGateway, hasPort]);

  const backend = useMemo(() => {
    if (!hasGateway || needsPort) {
      return null;
    }

    // `PageLayout` hides its children behind an access check, and the standalone
    // editor has no /auth endpoint to answer it: there is one local user, who is
    // the administrator.
    authStore.userRole = UserRole.Admin;

    return new PyodideDaliBackend({
      scenario: scenarioForGateways(gateways),
      onLog: (text) => setBootLog((lines) => [...lines.slice(-200), text]),
    });
  }, [hasGateway, needsPort, gateways]);

  useEffect(() => {
    if (!backend) {
      return undefined;
    }
    let cancelled = false;
    mqttClient.attach(backend);
    backend.ready.then(
      () => !cancelled && setBooted(true),
      (error) => !cancelled && setBootError(String(error?.message ?? error))
    );

    return () => {
      cancelled = true;
      mqttClient.detach(backend);
      backend.dispose();
    };
  }, [backend]);

  return (
    <DaliShell gateways={gateways}>
      {!hasGateway && (
        <PageLayout title={t('dali.title')} hasRights>
          <Alert variant="info">{t('dali-wasm.labels.no-gateway')}</Alert>
        </PageLayout>
      )}
      {hasGateway && asksForPort && <PortGate onSelected={() => setHasPort(true)} />}
      {hasGateway && !asksForPort && (needsPort || bootError || !isBooted) && (
        <BootProgress error={bootError} log={bootLog} />
      )}
      {hasGateway && !needsPort && !bootError && isBooted && (
        <MemoryRouter>
          <div
            className={classNames('daliWasm', {
              'daliWasm-consoleRight': consolePanelStore.position === 'right',
            })}
          >
            <div className="daliWasm-page">
              <DaliPage />
            </div>
            {consolePanelStore.isVisible && <ConsolePanel />}
          </div>
        </MemoryRouter>
      )}
    </DaliShell>
  );
});
