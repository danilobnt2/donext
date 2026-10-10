import type { Todo } from '@donext/shared'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const existing: Todo = {
  id: '01JA2B3C4D5E6F7G8H9JKMNPQR',
  title: 'Cut the lawn',
  notes: null,
  state: 'new',
  dueDate: null,
  rev: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  doneAt: null,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return jsonResponse({ todos: [existing] })
    const body = JSON.parse(init.body as string)
    return jsonResponse(
      {
        todo: {
          ...existing,
          id: body.id,
          title: body.title.trim(),
          notes: body.notes || null,
          dueDate: body.dueDate,
        },
      },
      201,
    )
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('creating a To-Do', () => {
  it('adds the new To-Do to the New column', async () => {
    const user = userEvent.setup()
    render(<App />)
    const newColumn = await screen.findByRole('region', { name: 'New' })
    expect(within(newColumn).getByText('Cut the lawn')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New To-Do' }))
    const dialog = screen.getByRole('dialog', { name: 'New To-Do' })
    await user.type(within(dialog).getByLabelText('Goal'), 'Get hired to a new job')
    await user.type(within(dialog).getByLabelText(/Notes/), 'Senior roles only')
    await user.click(within(dialog).getByRole('button', { name: 'Create To-Do' }))

    expect(await within(newColumn).findByText('Get hired to a new job')).toBeInTheDocument()
    expect(within(newColumn).getByText('Senior roles only')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('2 To-Dos')).toBeInTheDocument()

    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({
      title: 'Get hired to a new job',
      notes: 'Senior roles only',
      dueDate: null,
    })
  })

  it('requires a title before sending anything', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'New To-Do' }))
    await user.click(screen.getByRole('button', { name: 'Create To-Do' }))

    expect(screen.getByText('title is required')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft and explains when the request fails', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'New To-Do' }))
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await user.type(screen.getByLabelText('Goal'), 'Renew passport')
    await user.click(screen.getByRole('button', { name: 'Create To-Do' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/)
    expect(screen.getByLabelText('Goal')).toHaveValue('Renew passport')
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'New To-Do' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
