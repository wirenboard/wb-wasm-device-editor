import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { EmbeddedSoftwarePanel } from '@/pages/settings/device-manager';

interface BootloaderDeviceViewProps {
  selectedDevice: number;
  fwSignature: string;
  embeddedSoftware: any;
  isRestoring: boolean;
  onRestore: () => void;
}

export const BootloaderDeviceView = ({
  selectedDevice,
  fwSignature,
  embeddedSoftware,
  isRestoring,
  onRestore,
}: BootloaderDeviceViewProps) => {
  const { t } = useTranslation();

  return (
    <>
      <header className="deviceSettingsWasm-header">
        <h3 className="deviceSettingsWasm-title">{selectedDevice} {fwSignature}</h3>
      </header>
      <EmbeddedSoftwarePanel
        embeddedSoftware={embeddedSoftware}
        onUpdateFirmware={() => { }}
        onUpdateBootloader={() => { }}
        onUpdateComponents={() => { }}
      />
      {!embeddedSoftware.isUpdating && (
        <Alert variant="warn" className="hasUpdateAlert">
          <div>
            {t('wasm.labels.bootloader-device')}
          </div>
          <Button
            label={t('wasm.buttons.restore')}
            variant="warn"
            isLoading={isRestoring}
            disabled={isRestoring}
            onClick={onRestore}
          />
        </Alert>
      )}
    </>
  );
};
