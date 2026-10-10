import { createTodoInput, NOTES_MAX, TITLE_MAX, type Todo } from '@donext/shared'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { ulid } from 'ulid'
import { createTodo, type FieldIssues } from './api'

type Props = {
  onClose: () => void
  onCreated: (todo: Todo) => void
}

export function NewTodoDialog({ onClose, onCreated }: Props) {
  // One id per draft: a retry after a lost response replays the same create.
  const [id] = useState(() => ulid())
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [issues, setIssues] = useState<FieldIssues>({})
  const [message, setMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const fieldId = useId()

  useEffect(() => {
    titleRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const input = {
      id,
      title,
      notes,
      dueDate: dueDate || null,
      clientChangedAt: new Date().toISOString(),
    }
    const parsed = createTodoInput.safeParse(input)
    if (!parsed.success) {
      setIssues(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])))
      return
    }
    setIssues({})
    setMessage(null)
    setSubmitting(true)
    const result = await createTodo(input)
    setSubmitting(false)
    if (result.ok) onCreated(result.todo)
    else if ('issues' in result) setIssues(result.issues)
    else setMessage(result.message)
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div className="sheet-head">
          <h2 id={headingId}>New To-Do</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <p className="sheet-lead">
          An outcome you want to reach. You'll add small timed tasks next.
        </p>
        <form onSubmit={submit} noValidate>
          <label className="field">
            <span>Goal</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              placeholder="Plan dad's 70th birthday"
              aria-invalid={Boolean(issues.title)}
              aria-describedby={issues.title ? `${fieldId}-title` : undefined}
            />
            {issues.title && (
              <small id={`${fieldId}-title`} className="field-error">
                {issues.title}
              </small>
            )}
          </label>
          <label className="field">
            <span>
              Notes <em>optional</em>
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={NOTES_MAX}
              rows={3}
            />
          </label>
          <label className="field">
            <span>
              Due date <em>optional</em>
            </span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              aria-invalid={Boolean(issues.dueDate)}
              aria-describedby={issues.dueDate ? `${fieldId}-due` : undefined}
            />
            {issues.dueDate && (
              <small id={`${fieldId}-due`} className="field-error">
                {issues.dueDate}
              </small>
            )}
          </label>
          {message && (
            <p className="form-error" role="alert">
              {message}
            </p>
          )}
          <div className="sheet-actions">
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create To-Do'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
