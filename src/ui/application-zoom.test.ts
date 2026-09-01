/**
 * Verifies that application-level zoom inputs are cancelled without blocking ordinary input or propagation.
 * Tests use DOM-compatible events supplied by Vitest's Node runtime.
 */

import { describe, expect, it, vi } from 'vitest';
import { initializeApplicationZoomGuard } from './application-zoom';

function createInputEvent(type: string, properties: Record<string, unknown> = {}): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(
    event,
    Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [name, { configurable: true, value }])
    )
  );
  return event;
}

describe('application zoom guard', () => {
  it.each(['+', '-', '=', '_', '0'])('blocks Ctrl/Command + %s browser zoom shortcuts', (key) => {
    const documentTarget = new EventTarget() as Document;
    initializeApplicationZoomGuard(documentTarget);
    const ctrlEvent = createInputEvent('keydown', { key, ctrlKey: true });
    const metaEvent = createInputEvent('keydown', { key, metaKey: true });

    documentTarget.dispatchEvent(ctrlEvent);
    documentTarget.dispatchEvent(metaEvent);

    expect(ctrlEvent.defaultPrevented).toBe(true);
    expect(metaEvent.defaultPrevented).toBe(true);
  });

  it('allows ordinary keyboard and wheel input', () => {
    const documentTarget = new EventTarget() as Document;
    initializeApplicationZoomGuard(documentTarget);
    const keyEvent = createInputEvent('keydown', { key: '+' });
    const wheelEvent = createInputEvent('wheel');

    documentTarget.dispatchEvent(keyEvent);
    documentTarget.dispatchEvent(wheelEvent);

    expect(keyEvent.defaultPrevented).toBe(false);
    expect(wheelEvent.defaultPrevented).toBe(false);
  });

  it('cancels pinch-style browser zoom without stopping map event propagation', () => {
    const documentTarget = new EventTarget() as Document;
    const propagatedWheel = vi.fn();
    initializeApplicationZoomGuard(documentTarget);
    documentTarget.addEventListener('wheel', propagatedWheel);
    const wheelEvent = createInputEvent('wheel', { ctrlKey: true });
    const gestureEvent = new Event('gesturestart', { cancelable: true });

    documentTarget.dispatchEvent(wheelEvent);
    documentTarget.dispatchEvent(gestureEvent);

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(gestureEvent.defaultPrevented).toBe(true);
    expect(propagatedWheel).toHaveBeenCalledOnce();
  });
});
