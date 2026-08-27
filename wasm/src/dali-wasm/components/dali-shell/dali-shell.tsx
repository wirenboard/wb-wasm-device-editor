import type { PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
import { closeDali } from '../../../navigation';
import './styles.css';

/**
 * A strip above the DALI page carrying the two things the homeui page cannot
 * provide on its own: a way back to the Modbus editor, and a statement that the
 * bus is simulated — without which a scan finding four luminaires on a machine
 * with no hardware attached is thoroughly misleading.
 */
export const DaliShell = ({ children }: PropsWithChildren) => {
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
        <span className="daliShell-notice">{t('dali-wasm.labels.simulated')}</span>
      </div>
      <div className="daliShell-page">{children}</div>
    </div>
  );
};
