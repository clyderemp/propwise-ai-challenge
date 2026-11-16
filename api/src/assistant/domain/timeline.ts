import { ResolvedTimeline, TimelineIntent } from '../assistant.types';
import { addDays, CalendarDate, compareDates, isValidDate, localDate, toUtcMs, weekdayOf } from './follow-up-date';

/**
 * Resolves the lead's purchase or move timeline ("ready to buy this week", "moving in next month") to a
 * window of local calendar dates in the agent's time zone.
 *
 * - The window is anchored on the message's sentAt, like every date in the assistant; the model only
 *   classifies the phrase. A week is Monday to Sunday (the UAE work week starts on Monday).
 * - `analysedAt` is used for one thing only: `stale`, true when the window had already ended on the
 *   agent's local calendar when the run read the message. It never moves the window.
 * - Urgent means the lead means to act within about a month: asap, this/next week, this/next month,
 *   within 31 days or by a date at most 31 days after the sent date.
 * - Invalid model output (a missing or impossible date, a negative number of days) gives null.
 */

export const URGENT_WITHIN_DAYS = 31;
const MAX_WITHIN_DAYS = 366 * 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function resolveTimeline(t: TimelineIntent, sentAt: Date, timeZone: string, analysedAt: Date): ResolvedTimeline | null {
  const sent = localDate(sentAt, timeZone);
  const analysed = localDate(analysedAt, timeZone);
  const quote = t.quote?.trim() || null;

  const windowed = (kind: ResolvedTimeline['kind'], phrase: string | null, start: CalendarDate, end: CalendarDate, urgent: boolean): ResolvedTimeline => {
    const window = formatRange(start, end);
    return {
      kind,
      quote,
      windowStart: iso(start),
      windowEnd: iso(end),
      window,
      label: phrase === null ? `by ${formatDay(end)}` : `${phrase} (${window})`,
      urgent,
      stale: compareDates(analysed, end) > 0,
    };
  };

  switch (t.kind) {
    case 'this_week': {
      const monday = addDays(sent, -((weekdayOf(sent) + 6) % 7));
      return windowed('this_week', 'this week', monday, addDays(monday, 6), true);
    }
    case 'next_week': {
      const monday = addDays(sent, 7 - ((weekdayOf(sent) + 6) % 7));
      return windowed('next_week', 'next week', monday, addDays(monday, 6), true);
    }
    case 'this_month':
      return windowed('this_month', 'this month', { ...sent, day: 1 }, lastDayOfMonth(sent.year, sent.month), true);
    case 'next_month': {
      const year = sent.month === 12 ? sent.year + 1 : sent.year;
      const month = sent.month === 12 ? 1 : sent.month + 1;
      return windowed('next_month', 'next month', { year, month, day: 1 }, lastDayOfMonth(year, month), true);
    }
    case 'within_days': {
      const n = t.days;
      if (n === null || !Number.isInteger(n) || n < 0 || n > MAX_WITHIN_DAYS) return null;
      return windowed('within_days', `within ${n} day${n === 1 ? '' : 's'}`, sent, addDays(sent, n), n <= URGENT_WITHIN_DAYS);
    }
    case 'by_date': {
      const end = byDate(t, sent);
      if (!end) return null;
      return windowed('by_date', null, sent, end, daysBetween(sent, end) <= URGENT_WITHIN_DAYS);
    }
    case 'asap':
      return { kind: 'asap', quote, windowStart: iso(sent), windowEnd: null, window: null, label: 'as soon as possible', urgent: true, stale: false };
    case 'no_rush':
      return { kind: 'no_rush', quote, windowStart: null, windowEnd: null, window: null, label: 'no rush', urgent: false, stale: false };
    case 'none':
    default:
      return null;
  }
}

function byDate(t: TimelineIntent, sent: CalendarDate): CalendarDate | null {
  const { month, day, year } = t;
  if (month === null || day === null || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year !== null) {
    const date = { year, month, day };
    return Number.isInteger(year) && isValidDate(date) && compareDates(date, sent) >= 0 ? date : null;
  }
  for (let y = sent.year; y <= sent.year + 8; y++) {
    const date = { year: y, month, day };
    if (isValidDate(date) && compareDates(date, sent) >= 0) return date;
  }
  return null;
}

function lastDayOfMonth(year: number, month: number): CalendarDate {
  return addDays({ year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1, day: 1 }, -1);
}

function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

function iso(d: CalendarDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function formatDay(d: CalendarDate): string {
  return `${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}

/** "16-22 Nov 2026", "30 Nov-6 Dec 2026", "28 Dec 2026-3 Jan 2027". */
function formatRange(a: CalendarDate, b: CalendarDate): string {
  if (a.year !== b.year) return `${formatDay(a)}-${formatDay(b)}`;
  if (a.month !== b.month) return `${a.day} ${MONTHS[a.month - 1]}-${formatDay(b)}`;
  return `${a.day}-${formatDay(b)}`;
}
