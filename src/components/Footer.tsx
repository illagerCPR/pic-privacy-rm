import { useI18n } from '../i18n/index.tsx';
import { GithubIcon, LockIcon } from './Icons.tsx';

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <span className="footer-item">
          <LockIcon size={15} />
          {t('footer.offline')}
        </span>
        <span className="footer-dot" aria-hidden="true">
          ·
        </span>
        <span className="footer-item">{t('footer.license')}</span>
        <span className="footer-dot" aria-hidden="true">
          ·
        </span>
        <a
          className="footer-item footer-link"
          href="https://github.com/illagerCPR/pic-privacy-rm"
          target="_blank"
          rel="noreferrer noopener"
        >
          <GithubIcon size={15} />
          {t('footer.source')}
        </a>
      </div>
    </footer>
  );
}
