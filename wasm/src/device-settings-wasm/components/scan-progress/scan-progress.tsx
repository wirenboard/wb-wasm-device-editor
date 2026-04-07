import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button';
import { Checkbox } from '@/components/checkbox';
import { Progress } from '@/components/progress';

interface ScanProgressProps {
  isPortScanning: boolean;
  isBootScanning: boolean;
  progress: number;
  scanMessage: string;
  scanCount: number;
  bootScanProgress: number;
  bootScanMessage: string;
  bootScanCount: number;
  bootScanType: string;
  bootScanRequestedRef: React.MutableRefObject<boolean>;
  onStopBootScan: () => void;
}

export const ScanProgress = ({
  isPortScanning,
  isBootScanning,
  progress,
  scanMessage,
  scanCount,
  bootScanProgress,
  bootScanMessage,
  bootScanCount,
  bootScanType,
  bootScanRequestedRef,
  onStopBootScan,
}: ScanProgressProps) => {
  const { t } = useTranslation();

  if (isPortScanning && !isBootScanning) {
    return (
      <>
        <Progress value={progress} caption={progress.toFixed() + '%'} />
        <div className="deviceSettingsWasm-scanning">{t('wasm.labels.scanning', { message: scanMessage })}</div>
        {!!scanCount && <div className="deviceSettingsWasm-scanning">{t('wasm.labels.found-devices', { count: scanCount })}…</div>}
        <div className="deviceSettingsWasm-scanActions">
          <Checkbox
            checked={bootScanRequestedRef.current}
            title={t('wasm.labels.boot-scan')}
            onChange={(checked) => { bootScanRequestedRef.current = checked; }}
          />
        </div>
      </>
    );
  }

  if (isBootScanning) {
    const label = bootScanType === 'broadcast'
      ? t('wasm.labels.boot-scan-broadcast', { message: bootScanMessage })
      : t('wasm.labels.boot-scanning', { message: bootScanMessage });

    return (
      <>
        <Progress value={bootScanProgress} caption={bootScanProgress.toFixed() + '%'} />
        <div className="deviceSettingsWasm-scanning">{label}</div>
        {!!bootScanCount && <div className="deviceSettingsWasm-scanning">{t('wasm.labels.found-devices', { count: bootScanCount })}…</div>}
        <div className="deviceSettingsWasm-scanActions">
          <Button label={t('wasm.buttons.stop')} size="small" variant="secondary" onClick={onStopBootScan} />
        </div>
      </>
    );
  }

  return null;
};
