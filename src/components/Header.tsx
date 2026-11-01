import { useI18n } from '../i18n/index.tsx';
import { GithubIcon, ShieldIcon } from './Icons.tsx';

export function Header({ onOpenPrivacy }: { onOpenPrivacy: () => void }) {
  const { t, lang, setLang } = useI18n();

  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <a className="brand" href="./" aria-label="PicPrivacy">
          <span className="brand-mark">
            <ShieldIcon size={21} />
          </span>
          <span className="brand-name">PicPrivacy</span>
        </a>
        <nav className="header-nav">
          <button type="button" className="nav-link" onClick={onOpenPrivacy}>
            {t('nav.privacy')}
          </button>
          <a
            className="nav-link nav-link--icon"
            href="https://github.com/illagerCPR/pic-privacy-rm"
            target="_blank"
            rel="noreferrer noopener"
          >
            <GithubIcon size={17} />
            <span>{t('nav.github')}</span>
          </a>
          <div className="lang-switch" role="group" aria-label={t('nav.lang')}>
            <button
              type="button"
              className={lang === 'zh' ? 'is-active' : ''}
              aria-pressed={lang === 'zh'}
              onClick={() => setLang('zh')}
            >
              中
            </button>
            <button
              type="button"
              className={lang === 'en' ? 'is-active' : ''}
              aria-pressed={lang === 'en'}
              onClick={() => setLang('en')}
            >
              EN
            </button>
          </div>
        </nav>
      </div>
    </header>
  );
}
