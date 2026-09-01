import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/components/alert';
import { Button } from '@/components/button';
import { Loader } from '@/components/loader';
import { PageLayout } from '@/layouts/page';
import './styles.css';

interface BootProgressProps {
  /** Set once the runtime has failed to start; the log is then the diagnosis. */
  error?: string | null;
  log: string[];
  /** Throw the failed runtime away and boot a fresh one. */
  onRetry?: () => void;
}

/**
 * The likely cause of a boot failure, as a translation key.
 *
 * The raw error is a Python traceback — accurate, but useless to someone whose
 * actual problem is an unpowered module or a flaky download. Recognize the two
 * failure shapes that have real-world fixes and say the fix; anything else
 * stays diagnosis-by-log.
 */
function hintFor(error: string): string | null {
  if (/timed out|Port IO error|no response|NetworkError writing|port is closed/i.test(error)) {
    return 'dali-wasm.labels.boot-hint-timeout';
  }
  if (/failed to fetch|content-length|truncated|deadline|CompileError|NetworkError/i.test(error)) {
    return 'dali-wasm.labels.boot-hint-network';
  }
  return null;
}

/**
 * Shown while the DALI runtime starts.
 *
 * Booting means fetching ~10 MB of Python runtime, unpacking it and starting
 * the daemon — several seconds on a first visit. A bare spinner for that long
 * reads as a hang, so the daemon's own log is shown as it happens, and stays
 * visible as the diagnosis if the boot fails.
 */
export const BootProgress = ({ error, log, onRetry }: BootProgressProps) => {
  const { t } = useTranslation();
  const hint = error ? hintFor(error) : null;
  const logRef = useRef<HTMLPreElement>(null);
  // Follow the tail, unless the reader has scrolled up.
  const pinned = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [log, error]);

  return (
    // Not PageLayout's own isLoading: that renders the spinner INSTEAD of the
    // children, which is precisely the bare-spinner-hiding-the-log experience
    // this component exists to avoid.
    <PageLayout title={t('dali.title')} hasRights>
      {error && (
        <Alert variant="danger">
          <div>{t('dali-wasm.labels.boot-failed')}</div>
          {hint && <div className="daliBoot-hint">{t(hint)}</div>}
        </Alert>
      )}
      {error && onRetry && (
        <div className="daliBoot-retry">
          <Button label={t('dali-wasm.buttons.retry')} variant="primary" onClick={onRetry} />
        </div>
      )}
      {!error && (
        <div className="daliBoot-loader">
          <Loader />
        </div>
      )}
      {(error || log.length > 0) && (
        <pre
          ref={logRef}
          className="daliBoot-log"
          onScroll={(event) => {
            const el = event.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {[...log, error].filter(Boolean).join('\n')}
        </pre>
      )}
    </PageLayout>
  );
};
