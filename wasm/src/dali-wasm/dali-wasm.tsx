import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { Alert } from '@/components/alert';
import { ConsolePanel } from '@/components/console-panel';
import { PageLayout } from '@/layouts/page';
import DaliPage from '@/pages/settings/configs/dali';
// Imported from the concrete module, not the bus-monitor barrel: the barrel
// is imported by daliGlobalStore, and the empty state imports that store —
// routing through the barrel would close an import cycle.
import { DaliMonitorEmptyState } from '@/pages/settings/configs/dali/components/bus-monitor/monitor-empty-state';
import { authStore, UserRole } from '@/stores/auth';
import { consolePanelStore } from '@/stores/console-panel';
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
// One live runtime per set of gateways, surviving view switches (see the
// unmount comment below for why). Replaced — with the old one disposed — only
// when a rescan changes the gateways.
let liveBackend: { key: string; backend: PyodideDaliBackend } | null = null;

function obtainBackend(
  scenario: ReturnType<typeof scenarioForGateways>,
  onLog: (text: string) => void,
): PyodideDaliBackend {
  const key = JSON.stringify(scenario);
  if (liveBackend && liveBackend.key === key && !liveBackend.backend.isDefunct) {
    return liveBackend.backend;
  }
  liveBackend?.backend.dispose();
  liveBackend = { key, backend: new PyodideDaliBackend({ scenario, onLog }) };
  return liveBackend.backend;
}

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
  // Bumped by the retry button after a failed boot; a new value makes the
  // backend memo run again, and `obtainBackend` replaces the defunct runtime.
  const [bootNonce, setBootNonce] = useState(0);

  const hasGateway = gateways.length > 0;

  // The daemon must not start before a serial port exists; see PortGate.
  const needsPort = hasPort !== true;
  const asksForPort = hasPort === false;

  useEffect(() => {
    if (!hasGateway || hasPort) {
      return undefined;
    }
    // A simulated gateway (slave id 250, see wbdali_browser.browser) is not
    // behind any serial port — the e2e suite and demos boot straight through.
    if (gateways.every((gateway) => gateway.slaveId === 250)) {
      setHasPort(true);
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
    // The retry button's only lever: a new nonce makes this memo run again,
    // and `obtainBackend` then replaces the defunct runtime with a fresh one.
    void bootNonce;
    if (!hasGateway || needsPort) {
      return null;
    }

    // `PageLayout` hides its children behind an access check, and the standalone
    // editor has no /auth endpoint to answer it: there is one local user, who is
    // the administrator.
    authStore.userRole = UserRole.Admin;

    return obtainBackend(
      scenarioForGateways(gateways),
      (text) => {
        // The boot pane keeps only the tail and disappears once the page is
        // up; the console keeps the daemon's whole story for field debugging.
        console.debug('[dali]', text);
        setBootLog((lines) => [...lines.slice(-200), text]);
      },
    );
  }, [hasGateway, needsPort, gateways, bootNonce]);

  const retryBoot = () => {
    // The failed backend is defunct but still cached; drop it so the next
    // obtainBackend builds a fresh one even if its failure flag was not set.
    liveBackend?.backend.dispose();
    liveBackend = null;
    setBootError(null);
    setBooted(false);
    setBootLog([]);
    setBootNonce((nonce) => nonce + 1);
  };

  useEffect(() => {
    if (!backend) {
      return undefined;
    }
    let cancelled = false;
    mqttClient.attach(backend);
    backend.ready.then(
      () => !cancelled && setBooted(true),
      (error) => !cancelled && setBootError(String(error?.message ?? error)),
    );

    return () => {
      cancelled = true;
      // Detach the page, keep the runtime: the daemon's knowledge of the bus —
      // every memory bank read, every probed feature, a first device-page open
      // worth 400+ frames of real serial time — lives in its memory and dies
      // with it. Navigating to the Modbus editor and back now costs nothing;
      // the worker is only replaced when the gateways change, and dies with
      // the tab. Its background polling shares the serial port transaction by
      // transaction with the editor, which the request queue already
      // serializes.
      mqttClient.detach(backend);
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
        <BootProgress error={bootError} log={bootLog} onRetry={retryBoot} />
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
            {consolePanelStore.isVisible && <ConsolePanel emptyState={<DaliMonitorEmptyState />} />}
          </div>
        </MemoryRouter>
      )}
    </DaliShell>
  );
});
