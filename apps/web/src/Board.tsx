import { BOARD_COLUMNS, type Todo } from '@donext/shared'
import { useState } from 'react'
import { formatDue, localToday } from './dates'

type Column = (typeof BOARD_COLUMNS)[number]

const LABELS: Record<Column, string> = {
  new: 'New',
  active: 'Active',
  pending: 'Pending',
  done: 'Done',
}

const EMPTY: Record<Column, string> = {
  new: 'Nothing new. Add an outcome you want to reach.',
  active: 'To-Dos move here once their first task is done.',
  pending: 'Tasks all done, goal not reached. Add a next task or close it.',
  done: 'Reached goals land here.',
}

type Props = {
  todos: Todo[]
  onAdd: () => void
  column: Column
  onColumnChange: (column: Column) => void
}

export function Board({ todos, onAdd, column, onColumnChange }: Props) {
  const [today] = useState(localToday)
  const byColumn = Object.fromEntries(
    BOARD_COLUMNS.map((c) => [c, todos.filter((t) => t.state === c)]),
  ) as Record<Column, Todo[]>

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Board columns">
        {BOARD_COLUMNS.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={c === column}
            className={`tab tab-${c}`}
            onClick={() => onColumnChange(c)}
          >
            {LABELS[c]}
            <span className="tab-count" data-nonzero={byColumn[c].length > 0}>
              {byColumn[c].length}
            </span>
          </button>
        ))}
      </div>
      <div className="board">
        {BOARD_COLUMNS.map((c) => (
          <section
            key={c}
            aria-label={LABELS[c]}
            className={`column column-${c}`}
            data-current={c === column}
          >
            <h2 className="column-head">
              <span className="dot" />
              {LABELS[c]}
              <span className="column-count">{byColumn[c].length}</span>
            </h2>
            {byColumn[c].length === 0 && c !== 'new' && <p className="column-empty">{EMPTY[c]}</p>}
            {byColumn[c].map((todo) => (
              <TodoCard key={todo.id} todo={todo} today={today} />
            ))}
            {c === 'new' && (
              <button type="button" className="add-card" onClick={onAdd}>
                + Add To-Do
              </button>
            )}
          </section>
        ))}
      </div>
    </>
  )
}

function TodoCard({ todo, today }: { todo: Todo; today: string }) {
  const due = todo.dueDate ? formatDue(todo.dueDate, today) : null
  return (
    <article className="card">
      <h3>{todo.title}</h3>
      {due && <div className={`due due-${due.tone}`}>{due.label}</div>}
      {todo.notes && <p className="notes">{todo.notes}</p>}
      <div className="next">No tasks yet</div>
    </article>
  )
}
