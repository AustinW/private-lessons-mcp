/**
 * End-to-end tests of the MCP server over the SDK's in-memory transport: a real MCP
 * client talks to the real server, which talks to the mock HTTP layer.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { ScorSyncClient } from '../src/core/client.js';
import { buildServer, TOOL_NAMES } from '../src/mcp/server.js';
import { makeAthlete, makeLesson, MockApi, problem } from './helpers/mock-api.js';

async function connect(api: MockApi): Promise<Client> {
  const server = buildServer({
    client: new ScorSyncClient({ baseUrl: api.baseUrl, token: 'test-token', fetch: api.fetch }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

interface CallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ raw: CallResult; json: Record<string, unknown> }> {
  const raw = (await client.callTool({ name, arguments: args })) as unknown as CallResult;
  const text = raw.content[0]?.text ?? '{}';
  return { raw, json: JSON.parse(text) as Record<string, unknown> };
}

function fullApi(): MockApi {
  return new MockApi()
    .on('GET /lessons', () => ({ body: { data: [makeLesson()] } }))
    .on('GET /lessons/{id}', () => ({
      body: { data: makeLesson({ version: 3 }) },
      headers: { etag: '"lesson-42-v3"' },
    }))
    .on('POST /lessons', () => ({
      status: 201,
      body: { data: makeLesson({ id: 43, version: 1 }) },
      headers: { etag: '"lesson-43-v1"' },
    }))
    .on('PATCH /lessons/{id}', () => ({
      body: { data: makeLesson({ version: 4 }) },
      headers: { etag: '"lesson-42-v4"' },
    }))
    .on('POST /lessons/{id}/cancel', () => ({
      body: { data: makeLesson({ version: 4, cancelled_at: '2026-07-21T10:00:00-07:00' }) },
      headers: { etag: '"lesson-42-v4"' },
    }))
    .on('POST /lessons/{id}/mark-paid', () => ({
      body: { data: makeLesson({ version: 4, paid_at: '2026-07-21T10:00:00-07:00' }) },
      headers: { etag: '"lesson-42-v4"' },
    }))
    .on('GET /athletes', () => ({ body: { data: [makeAthlete(101, 'Ada Lovelace')] } }))
    .on('POST /athletes', () => ({ status: 201, body: { data: makeAthlete(102, 'Alan Turing') } }))
    .on('GET /availability', () => ({
      body: {
        data: {
          date: '2026-08-04',
          coach_id: 7,
          coach_name: 'Dana Smith',
          duration_minutes: 60,
          timezone: 'America/Los_Angeles',
          business_hours: { start: '07:00', end: '22:00' },
          slots: [
            { start: '2026-08-04T13:00:00-07:00', end: '2026-08-04T17:00:00-07:00', is_late_booking: false },
          ],
        },
      },
    }))
    .on('GET /pricing-quotes', () => ({
      body: {
        data: {
          duration_minutes: 60,
          athlete_ids: [101],
          scheduled_at: '2026-08-04T14:00:00-07:00',
          is_member: true,
          is_late_booking: false,
          cost_cents: 2000,
          currency: 'USD',
          hourly_rate_cents: 2000,
          late_multiplier_applied: false,
          breakdown: '60 minutes at the member rate.',
          quoted_at: '2026-07-21T10:00:00-07:00',
          advisory: true,
        },
      },
    }))
    .on('GET /balances', () => ({
      body: {
        data: [
          { coach_id: 7, coach_name: 'Dana Smith', unpaid_cents: 6000, currency: 'USD', unpaid_lesson_count: 3 },
        ],
      },
    }))
    .on('GET /audit-events', () => ({
      body: { data: [], meta: { limit: 50, has_more: false, next_cursor: null } },
    }));
}

describe('tool surface', () => {
  let client: Client;

  beforeEach(async () => {
    client = await connect(fullApi());
  });

  it('exposes exactly the 12 specified tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(12);
  });

  it('exposes NO generic HTTP escape hatch', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of names) {
      expect(name).not.toMatch(/request|http|fetch|call_api|raw|proxy|query_api/i);
    }
  });

  it('exposes NO token-management tool — minting a token is impossible by design', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of names) {
      expect(name).not.toMatch(/token|auth|credential|login|secret|key/i);
    }
  });

  it('declares side effects in the description of every mutation tool', async () => {
    const tools = (await client.listTools()).tools;
    const mutations = [
      'scorsync_create_lesson',
      'scorsync_update_lesson',
      'scorsync_cancel_lesson',
      'scorsync_mark_lesson_paid',
      'scorsync_create_athlete',
    ];
    for (const name of mutations) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.description, name).toMatch(/SIDE EFFECT/);
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
    }
  });

  it('offers a dry run on every mutation tool', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of [
      'scorsync_create_lesson',
      'scorsync_update_lesson',
      'scorsync_cancel_lesson',
      'scorsync_mark_lesson_paid',
      'scorsync_create_athlete',
    ]) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as {
        properties?: Record<string, unknown>;
      };
      expect(Object.keys(schema.properties ?? {}), name).toContain('dry_run');
    }
  });

  it('marks the two destructive tools as destructive', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['scorsync_cancel_lesson', 'scorsync_mark_lesson_paid']) {
      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
    }
  });

  it('has no athlete-name field on any write tool', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['scorsync_create_lesson', 'scorsync_update_lesson']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as {
        properties?: Record<string, unknown>;
      };
      const properties = Object.keys(schema.properties ?? {});
      expect(properties, name).toContain('athlete_ids');
      expect(properties, name).not.toContain('athlete_name');
      expect(properties, name).not.toContain('athlete_names');
      expect(properties, name).not.toContain('student_name');
    }
  });

  it('instructs the caller through the two-step athlete flow in the tool descriptions', async () => {
    const tools = (await client.listTools()).tools;
    const search = tools.find((t) => t.name === 'scorsync_search_athletes');
    expect(search?.description).toMatch(/ATHLETE_AMBIGUOUS/);
    expect(search?.description).toMatch(/ask the user/i);
    expect(search?.description).toMatch(/Do not pick the first/i);

    const create = tools.find((t) => t.name === 'scorsync_create_lesson');
    expect(create?.description).toMatch(/scorsync_search_athletes/);
    expect(create?.description).toMatch(/never guess/i);
    expect(create?.description).toMatch(/no name field/i);
  });
});

describe('dry runs write nothing', () => {
  it('scorsync_create_lesson dry run only reads', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_create_lesson', {
      coach_id: 7,
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration_minutes: 60,
      fee_acknowledged: true,
      dry_run: true,
    });

    expect(json.dry_run).toBe(true);
    expect(json.quote).toMatchObject({ cost_cents: 2000, advisory: true });
    expect((json.availability as Record<string, unknown>).window_is_bookable).toBe(true);
    expect(json.scheduled_at_pacific).toContain('Aug 4, 2026');

    expect(api.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(api.requestsFor('POST', '/lessons')).toHaveLength(0);
  });

  it('scorsync_cancel_lesson dry run only reads and shows the Pacific time', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_cancel_lesson', {
      lesson_id: 42,
      dry_run: true,
    });

    expect(json.dry_run).toBe(true);
    expect(json.when_pacific).toContain('Aug 4, 2026');
    expect(json.if_match_to_use).toBe('"lesson-42-v3"');
    expect(api.requestsFor('POST', '/lessons/42/cancel')).toHaveLength(0);
  });

  it('scorsync_mark_lesson_paid dry run reports the amount and writes nothing', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_mark_lesson_paid', {
      lesson_id: 42,
      dry_run: true,
    });

    expect(json.dry_run).toBe(true);
    expect(json.amount_owed_cents).toBe(2000);
    expect(json.already_paid).toBe(false);
    expect(api.requestsFor('POST', '/lessons/42/mark-paid')).toHaveLength(0);
  });

  it('scorsync_create_athlete dry run surfaces possible duplicates', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_create_athlete', {
      first_name: 'Ada',
      last_name: 'Lovelace',
      dry_run: true,
    });

    expect(json.dry_run).toBe(true);
    expect(json.possible_duplicates).toHaveLength(1);
    expect(json.warnings).toHaveLength(1);
    expect(api.requestsFor('POST', '/athletes')).toHaveLength(0);
  });

  it('flags a late booking in the create dry run', async () => {
    const api = fullApi().on('GET /pricing-quotes', () => ({
      body: {
        data: {
          duration_minutes: 60,
          athlete_ids: [101],
          scheduled_at: '2026-08-04T14:00:00-07:00',
          is_member: false,
          is_late_booking: true,
          cost_cents: 4000,
          currency: 'USD',
          hourly_rate_cents: 2000,
          late_multiplier_applied: true,
          breakdown: 'Late booking, non-member rate.',
          quoted_at: '2026-07-21T10:00:00-07:00',
          advisory: true,
        },
      },
    }));
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_create_lesson', {
      coach_id: 7,
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration_minutes: 60,
      fee_acknowledged: true,
      dry_run: true,
    });
    const warnings = json.warnings as string[];
    expect(warnings.some((w) => w.includes('LATE BOOKING'))).toBe(true);
    expect(warnings.some((w) => w.includes('LATE_BOOKING_ACK_REQUIRED'))).toBe(true);
  });
});

describe('the two-step athlete flow through the tools', () => {
  it('reports ATHLETE_AMBIGUOUS as a successful result with candidates, not an error', async () => {
    const api = fullApi().on('GET /athletes', () => ({
      status: 200,
      body: { data: [makeAthlete(1, 'Ada Smith'), makeAthlete(2, 'Alan Smith')] },
    }));
    const client = await connect(api);
    const { raw, json } = await call(client, 'scorsync_search_athletes', { query: 'Smith' });

    expect(raw.isError).toBeFalsy();
    expect(json.status).toBe('ambiguous');
    expect(json.code).toBe('ATHLETE_AMBIGUOUS');
    expect(json.candidates).toHaveLength(2);
    expect(json.next_step).toMatch(/Ask the user/);
    expect(json.next_step).toMatch(/Do NOT guess/);
  });

  it('hands back a single id with the next step spelled out', async () => {
    const client = await connect(fullApi());
    const { json } = await call(client, 'scorsync_search_athletes', { query: 'Ada' });
    expect(json.status).toBe('resolved');
    expect(json.next_step).toContain('athlete_ids: [101]');
  });

  it('reports a zero match without inventing an athlete', async () => {
    const api = fullApi().on('GET /athletes', () => ({ body: { data: [] } }));
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_search_athletes', { query: 'Nobody' });
    expect(json.status).toBe('not_found');
    expect(api.requestsFor('POST', '/athletes')).toHaveLength(0);
  });
});

describe('writes', () => {
  it('sends a generated Idempotency-Key on create', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_create_lesson', {
      coach_id: 7,
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration_minutes: 60,
      fee_acknowledged: true,
    });
    expect(json.created).toBe(true);
    expect(api.requestsFor('POST', '/lessons')[0]?.headers['idempotency-key']).toBeTruthy();
  });

  it('uses a caller-supplied if_match verbatim on cancel', async () => {
    const api = fullApi();
    const client = await connect(api);
    await call(client, 'scorsync_cancel_lesson', {
      lesson_id: 42,
      if_match: '"lesson-42-v3"',
      reason: 'family cancelled',
    });
    expect(api.requestsFor('POST', '/lessons/42/cancel')[0]?.headers['if-match']).toBe(
      '"lesson-42-v3"',
    );
  });

  it('warns when it had to fetch the ETag itself', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { json } = await call(client, 'scorsync_update_lesson', {
      lesson_id: 42,
      notes: 'updated',
    });
    expect(json.updated).toBe(true);
    expect(String(json.warning)).toContain('No if_match was supplied');
  });

  it('rejects a weak or wildcard if_match', async () => {
    const client = await connect(fullApi());
    for (const bad of ['W/"lesson-42-v3"', '*']) {
      const { raw, json } = await call(client, 'scorsync_update_lesson', {
        lesson_id: 42,
        notes: 'x',
        if_match: bad,
      });
      expect(raw.isError).toBe(true);
      expect(json.code).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses an empty PATCH rather than bumping the version for nothing', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { raw, json } = await call(client, 'scorsync_update_lesson', { lesson_id: 42 });
    expect(raw.isError).toBe(true);
    expect(json.code).toBe('VALIDATION_FAILED');
    expect(api.requestsFor('PATCH', '/lessons/42')).toHaveLength(0);
  });

  it('distinguishes an absent field from an explicit null on PATCH', async () => {
    const api = fullApi();
    const client = await connect(api);
    await call(client, 'scorsync_update_lesson', {
      lesson_id: 42,
      notes: null,
      if_match: '"lesson-42-v3"',
    });
    const body = api.requestsFor('PATCH', '/lessons/42')[0]?.body as Record<string, unknown>;
    expect(body).toHaveProperty('notes', null);
    expect(body).not.toHaveProperty('observer');
  });

  it('surfaces a 412 VERSION_MISMATCH as a tool error carrying current_version', async () => {
    const api = fullApi().on('PATCH /lessons/{id}', () =>
      problem(412, 'VERSION_MISMATCH', 'stale', { current_version: 5 }),
    );
    const client = await connect(api);
    const { raw, json } = await call(client, 'scorsync_update_lesson', {
      lesson_id: 42,
      notes: 'x',
      if_match: '"lesson-42-v3"',
    });
    expect(raw.isError).toBe(true);
    expect(json.code).toBe('VERSION_MISMATCH');
    expect(json.current_version).toBe(5);
    expect(json.exit_code).toBe(9);
  });

  it('rejects a naive timestamp without contacting the API', async () => {
    const api = fullApi();
    const client = await connect(api);
    const { raw, json } = await call(client, 'scorsync_create_lesson', {
      coach_id: 7,
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00',
      duration_minutes: 60,
      fee_acknowledged: true,
    });
    expect(raw.isError).toBe(true);
    expect(String(json.detail)).toContain('explicit UTC offset');
    expect(api.requestsFor('POST', '/lessons')).toHaveLength(0);
  });
});

describe('reads', () => {
  it('renders every timestamp in Pacific alongside the machine form', async () => {
    const client = await connect(fullApi());
    const { json } = await call(client, 'scorsync_list_lessons', {});
    const lessons = json.lessons as Array<Record<string, unknown>>;
    expect(lessons[0]?.scheduled_at).toBe('2026-08-04T14:00:00-07:00');
    expect(String(lessons[0]?.scheduled_at_pacific)).toContain('Aug 4, 2026');
    expect(json.timezone).toBe('America/Los_Angeles');
  });

  it('labels the quote as advisory and never computes a fee itself', async () => {
    const client = await connect(fullApi());
    const { json } = await call(client, 'scorsync_get_quote', {
      athlete_ids: [101],
      scheduled_at: '2026-08-04T14:00:00-07:00',
      duration: 60,
    });
    expect(json.advisory).toBe(true);
    expect(json.cost_cents).toBe(2000);
    expect(String(json.reminder)).toContain('recalculated server-side');
  });

  it('explains what a balance means', async () => {
    const client = await connect(fullApi());
    const { json } = await call(client, 'scorsync_get_balance', {});
    expect(String(json.meaning)).toContain('coach owes the gym');
  });

  it('surfaces a 403 FORBIDDEN from the audit endpoint as a tool error', async () => {
    const api = fullApi().on('GET /audit-events', () =>
      problem(403, 'FORBIDDEN', 'You do not have permission to perform this action.'),
    );
    const client = await connect(api);
    const { raw, json } = await call(client, 'scorsync_list_audit_events', {});
    expect(raw.isError).toBe(true);
    expect(json.code).toBe('FORBIDDEN');
    expect(json.request_id).toBeTruthy();
  });
});
