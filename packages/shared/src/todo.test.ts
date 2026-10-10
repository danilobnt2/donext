import { describe, expect, it } from 'vitest'
import { createTodoInput } from './todo'

const id = '01JA2B3C4D5E6F7G8H9JKMNPQR'

describe('createTodoInput', () => {
  it('accepts a title only and normalises optional fields to null', () => {
    expect(createTodoInput.parse({ id, title: '  Cut the lawn  ' })).toEqual({
      id,
      title: 'Cut the lawn',
      notes: null,
      dueDate: null,
    })
  })

  it('keeps notes and a due date', () => {
    const parsed = createTodoInput.parse({
      id,
      title: 'Plan dad’s 70th birthday',
      notes: 'Ask mum first',
      dueDate: '2026-10-24',
    })
    expect(parsed.notes).toBe('Ask mum first')
    expect(parsed.dueDate).toBe('2026-10-24')
  })

  it('treats blank notes as absent', () => {
    expect(createTodoInput.parse({ id, title: 'x', notes: '   ' }).notes).toBeNull()
  })

  it.each([
    ['empty title', { id, title: '   ' }],
    ['too long title', { id, title: 'a'.repeat(201) }],
    ['bad id', { id: 'not-a-ulid', title: 'x' }],
    ['impossible date', { id, title: 'x', dueDate: '2026-02-30' }],
    ['malformed date', { id, title: 'x', dueDate: '24/10/2026' }],
  ])('rejects %s', (_, input) => {
    expect(createTodoInput.safeParse(input).success).toBe(false)
  })
})
