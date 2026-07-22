import { describe, expect, it } from 'vitest';

import {
  AthleteAmbiguousError,
  EXIT_CODES,
  exitCodeFor,
  isApiErrorCode,
  problemToError,
  ScorSyncError,
  toScorSyncError,
  type ApiErrorCode,
} from '../src/core/errors.js';

/** The frozen 13. If the contract ever changes, this list must change with it. */
const FROZEN_CODES: ApiErrorCode[] = [
  'VALIDATION_FAILED',
  'ATHLETE_NOT_FOUND',
  'ATHLETE_AMBIGUOUS',
  'LESSON_NOT_FOUND',
  'SLOT_CONFLICT',
  'OUTSIDE_BUSINESS_HOURS',
  'VERSION_MISMATCH',
  'IDEMPOTENCY_KEY_REUSED',
  'INSUFFICIENT_SCOPE',
  'FORBIDDEN',
  'RATE_LIMITED',
  'FACILITY_FEE_ACK_REQUIRED',
  'LATE_BOOKING_ACK_REQUIRED',
];

describe('error taxonomy', () => {
  it('recognises exactly the 13 contract codes', () => {
    for (const code of FROZEN_CODES) expect(isApiErrorCode(code)).toBe(true);
    // Codes explicitly dropped from the taxonomy must not creep back in.
    for (const dropped of [
      'SLOT_FULL',
      'DUPLICATE_SOURCE_EVENT',
      'PREVIEW_STALE',
      'QUOTE_EXPIRED',
      'UPSTREAM_UNAVAILABLE',
    ]) {
      expect(isApiErrorCode(dropped)).toBe(false);
    }
  });

  it('maps every contract code to a distinct, stable exit code', () => {
    const codes = FROZEN_CODES.map((c) => exitCodeFor(c));
    expect(codes).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(new Set(codes).size).toBe(FROZEN_CODES.length);
  });

  it('maps client-side conditions to their own exit codes', () => {
    expect(exitCodeFor('UNAUTHENTICATED')).toBe(16);
    expect(exitCodeFor('NO_TOKEN')).toBe(17);
    expect(exitCodeFor('NETWORK_ERROR')).toBe(18);
    expect(exitCodeFor('ABORTED')).toBe(19);
    expect(exitCodeFor('USAGE_ERROR')).toBe(2);
    expect(exitCodeFor('UNKNOWN_ERROR')).toBe(1);
  });

  it('falls back to 1 for an unrecognised code', () => {
    expect(exitCodeFor(undefined)).toBe(EXIT_CODES.UNKNOWN_ERROR);
    expect(exitCodeFor('NOT_A_REAL_CODE' as ApiErrorCode)).toBe(EXIT_CODES.UNKNOWN_ERROR);
  });

  it('never collides with the shell-reserved exit codes', () => {
    for (const value of Object.values(EXIT_CODES)) {
      expect(value).toBeLessThan(126);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('problemToError', () => {
  const headers = (extra: Record<string, string> = {}): Headers =>
    new Headers({ 'x-request-id': 'req-from-header', ...extra });

  it('parses an RFC 9457 problem document into code + detail + request_id', () => {
    const err = problemToError(
      409,
      {
        type: 'https://scorsync.example.com/errors/slot-conflict',
        title: 'Lesson conflicts with an existing booking',
        status: 409,
        detail: 'Coach already has a lesson from 2:00 PM to 3:00 PM Pacific.',
        code: 'SLOT_CONFLICT',
        request_id: 'req-from-body',
        retryable: false,
        errors: { scheduled_at: ['This time overlaps an existing lesson.'] },
      },
      headers(),
    );

    expect(err.code).toBe('SLOT_CONFLICT');
    expect(err.exitCode).toBe(EXIT_CODES.SLOT_CONFLICT);
    expect(err.requestId).toBe('req-from-body');
    expect(err.detail).toContain('2:00 PM');
    expect(err.fieldErrors?.scheduled_at?.[0]).toContain('overlaps');
  });

  it('surfaces code, detail and request_id rather than a raw JSON blob', () => {
    const err = problemToError(
      403,
      {
        title: 'Insufficient scope',
        status: 403,
        detail: "This token is missing the required scope 'lessons:write'.",
        code: 'INSUFFICIENT_SCOPE',
        request_id: 'abc123',
        retryable: false,
      },
      headers(),
    );
    const display = err.toDisplayString();
    expect(display).toContain('INSUFFICIENT_SCOPE');
    expect(display).toContain("missing the required scope 'lessons:write'");
    expect(display).toContain('request_id: abc123');
    expect(display).not.toContain('{');
  });

  it('carries current_version through a 412 VERSION_MISMATCH', () => {
    const err = problemToError(
      412,
      {
        title: 'Lesson version mismatch',
        status: 412,
        detail: 'The lesson was modified since you last read it. Current version is 5.',
        code: 'VERSION_MISMATCH',
        request_id: 'r1',
        retryable: false,
        current_version: 5,
      },
      headers(),
    );
    expect(err.code).toBe('VERSION_MISMATCH');
    expect(err.currentVersion).toBe(5);
    expect(err.toDisplayString()).toContain('current_version: 5');
    expect(err.toJSON().current_version).toBe(5);
  });

  it('distinguishes the two 409 idempotency cases by retryable + Retry-After', () => {
    const reused = problemToError(
      409,
      {
        code: 'IDEMPOTENCY_KEY_REUSED',
        title: 'Idempotency key reused with a different request',
        status: 409,
        detail: 'This Idempotency-Key was already used with a different request body.',
        request_id: 'r',
        retryable: false,
      },
      headers(),
    );
    const inProgress = problemToError(
      409,
      {
        code: 'IDEMPOTENCY_KEY_REUSED',
        title: 'A request with this Idempotency-Key is in progress',
        status: 409,
        detail: 'The original request is still being processed.',
        request_id: 'r',
        retryable: true,
      },
      headers({ 'retry-after': '2' }),
    );

    expect(reused.retryable).toBe(false);
    expect(reused.retryAfterSeconds).toBeUndefined();
    expect(inProgress.retryable).toBe(true);
    expect(inProgress.retryAfterSeconds).toBe(2);
    // Same code, same exit code — the disambiguation is `retryable`, per the contract.
    expect(reused.exitCode).toBe(inProgress.exitCode);
  });

  it('treats 401 as UNAUTHENTICATED, outside the 13-code taxonomy', () => {
    const err = problemToError(401, { message: 'Unauthenticated.' }, headers());
    expect(err.code).toBe('UNAUTHENTICATED');
    expect(err.exitCode).toBe(16);
    expect(isApiErrorCode(err.code)).toBe(false);
  });

  it('does not invent a code when the body is not a problem document', () => {
    const err = problemToError(502, '<html>bad gateway</html>', headers());
    expect(err.code).toBe('UNKNOWN_ERROR');
    expect(err.exitCode).toBe(1);
    expect(err.requestId).toBe('req-from-header');
  });
});

describe('toScorSyncError', () => {
  it('passes a ScorSyncError through unchanged', () => {
    const original = new ScorSyncError('FORBIDDEN', 'nope');
    expect(toScorSyncError(original)).toBe(original);
  });

  it('classifies a fetch failure as NETWORK_ERROR', () => {
    const err = toScorSyncError(new TypeError('fetch failed'));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.exitCode).toBe(18);
  });

  it('classifies an abort as ABORTED, not as a transport failure', () => {
    // readline rejects with "Aborted with Ctrl+D" when stdin reaches EOF mid-prompt.
    // Reporting that as NETWORK_ERROR would tell the operator the API was unreachable
    // when in fact they simply did not confirm.
    for (const err of [
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
      new Error('Aborted with Ctrl+D'),
    ]) {
      const mapped = toScorSyncError(err);
      expect(mapped.code).toBe('ABORTED');
      expect(mapped.exitCode).toBe(19);
    }
  });
});

describe('AthleteAmbiguousError', () => {
  it('is client-surfaced: no HTTP status, and it lists the candidates', () => {
    const err = new AthleteAmbiguousError('Smith', [
      { id: 1, name: 'Ada Smith' },
      { id: 2, name: 'Alan Smith' },
    ]);
    expect(err.code).toBe('ATHLETE_AMBIGUOUS');
    expect(err.status).toBeUndefined();
    expect(err.exitCode).toBe(EXIT_CODES.ATHLETE_AMBIGUOUS);
    expect(err.toDisplayString()).toContain('id=1');
    expect(err.toDisplayString()).toContain('id=2');
    expect(err.toJSON().candidates).toHaveLength(2);
  });
});
