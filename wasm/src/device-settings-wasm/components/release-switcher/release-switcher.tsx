import { useTranslation } from 'react-i18next';
import './styles.css';

type Release = 'stable' | 'testing';

interface ReleaseSwitcherProps {
  nextRelease: Release;
  onClick: () => void;
}

export const ReleaseSwitcher = ({ nextRelease, onClick }: ReleaseSwitcherProps) => {
  const { t } = useTranslation();
  return (
    <a
      className="releaseSwitcher"
      href="#"
      onClick={(e) => { e.preventDefault(); onClick(); }}
    >
      {t(`wasm.release.switch-to-${nextRelease}-link`)}
    </a>
  );
};
