import type { CreateTodoInput, Todo } from '@donext/shared'

export type FieldIssues = Record<string, string>

export type CreateResult =
  | { ok: true; todo: Todo }
  | { ok: false; issues: FieldIssues }
  | { ok: false; message: string }

export async function fetchTodos(): Promise<Todo[]> {
  const response = await fetch('/api/todos', { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Could not load To-Dos (${response.status})`)
  const body = (await response.json()) as { todos: Todo[] }
  return body.todos
}

export async function createTodo(input: CreateTodoInput): Promise<CreateResult> {
  let response: Response
  try {
    response = await fetch('/api/todos', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    return { ok: false, message: 'You seem to be offline. Try again when you are back online.' }
  }
  if (response.ok) {
    const body = (await response.json()) as { todo: Todo }
    return { ok: true, todo: body.todo }
  }
  if (response.status === 400) {
    const body = (await response.json()) as {
      error?: { issues?: { path: string; message: string }[] }
    }
    if (body.error?.issues?.length) {
      return {
        ok: false,
        issues: Object.fromEntries(body.error.issues.map((i) => [i.path, i.message])),
      }
    }
  }
  return { ok: false, message: `Something went wrong (${response.status}). Try again.` }
}
