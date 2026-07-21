/**
 * Verifies theme restoration, toggle state, and local persistence without requiring a browser DOM.
 * The test supplies only the document, button, and storage contracts used by the theme initializer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeThemeToggle } from './theme';

describe('theme toggle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores dark mode and persists switching back to light mode', () => {
    const clickHandlers: Array<() => void> = [];
    const attributes = new Map<string, string>();
    const button = {
      title: '',
      setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
      addEventListener: vi.fn((eventName: string, handler: () => void) => {
        if (eventName === 'click') {
          clickHandlers.push(handler);
        }
      })
    };
    const documentElement = { dataset: {} as Record<string, string> };
    const localStorage = {
      getItem: vi.fn(() => 'dark'),
      setItem: vi.fn()
    };

    vi.stubGlobal('document', {
      documentElement,
      getElementById: vi.fn(() => button)
    });
    vi.stubGlobal('window', { localStorage });

    initializeThemeToggle();

    expect(documentElement.dataset.theme).toBe('dark');
    expect(attributes.get('aria-pressed')).toBe('true');
    expect(attributes.get('aria-label')).toBe('Switch to light theme');
    expect(button.title).toBe('Switch to light theme');

    const clickHandler = clickHandlers[0];
    if (!clickHandler) {
      throw new Error('Theme toggle did not register a click handler.');
    }
    clickHandler();

    expect(documentElement.dataset.theme).toBe('light');
    expect(attributes.get('aria-pressed')).toBe('false');
    expect(attributes.get('aria-label')).toBe('Switch to dark theme');
    expect(button.title).toBe('Switch to dark theme');
    expect(localStorage.setItem).toHaveBeenCalledWith('threat-emulator-theme', 'light');
  });
});
