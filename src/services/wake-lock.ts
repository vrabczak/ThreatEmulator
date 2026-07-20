/**
 * Encapsulates Screen Wake Lock acquisition, release, and visibility restoration.
 * Browser support is optional; state and user-facing failures are reported through callbacks.
 */

export type WakeLockMessageTone = 'warning' | 'error';

export interface WakeLockControllerOptions {
  onStateChanged: () => void;
  onMessage: (message: string, tone: WakeLockMessageTone) => void;
}

/**
 * Maintains the user's stay-awake preference and the current browser wake-lock sentinel.
 * A requested lock is reacquired when the document becomes visible after browser suspension.
 */
export class WakeLockController {
  private requested = false;
  private sentinel: WakeLockSentinel | null = null;

  /**
   * Creates the controller and binds visibility-based wake-lock restoration.
   * @param options - Callbacks for state redraws and user-facing failures.
   */
  public constructor(private readonly options: WakeLockControllerOptions) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.requested && this.sentinel === null) {
        void this.acquire();
      }
    });
  }

  /**
   * Reports whether the browser currently holds a screen wake lock.
   * @returns `true` while a live sentinel is held.
   */
  public get active(): boolean {
    return this.sentinel !== null;
  }

  /**
   * Toggles the user's stay-awake request, acquiring or releasing the browser lock.
   * @returns A promise that settles after the browser operation completes.
   */
  public async toggle(): Promise<void> {
    if (this.requested) {
      this.requested = false;
      await this.sentinel?.release();
      this.sentinel = null;
      this.options.onStateChanged();
      return;
    }

    this.requested = true;
    await this.acquire();
  }

  private async acquire(): Promise<void> {
    if (!('wakeLock' in navigator)) {
      this.requested = false;
      this.options.onMessage('This browser does not support keeping the screen awake.', 'warning');
      this.options.onStateChanged();
      return;
    }

    try {
      const sentinel = await navigator.wakeLock.request('screen');
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) {
          this.sentinel = null;
          this.options.onStateChanged();
        }
      });
    } catch (error) {
      this.requested = false;
      const reason = error instanceof Error ? error.message : 'The wake lock request was rejected.';
      this.options.onMessage(`Unable to keep the screen awake: ${reason}`, 'warning');
    }
    this.options.onStateChanged();
  }
}
