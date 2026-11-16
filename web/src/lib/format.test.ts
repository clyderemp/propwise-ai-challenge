import { formatDueDate } from './format';

describe('formatDueDate', () => {
  it("shows the weekday, date, year and time in the agent's timezone", () => {
    // 06:00 UTC is 10:00 in Dubai (UTC+4).
    expect(formatDueDate('2026-10-16T06:00:00.000Z', 'Asia/Dubai')).toBe('Fri 16 Oct 2026, 10:00');
  });

  it('respects the offset in the ISO string, not the browser zone', () => {
    expect(formatDueDate('2026-10-18T23:30:00-02:00', 'Asia/Dubai')).toBe('Mon 19 Oct 2026, 05:30');
  });
});
