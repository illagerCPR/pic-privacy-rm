import type { ReactNode } from 'react';
import { useTheme } from '../hooks/useTheme.ts';
import { useI18n } from '../i18n/index.tsx';
import type { MessageKey } from '../i18n/zh.ts';
import type { ThemeChoice } from '../lib/theme.ts';
import { GithubIcon, MonitorIcon, MoonIcon, ShieldIcon, SunIcon } from './Icons.tsx';

const THEMES: { value: ThemeChoice; label: MessageKey; icon: ReactNode }[] = [
  { value: 'system', label: 'theme.system', icon: <MonitorIcon size={15} /> },
  { value: 'light', label: 'theme.light', icon: <SunIcon size={15} /> },
  { value: 'dark', label: 'theme.dark', icon: <MoonIcon size={15} /> },
];

export function Header({ onOpenPrivacy }: { onOpenPrivacy: () => void }) {
  const { t, lang, setLang } = useI18n();
  const theme = useTheme();

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
          <div className="theme-switch" role="group" aria-label={t('theme.label')}>
            {THEMES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={theme.choice === option.value ? 'is-active' : ''}
                aria-pressed={theme.choice === option.value}
                aria-label={t(option.label)}
                title={t(option.label)}
                onClick={() => theme.setChoice(option.value)}
              >
                {option.icon}
              </button>
            ))}
          </div>
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
