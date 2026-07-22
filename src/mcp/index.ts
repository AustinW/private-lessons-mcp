#!/usr/bin/env node
/**
 * stdio entry point for the ScorSync MCP server.
 *
 * Configuration is environment-only, because an MCP client launches this process with
 * no terminal to prompt at:
 *   SCORSYNC_BASE_URL  required, e.g. https://scorsync.example.com/api/v1
 *   SCORSYNC_TOKEN     optional; when unset the OS credential store is used
 *   SCORSYNC_PROFILE   optional credential-store profile (default: "default")
 *
 * Nothing is ever written to stdout except MCP protocol frames — diagnostics go to
 * stderr, because stdout *is* the transport.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { toScorSyncError } from '../core/errors.js';
import { openSession } from '../core/session.js';
import { buildServer } from './server.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const session = await openSession({
    profile: process.env.SCORSYNC_PROFILE ?? 'default',
    userAgent: `scorsync-mcp/${VERSION}`,
  });

  process.stderr.write(
    `scorsync-mcp ${VERSION} → ${session.baseUrl} (token from ${session.tokenSource})\n`,
  );

  const server = buildServer({ client: session.client, version: VERSION });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  const error = toScorSyncError(err);
  process.stderr.write(`scorsync-mcp failed to start:\n${error.toDisplayString()}\n`);
  process.exit(error.exitCode);
});
