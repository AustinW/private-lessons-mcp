/**
 * Dry-run preflight for the mutating paths.
 *
 * Every mutation tool/command supports a dry run that answers "what would this cost and
 * would it be accepted?" using only read endpoints — `GET /pricing-quotes` and
 * `GET /availability`. Nothing is written.
 *
 * Two honesty constraints are baked in:
 *
 *  - The quote is **advisory**. `GET /pricing-quotes` says so in its own payload
 *    (`advisory: true`), because membership can change and `is_late_booking` flips once
 *    the scheduled time passes. The fee is always recalculated server-side at create
 *    time and no quote token exists to expire. This client never caches a quote, never
 *    sends one back, and never hardcodes a rate.
 *  - The availability check is a **preview**, not the server's conflict check. The
 *    authoritative check happens inside the create/update transaction and can still
 *    return `409 SLOT_CONFLICT` if something is booked in between.
 */

import type { Availability, DurationMinutes, PricingQuote, PrivateLessonsClient } from './client.js';
import { formatPacific, pacificDate, parseRfc3339, TENANT_TIMEZONE } from './time.js';

export interface PreflightInput {
  coachId: number;
  athleteIds: number[];
  scheduledAt: string;
  durationMinutes: DurationMinutes;
  /**
   * When rescheduling, the lesson being moved. `GET /availability` cannot know to
   * exclude it, so its own current window shows as busy; this is reported, not hidden.
   */
  excludeLessonId?: number;
}

export interface PreflightResult {
  scheduled_at: string;
  scheduled_at_pacific: string;
  ends_at_pacific: string;
  timezone: typeof TENANT_TIMEZONE;
  duration_minutes: DurationMinutes;
  coach_id: number;
  athlete_ids: number[];
  /** Advisory server-computed fee. Never trusted as the source of truth. */
  quote: PricingQuote | null;
  quote_error: string | null;
  availability: {
    checked: boolean;
    /** `true` when the requested window fits entirely inside a bookable slot. */
    window_is_bookable: boolean | null;
    slots_on_date: number;
    business_hours: Availability['business_hours'] | null;
    error: string | null;
  };
  /** Human-readable warnings the caller should read before committing. */
  warnings: string[];
  notes: string[];
}

const MINUTE_MS = 60_000;

/** Does `[start, start+duration]` fit entirely inside one of the bookable slots? */
export function windowIsBookable(
  availability: Availability,
  scheduledAt: string,
  durationMinutes: number,
): boolean {
  const start = parseRfc3339(scheduledAt).getTime();
  const end = start + durationMinutes * MINUTE_MS;
  return availability.slots.some((slot) => {
    const slotStart = parseRfc3339(slot.start).getTime();
    const slotEnd = parseRfc3339(slot.end).getTime();
    return slotStart <= start && end <= slotEnd;
  });
}

/**
 * Run the read-only checks a write would be subject to.
 *
 * Never throws for a failed sub-check: a preflight that blows up is less useful than
 * one that reports which half it could not verify. Errors that mean "your input is
 * wrong" (a naive timestamp, say) still propagate — those are not check failures.
 */
export async function preflightLesson(
  client: PrivateLessonsClient,
  input: PreflightInput,
): Promise<PreflightResult> {
  const start = parseRfc3339(input.scheduledAt);
  const end = new Date(start.getTime() + input.durationMinutes * MINUTE_MS);

  const result: PreflightResult = {
    scheduled_at: input.scheduledAt,
    scheduled_at_pacific: formatPacific(start),
    ends_at_pacific: formatPacific(end),
    timezone: TENANT_TIMEZONE,
    duration_minutes: input.durationMinutes,
    coach_id: input.coachId,
    athlete_ids: input.athleteIds,
    quote: null,
    quote_error: null,
    availability: {
      checked: false,
      window_is_bookable: null,
      slots_on_date: 0,
      business_hours: null,
      error: null,
    },
    warnings: [],
    notes: [
      'Dry run: nothing was written.',
      'The quote is advisory — the server recalculates the fee at create time.',
      'Availability is a preview; the authoritative conflict check runs inside the write.',
    ],
  };

  const [quoteOutcome, availabilityOutcome] = await Promise.allSettled([
    client.getPricingQuote({
      duration: input.durationMinutes,
      athlete_ids: input.athleteIds,
      scheduled_at: input.scheduledAt,
    }),
    client.getAvailability({
      date: pacificDate(start),
      duration: input.durationMinutes,
      coach: input.coachId,
    }),
  ]);

  if (quoteOutcome.status === 'fulfilled') {
    result.quote = quoteOutcome.value;
    if (quoteOutcome.value.is_late_booking) {
      result.warnings.push(
        'This is a LATE BOOKING. `late_booking_acknowledged: true` is required, ' +
          'else the write fails with 422 LATE_BOOKING_ACK_REQUIRED.',
      );
    }
    if (!quoteOutcome.value.is_member) {
      result.warnings.push(
        'Not all athletes are enrolled members — the non-member rate applies.',
      );
    }
  } else {
    result.quote_error = describe(quoteOutcome.reason);
  }

  if (availabilityOutcome.status === 'fulfilled') {
    const availability = availabilityOutcome.value;
    const bookable = windowIsBookable(availability, input.scheduledAt, input.durationMinutes);
    result.availability = {
      checked: true,
      window_is_bookable: bookable,
      slots_on_date: availability.slots.length,
      business_hours: availability.business_hours,
      error: null,
    };
    if (!bookable) {
      if (input.excludeLessonId !== undefined) {
        result.warnings.push(
          `The requested window is not free according to GET /availability. Note that ` +
            `lesson ${input.excludeLessonId} (the one being rescheduled) occupies its own ` +
            'current window and is not excluded from that view, so this may be a false alarm ' +
            'if the new window overlaps the old one.',
        );
      } else {
        result.warnings.push(
          'The requested window is NOT inside a bookable slot for this coach — a real ' +
            'write would likely fail with 409 SLOT_CONFLICT or 422 OUTSIDE_BUSINESS_HOURS.',
        );
      }
    }
  } else {
    result.availability.error = describe(availabilityOutcome.reason);
  }

  return result;
}

function describe(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'toDisplayString' in reason) {
    return (reason as { toDisplayString(): string }).toDisplayString();
  }
  return reason instanceof Error ? reason.message : String(reason);
}
