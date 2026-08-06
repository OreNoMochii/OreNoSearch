import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'ui_theme';

function readStoredChoice(): ThemeChoice {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies the choice to the document.
 *
 * `system` REMOVES the attribute rather than writing the resolved value, which
 * is what lets the `prefers-color-scheme` block in index.css take over. Writing
 * the resolved value instead would pin the theme at page load and stop it
 * following the OS when the user flips their system setting mid-session.
 */
function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export interface Theme {
  /** What the user picked, including 'system'. */
  choice: ThemeChoice;
  /** What that actually resolves to right now. */
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
  /**
   * Advances system → light → dark → system.
   *
   * A plain light/dark flip would make 'system' unreachable after the first
   * click: nothing in the UI could ever hand control back to the OS, and the
   * only way out would be clearing localStorage.
   */
  cycle: () => void;
}

const NEXT_CHOICE: Record<ThemeChoice, ThemeChoice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export function useTheme(): Theme {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStoredChoice());
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(() => systemTheme());

  // Follow the OS while the choice is 'system'. The listener stays attached
  // regardless so that switching back to 'system' is immediately correct.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemResolved(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    apply(choice);
  }, [choice]);

  // A theme picked in another tab should not leave this one disagreeing.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setChoiceState(readStoredChoice());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    localStorage.setItem(STORAGE_KEY, next);
    setChoiceState(next);
  }, []);

  const resolved: ResolvedTheme = choice === 'system' ? systemResolved : choice;

  const cycle = useCallback(() => {
    setChoice(NEXT_CHOICE[choice]);
  }, [choice, setChoice]);

  return { choice, resolved, setChoice, cycle };
}
