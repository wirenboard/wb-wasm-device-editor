import { observer } from 'mobx-react-lite';
import type { PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
import { consolePanelStore } from '@/stores/console-panel';
import { closeDali } from '../../../navigation';
import type { DaliGateway } from '../../gateways';
import './styles.css';

interface DaliShellProps {
  /** The WB-DALI modules the Modbus scan found. */
  gateways: DaliGateway[];
}

/**
 * A strip above the DALI page carrying the two things the homeui page cannot
 * provide on its own: a way back to the Modbus editor, and which module the
 * bus hangs off.
 */
export const DaliShell = observer(({ gateways, children }: PropsWithChildren<DaliShellProps>) => {
  const { t } = useTranslation();

  return (
    <div className="daliShell">
      <div className="daliShell-bar">
        <Button
          label={t('dali-wasm.buttons.back')}
          variant="secondary"
          size="small"
          onClick={closeDali}
        />
        {gateways.length > 0 && (
          <span className="daliShell-gateway">
            {t('dali-wasm.labels.mode-gateway', { name: gateways[0].id })}
          </span>
        )}
        {/* In homeui the console panel is reopened from the app navigation,
            which this editor does not have — without this button the panel's
            own close cross would be a one-way door. */}
        <Button
          className="daliShell-debug"
          label={t('dali.labels.bus-monitor')}
          variant={consolePanelStore.isVisible ? 'primary' : 'secondary'}
          size="small"
          aria-pressed={consolePanelStore.isVisible}
          onClick={() => consolePanelStore.toggleVisibility()}
        />
      </div>
      <div className="daliShell-page">{children}</div>
    </div>
  );
});
