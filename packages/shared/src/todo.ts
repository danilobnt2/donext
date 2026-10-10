import { z } from 'zod'

export const TODO_STATES = ['new', 'active', 'pending', 'done', 'abandoned'] as const
export type TodoState = (typeof TODO_STATES)[number]

/** Board columns, in display order. Abandoned is a hidden end state, not a column. */
export const BOARD_COLUMNS = ['new', 'active', 'pending', 'done'] as const satisfies TodoState[]

export const TITLE_MAX = 200
export const NOTES_MAX = 5000

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID')

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
  }, 'must be a real calendar date')

export const createTodoInput = z.object({
  id: ulid,
  title: z.string().trim().min(1, 'title is required').max(TITLE_MAX),
  notes: z
    .string()
    .trim()
    .max(NOTES_MAX)
    .optional()
    .transform((value) => value || null),
  dueDate: calendarDate.nullish().transform((value) => value ?? null),
  clientChangedAt: z.iso.datetime({ offset: true }).optional(),
})

export type CreateTodoInput = z.input<typeof createTodoInput>
export type CreateTodo = z.output<typeof createTodoInput>

export interface Todo {
  id: string
  title: string
  notes: string | null
  state: TodoState
  dueDate: string | null
  rev: number
  createdAt: string
  updatedAt: string
  doneAt: string | null
}
