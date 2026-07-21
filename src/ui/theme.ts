/**
 * Initializes the light/dark appearance control and persists the user's explicit preference.
 * The module assumes the application shell has already mounted the stable `themeToggle` button.
 */

import { getElement } from './dom';

type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'threat-emulator-theme';

/**
 * Applies the stored theme and binds the header control for page-lifetime theme changes.
 * Browsers that deny local storage still support switching for the current page session.
 * @returns Nothing.
 */
export function initializeThemeToggle(): void {
  const toggle = getElement<HTMLButtonElement>('themeToggle');
  let theme = readStoredTheme();

  const applyTheme = (): void => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    toggle.setAttribute('aria-pressed', String(theme === 'dark'));
    toggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
    toggle.title = `Switch to ${nextTheme} theme`;
  };

  toggle.addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    applyTheme();
    storeTheme(theme);
  });

  applyTheme();
}

/**
 * Reads a previously selected theme, falling back to the light theme for a first visit.
 * @returns A supported application theme.
 */
function readStoredTheme(): Theme {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Persists a theme preference when browser storage is available.
 * @param theme - Supported theme selected by the user.
 * @returns Nothing.
 */
function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching remains useful when privacy settings make storage unavailable.
  }
}
