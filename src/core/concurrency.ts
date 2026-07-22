/**
 * Optimistic-concurrency and idempotency helpers (contract §6).
 *
 * ETags are strong and structured: `"lesson-<id>-v<version>"`. `If-Match` is required
 * on PATCH, cancel and mark-paid; a stale value returns `412 VERSION_MISMATCH` carrying
 * `current_version`.
 *
 * `Idempotency-Key` is required on `POST /lessons` and `POST /athletes` and honoured on
 * cancel and mark-paid. Callers that do not supply one get a generated UUID, so an
 * interrupted retry is safe by default rather than by remembering.
 */

import { randomUUID } from 'node:crypto';

const ETAG_RE = /^"lesson-(\d+)-v(\d+)"$/;

export interface ParsedETag {
  lessonId: number;
  version: number;
}

/** Build the strong ETag for a lesson id + version. */
export function formatETag(lessonId: number, version: number): string {
  return `"lesson-${lessonId}-v${version}"`;
}

/**
 * Parse a strong lesson ETag. Weak validators (`W/"..."`) are rejected: RFC 9110
 * `If-Match` uses strong comparison, and the API never emits a weak tag.
 */
export function parseETag(etag: string): ParsedETag | null {
  const match = ETAG_RE.exec(etag.trim());
  if (!match) return null;
  return { lessonId: Number(match[1]), version: Number(match[2]) };
}

/** Generate a fresh idempotency key. */
export function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * Normalise a caller-supplied key, or mint one.
 * The API caps the header at 255 characters.
 */
export function resolveIdempotencyKey(supplied?: string | null): string {
  const trimmed = supplied?.trim();
  if (!trimmed) return newIdempotencyKey();
  if (trimmed.length > 255) {
    throw new Error('Idempotency-Key must be at most 255 characters.');
  }
  return trimmed;
}

/**
 * Normalise an `If-Match` value supplied on the command line.
 *
 * Accepts the ETag verbatim (`"lesson-42-v3"`), the same value without the quotes a
 * shell tends to eat (`lesson-42-v3`), or a bare version number (`3`) combined with the
 * lesson id from the path. Rejects a weak validator and `*` outright: both would defeat
 * the precondition the contract requires.
 */
export function resolveIfMatch(supplied: string, lessonId: number): string {
  const value = supplied.trim();
  if (value === '*') {
    throw new Error(
      'If-Match: * is not accepted — a wildcard precondition would skip the version check.',
    );
  }
  if (/^W\//i.test(value)) {
    throw new Error(
      'If-Match must be a strong ETag; the API never emits a weak (W/"...") validator.',
    );
  }
  if (parseETag(value)) return value;
  if (parseETag(`"${value}"`)) return `"${value}"`;
  if (/^\d+$/.test(value)) return formatETag(lessonId, Number(value));
  throw new Error(
    `Unrecognised If-Match value ${JSON.stringify(supplied)}. ` +
      'Use the ETag from a prior GET, e.g. "lesson-42-v3".',
  );
}
