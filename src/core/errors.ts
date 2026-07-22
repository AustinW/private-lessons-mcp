/**
 * Error taxonomy and process exit codes.
 *
 * The API's error surface is frozen at exactly 13 `code` values (see
 * `contract/contracts.md` §1). Two of them never arrive over HTTP:
 *
 *  - `ATHLETE_AMBIGUOUS` is *client-surfaced*. The server cannot know whether a
 *    multi-match `GET /athletes` is a user browsing or an agent resolving a name,
 *    so it always answers `200` with a candidate list. This client raises the
 *    condition when it was asked to resolve a name to exactly one athlete and the
 *    search returned more than one candidate.
 *  - `ATHLETE_NOT_FOUND` *is* an HTTP 404 from a write, but this client also raises
 *    it locally when a name search returns zero candidates.
 *
 * HTTP 401 is deliberately outside the 13-code taxonomy (the auth layer rejects a
 * missing/invalid/expired token before the application error model runs), so it gets
 * its own local code.
 */

import type { components } from '../generated/openapi.js';

/** The frozen 13-value application error taxonomy, sourced from the generated types. */
export type ApiErrorCode = components['schemas']['ErrorCode'];

/** RFC 9457 problem document, sourced from the generated types. */
export type ProblemDetails = components['schemas']['ProblemDetails'];

/**
 * Conditions this client can report that are not one of the 13 API codes.
 * They exist because a CLI process must distinguish "the API said no" from
 * "I could not reach the API" or "you have not configured a token".
 */
export type ClientErrorCode =
  | 'UNAUTHENTICATED'
  | 'NO_TOKEN'
  | 'NETWORK_ERROR'
  | 'USAGE_ERROR'
  | 'ABORTED'
  | 'UNKNOWN_ERROR';

export type ScorSyncErrorCode = ApiErrorCode | ClientErrorCode;

/**
 * Process exit codes.
 *
 * Stability contract: these values are part of the CLI's public interface and must
 * not be renumbered. Ranges 1-2 are conventional; 3-15 map 1:1 onto the 13 API codes
 * in the order they are declared in the contract; 16-19 are client-side conditions.
 * 126, 127 and 128+ are avoided because POSIX shells reserve them.
 */
export const EXIT_CODES = {
  OK: 0,
  UNKNOWN_ERROR: 1,
  USAGE_ERROR: 2,

  // The 13 frozen API codes.
  VALIDATION_FAILED: 3,
  ATHLETE_NOT_FOUND: 4,
  ATHLETE_AMBIGUOUS: 5,
  LESSON_NOT_FOUND: 6,
  SLOT_CONFLICT: 7,
  OUTSIDE_BUSINESS_HOURS: 8,
  VERSION_MISMATCH: 9,
  IDEMPOTENCY_KEY_REUSED: 10,
  INSUFFICIENT_SCOPE: 11,
  FORBIDDEN: 12,
  RATE_LIMITED: 13,
  FACILITY_FEE_ACK_REQUIRED: 14,
  LATE_BOOKING_ACK_REQUIRED: 15,

  // Client-side conditions.
  UNAUTHENTICATED: 16,
  NO_TOKEN: 17,
  NETWORK_ERROR: 18,
  ABORTED: 19,
} as const satisfies Record<ScorSyncErrorCode | 'OK', number>;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Map any error code this client can produce to its documented exit code. */
export function exitCodeFor(code: ScorSyncErrorCode | undefined): number {
  if (code && code in EXIT_CODES) {
    return EXIT_CODES[code as keyof typeof EXIT_CODES];
  }
  return EXIT_CODES.UNKNOWN_ERROR;
}

/** Base class for every error this client raises deliberately. */
export class ScorSyncError extends Error {
  readonly code: ScorSyncErrorCode;

  readonly retryable: boolean;

  readonly requestId: string | undefined;

  readonly status: number | undefined;

  readonly detail: string | undefined;

  readonly fieldErrors: Record<string, string[]> | undefined;

  /** Present on `VERSION_MISMATCH`: the server's current version of the lesson. */
  readonly currentVersion: number | undefined;

  /** Present on `RATE_LIMITED` / retryable idempotency conflicts, in seconds. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ScorSyncErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      requestId?: string | undefined;
      status?: number | undefined;
      detail?: string | undefined;
      fieldErrors?: Record<string, string[]> | undefined;
      currentVersion?: number | undefined;
      retryAfterSeconds?: number | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ScorSyncError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.status = options.status;
    this.detail = options.detail;
    this.fieldErrors = options.fieldErrors;
    this.currentVersion = options.currentVersion;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get exitCode(): number {
    return exitCodeFor(this.code);
  }

  /**
   * Human-readable rendering. Surfaces `code`, `detail` and `request_id` rather than
   * dumping the raw problem JSON at the user.
   */
  toDisplayString(): string {
    const parts: string[] = [];
    parts.push(`${this.code}: ${this.detail ?? this.message}`);
    if (this.fieldErrors && Object.keys(this.fieldErrors).length > 0) {
      for (const [field, messages] of Object.entries(this.fieldErrors)) {
        for (const m of messages) parts.push(`  - ${field}: ${m}`);
      }
    }
    if (this.currentVersion !== undefined && this.currentVersion !== null) {
      parts.push(`  current_version: ${this.currentVersion}`);
    }
    if (this.retryAfterSeconds !== undefined) {
      parts.push(`  retry after: ${this.retryAfterSeconds}s`);
    }
    if (this.retryable) parts.push('  retryable: yes');
    if (this.requestId) parts.push(`  request_id: ${this.requestId}`);
    return parts.join('\n');
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      detail: this.detail ?? this.message,
      request_id: this.requestId ?? null,
      status: this.status ?? null,
      retryable: this.retryable,
      ...(this.fieldErrors ? { errors: this.fieldErrors } : {}),
      ...(this.currentVersion !== undefined && this.currentVersion !== null
        ? { current_version: this.currentVersion }
        : {}),
      ...(this.retryAfterSeconds !== undefined ? { retry_after: this.retryAfterSeconds } : {}),
      exit_code: this.exitCode,
    };
  }
}

/**
 * Raised when a name search was asked to resolve to exactly one athlete and matched
 * more than one. This is never an HTTP error — the server answered `200`.
 */
export class AthleteAmbiguousError extends ScorSyncError {
  readonly candidates: ReadonlyArray<{ id: number; name: string }>;

  readonly query: string;

  constructor(query: string, candidates: ReadonlyArray<{ id: number; name: string }>) {
    super(
      'ATHLETE_AMBIGUOUS',
      `The search "${query}" matched ${candidates.length} athletes.`,
      {
        detail:
          `The search "${query}" matched ${candidates.length} athletes. ` +
          'Choose one and retry with its explicit athlete id — a write never guesses an identity.',
      },
    );
    this.name = 'AthleteAmbiguousError';
    this.candidates = candidates;
    this.query = query;
  }

  override toDisplayString(): string {
    const lines = [super.toDisplayString(), '  candidates:'];
    for (const c of this.candidates) lines.push(`    - id=${c.id}  ${c.name}`);
    return lines.join('\n');
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), query: this.query, candidates: this.candidates };
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
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
]);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Turn an HTTP failure into a `ScorSyncError`.
 *
 * `body` is whatever the response carried. A well-behaved API always sends an RFC 9457
 * problem document; this function stays defensive because a proxy, a 502 page, or a
 * `401` from the auth layer (which is outside the taxonomy) may not.
 */
export function problemToError(status: number, body: unknown, headers?: Headers): ScorSyncError {
  const problem = (body ?? {}) as Partial<ProblemDetails> & Record<string, unknown>;
  const requestId =
    (typeof problem.request_id === 'string' ? problem.request_id : undefined) ??
    headers?.get('x-request-id') ??
    undefined;
  const retryAfterSeconds = parseRetryAfter(headers?.get('retry-after') ?? null);

  if (status === 401) {
    return new ScorSyncError('UNAUTHENTICATED', 'Authentication failed.', {
      status,
      requestId,
      detail:
        typeof problem.detail === 'string'
          ? problem.detail
          : 'The token is missing, invalid, expired or revoked. Run `scorsync auth set-token`.',
    });
  }

  if (!isApiErrorCode(problem.code)) {
    return new ScorSyncError('UNKNOWN_ERROR', `Unexpected HTTP ${status} response.`, {
      status,
      requestId,
      retryAfterSeconds,
      detail:
        typeof problem.detail === 'string'
          ? problem.detail
          : typeof problem.title === 'string'
            ? problem.title
            : `The server returned HTTP ${status} without a recognised problem document.`,
    });
  }

  const fieldErrors =
    problem.errors && typeof problem.errors === 'object'
      ? (problem.errors as Record<string, string[]>)
      : undefined;

  return new ScorSyncError(problem.code, problem.title ?? problem.code, {
    status,
    requestId,
    retryAfterSeconds,
    retryable: problem.retryable === true,
    detail: typeof problem.detail === 'string' ? problem.detail : undefined,
    fieldErrors,
    currentVersion:
      typeof problem.current_version === 'number' ? problem.current_version : undefined,
  });
}

/** Normalise any thrown value into a `ScorSyncError`. */
export function toScorSyncError(err: unknown): ScorSyncError {
  if (err instanceof ScorSyncError) return err;
  if (err instanceof Error) {
    // fetch surfaces connection problems as TypeError('fetch failed') with a cause.
    const isNetwork =
      err.name === 'TypeError' ||
      err.name === 'AbortError' ||
      /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(
        `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`,
      );
    return new ScorSyncError(
      isNetwork ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR',
      err.message,
      { detail: err.message, cause: err },
    );
  }
  return new ScorSyncError('UNKNOWN_ERROR', String(err), { detail: String(err) });
}
