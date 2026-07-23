/**
 * The two-step athlete flow: search -> confirm one explicit id -> write.
 *
 * The property under test is that no code path can turn a name into a write. The write
 * bodies carry `athlete_ids` and nothing else, and the ambiguity condition is raised by
 * the client on a `200` response — never by the server.
 */

import { describe, expect, it } from 'vitest';

import {
  assertExplicitAthleteIds,
  requireSingleAthlete,
  resolveAthleteByName,
} from '../src/core/athletes.js';
import { PrivateLessonsClient } from '../src/core/client.js';
import { AthleteAmbiguousError, PrivateLessonsError } from '../src/core/errors.js';
import { makeAthlete, makeLesson, MockApi } from './helpers/mock-api.js';

function clientFor(api: MockApi): PrivateLessonsClient {
  return new PrivateLessonsClient({ baseUrl: api.baseUrl, token: 'test-token', fetch: api.fetch });
}

describe('step 1 — search', () => {
  it('returns a single candidate as resolved', async () => {
    const api = new MockApi().on('GET /athletes', () => ({
      body: { data: [makeAthlete(101, 'Ada Lovelace')] },
    }));
    const result = await resolveAthleteByName(clientFor(api), 'Ada');
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.athlete.id).toBe(101);
  });

  it('returns multiple candidates as ambiguous, with HTTP 200 from the server', async () => {
    const api = new MockApi().on('GET /athletes', () => ({
      status: 200,
      body: { data: [makeAthlete(1, 'Ada Smith'), makeAthlete(2, 'Alan Smith')] },
    }));
    const result = await resolveAthleteByName(clientFor(api), 'Smith');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') expect(result.candidates).toHaveLength(2);
  });

  it('returns an empty match as not_found', async () => {
    const api = new MockApi().on('GET /athletes', () => ({ body: { data: [] } }));
    expect((await resolveAthleteByName(clientFor(api), 'Nobody')).status).toBe('not_found');
  });
});

describe('step 2 — confirmation is mandatory', () => {
  it('raises ATHLETE_AMBIGUOUS client-side when the search matches more than one', async () => {
    const api = new MockApi().on('GET /athletes', () => ({
      status: 200,
      body: { data: [makeAthlete(1, 'Ada Smith'), makeAthlete(2, 'Alan Smith')] },
    }));

    await expect(requireSingleAthlete(clientFor(api), 'Smith')).rejects.toThrowError(
      AthleteAmbiguousError,
    );

    try {
      await requireSingleAthlete(clientFor(api), 'Smith');
    } catch (err) {
      const error = err as AthleteAmbiguousError;
      expect(error.code).toBe('ATHLETE_AMBIGUOUS');
      // The condition is client-surfaced: it never carries an HTTP status.
      expect(error.status).toBeUndefined();
      expect(error.candidates.map((c) => c.id)).toEqual([1, 2]);
      expect(error.detail).toContain('Choose one');
    }
  });

  it('raises ATHLETE_NOT_FOUND rather than creating anything when nothing matches', async () => {
    const api = new MockApi().on('GET /athletes', () => ({ body: { data: [] } }));
    await expect(requireSingleAthlete(clientFor(api), 'Nobody')).rejects.toMatchObject({
      code: 'ATHLETE_NOT_FOUND',
    });
    expect(api.requestsFor('POST', '/athletes')).toHaveLength(0);
  });

  it('resolves cleanly when exactly one athlete matches', async () => {
    const api = new MockApi().on('GET /athletes', () => ({
      body: { data: [makeAthlete(101, 'Ada Lovelace')] },
    }));
    const athlete = await requireSingleAthlete(clientFor(api), 'Ada Lovelace');
    expect(athlete).toMatchObject({ id: 101, name: 'Ada Lovelace' });
  });
});

describe('step 3 — writes take explicit ids only', () => {
  it('sends athlete_ids and no name field whatsoever', async () => {
    const api = new MockApi()
      .on('GET /athletes', () => ({ body: { data: [makeAthlete(101, 'Ada Lovelace')] } }))
      .on('POST /lessons', () => ({
        status: 201,
        body: { data: makeLesson() },
        headers: { etag: '"lesson-42-v1"' },
      }));

    const client = clientFor(api);
    const athlete = await requireSingleAthlete(client, 'Ada Lovelace');
    await client.createLesson({
      coach_id: 7,
      athlete_ids: [athlete.id],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration_minutes: 60,
      fee_acknowledged: true,
    });

    const [request] = api.requestsFor('POST', '/lessons');
    const body = request?.body as Record<string, unknown>;
    expect(body.athlete_ids).toEqual([101]);
    for (const forbidden of ['athlete_name', 'name', 'student_name', 'athlete']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('refuses a write whose athlete_ids are missing, empty, or not ids', () => {
    for (const bad of [undefined, null, [], ['Ada Lovelace'], [0], [-1], [1.5]]) {
      expect(() => assertExplicitAthleteIds(bad)).toThrowError(PrivateLessonsError);
    }
    expect(assertExplicitAthleteIds([101, 102])).toEqual([101, 102]);
  });

  it('explains that names are never accepted when given one', () => {
    try {
      assertExplicitAthleteIds(['Ada Lovelace']);
    } catch (err) {
      expect((err as PrivateLessonsError).code).toBe('VALIDATION_FAILED');
      expect((err as PrivateLessonsError).detail).toContain('Names are never accepted');
    }
  });
});
