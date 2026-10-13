/**
 * Platform-fee fallbacks.
 *
 * The contract marks `platform_fee_cents` (lesson, quote), `unpaid_platform_fee_cents`
 * and `unpaid_total_cents` (balance) as required, but this client can be upgraded before
 * the API that sends them is deployed. Every read of those fields goes through here so
 * a missing value degrades to the old facility-only amounts instead of `NaN`.
 *
 *  - missing `platform_fee_cents` / `unpaid_platform_fee_cents` is 0;
 *  - missing `unpaid_total_cents` is `unpaid_cents + unpaid_platform_fee_cents`.
 */

import type { Balance, Lesson } from './client.js';

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
