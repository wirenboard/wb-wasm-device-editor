import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import { Loader } from '@/components/loader';
import { PageLayout } from '@/layouts/page';
import './styles.css';

interface BootProgressProps {
  /** Set once the runtime has failed to start; the log is then the diagnosis. */
  error?: string | null;
  log: string[];
}

/**
 * Shown while the DALI runtime starts.
 *
 * Booting means fetching ~10 MB of Python runtime, unpacking it and starting
 * the daemon — several seconds on a first visit. A bare spinner for that long
 * reads as a hang, so the daemon's own log is shown as it happens, and stays
 * visible as the diagnosis if the boot fails.
 */
export const BootProgress = ({ error, log }: BootProgressProps) => {
  const { t } = useTranslation();

  return (
    // Not PageLayout's own isLoading: that renders the spinner INSTEAD of the
    // children, which is precisely the bare-spinner-hiding-the-log experience
    // this component exists to avoid.
    <PageLayout title={t('dali.title')} hasRights>
      {error && <Alert variant="danger">{t('dali-wasm.labels.boot-failed')}</Alert>}
      {!error && (
        <div className="daliBoot-loader">
          <Loader />
        </div>
      )}
      {(error || log.length > 0) && (
        <pre className="daliBoot-log">{[...log, error].filter(Boolean).join('\n')}</pre>
      )}
    </PageLayout>
  );
};
