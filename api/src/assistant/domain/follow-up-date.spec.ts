import { FollowUpIntent, ResolvedTimeline } from '../assistant.types';
import { NO_FOLLOW_UP_TIMING, resolveDueAt, resolveFollowUpDue } from './follow-up-date';

const DUBAI = 'Asia/Dubai';

function intent(over: Partial<FollowUpIntent>): FollowUpIntent {
  return {
    kind: 'none',
    days: null,
    weekday: null,
    month: null,
    day: null,
    year: null,
    time: null,
    quote: null,
    unclearReason: null,
    ...over,
  };
}

const tomorrow = intent({ kind: 'relative_days', days: 1, quote: 'tomorrow' });
const afterWeekend = intent({ kind: 'after_weekend', quote: 'after the weekend' });

// Calendar (Asia/Dubai, UTC+4, no DST):
// 2026-10-15 Thu, 16 Fri, 17 Sat, 18 Sun, 19 Mon, 22 Thu, 26 Mon.
// Dubai local time = UTC + 4h; 06:00Z is 10:00 local on the same date.
const at = (iso: string) => new Date(iso);

describe('resolveDueAt', () => {
  describe('relative days', () => {
    it('tomorrow is the next Dubai calendar day at 10:00 +04:00', () => {
      expect(resolveDueAt(tomorrow, at('2026-10-15T06:00:00Z'), DUBAI)).toEqual({
        dueAt: '2026-10-16T10:00:00+04:00',
        needsClarification: null,
      });
    });

    it('anchors on the Dubai date, not the UTC date, late in the evening UTC', () => {
      // 21:30Z on Fri 16 Oct is 01:30 on Sat 17 Oct in Dubai, so tomorrow is Sun 18 Oct.
      expect(resolveDueAt(tomorrow, at('2026-10-16T21:30:00Z'), DUBAI).dueAt).toBe('2026-10-18T10:00:00+04:00');
    });

    it('tomorrow can be a Saturday (sent Friday)', () => {
      expect(resolveDueAt(tomorrow, at('2026-10-16T08:00:00Z'), DUBAI).dueAt).toBe('2026-10-17T10:00:00+04:00');
    });

    it('tomorrow can be a Sunday (sent Saturday)', () => {
      expect(resolveDueAt(tomorrow, at('2026-10-17T08:00:00Z'), DUBAI).dueAt).toBe('2026-10-18T10:00:00+04:00');
    });

    it('today is the sent date', () => {
      expect(resolveDueAt(intent({ kind: 'relative_days', days: 0 }), at('2026-10-15T06:00:00Z'), DUBAI).dueAt).toBe(
        '2026-10-15T10:00:00+04:00',
      );
    });

    it('in three days crosses a month end', () => {
      expect(resolveDueAt(intent({ kind: 'relative_days', days: 3 }), at('2026-10-30T06:00:00Z'), DUBAI).dueAt).toBe(
        '2026-11-02T10:00:00+04:00',
      );
    });

    it('uses the time the lead stated', () => {
      expect(resolveDueAt({ ...tomorrow, time: '14:30' }, at('2026-10-15T06:00:00Z'), DUBAI).dueAt).toBe(
        '2026-10-16T14:30:00+04:00',
      );
    });

    it('falls back to 10:00 for a malformed time', () => {
      expect(resolveDueAt({ ...tomorrow, time: '25:99' }, at('2026-10-15T06:00:00Z'), DUBAI).dueAt).toBe(
        '2026-10-16T10:00:00+04:00',
      );
    });

    it.each([null, -1, 1.5, 400])('is unclear for days = %p', (days) => {
      const r = resolveDueAt(intent({ kind: 'relative_days', days }), at('2026-10-15T06:00:00Z'), DUBAI);
      expect(r.dueAt).toBeNull();
      expect(r.needsClarification).toEqual(expect.any(String));
    });
  });

  describe('after the weekend (UAE weekend is Saturday and Sunday)', () => {
    it.each([
      ['Thursday', '2026-10-15T08:00:00Z'],
      ['Friday', '2026-10-16T08:00:00Z'],
      ['Saturday', '2026-10-17T08:00:00Z'],
      ['Sunday', '2026-10-18T08:00:00Z'],
    ])('sent on %s is Monday 19 Oct', (_day, sent) => {
      expect(resolveDueAt(afterWeekend, at(sent), DUBAI)).toEqual({
        dueAt: '2026-10-19T10:00:00+04:00',
        needsClarification: null,
      });
    });

    it('sent on a Monday is the following Monday', () => {
      expect(resolveDueAt(afterWeekend, at('2026-10-19T08:00:00Z'), DUBAI).dueAt).toBe('2026-10-26T10:00:00+04:00');
    });

    it('uses the Dubai date: Sunday 21:00Z is already Monday in Dubai', () => {
      expect(resolveDueAt(afterWeekend, at('2026-10-18T21:00:00Z'), DUBAI).dueAt).toBe('2026-10-26T10:00:00+04:00');
    });
  });

  describe('weekday', () => {
    it('is strictly after the sent date (Thursday on a Thursday is next week)', () => {
      const r = resolveDueAt(intent({ kind: 'weekday', weekday: 'thursday' }), at('2026-10-15T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBe('2026-10-22T10:00:00+04:00');
    });

    it('Monday from a Thursday is the coming Monday', () => {
      const r = resolveDueAt(intent({ kind: 'weekday', weekday: 'monday' }), at('2026-10-15T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBe('2026-10-19T10:00:00+04:00');
    });

    it('Saturday from a Friday is the next day', () => {
      const r = resolveDueAt(intent({ kind: 'weekday', weekday: 'saturday' }), at('2026-10-16T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBe('2026-10-17T10:00:00+04:00');
    });

    it('is unclear without a weekday', () => {
      const r = resolveDueAt(intent({ kind: 'weekday' }), at('2026-10-15T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBeNull();
      expect(r.needsClarification).toEqual(expect.any(String));
    });
  });

  describe('absolute date', () => {
    it('uses the stated day this year when it is still ahead', () => {
      const r = resolveDueAt(intent({ kind: 'absolute_date', month: 10, day: 20 }), at('2026-10-17T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBe('2026-10-20T10:00:00+04:00');
    });

    it('accepts the sent date itself', () => {
      const r = resolveDueAt(intent({ kind: 'absolute_date', month: 10, day: 17 }), at('2026-10-17T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBe('2026-10-17T10:00:00+04:00');
    });

    it('rolls to next year when the day has passed', () => {
      const r = resolveDueAt(intent({ kind: 'absolute_date', month: 1, day: 5 }), at('2026-10-17T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBe('2027-01-05T10:00:00+04:00');
    });

    it('uses an explicit year', () => {
      const r = resolveDueAt(
        intent({ kind: 'absolute_date', year: 2027, month: 3, day: 1, time: '09:15' }),
        at('2026-10-17T08:00:00Z'),
        DUBAI,
      );
      expect(r.dueAt).toBe('2027-03-01T09:15:00+04:00');
    });

    it.each<[string, Partial<FollowUpIntent>]>([
      ['30 February', { month: 2, day: 30 }],
      ['month 13', { month: 13, day: 1 }],
      ['day 0', { month: 5, day: 0 }],
      ['missing day', { month: 5 }],
      ['a past explicit year', { year: 2025, month: 12, day: 1 }],
    ])('is unclear for %s', (_name, over) => {
      const r = resolveDueAt(intent({ kind: 'absolute_date', ...over }), at('2026-10-17T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBeNull();
      expect(r.needsClarification).toEqual(expect.any(String));
    });

    it('29 February with no year waits for the next leap year', () => {
      const r = resolveDueAt(intent({ kind: 'absolute_date', month: 2, day: 29 }), at('2026-10-17T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBe('2028-02-29T10:00:00+04:00');
    });
  });

  describe('none and unclear', () => {
    it('none has no date and says the lead gave no timing', () => {
      expect(resolveDueAt(intent({ kind: 'none' }), at('2026-10-17T08:00:00Z'), DUBAI)).toEqual({
        dueAt: null,
        needsClarification: NO_FOLLOW_UP_TIMING,
      });
    });

    it('unclear passes the reason through', () => {
      const r = resolveDueAt(
        intent({ kind: 'unclear', unclearReason: '"Sometime soon" does not name a day.' }),
        at('2026-10-17T08:00:00Z'),
        DUBAI,
      );
      expect(r).toEqual({ dueAt: null, needsClarification: '"Sometime soon" does not name a day.' });
    });

    it('unclear without a reason still explains itself', () => {
      const r = resolveDueAt(intent({ kind: 'unclear', unclearReason: '  ' }), at('2026-10-17T08:00:00Z'), DUBAI);
      expect(r.dueAt).toBeNull();
      expect(r.needsClarification).toMatch(/\S/);
    });
  });

  describe('other time zones', () => {
    it('renders a half-hour offset (Asia/Kolkata)', () => {
      expect(resolveDueAt(tomorrow, at('2026-10-15T06:00:00Z'), 'Asia/Kolkata').dueAt).toBe('2026-10-16T10:00:00+05:30');
    });

    it('uses the offset in force on the due date across a DST change (America/New_York)', () => {
      // 2026-10-31 23:00 EDT; DST ends 2026-11-01 02:00, so 10:00 on 1 Nov is EST.
      expect(resolveDueAt(tomorrow, at('2026-11-01T03:00:00Z'), 'America/New_York').dueAt).toBe(
        '2026-11-01T10:00:00-05:00',
      );
    });

    it('renders UTC as +00:00, never Z', () => {
      expect(resolveDueAt(tomorrow, at('2026-10-15T06:00:00Z'), 'UTC').dueAt).toBe('2026-10-16T10:00:00+00:00');
    });

    it('throws on an unknown time zone instead of guessing', () => {
      expect(() => resolveDueAt(tomorrow, at('2026-10-15T06:00:00Z'), 'Mars/Olympus')).toThrow(RangeError);
    });
  });

  describe('invariants', () => {
    const cases: FollowUpIntent[] = [
      tomorrow,
      afterWeekend,
      intent({ kind: 'weekday', weekday: 'sunday' }),
      intent({ kind: 'weekday' }),
      intent({ kind: 'absolute_date', month: 2, day: 30 }),
      intent({ kind: 'absolute_date', month: 12, day: 25 }),
      intent({ kind: 'relative_days', days: null }),
      intent({ kind: 'none' }),
      intent({ kind: 'unclear', unclearReason: 'x' }),
    ];

    it.each(cases.map((c) => [c.kind, c] as const))('dueAt is null iff needsClarification is set (%s)', (_k, c) => {
      const r = resolveDueAt(c, at('2026-10-15T06:00:00Z'), DUBAI);
      expect(r.dueAt === null).toBe(r.needsClarification !== null);
      if (r.dueAt !== null) expect(r.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    });

    it('never reads the current clock', () => {
      const spy = jest.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('Date.now must not be called');
      });
      try {
        expect(resolveDueAt(tomorrow, at('2026-10-15T06:00:00Z'), DUBAI).dueAt).toBe('2026-10-16T10:00:00+04:00');
      } finally {
        spy.mockRestore();
      }
    });
  });
});

// Calendar (Asia/Dubai): 2026-11-16 Mon, 19 Thu, 20 Fri, 21 Sat, 22 Sun, 23 Mon; 2026-11-07 Sat, 09 Mon.
function resolved(over: Partial<ResolvedTimeline>): ResolvedTimeline {
  return {
    kind: 'this_week',
    quote: 'Ready to buy this week',
    windowStart: '2026-11-16',
    windowEnd: '2026-11-22',
    window: '16-22 Nov 2026',
    label: 'this week (16-22 Nov 2026)',
    urgent: true,
    stale: false,
    ...over,
  };
}

describe('resolveFollowUpDue (contact timing first, then the lead timeline)', () => {
  const none = intent({ kind: 'none' });
  const urgent = resolved({});

  describe('no contact timing and an urgent timeline: the next working day after sentAt, 10:00', () => {
    it.each([
      ['Mon 16 Nov -> Tue 17 Nov', '2026-11-16T06:00:00Z', '2026-11-17T10:00:00+04:00'],
      ['Thu 19 Nov -> Fri 20 Nov', '2026-11-19T06:00:00Z', '2026-11-20T10:00:00+04:00'],
      ['Fri 20 Nov -> Mon 23 Nov (skips the weekend)', '2026-11-20T06:00:00Z', '2026-11-23T10:00:00+04:00'],
      ['Sat 21 Nov -> Mon 23 Nov', '2026-11-21T06:00:00Z', '2026-11-23T10:00:00+04:00'],
      ['Sun 22 Nov -> Mon 23 Nov', '2026-11-22T06:00:00Z', '2026-11-23T10:00:00+04:00'],
      ['21:30Z Thu 19 Nov is Fri 20 Nov in Dubai -> Mon 23 Nov', '2026-11-19T21:30:00Z', '2026-11-23T10:00:00+04:00'],
    ])('%s', (_name, sentAt, expected) => {
      expect(resolveFollowUpDue(none, urgent, at(sentAt), DUBAI)).toEqual({ dueAt: expected, needsClarification: null, fromTimeline: true });
    });

    it('stays anchored on sentAt when the window is stale', () => {
      expect(resolveFollowUpDue(none, resolved({ stale: true }), at('2026-11-07T08:00:00Z'), DUBAI).dueAt).toBe('2026-11-09T10:00:00+04:00');
    });

    it('uses the agent zone offset (Los Angeles)', () => {
      // 2026-11-16T20:00Z is Mon 16 Nov 12:00 in Los Angeles (PST, -08:00).
      expect(resolveFollowUpDue(none, urgent, at('2026-11-16T20:00:00Z'), 'America/Los_Angeles').dueAt).toBe('2026-11-17T10:00:00-08:00');
    });
  });

  describe('explicit contact timing wins', () => {
    it('"call me Thursday" plus "buying next month" is Thursday', () => {
      const thursday = intent({ kind: 'weekday', weekday: 'thursday', quote: 'call me Thursday' });
      const nextMonth = resolved({ kind: 'next_month', quote: 'buying next month' });
      expect(resolveFollowUpDue(thursday, nextMonth, at('2026-11-16T06:00:00Z'), DUBAI)).toEqual({
        dueAt: '2026-11-19T10:00:00+04:00',
        needsClarification: null,
        fromTimeline: false,
      });
    });

    it('"tomorrow" plus an urgent timeline is tomorrow, even on a Saturday', () => {
      expect(resolveFollowUpDue(tomorrow, urgent, at('2026-11-20T06:00:00Z'), DUBAI).dueAt).toBe('2026-11-21T10:00:00+04:00');
    });

    it('genuinely vague contact timing stays unclear', () => {
      const sometime = intent({ kind: 'unclear', quote: 'Give me a shout sometime', unclearReason: '"sometime" names no day.' });
      expect(resolveFollowUpDue(sometime, urgent, at('2026-11-16T06:00:00Z'), DUBAI)).toEqual({
        dueAt: null,
        needsClarification: '"sometime" names no day.',
        fromTimeline: false,
      });
    });

    it('an "unclear" reading of the same words as the timeline is the timeline', () => {
      const sameWords = intent({ kind: 'unclear', quote: 'this week', unclearReason: '"this week" does not name a day.' });
      expect(resolveFollowUpDue(sameWords, urgent, at('2026-11-16T06:00:00Z'), DUBAI)).toEqual({
        dueAt: '2026-11-17T10:00:00+04:00',
        needsClarification: null,
        fromTimeline: true,
      });
    });
  });

  describe('no urgent timeline: today\'s behaviour', () => {
    it.each([
      ['no timeline', null],
      ['no rush', resolved({ kind: 'no_rush', windowStart: null, windowEnd: null, window: null, label: 'no rush', urgent: false })],
    ])('%s gives no date and asks for clarification', (_name, t) => {
      expect(resolveFollowUpDue(none, t, at('2026-11-16T06:00:00Z'), DUBAI)).toEqual({ dueAt: null, needsClarification: NO_FOLLOW_UP_TIMING, fromTimeline: false });
    });
  });
});
