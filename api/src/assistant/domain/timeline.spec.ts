import { TimelineIntent } from '../assistant.types';
import { resolveTimeline } from './timeline';

const DUBAI = 'Asia/Dubai';

function timeline(over: Partial<TimelineIntent>): TimelineIntent {
  return { kind: 'none', days: null, month: null, day: null, year: null, quote: null, ...over };
}

// Calendar (Asia/Dubai, UTC+4, no DST): 2026-11-16 Mon, 22 Sun, 23 Mon, 29 Sun, 30 Mon; 2026-12-01 Tue.
// Dubai local time = UTC + 4h; 06:00Z is 10:00 local on the same date.
const at = (iso: string) => new Date(iso);
const thisWeek = timeline({ kind: 'this_week', quote: 'Ready to buy this week' });

describe('resolveTimeline', () => {
  describe('this week (Monday to Sunday in the agent zone)', () => {
    it('is the calendar week containing the sent date', () => {
      expect(resolveTimeline(thisWeek, at('2026-11-16T06:00:00Z'), DUBAI, at('2026-11-16T07:00:00Z'))).toEqual({
        kind: 'this_week',
        quote: 'Ready to buy this week',
        windowStart: '2026-11-16',
        windowEnd: '2026-11-22',
        window: '16-22 Nov 2026',
        label: 'this week (16-22 Nov 2026)',
        urgent: true,
        stale: false,
      });
    });

    it('sent on a Sunday, it is the week ending that Sunday', () => {
      const r = resolveTimeline(thisWeek, at('2026-11-22T08:00:00Z'), DUBAI, at('2026-11-22T09:00:00Z'));
      expect([r?.windowStart, r?.windowEnd]).toEqual(['2026-11-16', '2026-11-22']);
    });

    it('anchors on the Dubai date: 21:30Z on Sunday is already Monday in Dubai', () => {
      const r = resolveTimeline(thisWeek, at('2026-11-22T21:30:00Z'), DUBAI, at('2026-11-22T21:31:00Z'));
      expect([r?.windowStart, r?.windowEnd]).toEqual(['2026-11-23', '2026-11-29']);
    });

    it('spans a month end', () => {
      expect(resolveTimeline(thisWeek, at('2026-12-01T08:00:00Z'), DUBAI, at('2026-12-01T08:00:00Z'))?.label).toBe('this week (30 Nov-6 Dec 2026)');
    });

    it('spans a year end', () => {
      expect(resolveTimeline(thisWeek, at('2026-12-31T08:00:00Z'), DUBAI, at('2026-12-31T08:00:00Z'))?.label).toBe('this week (28 Dec 2026-3 Jan 2027)');
    });
  });

  describe('stale windows', () => {
    it('a "this week" message sent 9 days before the analysis is stale', () => {
      // Sat 7 Nov: the week is 2-8 Nov, which ended before Mon 16 Nov.
      const r = resolveTimeline(thisWeek, at('2026-11-07T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(r).toMatchObject({ windowStart: '2026-11-02', windowEnd: '2026-11-08', stale: true });
    });

    it('is not stale on the last day of the window (Dubai date)', () => {
      // 19:00Z on Sun 22 Nov is 23:00 Sunday in Dubai.
      expect(resolveTimeline(thisWeek, at('2026-11-16T06:00:00Z'), DUBAI, at('2026-11-22T19:00:00Z'))?.stale).toBe(false);
    });

    it('is stale once the Dubai date passes the window end, even when the UTC date has not', () => {
      // 20:30Z on Sun 22 Nov is 00:30 Monday in Dubai.
      expect(resolveTimeline(thisWeek, at('2026-11-16T06:00:00Z'), DUBAI, at('2026-11-22T20:30:00Z'))?.stale).toBe(true);
    });
  });

  describe('other kinds', () => {
    it('next week is the following Monday to Sunday', () => {
      const r = resolveTimeline(timeline({ kind: 'next_week' }), at('2026-11-22T08:00:00Z'), DUBAI, at('2026-11-22T08:00:00Z'));
      expect(r).toMatchObject({ windowStart: '2026-11-23', windowEnd: '2026-11-29', label: 'next week (23-29 Nov 2026)', urgent: true });
    });

    it('this month is the whole sent month', () => {
      const r = resolveTimeline(timeline({ kind: 'this_month' }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(r).toMatchObject({ windowStart: '2026-11-01', windowEnd: '2026-11-30', label: 'this month (1-30 Nov 2026)', urgent: true });
    });

    it('next month is the whole next calendar month, and urgent', () => {
      const r = resolveTimeline(timeline({ kind: 'next_month', quote: 'moving in next month' }), at('2026-11-15T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(r).toMatchObject({ windowStart: '2026-12-01', windowEnd: '2026-12-31', window: '1-31 Dec 2026', label: 'next month (1-31 Dec 2026)', urgent: true, stale: false });
    });

    it('next month from December is January of the next year', () => {
      const r = resolveTimeline(timeline({ kind: 'next_month' }), at('2026-12-15T08:00:00Z'), DUBAI, at('2026-12-15T08:00:00Z'));
      expect([r?.windowStart, r?.windowEnd]).toEqual(['2027-01-01', '2027-01-31']);
    });

    it('within N days runs from the sent date and is urgent up to 31 days', () => {
      const r = resolveTimeline(timeline({ kind: 'within_days', days: 14 }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(r).toMatchObject({ windowStart: '2026-11-16', windowEnd: '2026-11-30', label: 'within 14 days (16-30 Nov 2026)', urgent: true });
      expect(resolveTimeline(timeline({ kind: 'within_days', days: 31 }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'))?.urgent).toBe(true);
      expect(resolveTimeline(timeline({ kind: 'within_days', days: 60 }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'))?.urgent).toBe(false);
    });

    it('by a date is urgent only when the date is within 31 days of the sent date', () => {
      const soon = resolveTimeline(timeline({ kind: 'by_date', month: 11, day: 30 }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(soon).toMatchObject({ windowStart: '2026-11-16', windowEnd: '2026-11-30', label: 'by 30 Nov 2026', urgent: true });
      const later = resolveTimeline(timeline({ kind: 'by_date', month: 6, day: 1, year: 2027 }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(later).toMatchObject({ windowEnd: '2027-06-01', urgent: false });
    });

    it('by a date with no year takes the first occurrence on or after the sent date', () => {
      const r = resolveTimeline(timeline({ kind: 'by_date', month: 1, day: 10 }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(r?.windowEnd).toBe('2027-01-10');
    });

    it('asap is urgent, starts on the sent date, has no end and is never stale', () => {
      const r = resolveTimeline(timeline({ kind: 'asap', quote: 'ASAP' }), at('2026-11-01T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(r).toEqual({ kind: 'asap', quote: 'ASAP', windowStart: '2026-11-01', windowEnd: null, window: null, label: 'as soon as possible', urgent: true, stale: false });
    });

    it('no rush is not urgent and has no window', () => {
      const r = resolveTimeline(timeline({ kind: 'no_rush', quote: 'no rush, maybe next year' }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'));
      expect(r).toEqual({ kind: 'no_rush', quote: 'no rush, maybe next year', windowStart: null, windowEnd: null, window: null, label: 'no rush', urgent: false, stale: false });
    });

    it('none is null', () => {
      expect(resolveTimeline(timeline({ kind: 'none' }), at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'))).toBeNull();
    });
  });

  describe('invalid input from the model', () => {
    it.each([
      ['within_days without days', timeline({ kind: 'within_days', days: null })],
      ['within_days with negative days', timeline({ kind: 'within_days', days: -3 })],
      ['by_date without a month', timeline({ kind: 'by_date', day: 3 })],
      ['by_date on 31 February', timeline({ kind: 'by_date', month: 2, day: 31, year: 2027 })],
      ['by_date before the sent date', timeline({ kind: 'by_date', month: 1, day: 3, year: 2026 })],
    ])('%s gives no timeline', (_name, t) => {
      expect(resolveTimeline(t, at('2026-11-16T08:00:00Z'), DUBAI, at('2026-11-16T08:00:00Z'))).toBeNull();
    });
  });

  describe('other time zones', () => {
    it('uses the given zone, not the server zone', () => {
      // 05:00Z on Mon 16 Nov is 21:00 on Sun 15 Nov in Los Angeles: that week is 9-15 Nov.
      const r = resolveTimeline(thisWeek, at('2026-11-16T05:00:00Z'), 'America/Los_Angeles', at('2026-11-16T05:00:00Z'));
      expect([r?.windowStart, r?.windowEnd]).toEqual(['2026-11-09', '2026-11-15']);
    });
  });
});
