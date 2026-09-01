/**
 * Prevents browser-level scaling of the application while leaving Leaflet's own map interactions intact.
 * Page zoom shortcuts are cancelled at the document boundary; map zoom remains owned by Leaflet.
 */

const ZOOM_KEYS = new Set(['+', '-', '=', '_', '0']);

/**
 * Installs guards against browser keyboard, wheel, and Safari gesture zoom.
 * The listeners cancel browser defaults without stopping propagation, allowing Leaflet to keep processing
 * wheel and touch input inside its map container.
 * @param documentTarget - Document receiving application-wide input events.
 * @returns Nothing.
 */
export function initializeApplicationZoomGuard(documentTarget: Document = document): void {
  documentTarget.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && ZOOM_KEYS.has(event.key)) {
      event.preventDefault();
    }
  });

  documentTarget.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    },
    { passive: false }
  );

  documentTarget.addEventListener('gesturestart', (event) => event.preventDefault(), {
    passive: false
  });
}
