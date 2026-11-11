import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  isThemeChoice,
  readThemeChoice,
  resolveTheme,
  storeThemeChoice,
  type ThemeStorage,
} from '../src/lib/theme.ts';

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

describe('theme preference', () => {
  it('follows the system until the visitor picks something', () => {
    expect(readThemeChoice(memoryStorage())).toBe('system');
    expect(readThemeChoice(null)).toBe('system');
  });

  it('survives a value that is not a choice (old build, hand-edited storage)', () => {
    expect(readThemeChoice(memoryStorage({ 'picprivacy.theme': 'sepia' }))).toBe('system');
  });

  it('round-trips every choice', () => {
    for (const choice of ['system', 'light', 'dark'] as const) {
      const storage = memoryStorage();
      storeThemeChoice(choice, storage);
      expect(storage.values['picprivacy.theme']).toBe(choice);
      expect(readThemeChoice(storage)).toBe(choice);
    }
  });

  it('treats a throwing storage as a first visit instead of crashing', () => {
    const broken: ThemeStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readThemeChoice(broken)).toBe('system');
    expect(() => storeThemeChoice('dark', broken)).not.toThrow();
  });

  it('resolves system against the OS, and pins the rest', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('narrows untrusted values', () => {
    expect(isThemeChoice('dark')).toBe(true);
    expect(isThemeChoice('Dark')).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });
});

describe('applying the theme', () => {
  it('writes data-theme on the root element', () => {
    const root = { dataset: {} } as unknown as HTMLElement;
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
  });
});
