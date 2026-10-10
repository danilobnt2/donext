import type { ApiError, CreateTodoRequest, Todo } from '@donext/shared';

export async function listTodos(): Promise<Todo[]> {
  const res = await fetch('/api/todos');
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { todos: Todo[] }).todos;
}

export async function createTodo(title: string): Promise<Todo> {
  const body: CreateTodoRequest = { title };
  const res = await fetch('/api/todos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { todo: Todo }).todo;
}

export async function deleteAllTodos(): Promise<void> {
  const res = await fetch('/api/todos', { method: 'DELETE' });
  if (!res.ok) throw new Error(await errorMessage(res));
}

async function errorMessage(res: Response): Promise<string> {
  try {
    return ((await res.json()) as ApiError).error.message;
  } catch {
    return `Request failed (${res.status}).`;
  }
}
