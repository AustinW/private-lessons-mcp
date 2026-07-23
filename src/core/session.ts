/**
 * Turning ambient configuration into a ready client.
 *
 * Base URL: `--base-url` (CLI) > `PRIVATE_LESSONS_BASE_URL` > error.
 * Token:    `PRIVATE_LESSONS_TOKEN` > OS credential store > error.
 *
 * There is no default host. Guessing a host for a self-hosted app would mean sending a
 * bearer token somewhere the operator did not name.
 */

import { DEFAULT_BASE_URL_ENV, PrivateLessonsClient } from './client.js';
import { PrivateLessonsError } from './errors.js';
import { getToken, TOKEN_ENV_VAR, type TokenSource } from './token-store.js';

export interface SessionOptions {
  baseUrl?: string | undefined;
  profile?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  userAgent?: string | undefined;
}

export interface Session {
  client: PrivateLessonsClient;
  baseUrl: string;
  tokenSource: Exclude<TokenSource, 'none'>;
}

export function resolveBaseUrl(explicit?: string | undefined): string {
  const value = explicit?.trim() || process.env[DEFAULT_BASE_URL_ENV]?.trim();
  if (!value) {
    throw new PrivateLessonsError('USAGE_ERROR', 'No API base URL configured.', {
      detail:
        `No API base URL configured. Set ${DEFAULT_BASE_URL_ENV} ` +
        '(e.g. https://private-lessons.scorsync.com/api/v1) or pass --base-url.',
    });
  }
  return value;
}

export async function openSession(options: SessionOptions = {}): Promise<Session> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const resolved = await getToken(options.profile ?? 'default');
  if (!resolved) {
    throw new PrivateLessonsError('NO_TOKEN', 'No API token available.', {
      detail:
        'No API token available. Store one with `private-lessons auth set-token` (it is read ' +
        `from a prompt or stdin, never from argv) or set ${TOKEN_ENV_VAR}.`,
    });
  }

  return {
    client: new PrivateLessonsClient({
      baseUrl,
      token: resolved.token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    }),
    baseUrl,
    tokenSource: resolved.source,
  };
}
