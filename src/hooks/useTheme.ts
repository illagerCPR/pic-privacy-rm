import { useCallback, useEffect, useState } from 'react';
import {
  DARK_QUERY,
  applyTheme,
  readThemeChoice,
  resolveTheme,
  storeThemeChoice,
  systemPrefersDark,
  type ResolvedTheme,
  type ThemeChoice,
} from '../lib/theme.ts';

export interface Theme {
  choice: ThemeChoice;
  /** What `choice` currently resolves to, for the pressed state of the switch. */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

/**
 * Keeps `data-theme` on the root element in sync with the stored choice, and
 * re-resolves when the OS switches between light and dark while the choice is
 * `system`.
 */
export function useTheme(): Theme {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice());
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolved = resolveTheme(choice, systemDark);

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    storeThemeChoice(next);
  }, []);

  return { choice, resolved, setChoice };
}
