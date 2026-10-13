/**
 * Fee-field fallbacks.
 *
 * The contract marks `platform_fee_cents` (lesson, quote), `unpaid_platform_fee_cents`
 * and `unpaid_total_cents` (balance) as required, but this client can be upgraded before
 * the API that sends them is deployed. Every read of those fields goes through here so
 * a missing value degrades to the old facility-only amounts instead of `NaN`.
 *
 *  - missing `platform_fee_cents` / `unpaid_platform_fee_cents` is 0;
 *  - missing `unpaid_total_cents` is `unpaid_cents + unpaid_platform_fee_cents`.
 *
 * The same holds for the quote's coach-surcharge fields (`coach_id`, `multiplier`,
 * `coach_surcharge_applied`, `coach_surcharge_reason`). An API without them also ignores
 * the `coach` parameter and leaves the coach surcharge out of `cost_cents`, so a missing
 * value is `null` ("the API did not say"), never a guessed `false` or `1`.
 */

import type { Balance, Lesson, PricingQuote } from './client.js';

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface HasPlatformFee {
  platform_fee_cents?: number | null;
}

/** The platform fee on a lesson or quote, in cents; 0 when the API omits it. */
export function platformFeeCents(item: HasPlatformFee): number {
  return finiteOrNull(item.platform_fee_cents) ?? 0;
}

/** What the coach owes for a lesson: facility fee (after override/waiver) + platform fee. */
export function lessonOwedCents(
  lesson: Pick<Lesson, 'effective_cost_cents'> & HasPlatformFee,
): number {
  return lesson.effective_cost_cents + platformFeeCents(lesson);
}

type BalanceInput = Omit<Balance, 'unpaid_platform_fee_cents' | 'unpaid_total_cents'> & {
  unpaid_platform_fee_cents?: number | null;
  unpaid_total_cents?: number | null;
};

/** A balance row with both platform-fee fields filled in, whatever the API sent. */
export function normalizeBalance(balance: BalanceInput): Balance {
  const unpaidPlatformFeeCents = finiteOrNull(balance.unpaid_platform_fee_cents) ?? 0;
  return {
    ...balance,
    unpaid_platform_fee_cents: unpaidPlatformFeeCents,
    unpaid_total_cents:
      finiteOrNull(balance.unpaid_total_cents) ?? balance.unpaid_cents + unpaidPlatformFeeCents,
  };
}

type CoachSurchargeField =
  | 'coach_id'
  | 'multiplier'
  | 'coach_surcharge_applied'
  | 'coach_surcharge_reason';

type QuoteInput = Omit<PricingQuote, CoachSurchargeField | 'platform_fee_cents'> & {
  platform_fee_cents?: number | null;
  coach_id?: number | null;
  multiplier?: number | null;
  coach_surcharge_applied?: boolean | null;
  coach_surcharge_reason?: string | null;
};

/** A quote with every fee field filled in; `null` means the API did not send it. */
export type Quote = Omit<PricingQuote, CoachSurchargeField> & {
  coach_id: number | null;
  multiplier: number | null;
  /** `null` when the API is too old to report the coach surcharge. */
  coach_surcharge_applied: boolean | null;
  /** `non_class_coach` or `saturday` today; passed through as sent. */
  coach_surcharge_reason: string | null;
};

/** A quote with the platform fee and coach-surcharge fields filled in, whatever the API sent. */
export function normalizeQuote(quote: QuoteInput): Quote {
  return {
    ...quote,
    platform_fee_cents: platformFeeCents(quote),
    coach_id: finiteOrNull(quote.coach_id),
    multiplier: finiteOrNull(quote.multiplier),
    coach_surcharge_applied:
      typeof quote.coach_surcharge_applied === 'boolean' ? quote.coach_surcharge_applied : null,
    coach_surcharge_reason:
      typeof quote.coach_surcharge_reason === 'string' ? quote.coach_surcharge_reason : null,
  };
}

/** Why the coach surcharge applies, in words. */
export function coachSurchargeReasonText(reason: string | null): string {
  switch (reason) {
    case 'non_class_coach':
      return 'the coach does not regularly coach classes';
    case 'saturday':
      return 'Saturday, and the coach does not regularly work Saturdays';
    case null:
      return 'reason not given';
    default:
      return reason;
  }
}

/** Warning for a quote from an API that does not report the coach surcharge. */
export const COACH_SURCHARGE_UNKNOWN =
  'This API does not report the coach surcharge, so the quoted fee may be too low: it ' +
  'prices the token owner, not the requested coach, and leaves out the coach surcharge (the ' +
  'fee is multiplied when the coach does not regularly coach classes, or on a Saturday when ' +
  'the coach does not work Saturdays).';
