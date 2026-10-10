import { describe, expect, it } from 'vitest'
import { formatDue, localToday } from './dates'

describe('formatDue', () => {
  const today = '2026-10-04'

  it.each([
    ['2026-10-24', 'Due Sat 24 Oct · in 20 days', 'normal'],
    ['2026-10-07', 'Due Wed 7 Oct · in 3 days', 'soon'],
    ['2026-10-05', 'Due Mon 5 Oct · tomorrow', 'soon'],
    ['2026-10-04', 'Due Sun 4 Oct · today', 'soon'],
    ['2026-10-03', 'Due Sat 3 Oct · yesterday', 'overdue'],
    ['2026-09-28', 'Due Mon 28 Sept · 6 days ago', 'overdue'],
    ['2027-01-15', 'Due Fri 15 Jan 2027 · in 103 days', 'normal'],
  ])('formats %s', (due, label, tone) => {
    expect(formatDue(due, today)).toEqual({ label, tone })
  })
})

describe('localToday', () => {
  it('uses the local calendar date', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
  })
})
