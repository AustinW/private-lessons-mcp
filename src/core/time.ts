/**
 * RFC 3339 boundary handling (contract §3).
 *
 * The API requires an explicit UTC offset on every timestamp it receives and emits
 * every timestamp with an explicit Pacific offset. Naive input is rejected server-side
 * with `422 VALIDATION_FAILED`; this module rejects it *before* the request leaves, and
 * tells the caller what the correct string would have been.
 *
 * Strictness matches the contract exactly:
 *   - seconds are required (`2026-08-04T14:00Z` is ISO 8601, not RFC 3339);
 *   - the offset is `Z` or `±HH:MM` (`+0200` and `+02` are rejected);
 *   - impossible instants are rejected, never rolled over (`2026-02-30`, `14:60:00`);
 *   - `T`/`t` and `Z`/`z` are both accepted (ABNF literals are case-insensitive);
 *   - the RFC 3339 §5.6 space separator is not part of the grammar and is rejected.
 *
 * Leap seconds (`:60`) are not accepted. RFC 3339's grammar permits them, but the
 * platform Date has no representation for one, so accepting the string would mean
 * silently normalising it — exactly the lenient behaviour this boundary exists to
 * prevent. This is the single documented narrowing of the grammar.
 */

export const TENANT_TIMEZONE = 'America/Los_Angeles';

const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export class Rfc3339FormatError extends Error {
  readonly input: string;

  readonly suggestion: string | undefined;

  constructor(input: string, reason: string, suggestion?: string) {
    super(
      `Invalid RFC 3339 timestamp ${JSON.stringify(input)}: ${reason}` +
        (suggestion ? ` Did you mean "${suggestion}"?` : ''),
    );
    this.name = 'Rfc3339FormatError';
    this.input = input;
    this.suggestion = suggestion;
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** True when `value` is a strictly valid RFC 3339 timestamp per the contract. */
export function isRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    assertRfc3339(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a timestamp against the contract's strict RFC 3339 rule.
 * Returns the input unchanged so it can be used inline; throws `Rfc3339FormatError`
 * with a repaired suggestion when the input is merely missing its offset.
 */
export function assertRfc3339(value: string): string {
  const match = RFC3339_RE.exec(value);
  if (!match) {
    // The single most common mistake is a naive timestamp. If that's what this is,
    // compute the offset the tenant timezone would have had at that wall clock and
    // suggest the repaired string — never apply it silently.
    const naive = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(:(\d{2}))?$/.exec(value);
    if (naive) {
      const suggestion = suggestPacificTimestamp(value);
      throw new Rfc3339FormatError(
        value,
        'an explicit UTC offset is required (the API rejects naive timestamps).',
        suggestion ?? undefined,
      );
    }
    throw new Rfc3339FormatError(
      value,
      'expected YYYY-MM-DDTHH:MM:SS followed by Z or ±HH:MM (seconds required, ' +
        'basic-form offsets such as +0200 are not accepted).',
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8] as string;

  if (month < 1 || month > 12) throw new Rfc3339FormatError(value, `month ${month} is not 1-12.`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Rfc3339FormatError(
      value,
      `${year}-${String(month).padStart(2, '0')} has no day ${day} (dates are not rolled over).`,
    );
  }
  if (hour > 23) throw new Rfc3339FormatError(value, `hour ${hour} is not 0-23.`);
  if (minute > 59) throw new Rfc3339FormatError(value, `minute ${minute} is not 0-59.`);
  if (second > 59) {
    throw new Rfc3339FormatError(
      value,
      `second ${second} is not 0-59 (leap seconds are not supported by this client).`,
    );
  }

  if (offset !== 'Z' && offset !== 'z') {
    const offHour = Number(offset.slice(1, 3));
    const offMinute = Number(offset.slice(4, 6));
    if (offHour > 23 || offMinute > 59) {
      throw new Rfc3339FormatError(value, `offset ${offset} is out of range.`);
    }
  }

  return value;
}

/** Parse a contract-valid RFC 3339 string into an absolute instant. */
export function parseRfc3339(value: string): Date {
  assertRfc3339(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Rfc3339FormatError(value, 'the platform could not parse it as an instant.');
  }
  return date;
}

const OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: TENANT_TIMEZONE,
  timeZoneName: 'longOffset',
});

/**
 * The tenant-timezone UTC offset in effect at `instant`, as `±HH:MM`.
 * Derived from the ICU database rather than hardcoded, so DST is handled correctly.
 */
export function pacificOffsetAt(instant: Date): string {
  const part = OFFSET_FORMATTER.formatToParts(instant).find((p) => p.type === 'timeZoneName');
  const raw = part?.value ?? 'GMT+00:00';
  const match = /GMT([+-]\d{2}:\d{2})/.exec(raw);
  if (match?.[1]) return match[1];
  // ICU renders a zero offset as bare "GMT".
  return '+00:00';
}

const PACIFIC_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TENANT_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function pacificFields(instant: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of PACIFIC_PARTS.formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/**
 * Given a *naive* wall clock like `2026-08-04T14:00:00`, return the RFC 3339 string
 * that same wall clock corresponds to in the tenant timezone. Used only to *suggest*
 * a repair in an error message — never to coerce input.
 *
 * Returns `null` if the input is not a recognisable naive wall clock.
 */
export function suggestPacificTimestamp(naive: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(naive.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '00'] = match;
  const stamp = `${y}-${mo}-${d}T${h}:${mi}:${s}`;

  // Guess the offset by probing the instant that would result from treating the wall
  // clock as UTC, then correcting once. Two iterations converge for every real zone.
  let offset = pacificOffsetAt(new Date(`${stamp}Z`));
  for (let i = 0; i < 2; i += 1) {
    const candidate = new Date(`${stamp}${offset}`);
    if (Number.isNaN(candidate.getTime())) return null;
    const next = pacificOffsetAt(candidate);
    if (next === offset) break;
    offset = next;
  }
  return `${stamp}${offset}`;
}

/**
 * Render an instant for humans, in Pacific, absolutely and unambiguously.
 *
 * Example: `Tue, Aug 4, 2026 at 2:00 PM PDT (2026-08-04T14:00:00-07:00)`.
 *
 * The CLI prints this before any destructive action so the operator sees the real
 * wall-clock date and time being acted on, not an id.
 */
export function formatPacific(value: string | Date): string {
  const instant = typeof value === 'string' ? parseRfc3339(value) : value;
  const human = new Intl.DateTimeFormat('en-US', {
    timeZone: TENANT_TIMEZONE,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
  return `${human} (${toPacificRfc3339(instant)})`;
}

/** Re-express an instant as RFC 3339 with the explicit Pacific offset. */
export function toPacificRfc3339(instant: Date): string {
  const f = pacificFields(instant);
  const hour = f.hour === '24' ? '00' : f.hour;
  return `${f.year}-${f.month}-${f.day}T${hour}:${f.minute}:${f.second}${pacificOffsetAt(instant)}`;
}

/** The calendar date (`YYYY-MM-DD`) an instant falls on in the tenant timezone. */
export function pacificDate(value: string | Date): string {
  const instant = typeof value === 'string' ? parseRfc3339(value) : value;
  const f = pacificFields(instant);
  return `${f.year}-${f.month}-${f.day}`;
}

/** Validate a `YYYY-MM-DD` calendar date (used by `--date` / `--from` / `--to`). */
export function assertCalendarDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Rfc3339FormatError(value, 'expected a calendar date as YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Rfc3339FormatError(value, 'is not a real calendar date.');
  }
  return value;
}
