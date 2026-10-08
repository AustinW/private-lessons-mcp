import { describe, expect, it } from 'vitest';

import { lessonOwedCents, normalizeBalance, platformFeeCents } from '../src/core/fees.js';

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
