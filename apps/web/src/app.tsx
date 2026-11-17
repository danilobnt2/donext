import { checkTitle, type AuthUser, type Todo, type TodoState } from '@donext/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BoardClient, clearCachedBoard } from './board-client';

const STATE_LABELS: Record<TodoState, string> = {
  new: 'New',
  active: 'Active',
  pending: 'Pending',
  done: 'Done',
};

export function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [authError, setAuthError] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const clientRef = useRef<BoardClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/me');
        if (cancelled) return;
        if (res.status === 401) return setUser(null);
        if (!res.ok) throw new Error(`Request failed (${res.status}).`);
        const me = (await res.json()) as AuthUser;
        if (!cancelled) setUser(me);
      } catch (e) {
        if (!cancelled) {
          setAuthError((e as Error).message);
          setUser(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    setTodos(null);
    setLoadError(null);
    const client = new BoardClient(user.id, setTodos, setLoadError);
    clientRef.current = client;
    void client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [user?.id]);

  async function onSubmit(event: Event) {
    event.preventDefault();
    const check = checkTitle(title);
    if (!check.ok) return setFormError(check.message);
    if (!clientRef.current) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await clientRef.current.createTodo(check.title);
      if (!res.ok) return setFormError(res.message);
      setTitle('');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteAll() {
    if (!clientRef.current) return;
    setDeleteError(null);
    try {
      await clientRef.current.deleteAllTodos();
      setConfirmingDelete(false);
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  }

  async function onSignOut() {
    if (!user || signingOut) return;
    setSigningOut(true);
    clientRef.current?.stop();
    clientRef.current = null;
    await clearCachedBoard(user.id);
    const res = await fetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => null);
    const body = res?.ok
      ? ((await res.json().catch(() => null)) as { logoutUrl?: string } | null)
      : null;
    if (body?.logoutUrl) {
      location.assign(body.logoutUrl);
      return;
    }
    setTodos(null);
    setTitle('');
    setFormError(null);
    setConfirmingDelete(false);
    setDeleteError(null);
    setSigningOut(false);
    setUser(null);
  }

  return (
    <main class="page">
      <header>
        <div class="header-row">
          <h1>Do Next</h1>
          {user && (
            <button type="button" class="quiet" onClick={onSignOut} disabled={signingOut}>
              Sign out
            </button>
          )}
        </div>
        <p class="lead">To-Dos are outcomes you want to reach.</p>
      </header>

      {user === undefined && <p class="muted">Loading…</p>}

      {user === null && (
        <section class="sign-in" aria-label="Sign in">
          <a class="gsi-material-button" href="/api/v1/auth/login">
            <span class="gsi-material-button-state" aria-hidden="true" />
            <span class="gsi-material-button-content-wrapper">
              <span class="gsi-material-button-icon" aria-hidden="true">
                <svg viewBox="0 0 48 48">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
              </span>
              <span class="gsi-material-button-contents">Continue with Google</span>
            </span>
          </a>
          {authError && (
            <p class="error" role="alert">
              Could not check session: {authError}
            </p>
          )}
        </section>
      )}

      {user && (
        <>
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
              <button type="submit" disabled={saving || todos === null}>
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
                <p id="confirm-text">Delete all {todos?.length} To-Dos? This can't be undone.</p>
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
        </>
      )}
    </main>
  );
}
