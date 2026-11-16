import { FollowUpIntent, ResolvedTimeline, Weekday, WEEKDAYS } from '../assistant.types';

/**
 * Resolves a follow-up intent to a due date in the agent's time zone.
 *
 * Rules (plan 2.5 + section 7):
 * - The anchor is always the analysed message's sentAt. The current clock and the server's time zone
 *   are never read, so the result is the same whenever (and wherever) Sara runs the assistant.
 * - Calendar arithmetic is done on the local calendar date in `timeZone`, not on milliseconds.
 * - Time of day is the lead's stated "HH:MM", otherwise 10:00 local.
 * - The offset is the one in force at that local wall time, rendered like "+04:00" (never "Z").
 * - Invariant: dueAt === null if and only if needsClarification !== null.
 */

export interface DueAtResolution {
  dueAt: string | null;
  needsClarification: string | null;
}

export const NO_FOLLOW_UP_TIMING = 'The lead did not say when to follow up.';
export const DEFAULT_FOLLOW_UP_TIME = '10:00';
const DEFAULT_UNCLEAR = 'The follow-up timing in the message is unclear.';
const MAX_RELATIVE_DAYS = 366;

/** A calendar date with no time zone. month is 1-12. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Weekday index as Date#getUTCDay returns it: 0 = Sunday ... 6 = Saturday. */
const WEEKDAY_INDEX: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function resolveDueAt(intent: FollowUpIntent, sentAt: Date, timeZone: string): DueAtResolution {
  const sentDate = localDate(sentAt, timeZone); // throws RangeError for an unknown zone
  const target = targetDate(intent, sentDate);
  if ('unclear' in target) return { dueAt: null, needsClarification: target.unclear };
  return { dueAt: formatLocal(target.date, parseTime(intent.time), timeZone), needsClarification: null };
}

export interface FollowUpDue extends DueAtResolution {
  /** True when the date came from the lead's urgent timeline, not from contact timing. */
  fromTimeline: boolean;
}

/**
 * The follow-up date for a run. Contact timing the lead gave ("call me tomorrow", "by Thursday") always
 * wins. With none, an urgent purchase/move timeline ("ready to buy this week", "moving in next month")
 * means the agent follows up on the next working day (Monday to Friday) after the message, at 10:00.
 * Otherwise the result is resolveDueAt's. Anchored on sentAt only, like resolveDueAt.
 *
 * An "unclear" contact timing whose quote overlaps the timeline's quote is the model reading the same
 * words twice ("this week" as vague contact timing): it is treated as no contact timing.
 */
export function resolveFollowUpDue(intent: FollowUpIntent, timeline: ResolvedTimeline | null, sentAt: Date, timeZone: string): FollowUpDue {
  const noContactTiming = intent.kind === 'none' || (intent.kind === 'unclear' && sameWords(intent.quote, timeline?.quote ?? null));
  if (noContactTiming && timeline?.urgent) {
    const date = nextWorkingDayAfter(localDate(sentAt, timeZone));
    return { dueAt: formatLocal(date, parseTime(null), timeZone), needsClarification: null, fromTimeline: true };
  }
  return { ...resolveDueAt(intent, sentAt, timeZone), fromTimeline: false };
}

function sameWords(a: string | null, b: string | null): boolean {
  const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

/** The first Monday-to-Friday date strictly after d (the UAE weekend is Saturday and Sunday). */
function nextWorkingDayAfter(d: CalendarDate): CalendarDate {
  let next = addDays(d, 1);
  while (weekdayOf(next) === 0 || weekdayOf(next) === 6) next = addDays(next, 1);
  return next;
}

type Target = { date: CalendarDate } | { unclear: string };

function targetDate(intent: FollowUpIntent, sent: CalendarDate): Target {
  switch (intent.kind) {
    case 'relative_days': {
      const n = intent.days;
      if (n === null || !Number.isInteger(n) || n < 0 || n > MAX_RELATIVE_DAYS) {
        return { unclear: unclearOr(intent, 'The number of days until the follow-up is unclear.') };
      }
      return { date: addDays(sent, n) };
    }
    case 'weekday': {
      if (intent.weekday === null || !(WEEKDAYS as readonly string[]).includes(intent.weekday)) {
        return { unclear: unclearOr(intent, 'The day of the week for the follow-up is unclear.') };
      }
      return { date: nextWeekdayAfter(sent, WEEKDAY_INDEX[intent.weekday]) };
    }
    case 'after_weekend':
      // UAE weekend is Saturday and Sunday: the first Monday strictly after the sent date.
      return { date: nextWeekdayAfter(sent, WEEKDAY_INDEX.monday) };
    case 'absolute_date':
      return absoluteDate(intent, sent);
    case 'none':
      return { unclear: NO_FOLLOW_UP_TIMING };
    case 'unclear':
    default:
      return { unclear: unclearOr(intent, DEFAULT_UNCLEAR) };
  }
}

function absoluteDate(intent: FollowUpIntent, sent: CalendarDate): Target {
  const { month, day, year } = intent;
  const bad = { unclear: unclearOr(intent, 'The follow-up date in the message is not a valid date.') };
  if (month === null || day === null || !Number.isInteger(month) || !Number.isInteger(day)) return bad;

  if (year !== null) {
    if (!Number.isInteger(year)) return bad;
    const date = { year, month, day };
    if (!isValidDate(date)) return bad;
    if (compareDates(date, sent) < 0) {
      return { unclear: unclearOr(intent, 'The follow-up date is before the message was sent.') };
    }
    return { date };
  }

  // No year: the first occurrence on or after the sent date (8 years covers 29 February).
  for (let y = sent.year; y <= sent.year + 8; y++) {
    const date = { year: y, month, day };
    if (isValidDate(date) && compareDates(date, sent) >= 0) return { date };
  }
  return bad;
}

function unclearOr(intent: FollowUpIntent, fallback: string): string {
  const reason = intent.unclearReason?.trim();
  return reason ? reason : fallback;
}

// ---------------------------------------------------------------------------
// Calendar helpers (UTC-based arithmetic on plain calendar dates)
// ---------------------------------------------------------------------------

export function toUtcMs(d: CalendarDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

export function fromUtcMs(ms: number): CalendarDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function addDays(d: CalendarDate, n: number): CalendarDate {
  return fromUtcMs(Date.UTC(d.year, d.month - 1, d.day + n));
}

export function weekdayOf(d: CalendarDate): number {
  return new Date(toUtcMs(d)).getUTCDay();
}

function nextWeekdayAfter(d: CalendarDate, weekday: number): CalendarDate {
  const delta = ((weekday - weekdayOf(d) + 7) % 7) || 7;
  return addDays(d, delta);
}

export function isValidDate(d: CalendarDate): boolean {
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31 || d.year < 1970 || d.year > 9999) return false;
  const back = fromUtcMs(toUtcMs(d));
  return back.year === d.year && back.month === d.month && back.day === d.day;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return toUtcMs(a) - toUtcMs(b);
}

// ---------------------------------------------------------------------------
// Time zone helpers (Intl only; never the server's zone)
// ---------------------------------------------------------------------------

export interface WallTime {
  hour: number;
  minute: number;
}

function parseTime(time: string | null): WallTime {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? DEFAULT_FOLLOW_UP_TIME).trim());
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour <= 23 && minute <= 59) return { hour, minute };
  }
  return { hour: 10, minute: 0 };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields of an instant in a zone. */
function wallParts(instantMs: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

export function localDate(instant: Date, timeZone: string): CalendarDate {
  const p = wallParts(instant.getTime(), timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** Offset of the zone from UTC at an instant, in minutes (Dubai = +240). */
function offsetMinutes(instantMs: number, timeZone: string): number {
  const p = wallParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instantMs / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

export function formatLocal(date: CalendarDate, time: WallTime, timeZone: string): string {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  // Find the offset in force at that wall time (two passes handle DST transitions).
  let offset = offsetMinutes(wallAsUtc, timeZone);
  const second = offsetMinutes(wallAsUtc - offset * 60000, timeZone);
  if (second !== offset) offset = second;

  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}T${pad(time.hour)}:${pad(time.minute)}:00${formatOffset(offset)}`;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}
