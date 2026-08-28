import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ConsolePanel } from '@/components/console-panel';
import DaliPage from '@/pages/settings/configs/dali';
import { authStore, UserRole } from '@/stores/auth';
import { consolePanelStore } from '@/stores/console-panel';
import { BootProgress } from './components/boot-progress';
import { DaliShell } from './components/dali-shell';
import { PortGate } from './components/port-gate';
import { loadRememberedGateways, scenarioForGateways } from './gateways';
import { mqttClient } from './mqtt-client';
import { loadMode, saveMode } from './persistence';
import { PyodideDaliBackend, type DaliMode } from './pyodide-backend';
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
  // What the Modbus scan found. With a gateway in hand the daemon talks to it;
  // without one — reached by URL, or with nothing plugged in — there is still
  // the simulated installation to work against.
  const gateways = useMemo(loadRememberedGateways, []);
  // Arriving from a found gateway, that gateway is the point; the simulated bus
  // is what is left when there is nothing connected.
  const [mode, setMode] = useState<DaliMode>(
    () => loadMode() ?? (gateways.length ? 'hardware' : 'simulated')
  );
  const [hasPort, setHasPort] = useState(false);
  const [bootLog, setBootLog] = useState<string[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [isBooted, setBooted] = useState(false);

  // On real hardware the daemon must not start before a serial port exists; see
  // PortGate. In simulation there is nothing to choose.
  const needsPort = mode === 'hardware' && !hasPort;

  useEffect(() => {
    if (mode !== 'hardware' || hasPort) {
      return;
    }
    // The scan that found the gateway already opened a port. Asking for it
    // again would put a chooser in front of someone who has just chosen.
    Module.isReady
      .then(() => Module.serial.select(false))
      .then(() => setHasPort(true))
      .catch(() => setHasPort(false));
  }, [mode, hasPort]);

  const backend = useMemo(() => {
    if (needsPort) {
      return null;
    }

    // `PageLayout` hides its children behind an access check, and the standalone
    // editor has no /auth endpoint to answer it: there is one local user, who is
    // the administrator.
    authStore.userRole = UserRole.Admin;

    return new PyodideDaliBackend({
      mode,
      // In hardware mode the installation is the one the scan found; in
      // simulation the runtime supplies its own.
      scenario: mode === 'hardware' && gateways.length
        ? scenarioForGateways(gateways)
        : undefined,
      onLog: (text) => setBootLog((lines) => [...lines.slice(-200), text]),
    });
  }, [mode, needsPort, gateways]);

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
    <DaliShell mode={mode} onModeChange={changeMode} gateways={gateways}>
      {needsPort && <PortGate onSelected={() => setHasPort(true)} />}
      {!needsPort && (bootError || !isBooted) && <BootProgress error={bootError} log={bootLog} />}
      {!needsPort && !bootError && isBooted && (
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
