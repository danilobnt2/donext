const DAY_MS = 24 * 60 * 60 * 1000
/** Matches the default due-soon window from the spec's review thresholds. */
export const DUE_SOON_DAYS = 3

export type DueTone = 'normal' | 'soon' | 'overdue'

/** Today's date as YYYY-MM-DD in the device's time zone. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function utcDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS
}

/** "Due Sat 24 Oct · in 20 days", with a tone for highlighting close or missed dates. */
export function formatDue(dueDate: string, today: string): { label: string; tone: DueTone } {
  const days = utcDay(dueDate) - utcDay(today)
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatToParts(new Date(`${dueDate}T00:00:00Z`))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  const sameYear = dueDate.slice(0, 4) === today.slice(0, 4)
  const date = [part('weekday'), part('day'), part('month'), sameYear ? '' : part('year')]
    .filter(Boolean)
    .join(' ')
  let relative: string
  if (days === 0) relative = 'today'
  else if (days === 1) relative = 'tomorrow'
  else if (days === -1) relative = 'yesterday'
  else if (days > 0) relative = `in ${days} days`
  else relative = `${-days} days ago`

  const tone: DueTone = days < 0 ? 'overdue' : days <= DUE_SOON_DAYS ? 'soon' : 'normal'
  return { label: `Due ${date} · ${relative}`, tone }
}
