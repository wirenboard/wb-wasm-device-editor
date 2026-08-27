import type { PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
import { Dropdown, type Option } from '@/components/dropdown';
import { closeDali } from '../../../navigation';
import type { DaliMode } from '../../pyodide-backend';
import './styles.css';

interface DaliShellProps {
  mode: DaliMode;
  onModeChange: (mode: DaliMode) => void;
}

/**
 * A strip above the DALI page carrying the two things the homeui page cannot
 * provide on its own: a way back to the Modbus editor, and where the bus is.
 *
 * Saying which bus is in use matters: a scan that finds four luminaires on a
 * machine with nothing plugged in is thoroughly misleading otherwise.
 */
export const DaliShell = ({ mode, onModeChange, children }: PropsWithChildren<DaliShellProps>) => {
  const { t } = useTranslation();

  const options: Option<DaliMode>[] = [
    { value: 'simulated', label: t('dali-wasm.labels.mode-simulated') },
    { value: 'hardware', label: t('dali-wasm.labels.mode-hardware') },
  ];

  return (
    <div className="daliShell">
      <div className="daliShell-bar">
        <Button
          label={t('dali-wasm.buttons.back')}
          variant="secondary"
          size="small"
          onClick={closeDali}
        />
        <Dropdown
          className="daliShell-mode"
          ariaLabel={t('dali-wasm.labels.mode')}
          options={options}
          value={mode}
          size="small"
          isSearchable={false}
          onChange={(option: Option<DaliMode>) => onModeChange(option.value as DaliMode)}
        />
        {mode === 'simulated' && (
          <span className="daliShell-notice">{t('dali-wasm.labels.simulated')}</span>
        )}
      </div>
      <div className="daliShell-page">{children}</div>
    </div>
  );
};
