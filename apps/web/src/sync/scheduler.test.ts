import type { SyncOutcome } from '@donext/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RETRY_MS, MIN_RETRY_MS, POLL_MS, SyncScheduler, type WakeSource } from './scheduler';

const OK: SyncOutcome = { ok: true };
const FAILED: SyncOutcome = { ok: false, error: new Error('offline') };

function setup(outcomes: SyncOutcome[] = []) {
  const queue = [...outcomes];
  const engine = { sync: vi.fn(async () => queue.shift() ?? OK) };
  const handlers = new Set<() => void>();
  const page = { visible: true };
  const wake: WakeSource = {
    isVisible: () => page.visible,
    onWake(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const scheduler = new SyncScheduler(engine, wake);
  return { engine, scheduler, handlers, page, wakeUp: () => handlers.forEach((h) => h()) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SyncScheduler', () => {
  it('syncs at once, then polls while the page is visible', async () => {
    const { engine, scheduler } = setup();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(engine.sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(engine.sync).toHaveBeenCalledTimes(3);
  });

  it('does not poll while the page is hidden, and syncs when it wakes', async () => {
    const { engine, scheduler, page, wakeUp } = setup();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    page.visible = false;

    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(engine.sync).toHaveBeenCalledTimes(1);

    page.visible = true;
    wakeUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.sync).toHaveBeenCalledTimes(2);
  });

  it('backs off after failures, up to a limit, and recovers on success', async () => {
    const { engine, scheduler } = setup([
      FAILED,
      FAILED,
      FAILED,
      FAILED,
      FAILED,
      FAILED,
      FAILED,
      FAILED,
    ]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    const delays = [
      MIN_RETRY_MS,
      MIN_RETRY_MS * 2,
      MIN_RETRY_MS * 4,
      MIN_RETRY_MS * 8,
      MIN_RETRY_MS * 16,
    ];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(engine.sync).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.sync).toHaveBeenCalledTimes(index + 2);
    }

    // The sixth failure would wait 64s; it waits the 60s maximum instead.
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS - 1);
    expect(engine.sync).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.sync).toHaveBeenCalledTimes(7);

    // Failures 7 and 8 retry at the maximum; the ninth call succeeds and goes back to polling.
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(engine.sync).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(engine.sync).toHaveBeenCalledTimes(10);
  });

  it('keeps retrying while hidden after a failure', async () => {
    const { engine, scheduler, page } = setup([FAILED]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    page.visible = false;
    await vi.advanceTimersByTimeAsync(MIN_RETRY_MS);
    expect(engine.sync).toHaveBeenCalledTimes(2);
  });

  it('syncs on request without waiting for the timer', async () => {
    const { engine, scheduler } = setup();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.sync).toHaveBeenCalledTimes(2);
  });

  it('counts a failure once when asked to sync during a sync', async () => {
    const { engine, scheduler } = setup([FAILED]);
    let finish: (outcome: SyncOutcome) => void = () => {};
    engine.sync.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    scheduler.start();
    scheduler.syncNow();
    finish(FAILED);
    await vi.advanceTimersByTimeAsync(0);

    // One failure means one retry after the minimum wait, not after the doubled one.
    const calls = engine.sync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(MIN_RETRY_MS);
    expect(engine.sync.mock.calls.length).toBe(calls + 1);
  });

  it('stops for good', async () => {
    const { engine, scheduler, handlers, wakeUp } = setup();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();

    expect(handlers.size).toBe(0);
    wakeUp();
    scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(engine.sync).toHaveBeenCalledTimes(1);
  });
});
