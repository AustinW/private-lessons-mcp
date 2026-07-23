#!/usr/bin/env node
/**
 * stdio entry point for the Private Lessons MCP server.
 *
 * Configuration is environment-only, because an MCP client launches this process with
 * no terminal to prompt at:
 *   PRIVATE_LESSONS_BASE_URL  required, e.g. https://private-lessons.scorsync.com/api/v1
 *   PRIVATE_LESSONS_TOKEN     optional; when unset the OS credential store is used
 *   PRIVATE_LESSONS_PROFILE   optional credential-store profile (default: "default")
 *
 * Nothing is ever written to stdout except MCP protocol frames — diagnostics go to
 * stderr, because stdout *is* the transport.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { toPrivateLessonsError } from '../core/errors.js';
import { openSession } from '../core/session.js';
import { buildServer } from './server.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const session = await openSession({
    profile: process.env.PRIVATE_LESSONS_PROFILE ?? 'default',
    userAgent: `private-lessons-mcp/${VERSION}`,
  });

  process.stderr.write(
    `private-lessons-mcp ${VERSION} → ${session.baseUrl} (token from ${session.tokenSource})\n`,
  );

  const server = buildServer({ client: session.client, version: VERSION });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  const error = toPrivateLessonsError(err);
  process.stderr.write(`private-lessons-mcp failed to start:\n${error.toDisplayString()}\n`);
  process.exit(error.exitCode);
});
