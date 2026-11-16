import { formatDueDate, shortInput } from './format';

describe('formatDueDate', () => {
  it("shows the weekday, date, year and time in the agent's timezone", () => {
    // 06:00 UTC is 10:00 in Dubai (UTC+4).
    expect(formatDueDate('2026-10-16T06:00:00.000Z', 'Asia/Dubai')).toBe('Fri 16 Oct 2026, 10:00');
  });

  it('respects the offset in the ISO string, not the browser zone', () => {
    expect(formatDueDate('2026-10-18T23:30:00-02:00', 'Asia/Dubai')).toBe('Mon 19 Oct 2026, 05:30');
  });
});

describe('shortInput', () => {
  it('lists the set fields of a tool input as key: value, skipping null and empty ones', () => {
    expect(shortInput({ areas: ['Dubai Marina', 'JLT'], minBedrooms: 2, maxBedrooms: null, type: 'apartment', keywords: [] })).toBe(
      'areas: Dubai Marina/JLT, minBedrooms: 2, type: apartment',
    );
  });

  it('cuts long inputs to the given length with an ellipsis', () => {
    const text = shortInput({ reference: 'MBR-1001', note: 'x'.repeat(200) }, 40);
    expect(text).toHaveLength(40);
    expect(text.endsWith('…')).toBe(true);
  });

  it('handles primitives, empty objects and nested objects', () => {
    expect(shortInput('MBR-1009')).toBe('MBR-1009');
    expect(shortInput(null)).toBe('');
    expect(shortInput({})).toBe('');
    expect(shortInput({ budget: { max: 2000000 } })).toBe('budget: {"max":2000000}');
  });
});
