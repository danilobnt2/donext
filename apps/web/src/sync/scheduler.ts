import type { SyncOutcome } from '@donext/shared';

/** How the page tells the scheduler it is worth syncing now: back online, shown, focused. */
export interface WakeSource {
  isVisible(): boolean;
  onWake(handler: () => void): () => void;
}

/** Until the server can push changes over a WebSocket, a visible page polls this often. */
export const POLL_MS = 30_000;
export const MIN_RETRY_MS = 2_000;
export const MAX_RETRY_MS = 60_000;

/**
 * Decides when to sync. It syncs on start, on request, when the page wakes, and on a timer:
 * a slow poll while all is well, and exponential backoff after a failure.
 */
export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopWaking: (() => void) | undefined;
  private stopped = true;
  private running = false;
  private failures = 0;

  constructor(
    private readonly engine: { sync(): Promise<SyncOutcome> },
    private readonly wake: WakeSource,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopWaking = this.wake.onWake(() => this.syncNow());
    this.syncNow();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stopWaking?.();
    this.stopWaking = undefined;
  }

  /** Syncs now, for example right after the user changed something. */
  syncNow(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) {
      // The engine folds this into the sync in progress and makes one more pass.
      void this.engine.sync();
      return;
    }
    this.running = true;
    let outcome: SyncOutcome;
    try {
      outcome = await this.engine.sync();
    } finally {
      this.running = false;
    }
    if (this.stopped) return;

    this.failures = outcome.ok ? 0 : this.failures + 1;
    this.schedule(
      outcome.ok ? POLL_MS : Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** (this.failures - 1)),
    );
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // Polling waits while the page is hidden; retrying after a failure does not.
      if (this.failures === 0 && !this.wake.isVisible()) return this.schedule(delay);
      void this.run();
    }, delay);
  }
}
