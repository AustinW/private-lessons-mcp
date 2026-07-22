/**
 * The HTTP client.
 *
 * Every request goes through `openapi-fetch`, typed by `src/generated/openapi.ts`,
 * which is generated from `contract/openapi.yaml` by `npm run generate`. There are no
 * hand-written URLs, query shapes or body shapes here: a path, parameter or field that
 * drifts from the contract fails to typecheck. That is the whole point of the
 * generation step — see README §"Generated from the contract".
 */

import createClient, { type Client } from 'openapi-fetch';

import type { components, paths } from '../generated/openapi.js';
import { resolveIdempotencyKey } from './concurrency.js';
import { problemToError, ScorSyncError, toScorSyncError } from './errors.js';
import { assertRfc3339 } from './time.js';

export type Lesson = components['schemas']['Lesson'];
export type Athlete = components['schemas']['Athlete'];
export type AthleteCoachView = components['schemas']['AthleteCoachView'];
export type AthleteAdminView = components['schemas']['AthleteAdminView'];
export type Availability = components['schemas']['Availability'];
export type PricingQuote = components['schemas']['PricingQuote'];
export type Balance = components['schemas']['Balance'];
export type AuditEvent = components['schemas']['AuditEvent'];
export type CursorPageMeta = components['schemas']['CursorPageMeta'];
export type Me = components['schemas']['Me'];
export type DurationMinutes = components['schemas']['DurationMinutes'];
export type MembershipStatus = components['schemas']['MembershipStatus'];
export type CreateLessonRequest = components['schemas']['CreateLessonRequest'];
export type UpdateLessonRequest = components['schemas']['UpdateLessonRequest'];
export type CreateAthleteRequest = components['schemas']['CreateAthleteRequest'];

export const DURATION_MINUTES: readonly DurationMinutes[] = [30, 45, 60, 90, 120];

export const DEFAULT_BASE_URL_ENV = 'SCORSYNC_BASE_URL';

/** A single-lesson response plus the strong ETag to use as the next `If-Match`. */
export interface LessonResult {
  lesson: Lesson;
  /** `"lesson-<id>-v<version>"`, or `undefined` if the server omitted the header. */
  etag: string | undefined;
  requestId: string | undefined;
}

export interface AuditPage {
  events: AuditEvent[];
  meta: CursorPageMeta;
  requestId: string | undefined;
}

export interface ScorSyncClientOptions {
  /** Full base URL including `/api/v1`, e.g. `https://scorsync.example.com/api/v1`. */
  baseUrl: string;
  token: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

/** Normalise a user-supplied base URL, appending `/api/v1` when it is missing. */
export function normaliseBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/\/api\/v\d+$/.test(url)) url = `${url}/api/v1`;
  return url;
}

type FetchResult<T> = { data?: T; error?: unknown; response: Response };

function unwrap<T>(result: FetchResult<{ data: T }>): { value: T; response: Response } {
  const { response } = result;
  if (!response.ok || result.data === undefined) {
    throw problemToError(response.status, result.error ?? result.data, response.headers);
  }
  return { value: result.data.data, response };
}

function requestId(response: Response): string | undefined {
  return response.headers.get('x-request-id') ?? undefined;
}

function etagOf(response: Response): string | undefined {
  return response.headers.get('etag') ?? undefined;
}

/**
 * Typed façade over the generated client.
 *
 * Every method is a thin call into `openapi-fetch`; the only logic here is
 * (a) turning non-2xx into a `ScorSyncError`, (b) surfacing `ETag`/`X-Request-Id`,
 * and (c) validating timestamps at the boundary before they hit the wire.
 */
export class ScorSyncClient {
  private readonly http: Client<paths>;

  readonly baseUrl: string;

  constructor(options: ScorSyncClientOptions) {
    this.baseUrl = normaliseBaseUrl(options.baseUrl);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json, application/problem+json',
    };
    if (options.userAgent) headers['User-Agent'] = options.userAgent;

    this.http = createClient<paths>({
      baseUrl: this.baseUrl,
      headers,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /** Run `fn`, normalising anything it throws into a `ScorSyncError`. */
  private static async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ScorSyncError) throw err;
      throw toScorSyncError(err);
    }
  }

  async getMe(): Promise<Me> {
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/me', {});
      return unwrap<Me>(result as FetchResult<{ data: Me }>).value;
    });
  }

  async listLessons(
    query: NonNullable<paths['/lessons']['get']['parameters']['query']> = {},
  ): Promise<Lesson[]> {
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/lessons', { params: { query } });
      return unwrap<Lesson[]>(result as FetchResult<{ data: Lesson[] }>).value;
    });
  }

  async getLesson(id: number): Promise<LessonResult> {
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/lessons/{id}', { params: { path: { id } } });
      const { value, response } = unwrap<Lesson>(result as FetchResult<{ data: Lesson }>);
      return { lesson: value, etag: etagOf(response), requestId: requestId(response) };
    });
  }

  /**
   * `Idempotency-Key` is REQUIRED here. When the caller does not supply one, a UUID is
   * minted so that a retry after a dropped response replays instead of double-booking.
   */
  async createLesson(
    body: CreateLessonRequest,
    options: { idempotencyKey?: string } = {},
  ): Promise<LessonResult> {
    assertRfc3339(body.scheduled_at);
    const key = resolveIdempotencyKey(options.idempotencyKey);
    return ScorSyncClient.guard(async () => {
      const result = await this.http.POST('/lessons', {
        params: { header: { 'Idempotency-Key': key } },
        body,
      });
      const { value, response } = unwrap<Lesson>(result as FetchResult<{ data: Lesson }>);
      return { lesson: value, etag: etagOf(response), requestId: requestId(response) };
    });
  }

  /** `If-Match` is REQUIRED. Pass the ETag from a prior read, verbatim. */
  async updateLesson(
    id: number,
    body: UpdateLessonRequest,
    options: { ifMatch: string },
  ): Promise<LessonResult> {
    if (body.scheduled_at) assertRfc3339(body.scheduled_at);
    return ScorSyncClient.guard(async () => {
      const result = await this.http.PATCH('/lessons/{id}', {
        params: { path: { id }, header: { 'If-Match': options.ifMatch } },
        body,
      });
      const { value, response } = unwrap<Lesson>(result as FetchResult<{ data: Lesson }>);
      return { lesson: value, etag: etagOf(response), requestId: requestId(response) };
    });
  }

  async cancelLesson(
    id: number,
    body: { reason?: string | null },
    options: { ifMatch: string; idempotencyKey?: string },
  ): Promise<LessonResult> {
    const key = resolveIdempotencyKey(options.idempotencyKey);
    return ScorSyncClient.guard(async () => {
      const result = await this.http.POST('/lessons/{id}/cancel', {
        params: {
          path: { id },
          header: { 'If-Match': options.ifMatch, 'Idempotency-Key': key },
        },
        body,
      });
      const { value, response } = unwrap<Lesson>(result as FetchResult<{ data: Lesson }>);
      return { lesson: value, etag: etagOf(response), requestId: requestId(response) };
    });
  }

  async markLessonPaid(
    id: number,
    body: { paid_at?: string | null },
    options: { ifMatch: string; idempotencyKey?: string },
  ): Promise<LessonResult> {
    if (body.paid_at) assertRfc3339(body.paid_at);
    const key = resolveIdempotencyKey(options.idempotencyKey);
    return ScorSyncClient.guard(async () => {
      const result = await this.http.POST('/lessons/{id}/mark-paid', {
        params: {
          path: { id },
          header: { 'If-Match': options.ifMatch, 'Idempotency-Key': key },
        },
        body,
      });
      const { value, response } = unwrap<Lesson>(result as FetchResult<{ data: Lesson }>);
      return { lesson: value, etag: etagOf(response), requestId: requestId(response) };
    });
  }

  async getAvailability(query: {
    date: string;
    duration: DurationMinutes;
    coach?: number;
  }): Promise<Availability> {
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/availability', { params: { query } });
      return unwrap<Availability>(result as FetchResult<{ data: Availability }>).value;
    });
  }

  async searchAthletes(query?: string): Promise<Athlete[]> {
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/athletes', {
        params: { query: query ? { query } : {} },
      });
      return unwrap<Athlete[]>(result as FetchResult<{ data: Athlete[] }>).value;
    });
  }

  async getAthlete(id: number): Promise<Athlete> {
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/athletes/{id}', { params: { path: { id } } });
      return unwrap<Athlete>(result as FetchResult<{ data: Athlete }>).value;
    });
  }

  /** `Idempotency-Key` is REQUIRED here too; minted when absent. */
  async createAthlete(
    body: CreateAthleteRequest,
    options: { idempotencyKey?: string } = {},
  ): Promise<Athlete> {
    const key = resolveIdempotencyKey(options.idempotencyKey);
    return ScorSyncClient.guard(async () => {
      const result = await this.http.POST('/athletes', {
        params: { header: { 'Idempotency-Key': key } },
        body,
      });
      return unwrap<Athlete>(result as FetchResult<{ data: Athlete }>).value;
    });
  }

  async getPricingQuote(query: {
    duration: DurationMinutes;
    athlete_ids: number[];
    scheduled_at: string;
  }): Promise<PricingQuote> {
    assertRfc3339(query.scheduled_at);
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/pricing-quotes', { params: { query } });
      return unwrap<PricingQuote>(result as FetchResult<{ data: PricingQuote }>).value;
    });
  }

  async listBalances(): Promise<Balance[]> {
    return ScorSyncClient.guard(async () => {
      const result = await this.http.GET('/balances', {});
      return unwrap<Balance[]>(result as FetchResult<{ data: Balance[] }>).value;
    });
  }

  async listAuditEvents(query: { limit?: number; cursor?: string } = {}): Promise<AuditPage> {
    return ScorSyncClient.guard(async () => {
      const result = (await this.http.GET('/audit-events', {
        params: { query },
      })) as FetchResult<{ data: AuditEvent[]; meta: CursorPageMeta }>;
      const { response } = result;
      if (!response.ok || result.data === undefined) {
        throw problemToError(response.status, result.error ?? result.data, response.headers);
      }
      return {
        events: result.data.data,
        meta: result.data.meta,
        requestId: requestId(response),
      };
    });
  }
}
