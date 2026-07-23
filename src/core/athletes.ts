/**
 * The two-step athlete flow.
 *
 * Every write in this API takes `athlete_ids` and nothing else — there is deliberately
 * no name field on any request body, so a write can never guess an identity. The only
 * way to go from a human name to an id is:
 *
 *   1. search  — `GET /athletes?query=…` returns *candidates*, always `200`;
 *   2. confirm — the caller (human or agent) picks exactly one explicit id;
 *   3. write   — the id is sent.
 *
 * Step 2 is where `ATHLETE_AMBIGUOUS` lives. The server cannot raise it: it does not
 * know whether a multi-match search is a person browsing or an agent resolving. So this
 * module raises it, client-side, carrying the candidates so the caller can choose.
 * It is never an HTTP status and never appears in a problem document.
 */

import type { Athlete, PrivateLessonsClient } from './client.js';
import { AthleteAmbiguousError, PrivateLessonsError } from './errors.js';

export interface AthleteCandidate {
  id: number;
  name: string;
  /** Present on every view. */
  waiver_signed?: boolean;
  membership_status?: string;
}

export function toCandidate(athlete: Athlete): AthleteCandidate {
  const a = athlete as Athlete & {
    id: number;
    name: string;
    waiver_signed?: boolean;
    membership_status?: string;
  };
  return {
    id: a.id,
    name: a.name,
    ...(a.waiver_signed !== undefined ? { waiver_signed: a.waiver_signed } : {}),
    ...(a.membership_status !== undefined ? { membership_status: a.membership_status } : {}),
  };
}

export type AthleteResolution =
  | { status: 'resolved'; athlete: AthleteCandidate }
  | { status: 'ambiguous'; query: string; candidates: AthleteCandidate[] }
  | { status: 'not_found'; query: string };

/**
 * Step 1 + a classification of the result. Never throws for an ambiguous or empty
 * match — it returns the shape so a caller that wants to present choices can.
 */
export async function resolveAthleteByName(
  client: PrivateLessonsClient,
  query: string,
): Promise<AthleteResolution> {
  const candidates = (await client.searchAthletes(query)).map(toCandidate);
  if (candidates.length === 0) return { status: 'not_found', query };
  if (candidates.length > 1) return { status: 'ambiguous', query, candidates };
  return { status: 'resolved', athlete: candidates[0] as AthleteCandidate };
}

/**
 * Steps 1-2 with the confirmation enforced: resolve a name to exactly one id or refuse.
 *
 * Throws `AthleteAmbiguousError` (code `ATHLETE_AMBIGUOUS`) with the candidate list on
 * a multi-match, and `ATHLETE_NOT_FOUND` on an empty match. Callers that want to write
 * must have an explicit id in hand before this returns.
 */
export async function requireSingleAthlete(
  client: PrivateLessonsClient,
  query: string,
): Promise<AthleteCandidate> {
  const resolution = await resolveAthleteByName(client, query);
  switch (resolution.status) {
    case 'resolved':
      return resolution.athlete;
    case 'ambiguous':
      throw new AthleteAmbiguousError(resolution.query, resolution.candidates);
    case 'not_found':
      throw new PrivateLessonsError(
        'ATHLETE_NOT_FOUND',
        `No athlete matches "${query}".`,
        {
          detail:
            `No athlete matches "${query}". Create one with an explicit first and last ` +
            'name before booking — a write never creates an athlete implicitly.',
        },
      );
  }
}

/**
 * Guard used by every write path: the caller must have supplied explicit ids.
 *
 * This exists so the "two-step" rule is enforced in code, not only in documentation.
 * A tool or command that reaches a write with an unresolved name hits this.
 */
export function assertExplicitAthleteIds(ids: unknown): number[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new PrivateLessonsError(
      'VALIDATION_FAILED',
      'athlete_ids is required and must contain at least one explicit athlete id.',
      {
        detail:
          'athlete_ids is required and must contain at least one explicit athlete id. ' +
          'Search for the athlete first, confirm exactly one candidate, then pass its id — ' +
          'there is no name field on any write.',
      },
    );
  }
  const parsed = ids.map((id) => {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new PrivateLessonsError(
        'VALIDATION_FAILED',
        `athlete_ids entries must be positive integer ids; received ${JSON.stringify(id)}.`,
        {
          detail:
            `athlete_ids entries must be positive integer athlete ids; received ` +
            `${JSON.stringify(id)}. Names are never accepted on a write.`,
        },
      );
    }
    return id;
  });
  return parsed;
}
