# ScorSync Private Lessons — MCP server & CLI

Two clients for the ScorSync private-lessons REST API:

- **`scorsync-mcp`** — an [MCP](https://modelcontextprotocol.io) server (stdio) that gives
  an AI assistant twelve narrow, task-specific tools for scheduling, quoting, and billing
  private lessons.
- **`scorsync`** — a CLI for the same API, with stable `--json` output and meaningful
  exit codes.

Both are thin layers over one **generated** HTTP client.

---

## Generated from the contract

The typed client is generated from `contract/openapi.yaml` — the frozen OpenAPI 3.1
document for the API — by [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript),
and every request is issued through [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/),
which is typed by that output. There are no hand-written URLs, query shapes, or request
bodies anywhere in `src/`: a path, parameter, or field that drifts from the contract fails
to typecheck.

```bash
npm run generate        # contract/openapi.yaml -> src/generated/openapi.ts
npm run generate:check  # regenerate and fail if the committed output is stale
```

`src/generated/openapi.ts` is **committed**, so a clean clone builds and runs with no
network access — but the generation step is real and re-runnable. When the API contract
changes, drop in the new `contract/openapi.yaml`, run `npm run generate`, and the compiler
will point at every call site that no longer matches.

`contract/contracts.md` is the companion document that pins what OpenAPI cannot express:
the 13-value error taxonomy, the RFC 3339 boundary rule, the idempotency and
optimistic-concurrency semantics, and the athlete field-visibility rules. Both files are
vendored here so this repository is self-contained.

---

## Install

```bash
npm install
npm run build
npm test
```

Requires Node 20.11+.

To use the binaries from anywhere:

```bash
npm link          # or: npm install -g .
scorsync --help
```

---

## Authentication

The API uses Laravel Sanctum personal access tokens sent as `Authorization: Bearer <token>`.

**A token can only be minted in the ScorSync web UI** (Profile → API tokens). There is no
API endpoint that creates, reads, or rotates a token, by design — so there is no CLI
command and no MCP tool for it either.

Store the token in the OS credential store:

```bash
scorsync auth set-token          # prompts, input hidden
cat token.txt | scorsync auth set-token   # or read from stdin
```

The token is **never accepted as a command-line argument** — it would land in `ps` output
and shell history. It is read from a hidden TTY prompt, or from stdin when piped.

Storage uses [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) (macOS
Keychain, Windows Credential Manager, Linux Secret Service). It is an *optional*
dependency: on a platform with no prebuilt binary, or a headless box with no Secret
Service, the CLI degrades to environment-variable-only and says so. Nothing is ever
written to a plaintext dotfile as a fallback. (`keytar`, the usual choice, is archived and
unmaintained.)

Resolution order:

| What | Source, in order of precedence |
|---|---|
| Token | `SCORSYNC_TOKEN` → OS credential store → error (`NO_TOKEN`, exit 17) |
| Base URL | `--base-url` → `SCORSYNC_BASE_URL` → error (`USAGE_ERROR`, exit 2) |

There is no default host. Guessing one would mean sending a bearer token somewhere the
operator did not name.

```bash
export SCORSYNC_BASE_URL=https://scorsync.example.com/api/v1
scorsync auth status      # shows the source; never prints the token
scorsync auth whoami      # GET /me — owner, roles, granted scopes
```

Use `--profile <name>` to keep several instances' tokens side by side.

### Scopes

The API defines eight scopes. A token missing a required one gets `403 INSUFFICIENT_SCOPE`
(exit 11); a token that has the scope but is denied by policy gets `403 FORBIDDEN`
(exit 12).

`lessons:read`, `lessons:write`, `lessons:cancel`, `lessons:mark-paid`, `athletes:read`,
`athletes:create`, `balances:read`, `audit:read`.

`audit:read` additionally requires an Admin role — a non-Admin token holding the scope
still gets `403 FORBIDDEN`.

Waiver status is read-only through every scope. No scope can set it.

---

## MCP server

Add to your MCP client configuration (e.g. `claude_desktop_config.json`, or `.mcp.json`
for Claude Code). From a local checkout, after `npm run build`:

```json
{
  "mcpServers": {
    "scorsync": {
      "command": "node",
      "args": ["/absolute/path/to/private-lessons-mcp/dist/mcp/index.js"],
      "env": {
        "SCORSYNC_BASE_URL": "https://scorsync.example.com/api/v1"
      }
    }
  }
}
```

Once the package is published, or after `npm link` / `npm install -g .`:

```json
{
  "mcpServers": {
    "scorsync": {
      "command": "scorsync-mcp",
      "env": {
        "SCORSYNC_BASE_URL": "https://scorsync.example.com/api/v1"
      }
    }
  }
}
```

(For a published package without a global install, the `npx` form needs `--package`,
because the binary name differs from the package name:
`npx -y --package=@scorsync/private-lessons-clients scorsync-mcp`.)

The token comes from the OS credential store by default; set `SCORSYNC_PROFILE` to choose
a non-default profile, or add `SCORSYNC_TOKEN` to `env` if your MCP client runs somewhere
the credential store is not reachable. Diagnostics go to stderr; stdout carries only MCP
protocol frames.

### The twelve tools

| Tool | Kind | Notes |
|---|---|---|
| `scorsync_list_lessons` | read | Scoped by the token's visibility. |
| `scorsync_get_lesson` | read | Returns the strong ETag to use as `if_match`. |
| `scorsync_check_availability` | read | Bookable windows for a coach on one Pacific date. |
| `scorsync_get_quote` | read | Advisory server-computed fee. |
| `scorsync_search_athletes` | read | Step 1 of the two-step write flow. |
| `scorsync_create_athlete` | **write** | dry-run, auto `Idempotency-Key`. |
| `scorsync_create_lesson` | **write** | dry-run, auto `Idempotency-Key`. |
| `scorsync_update_lesson` | **write** | dry-run, requires `if_match`. |
| `scorsync_cancel_lesson` | **write, destructive** | dry-run, requires `if_match`. |
| `scorsync_mark_lesson_paid` | **write, destructive** | dry-run, requires `if_match`. |
| `scorsync_get_balance` | read | What a coach owes the gym. |
| `scorsync_list_audit_events` | read | Admin only; cursor-paginated. |

Deliberate omissions:

- **No generic HTTP tool.** A `scorsync_request(method, path, body)` escape hatch would let
  a model invent endpoints, skip the required `Idempotency-Key` / `If-Match` headers, and
  bypass every guard below. The twelve tools are the entire surface.
- **No token-management tool.** Minting or reading a token is impossible through this API
  by design; adding a tool would imply otherwise.

Every mutation tool:

- **declares its side effects in the tool description** (what is written, who gets
  notified, whether it is reversible);
- **supports `dry_run: true`**, which returns the advisory quote plus an
  availability/conflict preview and writes nothing;
- **generates an `Idempotency-Key`** when the caller supplies none, so a retry after a
  dropped response replays rather than double-booking;
- **never auto-retries a `412 VERSION_MISMATCH`** — the conflict is surfaced with
  `current_version` so the decision to overwrite belongs to a human.

### The two-step athlete flow

No write body in this API has a name field. Writes take `athlete_ids` and nothing else, so
a tool can never guess an identity. The only path from a name to an id is:

1. **search** — `scorsync_search_athletes` returns candidates, always `200`;
2. **confirm** — exactly one explicit id is chosen;
3. **write** — that id is sent.

Step 2 is where `ATHLETE_AMBIGUOUS` lives. The server cannot raise it: it does not know
whether a multi-match search is a person browsing or an agent resolving a name, so it
always answers `200` with a candidate list. The **client** surfaces the condition. It is
never an HTTP status and never appears in a problem document.

The tool descriptions state this explicitly and instruct the caller to stop and ask the
user when a search returns more than one candidate — not to pick the first, the closest,
or the most recently created.

---

## CLI

```
scorsync auth set-token|status|clear|whoami
scorsync lessons list|get|create|update|cancel|mark-paid
scorsync athletes search|create
scorsync availability --date <YYYY-MM-DD> [--duration 60] [--coach <id>]
scorsync balance [--coach <id>]
scorsync audit [--limit n] [--cursor c] [--all]
```

Global flags: `--json`, `--base-url <url>`, `--profile <name>`, `-y/--yes`.

### Examples

```bash
# Find the athlete first — a write never guesses an identity.
scorsync athletes search "Lovelace"

# Price and conflict-check a booking without writing anything.
scorsync lessons create --coach 7 --athlete-ids 101 \
  --at 2026-08-04T14:00:00-07:00 --duration 60 --dry-run

# Book it.
scorsync lessons create --coach 7 --athlete-ids 101 \
  --at 2026-08-04T14:00:00-07:00 --duration 60 --acknowledge-fee

# Read the ETag, then write against it.
scorsync lessons get 42                       # prints ETag: "lesson-42-v3"
scorsync lessons update 42 --at 2026-08-05T15:00:00-07:00 --if-match '"lesson-42-v3"'

# Destructive: prints the absolute Pacific date/time and requires a typed confirmation.
scorsync lessons cancel 42 --reason "family cancelled"
scorsync lessons mark-paid 42

# Machine-readable output.
scorsync --json lessons list --from 2026-08-01 --to 2026-08-31 | jq '.data[].id'
```

### `--json`

With `--json`, stdout carries **exactly one JSON document and nothing else** — no banners,
no progress, no prompts. Everything human-facing goes to stderr. Errors are emitted as
JSON on stdout too, carrying `code`, `detail`, `request_id`, and `exit_code`. A script can
pipe stdout into `jq` unconditionally.

### Idempotency and concurrency flags

- `--idempotency-key <key>` — supply your own. **One is generated automatically when you
  do not**, on every write, so retrying an interrupted command is safe by default. The API
  *requires* the header on `lessons create` and `athletes create` and honours it on cancel
  and mark-paid.
- `--if-match <etag>` — the strong ETag from a prior read, e.g. `"lesson-42-v3"`. The API
  **requires** it on update, cancel, and mark-paid. `scorsync lessons update` refuses to
  run without it and tells you the current ETag. `cancel` and `mark-paid` default to the
  ETag read during their own confirmation step, which is safe because you confirm the
  freshly-read state on screen. A stale value returns `412 VERSION_MISMATCH` (exit 9) with
  the server's `current_version`; nothing is retried automatically.

  The flag also accepts the ETag with the quotes stripped (shells eat them) or a bare
  version number. Weak validators (`W/"..."`) and `*` are refused.

### Destructive actions

`cancel` and `mark-paid` print the lesson's **absolute Pacific date and time**, the coach,
the athletes, and the amount, then require you to type `cancel <id>` / `mark-paid <id>` to
proceed. Without a TTY and without `--yes` they refuse and exit 19 (`ABORTED`) — an
unattended process cannot cancel a lesson by accident. Both also support `--dry-run`.

### Timestamps

The API requires **RFC 3339 with an explicit UTC offset** on input and emits every
timestamp with an explicit Pacific offset. The tenant timezone is `America/Los_Angeles`.
Naive input is rejected — by this client, before the request leaves, with a suggested
repair:

```
$ scorsync lessons create ... --at 2026-08-04T14:00:00
VALIDATION_FAILED: Invalid RFC 3339 timestamp "2026-08-04T14:00:00": an explicit UTC
offset is required (the API rejects naive timestamps). Did you mean
"2026-08-04T14:00:00-07:00"?
```

The suggestion is never applied silently. Validation is strict per the contract: seconds
are required, the offset must be `Z` or `±HH:MM` (`+0200` and `+02` are refused), and
impossible instants (`2026-02-30`, `14:60:00`) are rejected rather than rolled over. All
output is rendered in Pacific alongside the machine-readable form.

### Fees

The server computes every fee. This client never hardcodes a rate, never computes an
amount, and never sends one. `scorsync lessons create --dry-run` and
`scorsync_get_quote` return the server's **advisory** quote; the fee is recalculated at
create time, and there is no quote token to expire.

---

## Exit codes

Exit codes are mapped from the API's 13 frozen error codes. These values are part of the
CLI's interface and will not be renumbered. 126, 127, and 128+ are avoided because POSIX
shells reserve them.

| Exit | Code | Meaning |
|---:|---|---|
| 0 | — | Success. |
| 1 | `UNKNOWN_ERROR` | Unexpected failure, or an HTTP response with no recognisable problem document. |
| 2 | `USAGE_ERROR` | Bad arguments, unknown command, missing base URL. |
| 3 | `VALIDATION_FAILED` | Field validation; missing required `Idempotency-Key`/`If-Match`; naive timestamp. |
| 4 | `ATHLETE_NOT_FOUND` | An `athlete_ids` entry does not exist — create the athlete first. |
| 5 | `ATHLETE_AMBIGUOUS` | A name search matched more than one athlete. **Client-surfaced**: the server answered `200`. |
| 6 | `LESSON_NOT_FOUND` | No such lesson, or it is not visible to this token. |
| 7 | `SLOT_CONFLICT` | Overlaps an existing booking for that coach. |
| 8 | `OUTSIDE_BUSINESS_HOURS` | Start/end outside 07:00–22:00 Pacific. |
| 9 | `VERSION_MISMATCH` | Stale `If-Match`. The response carries `current_version`. |
| 10 | `IDEMPOTENCY_KEY_REUSED` | Same key with a different body, **or** a concurrent duplicate still in flight — distinguished by `retryable` and `Retry-After`, not by a separate code. |
| 11 | `INSUFFICIENT_SCOPE` | The token lacks the scope this endpoint requires. |
| 12 | `FORBIDDEN` | Scope present, but policy denies. |
| 13 | `RATE_LIMITED` | Per-token throttle exceeded. Retryable; see `Retry-After`. |
| 14 | `FACILITY_FEE_ACK_REQUIRED` | `--acknowledge-fee` was not given. |
| 15 | `LATE_BOOKING_ACK_REQUIRED` | Late booking without `--acknowledge-late-booking`. |
| 16 | `UNAUTHENTICATED` | HTTP 401 — missing, invalid, expired, or revoked token. Deliberately outside the 13-code taxonomy. |
| 17 | `NO_TOKEN` | No token in the environment or the credential store. |
| 18 | `NETWORK_ERROR` | The API could not be reached. |
| 19 | `ABORTED` | A destructive action was not confirmed. Nothing was written. |

Errors print `code`, `detail`, any field errors, and the `request_id` — never a raw JSON
blob. Quote the `request_id` when reporting a problem; it correlates to the server's logs
and to the audit event.

---

## Development

```bash
npm run generate        # regenerate the client from contract/openapi.yaml
npm run generate:check  # fail if the committed generated output is stale
npm run typecheck
npm run build
npm test                # vitest; builds the CLI first if dist/ is missing
```

Tests mock the HTTP layer end to end — the suite needs no live API, no database, and no
network. `tests/cli.test.ts` runs the built binary as a real subprocess against a local
`node:http` server, because exit codes and the stdout/stderr split only exist at the
process boundary. `tests/mcp-server.test.ts` drives the real MCP server through the SDK's
in-memory transport with a real MCP client.

Coverage is aimed at the things that are easy to get quietly wrong: the error-code →
exit-code mapping, the strict RFC 3339 boundary (including both DST transitions), the
two-step athlete flow, the required headers, and the guarantee that a dry run writes
nothing.

## Layout

```
contract/openapi.yaml      the frozen API contract (input to the generator)
contract/contracts.md      what OpenAPI cannot express
src/generated/openapi.ts   GENERATED — do not edit by hand
src/core/                  client, errors/exit codes, time, concurrency, tokens, preflight
src/mcp/                   MCP server (stdio) and its 12 tools
src/cli/                   the `scorsync` command
tests/                     unit + integration tests, all against a mocked HTTP layer
```
