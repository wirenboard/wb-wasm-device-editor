import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { PageLayout } from '@/layouts/page';
import './styles.css';

interface PortGateProps {
  onSelected: () => void;
}

/**
 * Asks for a serial port before the daemon starts on real hardware.
 *
 * Booting without one is not merely useless: every DALI command becomes a
 * `port/Load` that reopens the port, the browser's port chooser needs a user
 * gesture it will not get, and the daemon's own retries keep new commands
 * coming. Choosing the port first is also what the Modbus editor does, and both
 * share the same port.
 */
export const PortGate = ({ onSelected }: PortGateProps) => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [isSelecting, setSelecting] = useState(false);

  const selectPort = async () => {
    setSelecting(true);
    setError(null);
    try {
      await Module.isReady;
      await Module.serial.select(true);
      onSelected();
    } catch (selectError) {
      setError(String((selectError as Error)?.message ?? selectError));
    } finally {
      setSelecting(false);
    }
  };

  return (
    <PageLayout title={t('dali.title')} hasRights>
      <div className="daliPortGate">
        <p>{t('dali-wasm.labels.select-port-hint')}</p>
        <Button
          label={t('wasm.buttons.select')}
          variant="primary"
          isLoading={isSelecting}
          onClick={selectPort}
        />
        {error && <Alert variant="danger">{error}</Alert>}
      </div>
    </PageLayout>
  );
};
