import { describe, expect, it } from 'vitest';

import {
  coachSurchargeReasonText,
  lessonOwedCents,
  normalizeBalance,
  normalizeQuote,
  platformFeeCents,
} from '../src/core/fees.js';

const balance = {
  coach_id: 7,
  coach_name: 'Dana Smith',
  unpaid_cents: 6000,
  currency: 'USD' as const,
  unpaid_lesson_count: 3,
};

describe('platformFeeCents', () => {
  it('reads the fee when present', () => {
    expect(platformFeeCents({ platform_fee_cents: 100 })).toBe(100);
    expect(platformFeeCents({ platform_fee_cents: 0 })).toBe(0);
  });

  it('is 0 when the API omits the field or sends something that is not a number', () => {
    expect(platformFeeCents({})).toBe(0);
    expect(platformFeeCents({ platform_fee_cents: null })).toBe(0);
    expect(platformFeeCents({ platform_fee_cents: Number.NaN })).toBe(0);
    expect(platformFeeCents({ platform_fee_cents: '100' as unknown as number })).toBe(0);
  });
});

describe('lessonOwedCents', () => {
  it('adds the platform fee to the facility fee', () => {
    expect(lessonOwedCents({ effective_cost_cents: 2000, platform_fee_cents: 100 })).toBe(2100);
  });

  it('is the facility fee alone when the platform fee is missing', () => {
    expect(lessonOwedCents({ effective_cost_cents: 2000 })).toBe(2000);
  });
});

describe('normalizeBalance', () => {
  it('keeps values the API sent', () => {
    expect(
      normalizeBalance({ ...balance, unpaid_platform_fee_cents: 300, unpaid_total_cents: 6300 }),
    ).toMatchObject({ unpaid_platform_fee_cents: 300, unpaid_total_cents: 6300 });
  });

  it('fills both fields from unpaid_cents when the API sends neither', () => {
    expect(normalizeBalance(balance)).toMatchObject({
      unpaid_cents: 6000,
      unpaid_platform_fee_cents: 0,
      unpaid_total_cents: 6000,
    });
  });

  it('derives the total from the platform fee when only the total is missing', () => {
    expect(normalizeBalance({ ...balance, unpaid_platform_fee_cents: 300 })).toMatchObject({
      unpaid_platform_fee_cents: 300,
      unpaid_total_cents: 6300,
    });
  });

  it('does not mutate its input', () => {
    const input = { ...balance };
    normalizeBalance(input);
    expect(input).toEqual(balance);
  });
});

const oldQuote = {
  duration_minutes: 60 as const,
  athlete_ids: [13],
  scheduled_at: '2026-10-06T14:00:00-07:00',
  is_member: false,
  is_late_booking: false,
  cost_cents: 3000,
  currency: 'USD' as const,
  hourly_rate_cents: 3000,
  late_multiplier_applied: false,
  breakdown: '60 minutes at $30.00/hour (non-member rate) = $30.00.',
  quoted_at: '2026-09-29T09:29:55-07:00',
  advisory: true as const,
};

describe('normalizeQuote', () => {
  it('keeps the coach-surcharge fields the API sent', () => {
    expect(
      normalizeQuote({
        ...oldQuote,
        cost_cents: 6000,
        platform_fee_cents: 100,
        coach_id: 9,
        multiplier: 2,
        coach_surcharge_applied: true,
        coach_surcharge_reason: 'non_class_coach',
      }),
    ).toMatchObject({
      cost_cents: 6000,
      platform_fee_cents: 100,
      coach_id: 9,
      multiplier: 2,
      coach_surcharge_applied: true,
      coach_surcharge_reason: 'non_class_coach',
    });
  });

  it('is null, not false or 1, for every coach-surcharge field an older API omits', () => {
    expect(normalizeQuote(oldQuote)).toMatchObject({
      cost_cents: 3000,
      platform_fee_cents: 0,
      coach_id: null,
      multiplier: null,
      coach_surcharge_applied: null,
      coach_surcharge_reason: null,
    });
  });

  it('keeps a false surcharge distinct from a missing one', () => {
    expect(
      normalizeQuote({
        ...oldQuote,
        coach_id: 7,
        multiplier: 1,
        coach_surcharge_applied: false,
        coach_surcharge_reason: null,
      }),
    ).toMatchObject({ coach_surcharge_applied: false, multiplier: 1 });
  });
});

describe('coachSurchargeReasonText', () => {
  it('words both reasons and passes an unknown one through', () => {
    expect(coachSurchargeReasonText('non_class_coach')).toBe(
      'the coach does not regularly coach classes',
    );
    expect(coachSurchargeReasonText('saturday')).toBe(
      'Saturday, and the coach does not regularly work Saturdays',
    );
    expect(coachSurchargeReasonText('holiday')).toBe('holiday');
    expect(coachSurchargeReasonText(null)).toBe('reason not given');
  });
});
