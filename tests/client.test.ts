/**
 * Transport-level contract behaviour: the required headers, the ETag surface, the
 * timestamp boundary, and the fact that error responses become typed errors.
 */

import { describe, expect, it } from 'vitest';

import { normaliseBaseUrl, PrivateLessonsClient } from '../src/core/client.js';
import { formatETag, parseETag, resolveIdempotencyKey, resolveIfMatch } from '../src/core/concurrency.js';
import { PrivateLessonsError } from '../src/core/errors.js';
import { Rfc3339FormatError } from '../src/core/time.js';
import { makeAthlete, makeLesson, MockApi, problem } from './helpers/mock-api.js';

function clientFor(api: MockApi): PrivateLessonsClient {
  return new PrivateLessonsClient({ baseUrl: api.baseUrl, token: 'test-token', fetch: api.fetch });
}

describe('base URL handling', () => {
  it('appends the /api/v1 base path when it is missing and never guesses a host', () => {
    expect(normaliseBaseUrl('https://gym.example.com')).toBe('https://gym.example.com/api/v1');
    expect(normaliseBaseUrl('https://gym.example.com/')).toBe('https://gym.example.com/api/v1');
    expect(normaliseBaseUrl('https://gym.example.com/api/v1')).toBe(
      'https://gym.example.com/api/v1',
    );
    expect(normaliseBaseUrl('gym.example.com')).toBe('https://gym.example.com/api/v1');
  });
});

describe('authentication header', () => {
  it('sends the token as a bearer credential', async () => {
    const api = new MockApi().on('GET /balances', () => ({ body: { data: [] } }));
    await clientFor(api).listBalances();
    expect(api.requests[0]?.headers.authorization).toBe('Bearer test-token');
  });
});

describe('Idempotency-Key', () => {
  it('is generated automatically on POST /lessons when the caller supplies none', async () => {
    const api = new MockApi().on('POST /lessons', () => ({
      status: 201,
      body: { data: makeLesson() },
      headers: { etag: '"lesson-42-v1"' },
    }));

    await clientFor(api).createLesson({
      coach_id: 7,
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration_minutes: 60,
      fee_acknowledged: true,
    });

    const key = api.requestsFor('POST', '/lessons')[0]?.headers['idempotency-key'];
    expect(key).toBeTruthy();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is generated automatically on POST /athletes too', async () => {
    const api = new MockApi().on('POST /athletes', () => ({
      status: 201,
      body: { data: makeAthlete(101, 'Ada Lovelace') },
    }));
    await clientFor(api).createAthlete({ first_name: 'Ada', last_name: 'Lovelace' });
    expect(api.requestsFor('POST', '/athletes')[0]?.headers['idempotency-key']).toBeTruthy();
  });

  it('passes a caller-supplied key through verbatim, so a retry replays', async () => {
    const api = new MockApi().on('POST /lessons', () => ({
      status: 201,
      body: { data: makeLesson() },
    }));
    const client = clientFor(api);
    const body = {
      coach_id: 7,
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration_minutes: 60 as const,
      fee_acknowledged: true,
    };
    await client.createLesson(body, { idempotencyKey: 'my-key' });
    await client.createLesson(body, { idempotencyKey: 'my-key' });

    const keys = api.requestsFor('POST', '/lessons').map((r) => r.headers['idempotency-key']);
    expect(keys).toEqual(['my-key', 'my-key']);
  });

  it('is also sent on cancel and mark-paid, where the API accepts it', async () => {
    const api = new MockApi()
      .on('POST /lessons/{id}/cancel', () => ({ body: { data: makeLesson({ version: 4 }) } }))
      .on('POST /lessons/{id}/mark-paid', () => ({ body: { data: makeLesson({ version: 4 }) } }));
    const client = clientFor(api);
    await client.cancelLesson(42, {}, { ifMatch: '"lesson-42-v3"' });
    await client.markLessonPaid(42, {}, { ifMatch: '"lesson-42-v3"' });

    expect(api.requestsFor('POST', '/lessons/42/cancel')[0]?.headers['idempotency-key']).toBeTruthy();
    expect(
      api.requestsFor('POST', '/lessons/42/mark-paid')[0]?.headers['idempotency-key'],
    ).toBeTruthy();
  });

  it('rejects an over-long key rather than letting the server 422', () => {
    expect(() => resolveIdempotencyKey('x'.repeat(256))).toThrow();
    expect(resolveIdempotencyKey('  ')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('If-Match and ETags', () => {
  it('exposes the strong ETag from a read for use on the next write', async () => {
    const api = new MockApi().on('GET /lessons/{id}', () => ({
      body: { data: makeLesson({ version: 3 }) },
      headers: { etag: '"lesson-42-v3"' },
    }));
    const result = await clientFor(api).getLesson(42);
    expect(result.etag).toBe('"lesson-42-v3"');
    expect(parseETag(result.etag as string)).toEqual({ lessonId: 42, version: 3 });
  });

  it('sends If-Match verbatim on PATCH, cancel and mark-paid', async () => {
    const api = new MockApi()
      .on('PATCH /lessons/{id}', () => ({ body: { data: makeLesson({ version: 4 }) } }))
      .on('POST /lessons/{id}/cancel', () => ({ body: { data: makeLesson({ version: 4 }) } }))
      .on('POST /lessons/{id}/mark-paid', () => ({ body: { data: makeLesson({ version: 4 }) } }));

    const client = clientFor(api);
    await client.updateLesson(42, { notes: 'hi' }, { ifMatch: '"lesson-42-v3"' });
    await client.cancelLesson(42, {}, { ifMatch: '"lesson-42-v3"' });
    await client.markLessonPaid(42, {}, { ifMatch: '"lesson-42-v3"' });

    for (const request of api.requests.filter((r) => r.method !== 'GET')) {
      expect(request.headers['if-match']).toBe('"lesson-42-v3"');
    }
  });

  it('surfaces a stale If-Match as VERSION_MISMATCH with current_version', async () => {
    const api = new MockApi().on('PATCH /lessons/{id}', () =>
      problem(412, 'VERSION_MISMATCH', 'The lesson was modified since you last read it.', {
        current_version: 5,
      }),
    );

    await expect(
      clientFor(api).updateLesson(42, { notes: 'x' }, { ifMatch: '"lesson-42-v3"' }),
    ).rejects.toMatchObject({ code: 'VERSION_MISMATCH', currentVersion: 5, exitCode: 9 });
  });

  it('never auto-retries a 412 — the caller decides whether to overwrite', async () => {
    const api = new MockApi().on('PATCH /lessons/{id}', () =>
      problem(412, 'VERSION_MISMATCH', 'stale', { current_version: 5 }),
    );
    await expect(
      clientFor(api).updateLesson(42, { notes: 'x' }, { ifMatch: '"lesson-42-v3"' }),
    ).rejects.toThrow();
    expect(api.requestsFor('PATCH', '/lessons/42')).toHaveLength(1);
  });

  it('normalises a shell-mangled ETag but refuses a weak one or a wildcard', () => {
    expect(resolveIfMatch('"lesson-42-v3"', 42)).toBe('"lesson-42-v3"');
    expect(resolveIfMatch('lesson-42-v3', 42)).toBe('"lesson-42-v3"');
    expect(resolveIfMatch('3', 42)).toBe('"lesson-42-v3"');
    expect(() => resolveIfMatch('W/"lesson-42-v3"', 42)).toThrow(/strong/);
    expect(() => resolveIfMatch('*', 42)).toThrow(/wildcard/);
    expect(() => resolveIfMatch('nonsense', 42)).toThrow();
    expect(formatETag(42, 3)).toBe('"lesson-42-v3"');
    expect(parseETag('W/"lesson-42-v3"')).toBeNull();
  });
});

describe('timestamp boundary', () => {
  it('rejects a naive scheduled_at before the request leaves the process', async () => {
    const api = new MockApi().on('POST /lessons', () => ({ status: 201, body: { data: makeLesson() } }));
    await expect(
      clientFor(api).createLesson({
        coach_id: 7,
        athlete_ids: [101],
        scheduled_at: '2026-08-04T14:00:00',
        duration_minutes: 60,
        fee_acknowledged: true,
      }),
    ).rejects.toThrowError(Rfc3339FormatError);
    expect(api.requests).toHaveLength(0);
  });

  it('rejects a naive paid_at too', async () => {
    const api = new MockApi().on('POST /lessons/{id}/mark-paid', () => ({
      body: { data: makeLesson() },
    }));
    await expect(
      clientFor(api).markLessonPaid(42, { paid_at: '2026-08-04T14:00:00' }, {
        ifMatch: '"lesson-42-v3"',
      }),
    ).rejects.toThrowError(Rfc3339FormatError);
    expect(api.requests).toHaveLength(0);
  });

  it('sends a valid offset-bearing timestamp through unchanged', async () => {
    const api = new MockApi().on('POST /lessons', () => ({
      status: 201,
      body: { data: makeLesson() },
    }));
    await clientFor(api).createLesson({
      coach_id: 7,
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration_minutes: 60,
      fee_acknowledged: true,
    });
    expect((api.requests[0]?.body as Record<string, unknown>).scheduled_at).toBe(
      '2026-08-04T14:00:00-07:00',
    );
  });
});

describe('error surfacing', () => {
  it('turns every problem+json response into a typed PrivateLessonsError', async () => {
    const cases: Array<[number, string, number]> = [
      [403, 'INSUFFICIENT_SCOPE', 11],
      [403, 'FORBIDDEN', 12],
      [404, 'LESSON_NOT_FOUND', 6],
      [409, 'SLOT_CONFLICT', 7],
      [422, 'OUTSIDE_BUSINESS_HOURS', 8],
      [422, 'FACILITY_FEE_ACK_REQUIRED', 14],
      [422, 'LATE_BOOKING_ACK_REQUIRED', 15],
      [429, 'RATE_LIMITED', 13],
    ];

    for (const [status, code, exit] of cases) {
      const api = new MockApi().on('GET /lessons/{id}', () => problem(status, code, 'nope'));
      const err = await clientFor(api)
        .getLesson(42)
        .catch((e: unknown) => e as PrivateLessonsError);
      expect(err).toBeInstanceOf(PrivateLessonsError);
      expect((err as PrivateLessonsError).code).toBe(code);
      expect((err as PrivateLessonsError).exitCode).toBe(exit);
    }
  });

  it('reports an unreachable host as NETWORK_ERROR', async () => {
    const client = new PrivateLessonsClient({
      baseUrl: 'https://private-lessons.test/api/v1',
      token: 't',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(client.listBalances()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      exitCode: 18,
    });
  });
});

describe('audit pagination', () => {
  it('returns the keyset cursor envelope verbatim', async () => {
    const api = new MockApi().on('GET /audit-events', () => ({
      body: {
        data: [],
        meta: { limit: 50, has_more: true, next_cursor: 'opaque-cursor' },
      },
    }));
    const page = await clientFor(api).listAuditEvents({ limit: 50 });
    expect(page.meta.next_cursor).toBe('opaque-cursor');
    expect(api.requests[0]?.query.get('limit')).toBe('50');
  });
});

describe('pricing quote', () => {
  const quoteApi = (): MockApi =>
    new MockApi().on('GET /pricing-quotes', () => ({ body: { data: {} } }));

  it('sends the coach as the `coach` query parameter', async () => {
    const api = quoteApi();
    await clientFor(api).getPricingQuote({
      duration: 60,
      athlete_ids: [13],
      scheduled_at: '2026-10-06T14:00:00-07:00',
      coach: 9,
    });
    expect(api.requests[0]?.query.get('coach')).toBe('9');
  });

  it('sends no `coach` when the caller gives none, so the API prices the token owner', async () => {
    const api = quoteApi();
    await clientFor(api).getPricingQuote({
      duration: 60,
      athlete_ids: [13],
      scheduled_at: '2026-10-06T14:00:00-07:00',
    });
    expect(api.requests[0]?.query.has('coach')).toBe(false);
  });
});
