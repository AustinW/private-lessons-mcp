#!/usr/bin/env node
/**
 * The `private-lessons` CLI.
 *
 * Behavioural guarantees this file implements:
 *
 *  - the token is never an argv argument (see `auth set-token`);
 *  - `--json` produces exactly one JSON document on stdout and nothing else;
 *  - every destructive action prints the lesson's absolute Pacific date/time first and
 *    requires an explicit confirmation (`cancel`, `mark-paid`);
 *  - the process exit code is the documented mapping of the API's error codes
 *    (see README, "Exit codes");
 *  - `Idempotency-Key` is generated when not supplied, so a retry is safe by default.
 */

import { Command, Option } from 'commander';

import { requireSingleAthlete, toCandidate } from '../core/athletes.js';
import {
  DURATION_MINUTES,
  type Athlete,
  type DurationMinutes,
  type Lesson,
  type PrivateLessonsClient,
} from '../core/client.js';
import { formatETag, newIdempotencyKey, resolveIfMatch } from '../core/concurrency.js';
import { EXIT_CODES, PrivateLessonsError, toPrivateLessonsError } from '../core/errors.js';
import { preflightLesson } from '../core/preflight.js';
import { openSession, type Session } from '../core/session.js';
import {
  assertCalendarDate,
  assertRfc3339,
  formatPacific,
  Rfc3339FormatError,
  TENANT_TIMEZONE,
} from '../core/time.js';
import {
  deleteToken,
  fingerprint,
  getToken,
  keychainAvailable,
  setToken,
  TOKEN_ENV_VAR,
} from '../core/token-store.js';
import { confirm, info, printJson, readSecret, table, warn } from './io.js';

const VERSION = '0.1.0';

interface GlobalOptions {
  json: boolean;
  baseUrl?: string;
  profile: string;
  yes: boolean;
}

/** Options set on the root command, read by every subcommand. */
function globals(command: Command): GlobalOptions {
  const opts = command.optsWithGlobals<Record<string, unknown>>();
  return {
    json: opts.json === true,
    baseUrl: typeof opts.baseUrl === 'string' ? opts.baseUrl : undefined,
    profile: typeof opts.profile === 'string' ? opts.profile : 'default',
    yes: opts.yes === true,
  };
}

async function session(command: Command): Promise<Session> {
  const g = globals(command);
  return openSession({
    baseUrl: g.baseUrl,
    profile: g.profile,
    userAgent: `private-lessons-cli/${VERSION}`,
  });
}

function parseDuration(value: string): DurationMinutes {
  const n = Number(value);
  if (!DURATION_MINUTES.includes(n as DurationMinutes)) {
    throw new PrivateLessonsError(
      'USAGE_ERROR',
      `Invalid duration ${value}.`,
      { detail: `Duration must be one of ${DURATION_MINUTES.join(', ')} minutes.` },
    );
  }
  return n as DurationMinutes;
}

function parseIds(value: string): number[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const n = Number(part);
      if (!Number.isInteger(n) || n <= 0) {
        throw new PrivateLessonsError('USAGE_ERROR', `Invalid athlete id "${part}".`, {
          detail:
            `Invalid athlete id "${part}". --athlete-ids takes a comma-separated list of ` +
            'numeric ids. Find them with `private-lessons athletes search`.',
        });
      }
      return n;
    });
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What the coach owes for a lesson: facility fee (after override/waiver) + platform fee. */
function lessonTotalCents(lesson: Lesson): number {
  return lesson.effective_cost_cents + lesson.platform_fee_cents;
}

/**
 * `$16.00 ($15.00 facility + $1.00 platform)`. With no platform fee the breakdown adds
 * nothing, so the old single amount is shown.
 */
function feeText(facilityCents: number, platformCents: number): string {
  if (platformCents === 0) return dollars(facilityCents);
  return (
    `${dollars(facilityCents + platformCents)} ` +
    `(${dollars(facilityCents)} facility + ${dollars(platformCents)} platform)`
  );
}

function lessonFeeText(lesson: Lesson): string {
  return feeText(lesson.effective_cost_cents, lesson.platform_fee_cents);
}

function lessonRow(lesson: Lesson): Array<string | number | null> {
  return [
    lesson.id,
    formatPacific(lesson.scheduled_at),
    `${lesson.duration_minutes}m`,
    lesson.coach_name ?? lesson.coach_id,
    lesson.athletes.map((a) => a.name).join(', '),
    (lessonTotalCents(lesson) / 100).toFixed(2),
    lesson.cancelled_at ? 'cancelled' : lesson.paid_at ? 'paid' : 'unpaid',
    `v${lesson.version}`,
  ];
}

function printLessons(lessons: Lesson[], json: boolean): void {
  if (json) {
    printJson({ ok: true, count: lessons.length, data: lessons });
    return;
  }
  if (lessons.length === 0) {
    info('No lessons matched.', { json });
    return;
  }
  info(
    table(
      ['ID', `WHEN (${TENANT_TIMEZONE})`, 'DUR', 'COACH', 'ATHLETES', 'FEE $', 'STATUS', 'VER'],
      lessons.map(lessonRow),
    ),
    { json },
  );
}

function athleteName(athlete: Athlete): string {
  return (athlete as { name: string }).name;
}

/**
 * Read a lesson, show it in Pacific, and require a typed confirmation.
 * Returns the ETag to use as `If-Match`, or `null` when the operator declined.
 */
async function confirmDestructive(
  client: PrivateLessonsClient,
  lessonId: number,
  action: string,
  g: GlobalOptions,
  extraLines: (lesson: Lesson) => string[],
): Promise<{ etag: string; lesson: Lesson } | null> {
  const current = await client.getLesson(lessonId);
  const lesson = current.lesson;
  const etag = current.etag ?? formatETag(lesson.id, lesson.version);

  const lines = [
    '',
    `About to ${action}:`,
    `  lesson    #${lesson.id} (version ${lesson.version})`,
    `  when      ${formatPacific(lesson.scheduled_at)}`,
    `  duration  ${lesson.duration_minutes} minutes`,
    `  coach     ${lesson.coach_name ?? lesson.coach_id}`,
    `  athletes  ${lesson.athletes.map((a) => `${a.name} (#${a.id})`).join(', ') || '—'}`,
    `  fee       ${lessonFeeText(lesson)}`,
    ...extraLines(lesson),
    '',
  ];
  warn(lines.join('\n'));

  const proceed = await confirm(`Really ${action} lesson #${lesson.id}?`, {
    assumeYes: g.yes,
    requirePhrase: `${action} ${lesson.id}`,
  });
  if (!proceed) return null;
  return { etag, lesson };
}

// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('private-lessons')
  .description(
    'CLI for the Private Lessons API. The HTTP client is generated from ' +
      'contract/openapi.yaml, so it cannot drift from the contract.',
  )
  .version(VERSION)
  .option('--json', 'Emit exactly one JSON document on stdout; humans go to stderr.', false)
  .option('--base-url <url>', `API base URL (or set PRIVATE_LESSONS_BASE_URL).`)
  .option('--profile <name>', 'Credential-store profile.', 'default')
  .option('-y, --yes', 'Skip interactive confirmation for destructive actions.', false)
  .showHelpAfterError()
  // Commander throws a CommanderError for `--help`, `--version` and usage problems rather
  // than calling process.exit, so those paths stay distinguishable from API failures.
  // This must be set BEFORE any subcommand is created: `.command()` copies the callback
  // to the child at creation time, so a later call would not reach the subcommands.
  .exitOverride();

// ------------------------------------------------------------------- auth

const auth = program.command('auth').description('Manage the stored API token.');

auth
  .command('set-token')
  .description(
    'Store an API token in the OS credential store. The token is NEVER accepted as an ' +
      'argument: it is read from a hidden prompt, or from stdin when piped.',
  )
  .action(async (_opts, command: Command) => {
    const g = globals(command);
    if (!(await keychainAvailable())) {
      throw new PrivateLessonsError('USAGE_ERROR', 'No OS credential store available.', {
        detail:
          'No OS credential store is available on this platform. Set the ' +
          `${TOKEN_ENV_VAR} environment variable instead.`,
      });
    }
    const token = await readSecret('Paste the Private Lessons API token (input hidden): ');
    if (!token) {
      throw new PrivateLessonsError('USAGE_ERROR', 'No token supplied.', {
        detail: 'No token was supplied on stdin.',
      });
    }
    await setToken(token, g.profile);
    if (g.json) {
      printJson({ ok: true, stored: true, profile: g.profile, fingerprint: fingerprint(token) });
    } else {
      info(`Stored token ${fingerprint(token)} in the OS credential store (profile: ${g.profile}).`, g);
      if (process.env[TOKEN_ENV_VAR]) {
        warn(
          `Note: ${TOKEN_ENV_VAR} is set in this environment and takes precedence over the ` +
            'stored token.',
        );
      }
    }
  });

auth
  .command('status')
  .description('Show where the token would be read from. Never prints the token.')
  .action(async (_opts, command: Command) => {
    const g = globals(command);
    const resolved = await getToken(g.profile);
    const payload = {
      ok: true,
      profile: g.profile,
      keychain_available: await keychainAvailable(),
      token_source: resolved?.source ?? 'none',
      token_fingerprint: resolved ? fingerprint(resolved.token) : null,
      base_url: process.env.PRIVATE_LESSONS_BASE_URL ?? g.baseUrl ?? null,
    };
    if (g.json) {
      printJson(payload);
      return;
    }
    info(`profile           ${payload.profile}`, g);
    info(`keychain          ${payload.keychain_available ? 'available' : 'unavailable'}`, g);
    info(`token source      ${payload.token_source}`, g);
    info(`token             ${payload.token_fingerprint ?? '(none)'}`, g);
    info(`base url          ${payload.base_url ?? '(not configured)'}`, g);
  });

auth
  .command('clear')
  .description('Delete the stored token from the OS credential store.')
  .action(async (_opts, command: Command) => {
    const g = globals(command);
    const deleted = await deleteToken(g.profile);
    if (g.json) printJson({ ok: true, deleted, profile: g.profile });
    else info(deleted ? 'Stored token deleted.' : 'No stored token to delete.', g);
  });

auth
  .command('whoami')
  .description('Call GET /me and show the token owner, roles and granted scopes.')
  .action(async (_opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const me = await client.getMe();
    if (g.json) {
      printJson({ ok: true, data: me });
      return;
    }
    info(`user     ${me.name} <${me.email}> (#${me.id})`, g);
    info(`roles    ${me.roles.join(', ') || '—'}`, g);
    info(`scopes   ${me.scopes.join(', ') || '—'}`, g);
    info(`token    ${me.token.name} (#${me.token.id}, ${me.token.fingerprint})`, g);
    if (me.token.expires_at) info(`expires  ${formatPacific(me.token.expires_at)}`, g);
  });

// ---------------------------------------------------------------- lessons

const lessons = program.command('lessons').description('List and manage private lessons.');

lessons
  .command('list')
  .description('List lessons visible to the token. Requires lessons:read.')
  .option('--from <date>', 'Inclusive start date, YYYY-MM-DD (Pacific).')
  .option('--to <date>', 'Inclusive end date, YYYY-MM-DD (Pacific).')
  .option('--coach <id>', 'Filter by coach user id.')
  .option('--athlete <id>', 'Filter by athlete id.')
  .option('--external-id <id>', 'Reconcile lookup: linked calendar event id (pair with the two below).')
  .option('--external-provider <name>', 'Reconcile lookup: calendar provider, e.g. google.')
  .option('--external-calendar-id <id>', 'Reconcile lookup: the calendar the event lives in.')
  .addOption(new Option('--paid', 'Only paid lessons.').conflicts('unpaid'))
  .addOption(new Option('--unpaid', 'Only unpaid lessons.').conflicts('paid'))
  .action(async (opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const query: Record<string, unknown> = {};
    if (opts.from) query.from = assertCalendarDate(String(opts.from));
    if (opts.to) query.to = assertCalendarDate(String(opts.to));
    if (opts.coach) query.coach = Number(opts.coach);
    if (opts.athlete) query.athlete = Number(opts.athlete);
    if (opts.paid) query.paid = true;
    if (opts.unpaid) query.paid = false;
    // The unique identity is the full tuple; external_id alone can match several lessons.
    if (opts.externalId) query.external_id = String(opts.externalId);
    if (opts.externalProvider) query.external_provider = String(opts.externalProvider);
    if (opts.externalCalendarId) query.external_calendar_id = String(opts.externalCalendarId);
    printLessons(await client.listLessons(query), g.json);
  });

lessons
  .command('get')
  .description('Show one lesson and its strong ETag (use it as --if-match).')
  .argument('<id>', 'Lesson id.')
  .action(async (id: string, _opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const result = await client.getLesson(Number(id));
    const etag = result.etag ?? formatETag(result.lesson.id, result.lesson.version);
    if (g.json) {
      printJson({ ok: true, data: result.lesson, etag, request_id: result.requestId ?? null });
      return;
    }
    printLessons([result.lesson], false);
    info(`\nETag: ${etag}   (pass this as --if-match on the next write)`, g);
    if (result.lesson.notes) info(`notes: ${result.lesson.notes}`, g);
    if (result.lesson.observer) info(`observer: ${result.lesson.observer}`, g);
  });

/**
 * Build an external calendar link from the three `--external-*` flags (#62). All three
 * are required together (the tuple is the identity); returns undefined when none are given,
 * and a usage error when only some are.
 */
function externalRefFrom(opts: {
  externalProvider?: unknown;
  externalId?: unknown;
  externalCalendarId?: unknown;
}): { provider: string; id: string; calendar_id: string } | undefined {
  const parts = {
    provider: opts.externalProvider as string | undefined,
    id: opts.externalId as string | undefined,
    calendar_id: opts.externalCalendarId as string | undefined,
  };
  const given = Object.values(parts).filter((v) => v !== undefined && v !== '');
  if (given.length === 0) return undefined;
  if (given.length !== 3) {
    throw new PrivateLessonsError('USAGE_ERROR', 'An external calendar link needs all three parts.', {
      detail: 'Pass --external-provider, --external-id and --external-calendar-id together.',
    });
  }
  return { provider: parts.provider!, id: parts.id!, calendar_id: parts.calendar_id! };
}

lessons
  .command('create')
  .description(
    'Book a lesson. Requires lessons:write. Athletes are given as explicit ids only — ' +
      'there is no name field on a write.',
  )
  .requiredOption('--coach <id>', 'Coach user id.')
  .requiredOption(
    '--athlete-ids <ids>',
    'Comma-separated athlete ids. Find them with `private-lessons athletes search`.',
  )
  .requiredOption(
    '--at <timestamp>',
    'Start time, RFC 3339 with an explicit offset, e.g. 2026-08-04T14:00:00-07:00.',
  )
  .requiredOption('--duration <minutes>', `One of ${DURATION_MINUTES.join(', ')}.`)
  .option('--notes <text>')
  .option('--observer <name>')
  .option('--external-provider <name>', 'Link to a calendar event: provider, e.g. google (needs all three).')
  .option('--external-id <id>', 'Link to a calendar event: the event id (needs all three).')
  .option('--external-calendar-id <id>', 'Link to a calendar event: the calendar id (needs all three).')
  .option(
    '--acknowledge-fee',
    'Acknowledge the facility fee. Required by the API to book.',
    false,
  )
  .option(
    '--acknowledge-late-booking',
    'Acknowledge that this is a late booking. Required when it is.',
    false,
  )
  .option('--dry-run', 'Quote and check availability without writing anything.', false)
  .option('--idempotency-key <key>', 'Supply your own key; one is generated otherwise.')
  .action(async (opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);

    const athleteIds = parseIds(String(opts.athleteIds));
    const scheduledAt = assertRfc3339(String(opts.at));
    const duration = parseDuration(String(opts.duration));

    if (opts.dryRun) {
      const preflight = await preflightLesson(client, {
        coachId: Number(opts.coach),
        athleteIds,
        scheduledAt,
        durationMinutes: duration,
      });
      if (g.json) {
        printJson({ ok: true, dry_run: true, data: preflight });
        return;
      }
      info(`Dry run — nothing was written.`, g);
      info(`  when     ${preflight.scheduled_at_pacific}`, g);
      info(`  ends     ${preflight.ends_at_pacific}`, g);
      if (preflight.quote) {
        info(
          `  fee      ${feeText(preflight.quote.cost_cents, preflight.quote.platform_fee_cents)} (advisory)`,
          g,
        );
        info(`  basis    ${preflight.quote.breakdown}`, g);
        info(`  member   ${preflight.quote.is_member ? 'yes' : 'no'}`, g);
        info(`  late     ${preflight.quote.is_late_booking ? 'YES' : 'no'}`, g);
      } else {
        info(`  fee      (quote unavailable: ${preflight.quote_error})`, g);
      }
      info(
        `  slot     ${
          preflight.availability.checked
            ? preflight.availability.window_is_bookable
              ? 'available'
              : 'NOT available'
            : `(check failed: ${preflight.availability.error})`
        }`,
        g,
      );
      for (const w of preflight.warnings) warn(`  ! ${w}`);
      return;
    }

    if (!opts.acknowledgeFee) {
      throw new PrivateLessonsError(
        'FACILITY_FEE_ACK_REQUIRED',
        'The facility fee must be acknowledged.',
        {
          detail:
            'Booking charges the coach a facility fee. Pass --acknowledge-fee to confirm, ' +
            'or run with --dry-run first to see the advisory amount.',
        },
      );
    }

    const body: Record<string, unknown> = {
      coach_id: Number(opts.coach),
      athlete_ids: athleteIds,
      scheduled_at: scheduledAt,
      duration_minutes: duration,
      fee_acknowledged: true,
    };
    if (opts.acknowledgeLateBooking) body.late_booking_acknowledged = true;
    if (opts.notes !== undefined) body.notes = opts.notes;
    if (opts.observer !== undefined) body.observer = opts.observer;
    const externalRef = externalRefFrom(opts);
    if (externalRef) body.external_ref = externalRef;

    const key = typeof opts.idempotencyKey === 'string' ? opts.idempotencyKey : newIdempotencyKey();
    const result = await client.createLesson(
      body as Parameters<typeof client.createLesson>[0],
      { idempotencyKey: key },
    );
    const etag = result.etag ?? formatETag(result.lesson.id, result.lesson.version);
    if (g.json) {
      printJson({ ok: true, data: result.lesson, etag, idempotency_key: key });
      return;
    }
    info(`Booked lesson #${result.lesson.id} for ${formatPacific(result.lesson.scheduled_at)}.`, g);
    info(`  fee   ${lessonFeeText(result.lesson)}`, g);
    info(`  ETag  ${etag}`, g);
  });

lessons
  .command('update')
  .description(
    'Update a lesson. Requires lessons:write and a strong --if-match ETag from a prior read.',
  )
  .argument('<id>', 'Lesson id.')
  .option('--coach <id>')
  .option('--athlete-ids <ids>', 'Replace the roster with these explicit ids.')
  .option('--at <timestamp>', 'New start time, RFC 3339 with an explicit offset.')
  .option('--duration <minutes>')
  .option('--notes <text>', 'Set notes.')
  .option('--clear-notes', 'Clear notes (sends an explicit null).', false)
  .option('--observer <name>', 'Set observer.')
  .option('--clear-observer', 'Clear observer (sends an explicit null).', false)
  .option('--external-provider <name>', 'Link to a calendar event: provider (needs all three).')
  .option('--external-id <id>', 'Link to a calendar event: the event id (needs all three).')
  .option('--external-calendar-id <id>', 'Link to a calendar event: the calendar id (needs all three).')
  .option('--clear-external-ref', 'Unlink the calendar event (sends an explicit null).', false)
  .option('--acknowledge-late-booking', 'Required when the new time is a late booking.', false)
  .option(
    '--if-match <etag>',
    'Strong ETag from a prior read, e.g. "lesson-42-v3". Required unless --dry-run.',
  )
  .option('--dry-run', 'Show the change and preflight it without writing.', false)
  .action(async (id: string, opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const lessonId = Number(id);

    const body: Record<string, unknown> = {};
    if (opts.coach !== undefined) body.coach_id = Number(opts.coach);
    if (opts.athleteIds !== undefined) body.athlete_ids = parseIds(String(opts.athleteIds));
    if (opts.at !== undefined) body.scheduled_at = assertRfc3339(String(opts.at));
    if (opts.duration !== undefined) body.duration_minutes = parseDuration(String(opts.duration));
    if (opts.clearNotes) body.notes = null;
    else if (opts.notes !== undefined) body.notes = opts.notes;
    if (opts.clearObserver) body.observer = null;
    else if (opts.observer !== undefined) body.observer = opts.observer;
    if (opts.acknowledgeLateBooking) body.late_booking_acknowledged = true;

    // Calendar link (#62): --clear-external-ref sends null (unlink); the three
    // --external-* flags set it. Re-pointing a linked lesson to a different event is a 422
    // from the API — clear it first.
    const externalRef = externalRefFrom(opts);
    if (opts.clearExternalRef) {
      if (externalRef) {
        throw new PrivateLessonsError('USAGE_ERROR', 'Cannot set and clear the calendar link at once.', {
          detail: 'Pass either --clear-external-ref or the three --external-* flags, not both.',
        });
      }
      body.external_ref = null;
    } else if (externalRef) {
      body.external_ref = externalRef;
    }

    if (Object.keys(body).length === 0) {
      throw new PrivateLessonsError('USAGE_ERROR', 'Nothing to update.', {
        detail:
          'No field was supplied. An empty PATCH would still bump the version, write an ' +
          'audit event and send an update notification, so it is refused here.',
      });
    }

    const current = await client.getLesson(lessonId);
    const currentEtag = current.etag ?? formatETag(current.lesson.id, current.lesson.version);

    if (opts.dryRun) {
      const timeChanged = opts.at !== undefined || opts.duration !== undefined;
      const preflight = timeChanged
        ? await preflightLesson(client, {
            coachId: (body.coach_id as number | undefined) ?? current.lesson.coach_id,
            athleteIds:
              (body.athlete_ids as number[] | undefined) ??
              current.lesson.athletes.map((a) => a.id),
            scheduledAt: (body.scheduled_at as string | undefined) ?? current.lesson.scheduled_at,
            durationMinutes:
              (body.duration_minutes as DurationMinutes | undefined) ??
              current.lesson.duration_minutes,
            excludeLessonId: lessonId,
          })
        : null;
      const payload = {
        ok: true,
        dry_run: true,
        lesson_id: lessonId,
        changes: body,
        if_match_to_use: currentEtag,
        preflight,
      };
      if (g.json) printJson(payload);
      else {
        info('Dry run — nothing was written.', g);
        info(`  current   ${formatPacific(current.lesson.scheduled_at)} (v${current.lesson.version})`, g);
        info(`  changes   ${JSON.stringify(body)}`, g);
        info(`  if-match  ${currentEtag}`, g);
        if (preflight) {
          info(
            `  slot      ${
              preflight.availability.window_is_bookable ? 'available' : 'NOT available'
            }`,
            g,
          );
          for (const w of preflight.warnings) warn(`  ! ${w}`);
        }
      }
      return;
    }

    if (!opts.ifMatch) {
      throw new PrivateLessonsError('USAGE_ERROR', '--if-match is required.', {
        detail:
          '--if-match is required on an update: the API needs the strong ETag of the ' +
          `version you read. The current ETag for lesson ${lessonId} is ${currentEtag}. ` +
          'Re-read the lesson, confirm the change still makes sense, and pass it.',
      });
    }

    const ifMatch = resolveIfMatch(String(opts.ifMatch), lessonId);
    const result = await client.updateLesson(
      lessonId,
      body as Parameters<typeof client.updateLesson>[1],
      { ifMatch },
    );
    const etag = result.etag ?? formatETag(result.lesson.id, result.lesson.version);
    if (g.json) printJson({ ok: true, data: result.lesson, etag });
    else {
      info(`Updated lesson #${result.lesson.id} → ${formatPacific(result.lesson.scheduled_at)}.`, g);
      info(`  ETag  ${etag}`, g);
    }
  });

lessons
  .command('cancel')
  .description(
    'Cancel a lesson. DESTRUCTIVE: notifies the coach and family and removes the lesson ' +
      'from calendars. Requires lessons:cancel, --if-match, and an explicit confirmation.',
  )
  .argument('<id>', 'Lesson id.')
  .option('--reason <text>', 'Recorded in the audit event.')
  .option('--if-match <etag>', 'Strong ETag from a prior read. Defaults to the current one.')
  .option('--idempotency-key <key>', 'Supply your own key; one is generated otherwise.')
  .option('--dry-run', 'Show what would be cancelled without writing.', false)
  .action(async (id: string, opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const lessonId = Number(id);

    if (opts.dryRun) {
      const current = await client.getLesson(lessonId);
      const etag = current.etag ?? formatETag(current.lesson.id, current.lesson.version);
      if (g.json) {
        printJson({
          ok: true,
          dry_run: true,
          would_cancel: current.lesson,
          when_pacific: formatPacific(current.lesson.scheduled_at),
          if_match_to_use: etag,
        });
      } else {
        info('Dry run — nothing was written.', g);
        printLessons([current.lesson], false);
        info(`\nWould cancel the above at ${formatPacific(current.lesson.scheduled_at)}.`, g);
        info(`if-match: ${etag}`, g);
      }
      return;
    }

    const confirmed = await confirmDestructive(client, lessonId, 'cancel', g, (lesson) => [
      ...(lesson.paid_at ? [`  NOTE      already marked paid at ${formatPacific(lesson.paid_at)}`] : []),
      ...(lesson.cancelled_at ? ['  NOTE      already cancelled'] : []),
      '  effect    notifies the coach and family; removes it from calendars.',
    ]);
    if (!confirmed) {
      throw new PrivateLessonsError('ABORTED', 'Cancelled at the confirmation prompt.', {
        detail: 'No confirmation given; nothing was written.',
      });
    }

    const ifMatch = opts.ifMatch ? resolveIfMatch(String(opts.ifMatch), lessonId) : confirmed.etag;
    const key = typeof opts.idempotencyKey === 'string' ? opts.idempotencyKey : newIdempotencyKey();
    const result = await client.cancelLesson(
      lessonId,
      opts.reason !== undefined ? { reason: String(opts.reason) } : {},
      { ifMatch, idempotencyKey: key },
    );
    if (g.json) printJson({ ok: true, data: result.lesson, idempotency_key: key });
    else info(`Cancelled lesson #${result.lesson.id} (${formatPacific(result.lesson.scheduled_at)}).`, g);
  });

lessons
  .command('mark-paid')
  .description(
    'Record payment of the facility and platform fees. FINANCIAL: changes the coach balance and cannot ' +
      'be undone through this API. Requires lessons:mark-paid, --if-match, and confirmation.',
  )
  .argument('<id>', 'Lesson id.')
  .option('--paid-at <timestamp>', 'RFC 3339 with an explicit offset. Defaults to now.')
  .option('--if-match <etag>', 'Strong ETag from a prior read. Defaults to the current one.')
  .option('--idempotency-key <key>', 'Supply your own key; one is generated otherwise.')
  .option('--dry-run', 'Show what would be marked paid without writing.', false)
  .action(async (id: string, opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const lessonId = Number(id);

    if (opts.dryRun) {
      const current = await client.getLesson(lessonId);
      const etag = current.etag ?? formatETag(current.lesson.id, current.lesson.version);
      const payload = {
        ok: true,
        dry_run: true,
        lesson: current.lesson,
        when_pacific: formatPacific(current.lesson.scheduled_at),
        amount_cents: lessonTotalCents(current.lesson),
        facility_fee_cents: current.lesson.effective_cost_cents,
        platform_fee_cents: current.lesson.platform_fee_cents,
        already_paid: current.lesson.paid_at != null,
        if_match_to_use: etag,
      };
      if (g.json) printJson(payload);
      else {
        info('Dry run — nothing was written.', g);
        info(`  lesson  #${current.lesson.id} at ${formatPacific(current.lesson.scheduled_at)}`, g);
        info(`  amount  ${lessonFeeText(current.lesson)}`, g);
        info(`  paid    ${current.lesson.paid_at ? formatPacific(current.lesson.paid_at) : 'no'}`, g);
        info(`  if-match ${etag}`, g);
      }
      return;
    }

    const paidAt = opts.paidAt ? assertRfc3339(String(opts.paidAt)) : undefined;

    const confirmed = await confirmDestructive(client, lessonId, 'mark-paid', g, (lesson) => [
      `  amount    ${lessonFeeText(lesson)}`,
      ...(lesson.paid_at ? [`  NOTE      already paid at ${formatPacific(lesson.paid_at)}`] : []),
      '  effect    changes the coach balance; there is no un-mark-paid endpoint.',
    ]);
    if (!confirmed) {
      throw new PrivateLessonsError('ABORTED', 'Cancelled at the confirmation prompt.', {
        detail: 'No confirmation given; nothing was written.',
      });
    }

    const ifMatch = opts.ifMatch ? resolveIfMatch(String(opts.ifMatch), lessonId) : confirmed.etag;
    const key = typeof opts.idempotencyKey === 'string' ? opts.idempotencyKey : newIdempotencyKey();
    const result = await client.markLessonPaid(
      lessonId,
      paidAt ? { paid_at: paidAt } : {},
      { ifMatch, idempotencyKey: key },
    );
    if (g.json) printJson({ ok: true, data: result.lesson, idempotency_key: key });
    else {
      info(
        `Marked lesson #${result.lesson.id} paid` +
          (result.lesson.paid_at ? ` at ${formatPacific(result.lesson.paid_at)}` : '') +
          '.',
        g,
      );
    }
  });

// --------------------------------------------------------------- athletes

const athletes = program.command('athletes').description('Search and create athletes.');

athletes
  .command('search')
  .description(
    'Search athletes by name (step 1 of the two-step write flow). More than one match is ' +
      'the ATHLETE_AMBIGUOUS condition — pick one explicitly before writing.',
  )
  .argument('<query>', 'Name or partial name.')
  .option(
    '--require-one',
    'Exit non-zero (5, ATHLETE_AMBIGUOUS) unless exactly one athlete matches. ' +
      'Use this when scripting a write.',
    false,
  )
  .action(async (query: string, opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);

    if (opts.requireOne) {
      const athlete = await requireSingleAthlete(client, query);
      if (g.json) printJson({ ok: true, data: athlete });
      else info(`${athlete.id}\t${athlete.name}`, g);
      return;
    }

    const results = (await client.searchAthletes(query)).map(toCandidate);
    if (g.json) {
      printJson({
        ok: true,
        count: results.length,
        ambiguous: results.length > 1,
        data: results,
      });
      return;
    }
    if (results.length === 0) {
      info(`No athlete matches "${query}".`, g);
      return;
    }
    info(
      table(
        ['ID', 'NAME', 'WAIVER', 'MEMBERSHIP'],
        results.map((a) => [
          a.id,
          a.name,
          a.waiver_signed === undefined ? null : a.waiver_signed ? 'signed' : 'no',
          a.membership_status ?? null,
        ]),
      ),
      g,
    );
    if (results.length > 1) {
      warn(
        `\nATHLETE_AMBIGUOUS: "${query}" matched ${results.length} athletes. ` +
          'Choose one id explicitly — a write never guesses an identity.',
      );
    }
  });

athletes
  .command('create')
  .description(
    'Create an athlete. Requires athletes:create. `waiver_signed` cannot be set through ' +
      'any scope — waiver status is read-only across the whole API.',
  )
  .requiredOption('--first-name <name>')
  .requiredOption('--last-name <name>')
  .option('--membership-status <status>', 'unknown | member | not_member')
  .option('--notes <text>', 'Admin/Management only; ignored for Coach/Staff tokens.')
  .option('--dry-run', 'Search for possible duplicates without creating anything.', false)
  .option('--idempotency-key <key>', 'Supply your own key; one is generated otherwise.')
  .action(async (opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const fullName = `${opts.firstName} ${opts.lastName}`.trim();

    if (opts.dryRun) {
      const existing = (await client.searchAthletes(fullName)).map(toCandidate);
      if (g.json) {
        printJson({ ok: true, dry_run: true, would_create: fullName, possible_duplicates: existing });
      } else {
        info(`Dry run — nothing was written. Would create "${fullName}".`, g);
        if (existing.length > 0) {
          warn(`${existing.length} existing athlete(s) already match that name:`);
          info(table(['ID', 'NAME'], existing.map((a) => [a.id, a.name])), g);
        } else {
          info('No existing athlete matches that name.', g);
        }
      }
      return;
    }

    const membership = opts.membershipStatus as string | undefined;
    if (membership && !['unknown', 'member', 'not_member'].includes(membership)) {
      throw new PrivateLessonsError('USAGE_ERROR', `Invalid membership status "${membership}".`, {
        detail: 'membership-status must be one of: unknown, member, not_member.',
      });
    }

    const body: Record<string, unknown> = {
      first_name: String(opts.firstName),
      last_name: String(opts.lastName),
    };
    if (membership) body.membership_status = membership;
    if (opts.notes !== undefined) body.notes = opts.notes;

    const key = typeof opts.idempotencyKey === 'string' ? opts.idempotencyKey : newIdempotencyKey();
    const athlete = await client.createAthlete(
      body as Parameters<typeof client.createAthlete>[0],
      { idempotencyKey: key },
    );
    if (g.json) printJson({ ok: true, data: athlete, idempotency_key: key });
    else info(`Created athlete #${(athlete as { id: number }).id} ${athleteName(athlete)}.`, g);
  });

// ----------------------------------------------------------- availability

program
  .command('availability')
  .description('Show bookable windows for a coach on one Pacific calendar date.')
  .requiredOption('--date <date>', 'YYYY-MM-DD, interpreted in Pacific.')
  .option('--duration <minutes>', `One of ${DURATION_MINUTES.join(', ')}.`, '60')
  .option('--coach <id>', 'Coach user id. Coach/Staff default to their own schedule.')
  .action(async (opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const query: { date: string; duration: DurationMinutes; coach?: number } = {
      date: assertCalendarDate(String(opts.date)),
      duration: parseDuration(String(opts.duration)),
    };
    if (opts.coach) query.coach = Number(opts.coach);

    const availability = await client.getAvailability(query);
    if (g.json) {
      printJson({ ok: true, data: availability });
      return;
    }
    info(
      `${availability.date} — ${availability.coach_name ?? `coach #${availability.coach_id}`}, ` +
        `${availability.duration_minutes}m slots, business hours ` +
        `${availability.business_hours.start}-${availability.business_hours.end} ` +
        `${availability.timezone}`,
      g,
    );
    if (availability.slots.length === 0) {
      info('No bookable windows.', g);
      return;
    }
    info(
      table(
        ['START', 'END', 'LATE?'],
        availability.slots.map((s) => [
          formatPacific(s.start),
          formatPacific(s.end),
          s.is_late_booking ? 'LATE' : '',
        ]),
      ),
      g,
    );
  });

// ---------------------------------------------------------------- balance

program
  .command('balance')
  .description(
    'Show unpaid facility and platform fees coaches owe the gym (not money families owe coaches). ' +
      'Requires balances:read.',
  )
  .option('--coach <id>', 'Filter to one coach.')
  .action(async (opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);
    const all = await client.listBalances();
    const balances = opts.coach
      ? all.filter((b) => b.coach_id === Number(opts.coach))
      : all;
    if (g.json) {
      printJson({ ok: true, count: balances.length, data: balances });
      return;
    }
    if (balances.length === 0) {
      info('No balances.', g);
      return;
    }
    info(
      table(
        ['COACH', 'FACILITY $', 'PLATFORM $', 'OWES GYM $ (TOTAL)', 'UNPAID LESSONS'],
        balances.map((b) => [
          b.coach_name ?? `#${b.coach_id}`,
          (b.unpaid_cents / 100).toFixed(2),
          (b.unpaid_platform_fee_cents / 100).toFixed(2),
          (b.unpaid_total_cents / 100).toFixed(2),
          b.unpaid_lesson_count,
        ]),
      ),
      g,
    );
  });

// ------------------------------------------------------------------ audit

program
  .command('audit')
  .description(
    'Show the append-only audit log, newest first. Requires audit:read AND an Admin role.',
  )
  .option('--limit <n>', 'Events per page (default 50, max 200).')
  .option('--cursor <cursor>', 'Opaque cursor from a previous next_cursor. Pass verbatim.')
  .option('--all', 'Follow next_cursor until the log is exhausted.', false)
  .action(async (opts, command: Command) => {
    const g = globals(command);
    const { client } = await session(command);

    const query: { limit?: number; cursor?: string } = {};
    if (opts.limit !== undefined) query.limit = Number(opts.limit);
    if (opts.cursor !== undefined) query.cursor = String(opts.cursor);

    let page = await client.listAuditEvents(query);
    const events = [...page.events];
    while (opts.all && page.meta.has_more && page.meta.next_cursor) {
      const next: { limit?: number; cursor: string } = { cursor: page.meta.next_cursor };
      if (query.limit !== undefined) next.limit = query.limit;
      page = await client.listAuditEvents(next);
      events.push(...page.events);
    }

    if (g.json) {
      printJson({ ok: true, data: events, meta: page.meta });
      return;
    }
    if (events.length === 0) {
      info('No audit events.', g);
      return;
    }
    info(
      table(
        ['WHEN (Pacific)', 'ACTION', 'SUBJECT', 'SOURCE', 'ACTOR', 'REQUEST ID'],
        events.map((e) => [
          formatPacific(e.created_at),
          e.action,
          `${e.auditable_type}#${e.auditable_id ?? '—'}`,
          e.source,
          e.actor_id ?? null,
          e.request_id ?? null,
        ]),
      ),
      g,
    );
    if (page.meta.has_more) {
      warn(`\nMore events available. Next: --cursor ${page.meta.next_cursor}`);
    }
  });

// ----------------------------------------------------------------- driver

function emit(error: PrivateLessonsError): void {
  // The root options are not parsed yet when a usage error fires, so fall back to argv.
  const wantsJson = process.argv.includes('--json');
  if (wantsJson) printJson(error.toJSON());
  else process.stderr.write(`${error.toDisplayString()}\n`);
  process.exitCode = error.exitCode;
}

function isCommanderError(err: unknown): err is { code: string; exitCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('commander.')
  );
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isCommanderError(err)) {
      process.exitCode = err.exitCode === 0 ? EXIT_CODES.OK : EXIT_CODES.USAGE_ERROR;
      return;
    }
    if (err instanceof Rfc3339FormatError) {
      emit(new PrivateLessonsError('VALIDATION_FAILED', err.message, { detail: err.message }));
      return;
    }
    emit(toPrivateLessonsError(err));
  }
}

void main();
