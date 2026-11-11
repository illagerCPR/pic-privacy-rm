/**
 * Colour-theme preference.
 *
 * The palette itself lives in CSS, keyed on `data-theme` on the root element,
 * with the system preference as the default through `prefers-color-scheme`.
 * This module only decides which of the three choices is in effect and writes
 * the attribute; keeping the DOM side here (and taking the root as an argument)
 * lets the logic be unit-tested without a browser.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'picprivacy.theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    /* blocked storage (private mode, disabled cookies) */
    return null;
  }
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readThemeChoice(storage: ThemeStorage | null = browserStorage()): ThemeChoice {
  try {
    const stored = storage?.getItem(STORAGE_KEY) ?? null;
    if (isThemeChoice(stored)) return stored;
  } catch {
    /* unreadable storage behaves like a first visit */
  }
  return 'system';
}

export function storeThemeChoice(
  choice: ThemeChoice,
  storage: ThemeStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, choice);
  } catch {
    /* the choice still applies for this session */
  }
}

/** `system` follows the OS; the other two pin the palette regardless of it. */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

export function applyTheme(theme: ResolvedTheme, root?: HTMLElement): void {
  const element = root ?? document.documentElement;
  element.dataset['theme'] = theme;
}

/**
 * Apply the stored choice before the first render, so a page whose owner picked
 * the opposite of their OS theme does not start out in the wrong palette.
 */
export function applyStoredTheme(): void {
  applyTheme(resolveTheme(readThemeChoice(), systemPrefersDark()));
}
