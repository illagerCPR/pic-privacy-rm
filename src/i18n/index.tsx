import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from './en.ts';
import { zh, type Dict, type MessageKey } from './zh.ts';

export type Lang = 'en' | 'zh';

const DICTS: Record<Lang, Dict> = { en, zh };

function detectLang(): Lang {
  try {
    const stored = window.localStorage.getItem('picprivacy.lang');
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* private mode */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return nav.startsWith('zh') ? 'zh' : 'en';
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem('picprivacy.lang', next);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback<Translate>(
    (key, params) => {
      const dict = DICTS[lang];
      if (params && params['n'] === 1) {
        const one = dict[`${key}.one` as MessageKey] ?? DICTS.en[`${key}.one` as MessageKey];
        if (one) return interpolate(one, params);
      }
      const template = dict[key] ?? DICTS.en[key] ?? key;
      return interpolate(template, params);
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}

export function useT(): Translate {
  return useI18n().t;
}

export type { MessageKey };
