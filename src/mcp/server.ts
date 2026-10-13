/**
 * The Private Lessons MCP server.
 *
 * Design rules, from the spec:
 *
 *  - **Task-specific tools only. There is deliberately no generic HTTP tool.** A
 *    `private_lessons_request(method, path, body)` escape hatch would let a model invent
 *    endpoints, skip the required `Idempotency-Key`/`If-Match` headers, and bypass
 *    every guard below. The 12 tools here are the entire surface.
 *  - **There is no token tool.** Minting, reading or rotating a token is impossible
 *    through this API by design; the server reads a token from the environment or the
 *    OS credential store and never exposes it.
 *  - **Mutations declare their side effects in the description and support `dry_run`**,
 *    which returns the advisory quote plus an availability/conflict preview and writes
 *    nothing.
 *  - **Writes take `athlete_ids` only.** There is no name field on any write tool, so a
 *    tool can never guess an identity. `private_lessons_search_athletes` is the only way to go
 *    from a name to an id, and it reports the `ATHLETE_AMBIGUOUS` condition (client-
 *    surfaced, never an HTTP error) when the search matches more than one athlete.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { resolveAthleteByName } from '../core/athletes.js';
import {
  DURATION_MINUTES,
  type DurationMinutes,
  type Lesson,
  type LessonResult,
  type PrivateLessonsClient,
} from '../core/client.js';
import { formatETag, parseETag } from '../core/concurrency.js';
import { PrivateLessonsError, toPrivateLessonsError } from '../core/errors.js';
import { lessonOwedCents, normalizeBalance, platformFeeCents } from '../core/fees.js';
import { preflightLesson } from '../core/preflight.js';
import { formatPacific, TENANT_TIMEZONE } from '../core/time.js';

export const TOOL_NAMES = [
  'private_lessons_list_lessons',
  'private_lessons_get_lesson',
  'private_lessons_check_availability',
  'private_lessons_get_quote',
  'private_lessons_search_athletes',
  'private_lessons_create_athlete',
  'private_lessons_create_lesson',
  'private_lessons_update_lesson',
  'private_lessons_cancel_lesson',
  'private_lessons_mark_lesson_paid',
  'private_lessons_get_balance',
  'private_lessons_list_audit_events',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const error = toPrivateLessonsError(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error.toJSON(), null, 2) }],
  };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/** Add the Pacific rendering of every timestamp a human/model will read. */
function decorateLesson(lesson: Lesson): Record<string, unknown> {
  return {
    ...lesson,
    scheduled_at_pacific: formatPacific(lesson.scheduled_at),
    ...(lesson.paid_at ? { paid_at_pacific: formatPacific(lesson.paid_at) } : {}),
    ...(lesson.cancelled_at ? { cancelled_at_pacific: formatPacific(lesson.cancelled_at) } : {}),
    etag: formatETag(lesson.id, lesson.version),
    timezone: TENANT_TIMEZONE,
  };
}

function decorateResult(result: LessonResult): Record<string, unknown> {
  return {
    lesson: decorateLesson(result.lesson),
    etag: result.etag ?? formatETag(result.lesson.id, result.lesson.version),
    request_id: result.requestId ?? null,
    next_if_match:
      result.etag ?? formatETag(result.lesson.id, result.lesson.version),
  };
}

const durationSchema = z
  .union(
    DURATION_MINUTES.map((d) => z.literal(d)) as unknown as [
      z.ZodLiteral<30>,
      z.ZodLiteral<45>,
      z.ZodLiteral<60>,
      z.ZodLiteral<90>,
      z.ZodLiteral<120>,
    ],
  )
  .describe('Lesson duration in minutes. One of 30, 45, 60, 90, 120.');

const rfc3339Schema = z
  .string()
  .describe(
    'RFC 3339 timestamp with an EXPLICIT UTC offset, e.g. "2026-08-04T14:00:00-07:00". ' +
      'Naive/offset-less input is rejected (422 VALIDATION_FAILED). The tenant timezone ' +
      `is ${TENANT_TIMEZONE}; times are rendered back to you in Pacific.`,
  );

const athleteIdsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .describe(
    'Explicit athlete ids. THERE IS NO NAME FIELD — this tool never resolves a name. ' +
      'Use private_lessons_search_athletes first; if it returns more than one candidate that is ' +
      'the ATHLETE_AMBIGUOUS condition and you MUST ask the user which one before writing.',
  );

const dryRunSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'When true, WRITES NOTHING. Returns the advisory server-computed quote (facility fee ' +
      'in cost_cents, plus platform_fee_cents on top) and an availability/conflict preview ' +
      'so you can confirm with the user before committing.',
  );

const idempotencyKeySchema = z
  .string()
  .max(255)
  .optional()
  .describe(
    'Optional Idempotency-Key. One is generated automatically when omitted, so a retry ' +
      'after a dropped response replays the original result instead of writing twice.',
  );

const ifMatchSchema = z
  .string()
  .optional()
  .describe(
    'The strong ETag from a prior private_lessons_get_lesson, verbatim (e.g. "lesson-42-v3"). ' +
      'REQUIRED by the API. If omitted, this tool fetches the lesson first and uses its ' +
      'current ETag — which means it will not detect a concurrent edit made before that ' +
      'fetch. Pass the ETag you actually read to get the concurrency guarantee. A stale ' +
      'value returns 412 VERSION_MISMATCH with the current version.',
  );

// The external calendar link (issue #62). The full (provider, id, calendar_id) tuple is
// the identity — the same event id can exist in two calendars — so all three are required
// together. A second ACTIVE lesson with the same tuple is refused (EXTERNAL_REF_CONFLICT).
const externalRefSchema = z.object({
  provider: z.string().min(1).describe('Calendar provider, e.g. "google".'),
  id: z.string().min(1).describe('The calendar event id (a per-instance id for recurring events).'),
  calendar_id: z.string().min(1).describe('The id of the calendar the event lives in.'),
});

/**
 * Resolve the `If-Match` to send.
 *
 * When the caller supplies one it is used verbatim — that is the real optimistic-
 * concurrency guarantee. When it does not, we re-read the lesson and use its current
 * ETag. That convenience is explicit, narrow, and never silently retries after a 412:
 * a `VERSION_MISMATCH` always propagates to the caller with `current_version` so the
 * decision to re-apply belongs to whoever is driving.
 */
async function resolveIfMatchFor(
  client: PrivateLessonsClient,
  lessonId: number,
  supplied: string | undefined,
): Promise<{ ifMatch: string; refetched: boolean; lesson: Lesson | null }> {
  if (supplied) {
    const value = supplied.trim();
    if (/^W\//i.test(value) || value === '*') {
      throw new PrivateLessonsError(
        'VALIDATION_FAILED',
        'If-Match must be a strong ETag; weak validators and "*" are rejected.',
        {
          detail:
            'If-Match must be the strong ETag returned by a prior read ' +
            '(e.g. "lesson-42-v3"). Weak validators and "*" would skip the version check.',
        },
      );
    }
    const normalised = parseETag(value) ? value : parseETag(`"${value}"`) ? `"${value}"` : null;
    if (!normalised) {
      throw new PrivateLessonsError(
        'VALIDATION_FAILED',
        `Unrecognised If-Match value ${JSON.stringify(supplied)}.`,
        {
          detail:
            `Unrecognised If-Match value ${JSON.stringify(supplied)}. ` +
            'Use the ETag from private_lessons_get_lesson, e.g. "lesson-42-v3".',
        },
      );
    }
    return { ifMatch: normalised, refetched: false, lesson: null };
  }

  const current = await client.getLesson(lessonId);
  return {
    ifMatch: current.etag ?? formatETag(current.lesson.id, current.lesson.version),
    refetched: true,
    lesson: current.lesson,
  };
}

export interface BuildServerOptions {
  client: PrivateLessonsClient;
  name?: string;
  version?: string;
}

export function buildServer(options: BuildServerOptions): McpServer {
  const { client } = options;
  const server = new McpServer({
    name: options.name ?? 'private-lessons',
    version: options.version ?? '0.1.0',
  });

  // ---------------------------------------------------------------- reads

  server.registerTool(
    'private_lessons_list_lessons',
    {
      title: 'List private lessons',
      description:
        'READ-ONLY. Lists private lessons visible to the authenticated token ' +
        '(Admin/Management see all; Coach/Staff see only their own). Date filters are ' +
        `calendar dates in ${TENANT_TIMEZONE}. Times come back in Pacific. Requires the ` +
        'lessons:read scope.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        from: z.string().optional().describe('Inclusive start date, YYYY-MM-DD, Pacific.'),
        to: z.string().optional().describe('Inclusive end date, YYYY-MM-DD, Pacific.'),
        coach: z.number().int().positive().optional().describe('Filter by coach user id.'),
        paid: z.boolean().optional().describe('Filter by payment state.'),
        athlete: z.number().int().positive().optional().describe('Filter by athlete id.'),
        external_id: z
          .string()
          .optional()
          .describe(
            'Reconcile lookup (#62): the linked calendar event id. Identity is the full ' +
              '(external_id, external_provider, external_calendar_id) tuple — the same id can ' +
              'exist in two calendars — so pass all three to address exactly one lesson; ' +
              'external_id alone can return several.',
          ),
        external_provider: z.string().optional().describe('Reconcile lookup: the calendar provider (#62).'),
        external_calendar_id: z.string().optional().describe('Reconcile lookup: the calendar id (#62).'),
      },
    },
    async (args) =>
      run(async () => {
        const query: Record<string, unknown> = {};
        if (args.from) query.from = args.from;
        if (args.to) query.to = args.to;
        if (args.coach !== undefined) query.coach = args.coach;
        if (args.paid !== undefined) query.paid = args.paid;
        if (args.athlete !== undefined) query.athlete = args.athlete;
        if (args.external_id) query.external_id = args.external_id;
        if (args.external_provider) query.external_provider = args.external_provider;
        if (args.external_calendar_id) query.external_calendar_id = args.external_calendar_id;
        const lessons = await client.listLessons(query);
        return {
          count: lessons.length,
          timezone: TENANT_TIMEZONE,
          lessons: lessons.map(decorateLesson),
        };
      }),
  );

  server.registerTool(
    'private_lessons_get_lesson',
    {
      title: 'Get one private lesson',
      description:
        'READ-ONLY. Fetches one lesson and returns its strong ETag. Call this before any ' +
        'update/cancel/mark-paid and pass the returned `etag` back as `if_match` — that ' +
        'is what makes the write safe against a concurrent edit. Requires lessons:read.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: { lesson_id: z.number().int().positive() },
    },
    async ({ lesson_id }) => run(async () => decorateResult(await client.getLesson(lesson_id))),
  );

  server.registerTool(
    'private_lessons_check_availability',
    {
      title: 'Check bookable windows for a coach',
      description:
        'READ-ONLY. Returns the bookable windows for a coach on one Pacific calendar date, ' +
        'for a given lesson duration, with late-booking starts flagged. Business hours are ' +
        '07:00-22:00 Pacific. Use this before proposing a time. Requires lessons:read.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        date: z.string().describe('Calendar date, YYYY-MM-DD, interpreted in Pacific.'),
        duration: durationSchema,
        coach: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Coach user id. Coach/Staff tokens default to their own schedule.'),
      },
    },
    async ({ date, duration, coach }) =>
      run(async () => {
        const query: { date: string; duration: DurationMinutes; coach?: number } = {
          date,
          duration,
        };
        if (coach !== undefined) query.coach = coach;
        const availability = await client.getAvailability(query);
        return {
          ...availability,
          slots: availability.slots.map((slot) => ({
            ...slot,
            start_pacific: formatPacific(slot.start),
            end_pacific: formatPacific(slot.end),
          })),
        };
      }),
  );

  server.registerTool(
    'private_lessons_get_quote',
    {
      title: 'Get an advisory facility-fee quote',
      description:
        'READ-ONLY, no side effects. Returns the server-computed facility fee for a ' +
        'prospective lesson (cost_cents), plus the membership determination and whether it ' +
        'counts as a late booking. The platform fee (platform_fee_cents, $1 per lesson) is ' +
        'added on top of cost_cents; the coach owes both. THE QUOTE IS ADVISORY: ' +
        'membership can change and the late-booking flag flips once the scheduled time ' +
        'passes, so the fee is always recalculated at create time. Never quote a price to ' +
        'a user as final, and never compute a fee yourself — the server owns pricing. ' +
        'Requires lessons:read.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        athlete_ids: athleteIdsSchema,
        scheduled_at: rfc3339Schema,
        duration: durationSchema,
      },
    },
    async ({ athlete_ids, scheduled_at, duration }) =>
      run(async () => {
        const quote = await client.getPricingQuote({
          duration,
          athlete_ids,
          scheduled_at,
        });
        return {
          ...quote,
          platform_fee_cents: platformFeeCents(quote),
          scheduled_at_pacific: formatPacific(quote.scheduled_at),
          quoted_at_pacific: formatPacific(quote.quoted_at),
          reminder:
            'Advisory only. The facility fee is recalculated server-side when the lesson ' +
            'is actually created. The platform fee (platform_fee_cents) is added on top of ' +
            'cost_cents.',
        };
      }),
  );

  server.registerTool(
    'private_lessons_search_athletes',
    {
      title: 'Search athletes by name (step 1 of the two-step write flow)',
      description:
        'READ-ONLY. THE ONLY WAY to turn a person\'s name into an athlete id. ' +
        'The write tools accept `athlete_ids` and have no name field at all, so you MUST ' +
        'come through here first.\n\n' +
        'Interpret the result strictly:\n' +
        '  - exactly one candidate -> you may use that id;\n' +
        '  - MORE THAN ONE candidate -> this is the ATHLETE_AMBIGUOUS condition. It is ' +
        'client-surfaced, never an HTTP error: the server answers 200 because it cannot ' +
        'know your intent. STOP and ask the user which candidate they mean. Do not pick ' +
        'the first, the closest, or the most recently created one.\n' +
        '  - zero candidates -> the athlete does not exist. Ask the user before creating ' +
        'one; do not assume a spelling.\n\n' +
        'Field visibility depends on the caller\'s role: Coach/Staff tokens see exactly ' +
        'id, name, waiver_signed and membership_status. Requires athletes:read.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().min(1).describe('Name or partial name to search for.'),
      },
    },
    async ({ query }) =>
      run(async () => {
        const resolution = await resolveAthleteByName(client, query);
        switch (resolution.status) {
          case 'resolved':
            return {
              status: 'resolved',
              query,
              athlete: resolution.athlete,
              next_step: `Use athlete_ids: [${resolution.athlete.id}] on the write.`,
            };
          case 'ambiguous':
            return {
              status: 'ambiguous',
              code: 'ATHLETE_AMBIGUOUS',
              query,
              candidates: resolution.candidates,
              next_step:
                `"${query}" matched ${resolution.candidates.length} athletes. Ask the user ` +
                'which one they mean and use that explicit id. Do NOT guess.',
            };
          case 'not_found':
            return {
              status: 'not_found',
              query,
              candidates: [],
              next_step:
                `No athlete matches "${query}". Confirm the spelling with the user, or ` +
                'create the athlete explicitly with private_lessons_create_athlete.',
            };
        }
      }),
  );

  server.registerTool(
    'private_lessons_get_balance',
    {
      title: 'Get unpaid facility and platform fee balances',
      description:
        'READ-ONLY. Returns per-coach unpaid facility fees plus platform fees the COACH ' +
        'OWES THE GYM — not money families owe the coach. unpaid_total_cents is the amount ' +
        'owed (unpaid_cents + unpaid_platform_fee_cents). Coach/Staff tokens see their own ' +
        'balance; Admin/Management see all. Requires balances:read.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        coach_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Filter the returned list to one coach.'),
      },
    },
    async ({ coach_id }) =>
      run(async () => {
        const balances = await client.listBalances();
        const filtered =
          coach_id === undefined ? balances : balances.filter((b) => b.coach_id === coach_id);
        return {
          count: filtered.length,
          balances: filtered.map(normalizeBalance),
          meaning:
            'unpaid_total_cents is what the coach owes the gym: unpaid_cents (facility fees) + ' +
            'unpaid_platform_fee_cents (the $1-per-lesson platform fee).',
        };
      }),
  );

  server.registerTool(
    'private_lessons_list_audit_events',
    {
      title: 'List audit-log events',
      description:
        'READ-ONLY. Returns the append-only audit log, newest first, cursor-paginated. ' +
        'Requires the audit:read scope AND an Admin role — a non-Admin token holding ' +
        'audit:read still gets 403 FORBIDDEN. Pass `meta.next_cursor` back verbatim as ' +
        '`cursor`; never construct one. A limit above 200 is rejected, not clamped.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Events per page. Default 50, maximum 200.'),
        cursor: z
          .string()
          .optional()
          .describe('Opaque keyset cursor from a previous meta.next_cursor. Pass verbatim.'),
      },
    },
    async ({ limit, cursor }) =>
      run(async () => {
        const query: { limit?: number; cursor?: string } = {};
        if (limit !== undefined) query.limit = limit;
        if (cursor !== undefined) query.cursor = cursor;
        const page = await client.listAuditEvents(query);
        return {
          data: page.events.map((event) => ({
            ...event,
            created_at_pacific: formatPacific(event.created_at),
          })),
          meta: page.meta,
        };
      }),
  );

  // --------------------------------------------------------------- writes

  server.registerTool(
    'private_lessons_create_athlete',
    {
      title: 'Create an athlete',
      description:
        'WRITE — SIDE EFFECT: creates a new athlete record in the gym\'s database.\n\n' +
        'Call private_lessons_search_athletes FIRST and confirm with the user that the athlete ' +
        'does not already exist; a near-duplicate record is painful to unpick. Never ' +
        'invent or correct a spelling on the user\'s behalf.\n\n' +
        '`waiver_signed` cannot be set through any scope — waiver status is read-only ' +
        'across the whole API by design. `notes` is honoured for Admin/Management tokens ' +
        'only and silently ignored for Coach/Staff.\n\n' +
        'An Idempotency-Key is required by the API and generated automatically here, so a ' +
        'retry after a dropped response will not create a second athlete. ' +
        'Requires athletes:create.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        first_name: z.string().min(1),
        last_name: z.string().min(1),
        membership_status: z
          .enum(['unknown', 'member', 'not_member'])
          .optional()
          .describe('Defaults to "unknown" when omitted.'),
        notes: z.string().nullish().describe('Admin/Management only; ignored otherwise.'),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'When true, WRITES NOTHING. Runs a name search and reports any existing ' +
              'athletes that look like duplicates so you can confirm before creating.',
          ),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (args) =>
      run(async () => {
        const fullName = `${args.first_name} ${args.last_name}`.trim();
        if (args.dry_run) {
          const resolution = await resolveAthleteByName(client, fullName);
          const existing =
            resolution.status === 'resolved'
              ? [resolution.athlete]
              : resolution.status === 'ambiguous'
                ? resolution.candidates
                : [];
          return {
            dry_run: true,
            would_create: {
              first_name: args.first_name,
              last_name: args.last_name,
              membership_status: args.membership_status ?? 'unknown',
            },
            possible_duplicates: existing,
            warnings:
              existing.length > 0
                ? [
                    `${existing.length} existing athlete(s) already match "${fullName}". ` +
                      'Confirm with the user before creating another.',
                  ]
                : [],
            notes: ['Dry run: nothing was written.'],
          };
        }

        const body: Record<string, unknown> = {
          first_name: args.first_name,
          last_name: args.last_name,
        };
        if (args.membership_status) body.membership_status = args.membership_status;
        if (args.notes !== undefined) body.notes = args.notes;

        const athlete = await client.createAthlete(
          body as Parameters<typeof client.createAthlete>[0],
          args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {},
        );
        return { created: athlete };
      }),
  );

  server.registerTool(
    'private_lessons_create_lesson',
    {
      title: 'Book a private lesson',
      description:
        'WRITE — SIDE EFFECTS: books a lesson, charges the coach a facility fee plus the ' +
        '$1 platform fee, writes an audit event, and sends Slack/email notifications. Not ' +
        'silent, not free.\n\n' +
        'RUN WITH dry_run: true FIRST and show the user the advisory quote and the Pacific ' +
        'start time before committing.\n\n' +
        'ATHLETES: `athlete_ids` only. There is no name field. Resolve every name through ' +
        'private_lessons_search_athletes and, if it returns more than one candidate ' +
        '(ATHLETE_AMBIGUOUS), ask the user which one — never guess.\n\n' +
        'ACKNOWLEDGEMENTS: `fee_acknowledged` must be true and represents the coach ' +
        'accepting the facility fee; get real user confirmation before setting it. If the ' +
        'booking is late, `late_booking_acknowledged` must also be true (else 422 ' +
        'LATE_BOOKING_ACK_REQUIRED); the dry run tells you whether it is late.\n\n' +
        'PRICING: never compute or hardcode a fee. The server calculates it at create time ' +
        'and any earlier quote is advisory. The quote\'s platform_fee_cents is added on top ' +
        'of its cost_cents (the facility fee); the coach owes both.\n\n' +
        'An Idempotency-Key is required by the API and generated automatically, so a retry ' +
        'after a dropped response replays instead of double-booking. Requires lessons:write.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        coach_id: z.number().int().positive().describe('User id of the coach teaching.'),
        athlete_ids: athleteIdsSchema,
        scheduled_at: rfc3339Schema,
        duration_minutes: durationSchema,
        fee_acknowledged: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Must be true to book. Represents the coach acknowledging the facility fee — ' +
              'set it only after the user has actually agreed.',
          ),
        late_booking_acknowledged: z
          .boolean()
          .optional()
          .default(false)
          .describe('Must be true when the booking is late. The dry run tells you if it is.'),
        notes: z.string().nullish(),
        observer: z.string().nullish(),
        external_ref: externalRefSchema
          .optional()
          .describe(
            'Optionally link this lesson to the calendar event it mirrors (#62). Refused ' +
              'with EXTERNAL_REF_CONFLICT if another active lesson already holds this event.',
          ),
        dry_run: dryRunSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (args) =>
      run(async () => {
        if (args.dry_run) {
          const preflight = await preflightLesson(client, {
            coachId: args.coach_id,
            athleteIds: args.athlete_ids,
            scheduledAt: args.scheduled_at,
            durationMinutes: args.duration_minutes,
          });
          const warnings = [...preflight.warnings];
          if (!args.fee_acknowledged) {
            warnings.push(
              'fee_acknowledged is false. The real write will fail with 422 ' +
                'FACILITY_FEE_ACK_REQUIRED until the coach acknowledges the facility fee.',
            );
          }
          return { dry_run: true, ...preflight, warnings };
        }

        const body: Record<string, unknown> = {
          coach_id: args.coach_id,
          athlete_ids: args.athlete_ids,
          scheduled_at: args.scheduled_at,
          duration_minutes: args.duration_minutes,
          fee_acknowledged: args.fee_acknowledged,
        };
        if (args.late_booking_acknowledged) {
          body.late_booking_acknowledged = args.late_booking_acknowledged;
        }
        if (args.notes !== undefined) body.notes = args.notes;
        if (args.observer !== undefined) body.observer = args.observer;
        if (args.external_ref !== undefined) body.external_ref = args.external_ref;

        const result = await client.createLesson(
          body as Parameters<typeof client.createLesson>[0],
          args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {},
        );
        return { created: true, ...decorateResult(result) };
      }),
  );

  server.registerTool(
    'private_lessons_update_lesson',
    {
      title: 'Update / reschedule a private lesson',
      description:
        'WRITE — SIDE EFFECTS: modifies an existing booking, bumps its version, writes an ' +
        'audit event, and sends an update notification to the people involved.\n\n' +
        'RUN WITH dry_run: true FIRST when changing the time or duration.\n\n' +
        'CONCURRENCY: `if_match` is required by the API. Read the lesson with ' +
        'private_lessons_get_lesson and pass its `etag` back verbatim. A stale value returns 412 ' +
        'VERSION_MISMATCH with the server\'s current version — re-read, re-apply, and ask ' +
        'the user before overwriting somebody else\'s change. This tool never auto-retries ' +
        'a 412.\n\n' +
        'ABSENT vs NULL: omitted fields are left unchanged; sending `notes: null` or ' +
        '`observer: null` CLEARS them. Unknown fields are rejected outright (422).\n\n' +
        'ATHLETES: reassign with `athlete_ids` only — no name field exists. ' +
        'Requires lessons:write.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        lesson_id: z.number().int().positive(),
        if_match: ifMatchSchema,
        coach_id: z.number().int().positive().optional(),
        athlete_ids: z
          .array(z.number().int().positive())
          .min(1)
          .optional()
          .describe('Explicit ids only; replaces the whole roster. No name field exists.'),
        scheduled_at: rfc3339Schema.optional(),
        duration_minutes: durationSchema.optional(),
        notes: z.string().nullish().describe('null CLEARS the field; omit to leave unchanged.'),
        observer: z
          .string()
          .nullish()
          .describe('null CLEARS the field; omit to leave unchanged.'),
        late_booking_acknowledged: z
          .boolean()
          .optional()
          .describe('Required true if the new time is a late booking.'),
        external_ref: externalRefSchema
          .nullish()
          .describe(
            'Calendar link (#62). Pass the object to SET a link on a currently-unlinked ' +
              'lesson; pass null to CLEAR the link; omit to leave it unchanged. Re-pointing ' +
              'an already-linked lesson to a DIFFERENT event is refused (422) — clear it first.',
          ),
        dry_run: dryRunSchema,
      },
    },
    async (args) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        if (args.coach_id !== undefined) body.coach_id = args.coach_id;
        if (args.athlete_ids !== undefined) body.athlete_ids = args.athlete_ids;
        if (args.scheduled_at !== undefined) body.scheduled_at = args.scheduled_at;
        if (args.duration_minutes !== undefined) body.duration_minutes = args.duration_minutes;
        if (args.notes !== undefined) body.notes = args.notes;
        if (args.observer !== undefined) body.observer = args.observer;
        if (args.late_booking_acknowledged !== undefined) {
          body.late_booking_acknowledged = args.late_booking_acknowledged;
        }
        // undefined = leave unchanged; null = clear the link; object = set it.
        if (args.external_ref !== undefined) body.external_ref = args.external_ref;

        if (Object.keys(body).length === 0) {
          throw new PrivateLessonsError('VALIDATION_FAILED', 'Nothing to update.', {
            detail:
              'No mutable field was supplied. An empty PATCH would still bump the version, ' +
              'write an audit event and send a notification, so it is refused here.',
          });
        }

        const current = await client.getLesson(args.lesson_id);

        if (args.dry_run) {
          const scheduledAt = (args.scheduled_at ?? current.lesson.scheduled_at) as string;
          const duration = (args.duration_minutes ??
            current.lesson.duration_minutes) as DurationMinutes;
          const athleteIds =
            args.athlete_ids ?? current.lesson.athletes.map((a) => a.id);
          const coachId = args.coach_id ?? current.lesson.coach_id;
          const timeChanged =
            args.scheduled_at !== undefined || args.duration_minutes !== undefined;

          const preflight = timeChanged
            ? await preflightLesson(client, {
                coachId,
                athleteIds,
                scheduledAt,
                durationMinutes: duration,
                excludeLessonId: args.lesson_id,
              })
            : null;

          return {
            dry_run: true,
            lesson_id: args.lesson_id,
            current: decorateLesson(current.lesson),
            changes: body,
            if_match_to_use: current.etag ?? formatETag(
              current.lesson.id,
              current.lesson.version,
            ),
            preflight,
            notes: [
              'Dry run: nothing was written.',
              ...(timeChanged
                ? []
                : ['No time/duration change requested, so no availability check was run.']),
            ],
          };
        }

        const { ifMatch, refetched } = await resolveIfMatchFor(
          client,
          args.lesson_id,
          args.if_match,
        );
        const result = await client.updateLesson(
          args.lesson_id,
          body as Parameters<typeof client.updateLesson>[1],
          { ifMatch },
        );
        return {
          updated: true,
          ...decorateResult(result),
          ...(refetched
            ? {
                warning:
                  'No if_match was supplied, so the current ETag was read immediately ' +
                  'before the write. A concurrent edit made before that read would not ' +
                  'have been detected.',
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    'private_lessons_cancel_lesson',
    {
      title: 'Cancel a private lesson',
      description:
        'WRITE — DESTRUCTIVE SIDE EFFECTS: cancels (soft-deletes) the booking, removes it ' +
        'from calendars, writes an audit event, and notifies the coach and family. This is ' +
        'not a preview and not easily undone from this API.\n\n' +
        'ALWAYS run with dry_run: true first, show the user the lesson\'s absolute Pacific ' +
        'date and time and who it is for, and get an explicit confirmation before ' +
        'cancelling. Do not chain a cancel straight after a search.\n\n' +
        'CONCURRENCY: `if_match` is required by the API — pass the ETag from ' +
        'private_lessons_get_lesson. A stale value returns 412 VERSION_MISMATCH.\n\n' +
        'An Idempotency-Key is generated automatically, so a retry after a dropped ' +
        'response replays the original cancellation rather than 404-ing on the now ' +
        'soft-deleted lesson. Requires lessons:cancel.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        lesson_id: z.number().int().positive(),
        if_match: ifMatchSchema,
        reason: z.string().nullish().describe('Optional; recorded in the audit event.'),
        dry_run: dryRunSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (args) =>
      run(async () => {
        const current = await client.getLesson(args.lesson_id);
        const etag = current.etag ?? formatETag(current.lesson.id, current.lesson.version);

        if (args.dry_run) {
          return {
            dry_run: true,
            would_cancel: decorateLesson(current.lesson),
            when_pacific: formatPacific(current.lesson.scheduled_at),
            athletes: current.lesson.athletes,
            already_cancelled: current.lesson.cancelled_at != null,
            already_paid: current.lesson.paid_at != null,
            if_match_to_use: etag,
            warnings: [
              'Cancelling notifies the coach and the family and removes the lesson from ' +
                'calendars. Confirm the Pacific date/time above with the user first.',
              ...(current.lesson.paid_at != null
                ? ['This lesson is already marked paid — check the fee handling.']
                : []),
            ],
            notes: ['Dry run: nothing was written.'],
          };
        }

        const { ifMatch, refetched } = await resolveIfMatchFor(
          client,
          args.lesson_id,
          args.if_match,
        );
        const result = await client.cancelLesson(
          args.lesson_id,
          args.reason !== undefined ? { reason: args.reason } : {},
          {
            ifMatch,
            ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
          },
        );
        return {
          cancelled: true,
          when_pacific: formatPacific(result.lesson.scheduled_at),
          ...decorateResult(result),
          ...(refetched
            ? {
                warning:
                  'No if_match was supplied, so the current ETag was read immediately ' +
                  'before the write.',
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    'private_lessons_mark_lesson_paid',
    {
      title: 'Mark a lesson\'s fees as paid',
      description:
        'WRITE — FINANCIAL SIDE EFFECT: records that the coach has paid the facility fee ' +
        'and platform fee for this lesson. It changes the coach\'s balance and writes an ' +
        'audit event. There is no un-mark-paid endpoint in this API.\n\n' +
        'ALWAYS run with dry_run: true first, show the user the lesson\'s Pacific date/time ' +
        'and the exact amount, and get explicit confirmation before recording payment.\n\n' +
        'CONCURRENCY: `if_match` is required. Note that re-marking an ALREADY-PAID lesson ' +
        'with a stale If-Match is 412, not 200 — a 200 would assert your out-of-date view ' +
        'was current. The payment itself stays idempotent: the original paid_at and its ' +
        'single audit row are never overwritten.\n\n' +
        '`paid_at` defaults to now when omitted. Requires lessons:mark-paid.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        lesson_id: z.number().int().positive(),
        if_match: ifMatchSchema,
        paid_at: rfc3339Schema
          .nullish()
          .describe('When payment happened. Defaults to now if omitted.'),
        dry_run: dryRunSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (args) =>
      run(async () => {
        const current = await client.getLesson(args.lesson_id);
        const etag = current.etag ?? formatETag(current.lesson.id, current.lesson.version);

        if (args.dry_run) {
          return {
            dry_run: true,
            lesson: decorateLesson(current.lesson),
            when_pacific: formatPacific(current.lesson.scheduled_at),
            amount_owed_cents: lessonOwedCents(current.lesson),
            facility_fee_cents: current.lesson.effective_cost_cents,
            platform_fee_cents: platformFeeCents(current.lesson),
            already_paid: current.lesson.paid_at != null,
            already_paid_at_pacific: current.lesson.paid_at
              ? formatPacific(current.lesson.paid_at)
              : null,
            if_match_to_use: etag,
            warnings: [
              'Marking paid changes the coach\'s balance and cannot be undone through this ' +
                'API. Confirm the lesson and amount with the user first.',
              ...(current.lesson.paid_at != null
                ? ['This lesson is ALREADY marked paid; re-marking will not change paid_at.']
                : []),
            ],
            notes: ['Dry run: nothing was written.'],
          };
        }

        const { ifMatch, refetched } = await resolveIfMatchFor(
          client,
          args.lesson_id,
          args.if_match,
        );
        const result = await client.markLessonPaid(
          args.lesson_id,
          args.paid_at !== undefined && args.paid_at !== null ? { paid_at: args.paid_at } : {},
          {
            ifMatch,
            ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
          },
        );
        return {
          marked_paid: true,
          ...decorateResult(result),
          ...(refetched
            ? {
                warning:
                  'No if_match was supplied, so the current ETag was read immediately ' +
                  'before the write.',
              }
            : {}),
        };
      }),
  );

  return server;
}
