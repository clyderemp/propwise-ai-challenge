/** Shows a time in the agent's timezone, not the browser's: "16 Oct, 10:30". */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatAed(amount: number): string {
  return `AED ${new Intl.NumberFormat('en-US').format(amount)}`;
}

/** A due date in the agent's timezone, with weekday and year: "Fri 16 Oct 2026, 10:00". */
export function formatDueDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
