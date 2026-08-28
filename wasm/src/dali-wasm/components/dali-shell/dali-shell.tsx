import type { PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
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
export const DaliShell = ({ gateways, children }: PropsWithChildren<DaliShellProps>) => {
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
      </div>
      <div className="daliShell-page">{children}</div>
    </div>
  );
};
