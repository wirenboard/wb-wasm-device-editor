import { useTranslation } from 'react-i18next';
import type { GatewayStore } from '@/stores/dali';
import { loadRememberedGateways } from '../../gateways';
import './styles.css';

/**
 * The gateway page, replacing homeui's (see the redirect in vite.config.ts).
 *
 * homeui's gateway tab is one thing: the Lunatone DALI-2 IoT Gateway emulator —
 * a toggle that starts a WebSocket *server* for DALI Cockpit to connect to. A
 * page cannot listen for connections, so in this app the toggle could only ever
 * fail, and it is also the first thing a visitor would see: homeui selects the
 * gateway node on entry. What is useful here instead is what this app knows
 * about the module the scan found, and where to go next.
 */
export const GatewayTabContent = ({ store }: { store: GatewayStore }) => {
  const { t } = useTranslation();
  const gateway = loadRememberedGateways().find((entry) => entry.id === store.id);

  return (
    <div className="daliGatewayTab">
      {gateway ? (
        <dl className="daliGatewayTab-facts">
          <dt>{t('dali-wasm.labels.gateway-type')}</dt>
          <dd>{gateway.deviceType}</dd>
          <dt>{t('dali-wasm.labels.gateway-address')}</dt>
          <dd>{gateway.slaveId}</dd>
          <dt>{t('dali-wasm.labels.gateway-line')}</dt>
          <dd>
            {gateway.serial.baud_rate}{' '}
            {gateway.serial.data_bits}{gateway.serial.parity}{gateway.serial.stop_bits}
          </dd>
        </dl>
      ) : null}
      <p className="daliGatewayTab-hint">{t('dali-wasm.labels.gateway-hint')}</p>
    </div>
  );
};
