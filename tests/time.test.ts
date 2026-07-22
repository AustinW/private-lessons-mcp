import { describe, expect, it } from 'vitest';

import {
  assertCalendarDate,
  assertRfc3339,
  formatPacific,
  isRfc3339,
  pacificDate,
  pacificOffsetAt,
  parseRfc3339,
  Rfc3339FormatError,
  suggestPacificTimestamp,
  toPacificRfc3339,
} from '../src/core/time.js';

describe('strict RFC 3339 validation (contract §3)', () => {
  it('accepts a timestamp with an explicit offset', () => {
    expect(assertRfc3339('2026-08-04T14:00:00-07:00')).toBe('2026-08-04T14:00:00-07:00');
    expect(isRfc3339('2026-01-15T09:30:00-08:00')).toBe(true);
    expect(isRfc3339('2026-08-04T21:00:00Z')).toBe(true);
  });

  it('accepts lowercase t and z — ABNF literals are case-insensitive', () => {
    expect(isRfc3339('2026-08-04t14:00:00z')).toBe(true);
  });

  it('accepts fractional seconds', () => {
    expect(isRfc3339('2026-08-04T14:00:00.123-07:00')).toBe(true);
  });

  it('REJECTS a naive / offset-less timestamp', () => {
    expect(isRfc3339('2026-08-04T14:00:00')).toBe(false);
    expect(() => assertRfc3339('2026-08-04T14:00:00')).toThrow(Rfc3339FormatError);
  });

  it('REJECTS a missing seconds field (that is ISO 8601, not RFC 3339)', () => {
    expect(isRfc3339('2026-08-04T14:00Z')).toBe(false);
  });

  it('REJECTS basic-form offsets', () => {
    expect(isRfc3339('2026-08-04T14:00:00+0200')).toBe(false);
    expect(isRfc3339('2026-08-04T14:00:00+02')).toBe(false);
  });

  it('REJECTS the RFC 3339 §5.6 space separator', () => {
    expect(isRfc3339('2026-08-04 14:00:00-07:00')).toBe(false);
  });

  it('REJECTS impossible instants rather than rolling them over', () => {
    expect(isRfc3339('2026-02-30T10:00:00Z')).toBe(false);
    expect(isRfc3339('2026-08-04T14:60:00Z')).toBe(false);
    expect(isRfc3339('2026-13-01T10:00:00Z')).toBe(false);
    expect(isRfc3339('2026-08-04T24:00:00Z')).toBe(false);
    // 2026 is not a leap year; 2024 is.
    expect(isRfc3339('2026-02-29T10:00:00Z')).toBe(false);
    expect(isRfc3339('2024-02-29T10:00:00Z')).toBe(true);
  });

  it('REJECTS surrounding whitespace without repairing it', () => {
    expect(isRfc3339(' 2026-08-04T14:00:00-07:00')).toBe(false);
    expect(isRfc3339('2026-08-04T14:00:00-07:00 ')).toBe(false);
  });

  it('suggests the repaired Pacific string for a naive input, without applying it', () => {
    let thrown: Rfc3339FormatError | undefined;
    try {
      assertRfc3339('2026-08-04T14:00:00');
    } catch (err) {
      thrown = err as Rfc3339FormatError;
    }
    expect(thrown).toBeInstanceOf(Rfc3339FormatError);
    expect(thrown?.suggestion).toBe('2026-08-04T14:00:00-07:00');
    expect(thrown?.message).toContain('explicit UTC offset is required');
  });
});

describe('Pacific rendering', () => {
  it('resolves the tenant offset from the timezone database, honouring DST', () => {
    // PDT in August, PST in January.
    expect(pacificOffsetAt(new Date('2026-08-04T21:00:00Z'))).toBe('-07:00');
    expect(pacificOffsetAt(new Date('2026-01-15T21:00:00Z'))).toBe('-08:00');
  });

  it('renders an absolute Pacific date/time plus the machine-readable form', () => {
    const rendered = formatPacific('2026-08-04T14:00:00-07:00');
    expect(rendered).toContain('Aug 4, 2026');
    expect(rendered).toContain('2:00');
    expect(rendered).toContain('PM');
    expect(rendered).toContain('(2026-08-04T14:00:00-07:00)');
  });

  it('converts an instant expressed in another zone to the Pacific wall clock', () => {
    // 22:00 UTC is 15:00 Pacific in August.
    expect(formatPacific('2026-08-04T22:00:00Z')).toContain('3:00');
    expect(toPacificRfc3339(new Date('2026-08-04T22:00:00Z'))).toBe('2026-08-04T15:00:00-07:00');
  });

  it('round-trips an instant through the Pacific representation', () => {
    const original = '2026-11-01T09:30:00-08:00'; // the day after the fall-back transition
    expect(parseRfc3339(toPacificRfc3339(parseRfc3339(original))).getTime()).toBe(
      parseRfc3339(original).getTime(),
    );
  });

  it('reports the Pacific calendar date, not the UTC one', () => {
    // 2026-08-05T02:00Z is still 2026-08-04 in Pacific.
    expect(pacificDate('2026-08-05T02:00:00Z')).toBe('2026-08-04');
  });

  it('picks the right offset either side of both DST transitions', () => {
    // Spring forward 2026-03-08, fall back 2026-11-01.
    expect(suggestPacificTimestamp('2026-03-07T10:00:00')).toBe('2026-03-07T10:00:00-08:00');
    expect(suggestPacificTimestamp('2026-03-09T10:00:00')).toBe('2026-03-09T10:00:00-07:00');
    expect(suggestPacificTimestamp('2026-10-31T10:00:00')).toBe('2026-10-31T10:00:00-07:00');
    expect(suggestPacificTimestamp('2026-11-02T10:00:00')).toBe('2026-11-02T10:00:00-08:00');
  });
});

describe('calendar dates', () => {
  it('accepts a real date and rejects a fake one', () => {
    expect(assertCalendarDate('2026-08-04')).toBe('2026-08-04');
    expect(() => assertCalendarDate('2026-02-30')).toThrow(Rfc3339FormatError);
    expect(() => assertCalendarDate('04/08/2026')).toThrow(Rfc3339FormatError);
  });
});
