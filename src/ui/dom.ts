/**
 * Provides typed DOM lookup, template mounting, and cloning helpers for the application UI.
 * The helpers assume `app.html` owns the stable element and template IDs used by controllers.
 */

import appMarkup from './app.html?raw';

/**
 * Mounts the declarative HTML application shell into the Vite host page.
 * @returns Nothing.
 * @throws {Error} When the host page does not contain the expected `#app` element.
 */
export function mountAppShell(): void {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) {
    throw new Error('Missing application host: #app');
  }
  root.innerHTML = appMarkup;
}

/**
 * Resolves an application element by ID with a caller-selected element type.
 * @param id - Stable ID declared in the application HTML template.
 * @returns The resolved element.
 * @throws {Error} When the element is missing.
 */
export function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return element as T;
}

/**
 * Sets safe plain-text content on an application element.
 * @param id - Stable ID declared in the application HTML template.
 * @param value - Text to display.
 * @returns Nothing.
 * @throws {Error} When the element is missing.
 */
export function setText(id: string, value: string): void {
  getElement(id).textContent = value;
}

/**
 * Clones the first root element from a native HTML template.
 * @param id - ID of the template to clone.
 * @returns A detached, typed clone of the template root.
 * @throws {Error} When the template or its root element is missing.
 */
export function cloneTemplate<T extends Element>(id: string): T {
  const template = getElement<HTMLTemplateElement>(id);
  const root = template.content.firstElementChild;
  if (!root) {
    throw new Error(`UI template has no root element: ${id}`);
  }
  return root.cloneNode(true) as T;
}
