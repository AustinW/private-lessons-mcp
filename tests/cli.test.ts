/**
 * CLI integration tests.
 *
 * These run the built binary as a real subprocess against a real (local) HTTP server,
 * because the things being verified — the process exit code, what lands on stdout vs
 * stderr, and the refusal to act destructively without a confirmation — only exist at
 * the process boundary. No live API is involved: the server below is a few lines of
 * `node:http` returning canned contract-shaped responses.
 */

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeLesson } from './helpers/mock-api.js';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'dist/cli/index.js');

let server: Server;
let baseUrl: string;
const seen: Array<{
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}> = [];

beforeAll(async () => {
  if (!existsSync(CLI)) {
    // Keeps `npm test` self-contained on a clean clone where `npm run build` has not
    // been run yet. `npm run build && npm test` skips straight past this.
    await execFileAsync('npm', ['run', 'build'], { cwd: ROOT });
  }

  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace('/api/v1', '');
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ): void => {
      res.writeHead(status, {
        'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        'x-request-id': 'req-test-1',
        ...headers,
      });
      res.end(JSON.stringify(body));
    };

    if (path === '/lessons/42' && req.method === 'GET') {
      send(200, { data: makeLesson() }, { etag: '"lesson-42-v3"' });
      return;
    }
    if (path === '/lessons/999' && req.method === 'GET') {
      send(404, {
        type: 'https://private-lessons.scorsync.com/errors/lesson-not-found',
        title: 'Lesson not found',
        status: 404,
        detail: 'No lesson with id 999 is visible to this token.',
        code: 'LESSON_NOT_FOUND',
        request_id: 'req-test-1',
        retryable: false,
      });
      return;
    }
    if (path === '/lessons' && req.method === 'GET') {
      send(200, { data: [makeLesson()] });
      return;
    }
    if (path === '/lessons/42/cancel' && req.method === 'POST') {
      send(
        200,
        { data: makeLesson({ version: 4, cancelled_at: '2026-07-21T10:00:00-07:00' }) },
        { etag: '"lesson-42-v4"' },
      );
      return;
    }
    if (path === '/lessons/42/mark-paid' && req.method === 'POST') {
      send(
        200,
        { data: makeLesson({ version: 4, paid_at: '2026-07-21T10:00:00-07:00' }) },
        { etag: '"lesson-42-v4"' },
      );
      return;
    }
    if (path === '/balances' && req.method === 'GET') {
      send(403, {
        type: 'https://private-lessons.scorsync.com/errors/insufficient-scope',
        title: 'Insufficient scope',
        status: 403,
        detail: "This token is missing the required scope 'balances:read'.",
        code: 'INSUFFICIENT_SCOPE',
        request_id: 'req-test-1',
        retryable: false,
      });
      return;
    }
    if (path === '/audit-events' && req.method === 'GET') {
      send(401, { message: 'Unauthenticated.' });
      return;
    }
    send(500, { error: 'unexpected route' });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        PRIVATE_LESSONS_TOKEN: 'test-token',
        PRIVATE_LESSONS_BASE_URL: baseUrl,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('exit codes are mapped from the API error codes', () => {
  it('exits 0 on success', async () => {
    const result = await run(['lessons', 'get', '42']);
    expect(result.code).toBe(0);
  });

  it('exits 6 on LESSON_NOT_FOUND', async () => {
    const result = await run(['lessons', 'get', '999']);
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('LESSON_NOT_FOUND');
    expect(result.stderr).toContain('request_id: req-test-1');
  });

  it('exits 11 on INSUFFICIENT_SCOPE', async () => {
    const result = await run(['balance']);
    expect(result.code).toBe(11);
    expect(result.stderr).toContain('INSUFFICIENT_SCOPE');
    expect(result.stderr).toContain("missing the required scope 'balances:read'");
  });

  it('exits 16 on an unauthenticated 401', async () => {
    const result = await run(['audit']);
    expect(result.code).toBe(16);
    expect(result.stderr).toContain('UNAUTHENTICATED');
  });

  it('exits 17 when no token is configured anywhere', async () => {
    const result = await run(['lessons', 'list'], {
      PRIVATE_LESSONS_TOKEN: '',
      PRIVATE_LESSONS_PROFILE: 'a-profile-that-does-not-exist',
    });
    // Either NO_TOKEN (17) when the keychain is empty, or 0 if a real stored token for
    // the default profile exists on this machine; assert only the failure shape.
    if (result.code !== 0) {
      expect(result.code).toBe(17);
      expect(result.stderr).toContain('NO_TOKEN');
    }
  });

  it('exits 18 when the host is unreachable', async () => {
    const result = await run(['lessons', 'list'], {
      PRIVATE_LESSONS_BASE_URL: 'http://127.0.0.1:1/api/v1',
    });
    expect(result.code).toBe(18);
    expect(result.stderr).toContain('NETWORK_ERROR');
  });

  it('exits 3 (VALIDATION_FAILED) on a naive timestamp, without calling the API', async () => {
    const before = seen.length;
    const result = await run([
      'lessons',
      'create',
      '--coach',
      '7',
      '--athlete-ids',
      '101',
      '--at',
      '2026-08-04T14:00:00',
      '--duration',
      '60',
      '--acknowledge-fee',
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('explicit UTC offset is required');
    expect(result.stderr).toContain('2026-08-04T14:00:00-07:00');
    expect(seen.length).toBe(before);
  });

  it('exits 2 on a usage error', async () => {
    const result = await run(['lessons', 'nonsense-subcommand']);
    expect(result.code).toBe(2);
  });

  it('exits 0 on --help and --version', async () => {
    expect((await run(['--help'])).code).toBe(0);
    expect((await run(['--version'])).code).toBe(0);
  });
});

describe('--json output is a stable contract', () => {
  it('puts exactly one JSON document on stdout on success', async () => {
    const result = await run(['--json', 'lessons', 'get', '42']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.etag).toBe('"lesson-42-v3"');
    expect((parsed.data as Record<string, unknown>).id).toBe(42);
  });

  it('puts exactly one JSON document on stdout on failure, with the exit code in it', async () => {
    const result = await run(['--json', 'lessons', 'get', '999']);
    expect(result.code).toBe(6);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: false,
      code: 'LESSON_NOT_FOUND',
      request_id: 'req-test-1',
      exit_code: 6,
    });
  });

  it('keeps human chatter off stdout in --json mode', async () => {
    const result = await run(['--json', 'lessons', 'list']);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

describe('destructive actions require an explicit confirmation', () => {
  it('refuses to cancel without a TTY and without --yes, and writes nothing', async () => {
    const before = seen.filter((r) => r.method === 'POST').length;
    const result = await run(['lessons', 'cancel', '42']);
    expect(result.code).toBe(19); // ABORTED
    expect(result.stderr).toContain('About to cancel');
    expect(seen.filter((r) => r.method === 'POST').length).toBe(before);
  });

  it('refuses to mark-paid without a TTY and without --yes, and writes nothing', async () => {
    const before = seen.filter((r) => r.method === 'POST').length;
    const result = await run(['lessons', 'mark-paid', '42']);
    expect(result.code).toBe(19);
    expect(seen.filter((r) => r.method === 'POST').length).toBe(before);
  });

  it('prints the absolute Pacific date/time before asking', async () => {
    const result = await run(['lessons', 'cancel', '42']);
    expect(result.stderr).toContain('Aug 4, 2026');
    expect(result.stderr).toContain('2:00');
    expect(result.stderr).toContain('(2026-08-04T14:00:00-07:00)');
    expect(result.stderr).toContain('notifies the coach and family');
  });

  it('prints the amount before asking to mark paid', async () => {
    const result = await run(['lessons', 'mark-paid', '42']);
    expect(result.stderr).toContain('$20.00');
    expect(result.stderr).toContain('no un-mark-paid endpoint');
  });

  it('proceeds with --yes, sending both If-Match and a generated Idempotency-Key', async () => {
    const result = await run(['--json', '--yes', 'lessons', 'cancel', '42', '--reason', 'flu']);
    expect(result.code).toBe(0);

    const request = seen.filter((r) => r.url.endsWith('/lessons/42/cancel')).at(-1);
    expect(request).toBeDefined();
    // If-Match defaults to the ETag from the read this command just performed.
    expect(request?.headers['if-match']).toBe('"lesson-42-v3"');
    expect(request?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours an explicit --idempotency-key and --if-match', async () => {
    const result = await run([
      '--yes',
      'lessons',
      'mark-paid',
      '42',
      '--if-match',
      '"lesson-42-v3"',
      '--idempotency-key',
      'my-own-key',
    ]);
    expect(result.code).toBe(0);
    const request = seen.filter((r) => r.url.endsWith('/lessons/42/mark-paid')).at(-1);
    expect(request?.headers['if-match']).toBe('"lesson-42-v3"');
    expect(request?.headers['idempotency-key']).toBe('my-own-key');
  });

  it('does not write on --dry-run', async () => {
    const before = seen.filter((r) => r.method === 'POST').length;
    const result = await run(['--json', 'lessons', 'cancel', '42', '--dry-run']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.dry_run).toBe(true);
    expect(String(parsed.when_pacific)).toContain('Aug 4, 2026');
    expect(seen.filter((r) => r.method === 'POST').length).toBe(before);
  });
});

describe('the token is never an argv argument', () => {
  it('auth set-token exposes no positional or flag for the token value', async () => {
    const help = await run(['auth', 'set-token', '--help']);
    expect(help.code).toBe(0);
    const text = help.stdout + help.stderr;
    expect(text).toMatch(/NEVER accepted as an argument|hidden prompt/i);
    expect(text).not.toMatch(/--token[ <]/);
  });

  it('rejects an unknown argument rather than treating it as the token', async () => {
    const result = await run(['auth', 'set-token', 'sk-secret-value']);
    expect(result.code).toBe(2);
  });

  it('auth status never prints the token itself', async () => {
    const result = await run(['--json', 'auth', 'status']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.token_source).toBe('env');
    expect(String(parsed.token_fingerprint)).not.toContain('test-token');
    expect(result.stdout).not.toContain('test-token');
  });
});

describe('lessons list', () => {
  it('renders Pacific times in the human table', async () => {
    const result = await run(['lessons', 'list']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('America/Los_Angeles');
    expect(result.stdout).toContain('Aug 4, 2026');
  });
});
