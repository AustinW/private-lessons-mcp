/**
 * A mock HTTP layer.
 *
 * Every test in this suite runs against this — nothing here needs a live API, a
 * database, or a network. Routes are matched on `METHOD /path` and each handler sees
 * the request so a test can assert on the headers the client sent (which is how the
 * `Idempotency-Key` / `If-Match` guarantees are verified).
 */

import type { components } from '../../src/generated/openapi.js';

export type Lesson = components['schemas']['Lesson'];
export type Athlete = components['schemas']['Athlete'];

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

export type Handler = (req: RecordedRequest) => MockResponse | Promise<MockResponse>;

export class MockApi {
  readonly requests: RecordedRequest[] = [];

  private readonly routes = new Map<string, Handler>();

  readonly baseUrl = 'https://private-lessons.test/api/v1';

  on(route: string, handler: Handler): this {
    this.routes.set(route, handler);
    return this;
  }

  /** Every request recorded for `METHOD /path`. */
  requestsFor(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  get fetch(): typeof globalThis.fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const method = (
        init?.method ??
        (typeof input === 'object' && 'method' in input ? input.method : 'GET')
      ).toUpperCase();
      const path = url.pathname.replace('/api/v1', '');

      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
        (value, key) => {
          headers[key.toLowerCase()] = value;
        },
      );

      // openapi-fetch hands the platform a single `Request`, so the body lives there
      // rather than in an `init` argument. Read whichever one carries it.
      let rawBody: string | undefined;
      if (typeof init?.body === 'string' && init.body.length > 0) {
        rawBody = init.body;
      } else if (input instanceof Request) {
        const text = await input.clone().text();
        if (text.length > 0) rawBody = text;
      }

      let body: unknown;
      if (rawBody !== undefined) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }

      const record: RecordedRequest = {
        method,
        path,
        query: url.searchParams,
        headers,
        body,
      };
      this.requests.push(record);

      const handler = this.match(method, path);
      if (!handler) {
        return jsonResponse(500, {
          type: 'about:blank',
          title: 'No mock route',
          status: 500,
          detail: `No mock handler for ${method} ${path}`,
          code: 'VALIDATION_FAILED',
          request_id: 'mock',
          retryable: false,
        });
      }

      const result = await handler(record);
      return jsonResponse(
        result.status ?? 200,
        result.body ?? null,
        result.headers,
        result.contentType,
      );
    };
  }

  private match(method: string, path: string): Handler | undefined {
    const exact = this.routes.get(`${method} ${path}`);
    if (exact) return exact;
    for (const [route, handler] of this.routes) {
      const [routeMethod, routePath] = route.split(' ');
      if (routeMethod !== method || !routePath) continue;
      const pattern = new RegExp(`^${routePath.replace(/\{[^}]+\}/g, '[^/]+')}$`);
      if (pattern.test(path)) return handler;
    }
    return undefined;
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  contentType?: string,
): Response {
  const headers = new Headers({
    'content-type':
      contentType ?? (status >= 400 ? 'application/problem+json' : 'application/json'),
    'x-request-id': '01J8Z9Q2K3R4S5T6U7V8W9X0Y1',
    ...extraHeaders,
  });
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

// ------------------------------------------------------------------ fixtures

export function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 42,
    coach_id: 7,
    coach_name: 'Dana Smith',
    athletes: [{ id: 101, name: 'Ada Lovelace' }],
    student_name: 'Ada Lovelace',
    scheduled_at: '2026-08-04T14:00:00-07:00',
    duration_minutes: 60,
    is_member: true,
    is_late_booking: false,
    observer: null,
    notes: null,
    cost_cents: 2000,
    effective_cost_cents: 2000,
    cost_override_cents: null,
    cost_override_reason: null,
    late_fee_waived: false,
    paid_at: null,
    cancelled_at: null,
    version: 3,
    created_at: '2026-07-01T09:00:00-07:00',
    updated_at: '2026-07-01T09:00:00-07:00',
    ...overrides,
  };
}

export function makeAthlete(id: number, name: string): Athlete {
  return { id, name, waiver_signed: true, membership_status: 'member' };
}

export function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): MockResponse {
  return {
    status,
    body: {
      type: `https://private-lessons.scorsync.com/errors/${code.toLowerCase().replace(/_/g, '-')}`,
      title: code,
      status,
      detail,
      code,
      request_id: '01J8Z9Q2K3R4S5T6U7V8W9X0Y1',
      retryable: false,
      ...extra,
    },
  };
}
