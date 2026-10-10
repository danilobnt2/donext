import type { Todo } from '@donext/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchTodos } from './api'
import { Board } from './Board'
import { NewTodoDialog } from './NewTodoDialog'

type Column = 'new' | 'active' | 'pending' | 'done'

export function App() {
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [column, setColumn] = useState<Column>('new')
  const opener = useRef<HTMLElement | null>(null)

  const load = useCallback(() => {
    setError(null)
    fetchTodos()
      .then(setTodos)
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(load, [load])

  const openDialog = () => {
    opener.current = document.activeElement as HTMLElement | null
    setAdding(true)
  }
  const closeDialog = useCallback(() => {
    setAdding(false)
    opener.current?.focus()
  }, [])

  const count = todos?.filter((t) => t.state !== 'abandoned').length ?? 0

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                fill="none"
                stroke="#fff"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          Do Next
        </div>
        <nav aria-label="Main" className="side-nav">
          <a href="/" aria-current="page">
            To-Dos
          </a>
        </nav>
        <p className="side-foot">Guest account, kept on this browser until sign-in arrives.</p>
      </aside>

      <main className="main">
        <header className="page-head">
          <div>
            <h1>To-Dos</h1>
            {todos && (
              <p className="page-sub">
                {count} {count === 1 ? 'To-Do' : 'To-Dos'}
              </p>
            )}
          </div>
          <button type="button" className="button primary" onClick={openDialog}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 5v14M5 12h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
            New To-Do
          </button>
        </header>

        {error && (
          <div className="banner" role="alert">
            {error}
            <button type="button" className="button secondary" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {!todos && !error && <p className="loading">Loading…</p>}
        {todos && (
          <Board todos={todos} onAdd={openDialog} column={column} onColumnChange={setColumn} />
        )}
      </main>

      {adding && (
        <NewTodoDialog
          onClose={closeDialog}
          onCreated={(todo) => {
            setTodos((current) => [todo, ...(current ?? []).filter((t) => t.id !== todo.id)])
            setColumn('new')
            closeDialog()
          }}
        />
      )}
    </div>
  )
}
