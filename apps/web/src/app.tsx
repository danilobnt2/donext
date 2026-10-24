import {
  createTodo,
  deleteAllTodos,
  listTodos,
  type Rejection,
  type SyncStatus,
  type TodoState,
} from '@donext/shared';
import { useEffect, useState } from 'preact/hooks';
import { startSync, type SyncRuntime } from './sync/runtime';

const STATE_LABELS: Record<TodoState, string> = {
  new: 'New',
  active: 'Active',
  pending: 'Pending',
  done: 'Done',
};

/** Opens the local data and re-renders whenever it, the sync status or a rejection changes. */
function useSync(): { runtime: SyncRuntime | null; error: string | null } {
  const [runtime, setRuntime] = useState<SyncRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, redraw] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let stop = () => {};
    startSync().then(
      (started) => {
        if (cancelled) {
          started.scheduler.stop();
          return;
        }
        const unsubscribe = started.engine.subscribe(() => redraw((count) => count + 1));
        stop = () => {
          unsubscribe();
          started.scheduler.stop();
        };
        setRuntime(started);
      },
      (e: Error) => {
        if (!cancelled) setError(e.message);
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return { runtime, error };
}

function syncLabel(status: SyncStatus): string {
  const waiting = status.pending === 1 ? '1 change' : `${status.pending} changes`;
  if (!status.connected) return status.pending > 0 ? `Offline · ${waiting} waiting` : 'Offline';
  return status.pending > 0 ? `Syncing ${waiting}…` : 'Synced';
}

function describeRejection({ op, message }: Rejection): string {
  const title = op.kind === 'create' ? op.fields.title : null;
  return typeof title === 'string'
    ? `Could not save “${title}”: ${message}`
    : `A change was refused: ${message}`;
}

export function App() {
  const { runtime, error: loadError } = useSync();
  const todos = runtime ? listTodos(runtime.engine) : null;
  const status = runtime?.engine.status();
  const rejections = runtime?.engine.rejections() ?? [];

  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onSubmit(event: Event) {
    event.preventDefault();
    if (!runtime) return;
    setFormError(null);
    try {
      const result = await createTodo(runtime.engine, title);
      if (!result.ok) return setFormError(result.message);
      setTitle('');
      runtime.scheduler.syncNow();
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  async function onDeleteAll() {
    if (!runtime) return;
    setDeleteError(null);
    try {
      await deleteAllTodos(runtime.engine);
      setConfirmingDelete(false);
      runtime.scheduler.syncNow();
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  }

  return (
    <main class="page">
      <header>
        <h1>Do Next</h1>
        <p class="lead">To-Dos are outcomes you want to reach.</p>
        {status && (
          <p
            class="sync-status"
            role="status"
            data-state={!status.connected ? 'offline' : status.pending > 0 ? 'syncing' : 'synced'}
          >
            {syncLabel(status)}
          </p>
        )}
      </header>

      <form class="new-todo" onSubmit={onSubmit} noValidate>
        <label for="title">New To-Do</label>
        <div class="row">
          <input
            id="title"
            name="title"
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
            placeholder="Plan dad's 70th birthday"
            autocomplete="off"
            aria-invalid={formError !== null}
            aria-describedby={formError ? 'title-error' : undefined}
          />
          <button type="submit" disabled={!runtime}>
            Add
          </button>
        </div>
        {formError && (
          <p id="title-error" class="error" role="alert">
            {formError}
          </p>
        )}
      </form>

      {rejections.map((rejection) => (
        <div class="rejection" role="alert" key={rejection.op.opId}>
          <p>{describeRejection(rejection)}</p>
          <button
            type="button"
            class="quiet"
            onClick={() => runtime?.engine.dismissRejection(rejection.op.opId)}
          >
            Dismiss
          </button>
        </div>
      ))}

      <section aria-labelledby="todos-heading">
        <div class="section-head">
          <h2 id="todos-heading">To-Dos</h2>
          {todos && todos.length > 0 && !confirmingDelete && (
            <button type="button" class="quiet" onClick={() => setConfirmingDelete(true)}>
              Delete all
            </button>
          )}
        </div>
        {confirmingDelete && (
          <div class="confirm" role="group" aria-labelledby="confirm-text">
            <p id="confirm-text">
              Delete all {todos?.length} To-Dos for everyone? This can't be undone.
            </p>
            <div class="row">
              <button type="button" class="danger" onClick={onDeleteAll}>
                Delete all
              </button>
              <button type="button" class="quiet" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </div>
            {deleteError && (
              <p class="error" role="alert">
                {deleteError}
              </p>
            )}
          </div>
        )}
        {loadError && (
          <p class="error" role="alert">
            Could not load To-Dos: {loadError}
          </p>
        )}
        {todos === null && !loadError && <p class="muted">Loading…</p>}
        {todos?.length === 0 && <p class="muted">Nothing yet. Add your first To-Do above.</p>}
        {todos && todos.length > 0 && (
          <ul class="todos">
            {todos.map((todo) => (
              <li key={todo.id}>
                <span class="title">{todo.title}</span>
                <span class={`state state-${todo.state}`}>{STATE_LABELS[todo.state]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
