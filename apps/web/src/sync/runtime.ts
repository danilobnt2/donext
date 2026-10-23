import { MemoryStore, SyncEngine, httpTransport, type LocalStore } from '@donext/shared';
import { monotonicFactory } from 'ulid';
import { IdbStore } from './idb-store';
import { SyncScheduler, type WakeSource } from './scheduler';

// Ids made in the same millisecond still sort in the order they were made.
const newId = monotonicFactory();

export interface SyncRuntime {
  engine: SyncEngine;
  scheduler: SyncScheduler;
}

/** Opens this device's local data and starts keeping it in sync with the server. */
export async function startSync(): Promise<SyncRuntime> {
  const engine = await SyncEngine.open({
    store: await openStore(),
    transport: httpTransport((path, init) => fetch(path, init)),
    newId,
  });
  const scheduler = new SyncScheduler(engine, pageWake());
  scheduler.start();
  return { engine, scheduler };
}

async function openStore(): Promise<LocalStore> {
  try {
    return await IdbStore.open();
  } catch (error) {
    // Some private modes refuse IndexedDB. The app still works, but only until the page closes.
    console.warn('IndexedDB is unavailable: changes will not survive a reload.', error);
    return new MemoryStore();
  }
}

function pageWake(): WakeSource {
  return {
    isVisible: () => document.visibilityState === 'visible',
    onWake(handler) {
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') handler();
      };
      window.addEventListener('online', handler);
      window.addEventListener('focus', handler);
      document.addEventListener('visibilitychange', onVisibilityChange);
      return () => {
        window.removeEventListener('online', handler);
        window.removeEventListener('focus', handler);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      };
    },
  };
}
