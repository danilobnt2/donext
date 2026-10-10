import { checkTitle, type Todo, type TodoState } from '@donext/shared';
import { useEffect, useState } from 'preact/hooks';
import { createTodo, deleteAllTodos, listTodos } from './api';

const STATE_LABELS: Record<TodoState, string> = {
  new: 'New',
  active: 'Active',
  pending: 'Pending',
  done: 'Done',
};

export function App() {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    listTodos().then(setTodos, (e: Error) => setLoadError(e.message));
  }, []);

  async function onSubmit(event: Event) {
    event.preventDefault();
    const check = checkTitle(title);
    if (!check.ok) return setFormError(check.message);
    setSaving(true);
    setFormError(null);
    try {
      const todo = await createTodo(check.title);
      setTodos((current) => [todo, ...(current ?? [])]);
      setTitle('');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteAll() {
    setDeleteError(null);
    try {
      await deleteAllTodos();
      setTodos([]);
      setConfirmingDelete(false);
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  }

  return (
    <main class="page">
      <header>
        <h1>Do Next</h1>
        <p class="lead">To-Dos are outcomes you want to reach.</p>
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
          <button type="submit" disabled={saving}>
            Add
          </button>
        </div>
        {formError && (
          <p id="title-error" class="error" role="alert">
            {formError}
          </p>
        )}
      </form>

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
