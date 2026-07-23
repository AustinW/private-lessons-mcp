# Private Lessons API — Frozen Internal Contracts (Phase 1)

This document freezes the contracts that the OpenAPI document (`docs/api/openapi.yaml`)
cannot express, so Phases 2–7 build without re-litigation. It is the companion to that
OpenAPI file and **must stay consistent with it**: the same 13 error codes, the same DTO
field names, the same timestamp rule, and the same scope mapping appear in both. If a
downstream reader finds these two files disagreeing, that is a bug in this phase.

Source of truth for the decisions below: the design spec
`docs/superpowers/specs/2026-07-21-private-lessons-api-mcp-cli-design.md`
(binding sections §2, §3, §4, §5, §6, §7, §8, §13). Decisions in §13 are locked and are
not re-derived here.

There is **no runtime code in Phase 1.** Everything below describes what Phases 2+ must
implement; PHP type names are prescriptive, not existing.

---

## 1. Domain exception → HTTP mapping

Every application error is emitted as an RFC 9457 problem document
(`application/problem+json` → `ProblemDetails`) with a `code` drawn from the fixed
**13-value** enum. The API controller/exception handler translates domain exceptions (and
a few non-exception conditions handled by middleware / form-request validation) into these
responses. The web controller catches the *same* domain exceptions and renders
`back()->withErrors([...])` instead, preserving current UX — this is how "web and API
cannot diverge" is enforced.

| Trigger (exception or check) | HTTP | `code` | `retryable` | Notes |
|---|---|---|---|---|
| Field/request validation fails; **missing required `Idempotency-Key`**; **missing required `If-Match`**; **naive / offset-less timestamp** | 422 | `VALIDATION_FAILED` | false | Field messages in `errors`. |
| `AthleteNotFoundException` — an `athlete_ids` entry does not exist | 404 | `ATHLETE_NOT_FOUND` | false | Caller must `POST /athletes` first. Never raised for a name (writes take ids only). |
| Ambiguous name search — **client-surfaced, not a server error** | 200 | `ATHLETE_AMBIGUOUS` | n/a | The server always returns a plain `200` candidate list from `GET /athletes` (it cannot know caller intent). A client/CLI/MCP resolving a name to one athlete raises `ATHLETE_AMBIGUOUS` when the search returns `>1`. Never an HTTP status the server sets; never a write error; no problem document ever carries it. |
| `LessonNotFoundException` / model-not-found — no such lesson, or not visible to caller | 404 | `LESSON_NOT_FOUND` | false | |
| `LessonConflictException` — overlaps an existing booking for the coach | 409 | `SLOT_CONFLICT` | false | Offending field echoed in `errors.scheduled_at`. |
| `OutsideBusinessHoursException` — start/end outside 07:00–22:00 Pacific | 422 | `OUTSIDE_BUSINESS_HOURS` | false | |
| Optimistic-concurrency check fails (conditional `UPDATE ... WHERE version = ?` affects 0 rows) | 412 | `VERSION_MISMATCH` | false | Body carries `current_version`. |
| Idempotency: same key + **different** canonical body | 409 | `IDEMPOTENCY_KEY_REUSED` | false | |
| Idempotency: concurrent duplicate while original is **in progress** | 409 | `IDEMPOTENCY_KEY_REUSED` | true | Same code, disambiguated by `retryable: true` + `Retry-After`. See §6. |
| Token lacks the required ability/scope | 403 | `INSUFFICIENT_SCOPE` | false | Layer 1 of the permission intersection (§4). |
| `PrivateLessonPolicy` / `AthletePolicy` denies | 403 | `FORBIDDEN` | false | Layer 2 of the permission intersection. |
| Per-token throttle exceeded | 429 | `RATE_LIMITED` | true | `Retry-After` header. |
| `FeeAcknowledgementRequiredException` — `fee_acknowledged` not `true` on `POST /lessons` | 422 | `FACILITY_FEE_ACK_REQUIRED` | false | Recorded in the audit event. |
| `LateBookingAcknowledgementRequiredException` — late booking without `late_booking_acknowledged: true` | 422 | `LATE_BOOKING_ACK_REQUIRED` | false | Recorded in the audit event. Deliberate divergence from the web JS-only warning (§13.2). |

**Complete code set (exactly 13, no others):** `VALIDATION_FAILED`, `ATHLETE_NOT_FOUND`,
`ATHLETE_AMBIGUOUS`, `LESSON_NOT_FOUND`, `SLOT_CONFLICT`, `OUTSIDE_BUSINESS_HOURS`,
`VERSION_MISMATCH`, `IDEMPOTENCY_KEY_REUSED`, `INSUFFICIENT_SCOPE`, `FORBIDDEN`,
`RATE_LIMITED`, `FACILITY_FEE_ACK_REQUIRED`, `LATE_BOOKING_ACK_REQUIRED`.

**Dropped codes (do NOT introduce):** `SLOT_FULL`, `DUPLICATE_SOURCE_EVENT`,
`PREVIEW_STALE`, `QUOTE_EXPIRED`, `UPSTREAM_UNAVAILABLE` — each named a subsystem this
project does not build.

### Exception inventory

Spec §2 names four domain exceptions: `LessonConflictException`,
`OutsideBusinessHoursException`, `AthleteNotFoundException`,
`FeeAcknowledgementRequiredException`. Enforcing the late-booking acknowledgement (§5, locked
in §13.2) adds **`LateBookingAcknowledgementRequiredException`** as a sibling of the fee
exception. `LESSON_NOT_FOUND` is Laravel's route-model-binding / `ModelNotFoundException`
mapped by the handler; `VALIDATION_FAILED`, `VERSION_MISMATCH`, `IDEMPOTENCY_KEY_REUSED`,
`INSUFFICIENT_SCOPE`, `FORBIDDEN`, and `RATE_LIMITED` are produced by form-request
validation, the conditional-update path, the idempotency executor, and middleware
respectively — not by the action classes.

### Note on HTTP 401

A missing / invalid / expired / revoked token is rejected by the Sanctum auth layer with
**401** before the application error model runs. 401 is intentionally **outside** the
13-code taxonomy (no code denotes "unauthenticated"), so it is not represented as a
`ProblemDetails` response in the OpenAPI document. Authenticated-but-unauthorized is
`403` (`INSUFFICIENT_SCOPE` or `FORBIDDEN`).

---

## 2. Action DTO contracts

Five action classes under `app/Actions/` (spec §2): `Lessons/CreateLesson`,
`Lessons/UpdateLesson`, `Lessons/CancelLesson`, `Lessons/MarkLessonPaid`,
`Athletes/CreateAthlete`. Each accepts one typed input DTO and returns the model. Actions
throw the domain exceptions above instead of returning redirects. Actions run **inside** an
ambient transaction owned by the caller (the idempotency executor for API writes; a plain
`DB::transaction()` for web/Filament) — they never open or commit the outer transaction
(spec §2, transaction ownership).

### Cross-cutting DTO fields (every write action carries these)

These are populated by the caller, not by the request body wire fields:

| DTO property | PHP type | Meaning |
|---|---|---|
| `actor` | `User` | The **authenticated** user performing the action. |
| `source` | `Source` enum = `web \| api \| filament \| console` | Originating surface; recorded on the audit event. |
| `tokenId` | `?int` (nullable) | Sanctum token id for API calls; `null` for web/filament/console. |
| `tokenFingerprint` | `?string` (nullable) | Non-secret token prefix; `null` off the API. |
| `requestId` | `string` | The `X-Request-Id` correlation id (§5); recorded on the audit event. |

**`actor` vs `coachId` are distinct and must never be conflated.** Filament lets
Admin/Management pick another staff member as the coach; the web controller uses the actor
as the coach. `CreateLesson` therefore accepts an **explicit `coachId`** and authorizes
"actor books for coach" — it must not assume `actor == coach`.

### DTO → wire-field mapping

DTO properties are camelCase (PHP); the OpenAPI request bodies use snake_case JSON. The
mapping is 1:1 on names below. Cross-cutting fields (`actor`, `source`, `tokenId`,
`tokenFingerprint`, `requestId`) and the concurrency/idempotency inputs are **not** body
fields — they come from the authenticated context and headers.

#### `CreateLesson` → `CreateLessonData`

| DTO property | Type | Wire field (`POST /lessons`) | Rule |
|---|---|---|---|
| `coachId` | `int` | `coach_id` | Required. |
| `athleteIds` | `int[]` | `athlete_ids` | Required, **non-empty on `api`/`web`**. Empty array tolerated **only on `filament`/`console`** (§13.4) — the member flag is chosen manually there. |
| `scheduledAt` | `CarbonImmutable` (tz-aware) | `scheduled_at` | RFC 3339 with explicit offset in (§3). |
| `durationMinutes` | `int` ∈ {30,45,60,90,120} | `duration_minutes` | Matches the app's long-standing `in:30,45,60,90,120` validation; `45` was erroneously omitted from the Phase 1 `DurationMinutes` enum. |
| `feeAcknowledged` | `bool` | `fee_acknowledged` | Must be `true` on the API → else `FACILITY_FEE_ACK_REQUIRED`. |
| `lateBookingAcknowledged` | `bool` (default `false`) | `late_booking_acknowledged` | Must be `true` **when the booking is late** → else `LATE_BOOKING_ACK_REQUIRED`. Enforced **only when `source === api`** (`Source::requiresLateBookingAcknowledgement()`): the web/Filament/console paths send nothing and keep their current behaviour, which is the documented divergence of §13.2. Recorded on the audit event on every surface. |
| `notes` | `?string` | `notes` | Optional. |
| `observer` | `?string` | `observer` | Optional. |

There is **no athlete-name field** anywhere in this body (the landmine): a write can never
guess an identity, so `ATHLETE_AMBIGUOUS` is impossible here. Cost and membership are
computed server-side; clients never send a fee.

#### `UpdateLesson` → `UpdateLessonData` (PATCH)

Carries `lessonId` (from the path) and `expectedVersion` (parsed from the required
`If-Match` ETag). All mutable fields are wrapped in an **absent sentinel** — see §2.1.

> **`expectedVersion` is `?int` on the DTO — optional, defaulting to `null`.** The same
> three DTOs serve the web and Filament surfaces, which send no `If-Match` and must keep
> behaving exactly as they do today; `null` means "no `WHERE version = ?` predicate", i.e.
> no concurrency check. The `version` column is still incremented on every write from
> every surface, so the counter remains a truthful count of writes.
>
> **This does not loosen the wire contract.** `If-Match` stays *required* on `PATCH`,
> `cancel` and `mark-paid` (§6): the API form requests reject a missing, weak, wildcard or
> malformed validator with `422 VALIDATION_FAILED` before an action is ever constructed, so
> an API caller can never reach the no-check path. Only non-API callers pass `null`.

| DTO property | Type | Wire field (`PATCH /lessons/{id}`) | Semantics |
|---|---|---|---|
| `coachId` | `Optional<int>` | `coach_id` | absent = unchanged. |
| `athleteIds` | `Optional<int[]>` | `athlete_ids` | absent = unchanged; non-empty when present. |
| `scheduledAt` | `Optional<CarbonImmutable>` | `scheduled_at` | absent = unchanged. |
| `durationMinutes` | `Optional<int>` | `duration_minutes` | absent = unchanged. |
| `notes` | `Optional<?string>` | `notes` | **absent = leave unchanged; present-null = clear; present-value = set.** |
| `observer` | `Optional<?string>` | `observer` | absent / null / value, as `notes`. |
| `lateBookingAcknowledged` | `Optional<bool>` | `late_booking_acknowledged` | Required `true` if the update moves the lesson to a late start. |

#### `CancelLesson` → `CancelLessonData`

| DTO property | Type | Wire field (`POST /lessons/{id}/cancel`) | Rule |
|---|---|---|---|
| `lessonId` | `int` | path | |
| `expectedVersion` | `?int` | `If-Match` header | Required **on the wire**; `null` only for web/Filament (see the note under `UpdateLessonData`). Stale → `VERSION_MISMATCH` (412). |
| `reason` | `?string` | `reason` | Optional; recorded in the audit event. |
| `idempotencyKey` | — | `Idempotency-Key` header | **Accepted** (optional). A retry replays the original `200` rather than `404` on the soft-deleted lesson. Not a DTO property: the key is handled by `UseCaseExecutor::executeIdempotent()` via `IdempotencyContext`, one layer above the action, so no action needs to know it exists. |

#### `MarkLessonPaid` → `MarkLessonPaidData`

| DTO property | Type | Wire field (`POST /lessons/{id}/mark-paid`) | Rule |
|---|---|---|---|
| `lessonId` | `int` | path | |
| `expectedVersion` | `?int` | `If-Match` header | Required **on the wire**; `null` only for web/Filament. Stale → `VERSION_MISMATCH` (412). |
| `paidAt` | `?CarbonImmutable` | `paid_at` | Optional; defaults to `now()` when omitted/null. Normalized to the **app** timezone by the action — `paid_at` is an ordinary datetime column, unlike the tenant wall-clock `scheduled_at`. |
| `idempotencyKey` | — | `Idempotency-Key` header | Accepted (optional); handled by the executor, not carried on the DTO. |

#### `CreateAthlete` → `CreateAthleteData`

| DTO property | Type | Wire field (`POST /athletes`) | Rule |
|---|---|---|---|
| `firstName` | `string` | `first_name` | Required. |
| `lastName` | `string` | `last_name` | Required. |
| `membershipStatus` | `MembershipStatus` = `unknown \| member \| not_member` | `membership_status` | Optional; default `unknown`. |
| `notes` | `?string` | `notes` | **Admin/Management only**; ignored for Coach/Staff tokens (they cannot read notes). |

`waiver_signed` is **not** accepted — waiver status is read-only through every scope (§4).
`POST /athletes` requires the `Idempotency-Key` header (same rules as `POST /lessons`).

### 2.1 PATCH absent-vs-null sentinel (concrete mechanism for `UpdateLesson`)

`?T` alone cannot distinguish "field omitted → leave unchanged" from "field present as
`null` → clear it." Phase 2 implements a tiny immutable wrapper:

```php
/** @template T */
final readonly class Optional
{
    private function __construct(
        public bool $present,
        public mixed $value,   // the supplied value (may itself be null) when $present
    ) {}

    /** @return self<T> */  public static function of(mixed $value): self { return new self(true, $value); }
    /** @return self<never> */ public static function absent(): self       { return new self(false, null); }
}
```

- Field **absent** from the JSON body → `Optional::absent()` → the action leaves the column
  untouched.
- Field present with value `null` → `Optional::of(null)` → the action **clears** the column
  (nullable columns only: `notes`, `observer`).
- Field present with a value → `Optional::of($value)` → the action sets it.

The `FormRequest`/DTO factory builds each `Optional` by inspecting **key presence**
(`$request->has('notes')`) rather than value truthiness, so a JSON `null` is preserved
distinctly from omission. Only fields present in the payload are ever written.

---

## 3. RFC 3339 timestamp boundary contract

`private_lessons.scheduled_at` is stored as a **local wall-clock string in
`America/Los_Angeles`** (not UTC) via the model's `scheduledAt()` accessor/mutator
(`app/Models/PrivateLesson.php`). The mutator has two branches:

```php
set: fn ($value) => $value instanceof CarbonInterface
    ? $value->setTimezone(config('app.tenant_timezone'))->format('Y-m-d H:i:s')  // safe branch
    : Carbon::parse($value, config('app.tenant_timezone'))->format('Y-m-d H:i:s'), // string branch
```

The **string branch is unsafe for API input**: given an RFC 3339 string that carries an
explicit offset, `Carbon::parse($string, $tz)` honours the offset in the string and then
`format('Y-m-d H:i:s')` writes that offset's wall-clock **without first converting to
tenant time** — silently dropping the offset and storing the wrong local time. The API must
therefore never hand the raw string to the mutator.

**Boundary rule (the API serializer implements this at the edge, in and out):**

1. **Require an explicit RFC 3339 offset on input** (e.g. `2026-08-04T14:00:00-07:00`).
   Naive / offset-less input (`2026-08-04T14:00:00`) is **rejected with `422`
   `VALIDATION_FAILED`**. "RFC 3339" is enforced strictly, not as "whatever the date
   parser swallows" — a generated client only ever emits RFC 3339, so accepting more would
   mean the API silently disagrees with its own contract:
   - **seconds are required** — `2026-08-04T14:00Z` is ISO 8601, not RFC 3339;
   - **the offset is `Z` or `±HH:MM`** — the basic forms `+0200` and `+02` are rejected;
   - **impossible instants are rejected, not rolled over** — `2026-02-30T10:00:00Z` and
     `14:60:00` are `422`, never silently 2 March / the next minute;
   - **surrounding whitespace is not repaired** (note: Laravel's global `TrimStrings`
     middleware normalizes it before the boundary is reached, so this bites only
     non-HTTP callers of the boundary class);
   - `T`/`t` and `Z`/`z` are both accepted (ABNF literals are case-insensitive); the
     space separator of RFC 3339's §5.6 NOTE is not part of the grammar and is rejected.
2. Parse it as an **absolute instant**.
3. **Convert the instant to `America/Los_Angeles`.**
4. Hand a **timezone-aware `Carbon`/`CarbonImmutable`** to the model — the safe
   `CarbonInterface` branch of the mutator, **never** the raw RFC 3339 string.
5. **Emit** RFC 3339 **with an explicit Pacific offset** on output — never a naive
   timestamp. The `Z`/offset differs before and after each DST transition; a client in
   another zone always reconstructs the correct Pacific wall-clock.

This applies to every timestamp field in the contract (`scheduled_at`, `paid_at`,
`quoted_at`, availability `start`/`end`, `created_at`, `updated_at`, etc.).

**Interim status.** This boundary conversion is an explicit **temporary bridge** (spec §8,
§13.1). It does not touch the live `scheduled_at` column, the calendar feed, or the report
queries. The owner-approved end state is UTC storage, filed as a **separate standalone
GitHub issue #47** (not a phase of this project). When #47 lands, the boundary conversion
collapses to a no-op. The serializer is built so that removing the conversion later requires
**no change to this contract** — inputs and outputs remain RFC 3339 with explicit offsets
either way.

> Aside: `CLAUDE.md` states the app "stores timestamps in UTC." That is incorrect
> (`config/app.php` confirms wall-clock, tenant `America/Los_Angeles`) and should be
> corrected when #47 is addressed. It does not affect this contract.

DST scope: lessons are restricted to 07:00–22:00, while Pacific DST transitions occur
~02:00, so "which fall-back 1:30 AM instant wins?" is unreachable and no semantics are
invented for forbidden times. Correct offset conversion **is** required on and around both
transition dates.

---

## 4. Scope × endpoint matrix

Two layers, both must pass (spec §3, permission intersection):

1. **Scope (ability) check** — middleware asserts the token carries the required ability →
   else `403 INSUFFICIENT_SCOPE`.
2. **Policy check** — `PrivateLessonPolicy` / `AthletePolicy` runs against the token's
   owner → else `403 FORBIDDEN`.

Because policies evaluate per request, removing a role or disabling a user takes effect on
the next call; no token-invalidation sweep is needed.

| Endpoint | Method | Required scope(s) | Extra authorization |
|---|---|---|---|
| `/me` | GET | *(none — any valid token)* | — |
| `/lessons` | GET | `lessons:read` | Collection scoped by `PrivateLesson::visibleTo()`: Admin/Management → all; Coach/Staff → own. |
| `/lessons/{id}` | GET | `lessons:read` | `view` policy. |
| `/lessons` | POST | `lessons:write` | Actor authorized to book for `coach_id`. |
| `/lessons/{id}` | PATCH | `lessons:write` | `update` policy. |
| `/lessons/{id}/cancel` | POST | `lessons:cancel` | `update`/`delete` policy. |
| `/lessons/{id}/mark-paid` | POST | `lessons:mark-paid` | `update` policy. |
| `/availability` | GET | `lessons:read` | Coach/Staff default to their own schedule. |
| `/athletes` | GET | `athletes:read` | Coach branch permitted (search). Field visibility per §5. |
| `/athletes/{id}` | GET | `athletes:read` | Field visibility per §5. |
| `/athletes` | POST | `athletes:create` | Coach branch permitted (create). |
| `/pricing-quotes` | GET | `lessons:read` | Read-only, no side effects. |
| `/balances` | GET | `balances:read` | Coach/Staff → own balance; Admin/Management → all. |
| `/audit-events` | GET | `audit:read` | **Admin-only policy** — a non-Admin token with `audit:read` still gets `403 FORBIDDEN`. |

This mirrors the `x-required-scopes` extension and `security` blocks in
`docs/api/openapi.yaml` exactly.

**The 8 scopes (spec §3):** `lessons:read`, `lessons:write`, `lessons:cancel`,
`lessons:mark-paid`, `athletes:read`, `athletes:create`, `balances:read`, `audit:read`.
Dropped from the original 16 because the underlying subsystem does not exist: `waivers:read`
(folded into `athletes:read` — waiver is a column on the athlete), `attendance:write`,
`ledger:read`, `financial_tasks:*`, `calendar:*`, `webhooks:manage`.

**Waiver status is read-only through every scope — no scope can set it.** This satisfies
"an ordinary integration must not be able to falsely mark a waiver complete." `waiver_signed`
appears in read views only and is never a writable body field on any endpoint.

---

## 5. Coach athlete field visibility

Serialized athlete fields depend on the **caller's role**, not the token scope. Enforced by
returning **API Resources**, never raw models, so unpermitted columns are never serialized
(spec §3, §13.5).

| Caller role | Fields returned | `notes`? |
|---|---|---|
| **Coach / Staff** | **Exactly** `id`, `name`, `waiver_signed`, `membership_status` | **No** |
| **Admin / Management** | Full record: `id`, `name`, `first_name`, `last_name`, `waiver_signed`, `membership_status`, `notes`, `created_at`, `updated_at` | Yes |

- `name` is the athlete's full name (`first_name` + `last_name`; the model's `full_name`
  accessor).
- `membership_status` ∈ {`unknown`, `member`, `not_member`}.
- The coach-facing web picker (`AthletePicker`) is routed through the same policy/Resource
  so it stops bypassing authorization.

In the OpenAPI document these are the `AthleteCoachView` (additionalProperties: false —
exactly four fields) and `AthleteAdminView` schemas; the `Athlete` response is `oneOf` the
two, selected by role. Lessons embed only an `AthleteRef` (`id`, `name`) — safe for all
roles.

---

## 6. Idempotency & optimistic concurrency (contract summary)

These are fully specified in spec §5; summarized here only where they pin request/response
shape that OpenAPI cannot fully express.

- **`Idempotency-Key` required** on `POST /lessons` and `POST /athletes`; **accepted**
  (optional) on `POST /lessons/{id}/cancel` and `/mark-paid`.
- Uniqueness is over **`(user_id, endpoint, key)`**. `request_hash` is over **canonical
  JSON** (sorted keys), not raw bytes.
- **Replay** of a completed key with the same body returns the stored `response_status` +
  body but **mints a fresh `request_id`** (transport metadata is not replayed).
- Same key + **different** body → `409 IDEMPOTENCY_KEY_REUSED` (`retryable: false`).
- Concurrent duplicate while **in progress** → `409` with the **same** code
  `IDEMPOTENCY_KEY_REUSED` but `retryable: true` and a `Retry-After` header. (The 13-code
  enum has one idempotency code; the two 409 situations are disambiguated by `retryable`.)
- Only 2xx/4xx responses are stored, **with the exception of `401`/`403`**; **5xx is never
  cached** (a transient failure stays retryable). TTL is 24h, enforced at lookup (an
  expired row is treated as absent).
- **Identity and permission decisions are never cached, and never replayed.** Every
  authorization predicate for a write — the token's scope, the policy, and "may this actor
  book for this coach" — is evaluated **before** the idempotency lookup, on every request
  including a retry. A replay is therefore unreachable without passing the *current* rules.
  Reason: §3 guarantees that "removing a role or disabling a user takes effect on the very
  next call", and a permission outcome is precisely the kind of answer that can change
  between a call and its retry. Caching one would let a stale `403` outlive the grant that
  fixed it, or let a stored `201` keep replaying for an actor whose permission was revoked.
  Deterministic **domain** errors (slot conflict, athlete not found, acknowledgement
  failures, validation) are unaffected and are still stored and replayed.
- A request that produces an uncacheable outcome leaves **nothing** behind: the reservation
  row and any domain writes the work managed to make are rolled back together, so the retry
  the uncached failure invites starts from a clean slate rather than duplicating a partial
  write.
- **Strong** ETag on every **single-lesson** response (`GET /lessons/{id}`, create, update,
  cancel, mark-paid): `ETag: "lesson-<id>-v<version>"` (never weak `W/"..."` — RFC 9110
  strong comparison). The `GET /lessons` **collection does not** carry a single ETag header;
  a client must read the lesson detail (or use the per-item `version` in the payload) before
  issuing a conditional write.
- `PATCH`, `cancel`, `mark-paid` **require `If-Match`**. Missing → `422 VALIDATION_FAILED`;
  stale → `412 VERSION_MISMATCH` with `current_version` in the body. The version check is an
  **atomic** conditional `UPDATE ... WHERE id = ? AND version = ?` (0 rows → 412), never
  read-then-save. The precondition holds even when the write would be a no-op: re-marking an
  **already-paid** lesson with a stale `If-Match` is `412`, not `200` — a `200` would assert
  that the caller's (out-of-date) view of the record was current. The payment itself stays
  idempotent: the original `paid_at` and its single audit row are never overwritten.
- **Unknown request-body fields are rejected**, not ignored: every write body is
  `additionalProperties: false`, and a body carrying any undeclared top-level key is
  `422 VALIDATION_FAILED` with **every** offending key listed in `errors` (so a client can
  repair the request in one turn). This matters most on `PATCH`, where a silently-dropped
  typo would otherwise become a "successful" empty update that still moved `version`, wrote
  an audit event and sent an update notification.

---

## 7. Consistency checklist (openapi.yaml ↔ contracts.md)

- **Error codes:** identical 13-value set; identical dropped set. ✔
- **DTO field names:** the DTO→wire mapping tables in §2 name the exact snake_case fields
  used in the OpenAPI request bodies (`CreateLessonRequest`, `UpdateLessonRequest`,
  `CancelLessonRequest`, `MarkLessonPaidRequest`, `CreateAthleteRequest`). ✔
- **Timestamp rule:** §3 here and the `Rfc3339DateTime` schema + info-level note in OpenAPI
  state the same explicit-offset-in/out, naive-rejected rule — including the strictness
  clauses (seconds required, `Z`/`±HH:MM` only, no lenient rollover). ✔
- **Audit nullability:** §8.1 here and the `AuditEvent` schema in OpenAPI both keep
  `actor_type` / `request_id` **required** and typed `['string','null']`. ✔
- **Audit pagination:** §8.2 here and the `limit` / `cursor` parameters plus the
  `CursorPageMeta` envelope on `GET /audit-events` in OpenAPI describe the same keyset
  paging, the same default/maximum, and the same 422-not-clamp behaviour. ✔
- **Scope mapping:** the §4 matrix equals the `x-required-scopes` extensions and the
  info-level scope table in OpenAPI. ✔
- **Athlete visibility:** §5 equals `AthleteCoachView` / `AthleteAdminView` / `Athlete`
  (`oneOf`) in OpenAPI. ✔
- **Athlete ambiguity:** both files document `ATHLETE_AMBIGUOUS` as client-surfaced (a `200`
  `GET /athletes` candidate list), never a server-set status or write error; no operation
  emits it in a problem document, and `ProblemDetails` has no `candidates` field. ✔
- **409 responses:** each operation advertises only the 409 code it can actually return, and
  this is enforced **at the schema level** (not just descriptions/examples): `SlotConflict` →
  `SlotConflictProblem` (`code` const `SLOT_CONFLICT`) on PATCH; `IdempotencyConflict` →
  `IdempotencyConflictProblem` (`code` const `IDEMPOTENCY_KEY_REUSED`) on cancel, mark-paid,
  create-athlete; `LessonCreateConflict` → `oneOf` of those two on create-lesson. Each narrowed
  problem is `allOf: [ProblemDetails, {code: const …}]`, so a codegen tool sees a single-value
  `code` union per 409 (the base `ProblemDetails` and the 13-value `ErrorCode` enum are
  unchanged). ✔

---

## 8. Audit-event read contract (`GET /audit-events`)

### 8.1 Fields that are legitimately null

`actor_type` and `request_id` are **required** on `AuditEvent` (the key is always present)
and typed **`['string','null']`**:

| Field | Null when | Why it is not filled in |
|---|---|---|
| `request_id` | the write had no HTTP request (console / scheduled) | `null` means "no correlation existed". Minting an id at serialization time would let a reader join an audit row to a request that never happened. |
| `actor_type` | the write had no user actor (console / system) | The actor morph is nullable by design (spec §6). A synthetic actor would attribute an action to somebody. |

The rule is general: **the audit log is never repaired on read.** `changes` is likewise
passed through exactly as it was PII-scrubbed at write time, and `created_at` is
`NOT NULL` in the schema rather than defaulted at serialization.

### 8.2 Cursor pagination

The audit table is append-only and therefore unbounded over time, so the read is bounded:

- **`limit`** — default `50`, maximum `200`. Above the maximum → `422 VALIDATION_FAILED`
  (an explicit refusal, **not** a silent clamp: a client that asked for 5 000 rows and got
  200 without being told has a wrong answer to a question it did not ask).
- **`cursor`** — an **opaque keyset cursor** over the response's `(created_at DESC, id DESC)`
  ordering. Keyset, not offset: rows are continually appended, and an offset page repeats or
  skips a row as soon as a write lands between two requests. A cursor this endpoint did not
  issue → `422 VALIDATION_FAILED` (never silently treated as "start from the beginning").
- **Response envelope** — `{"data": [...], "meta": {"limit", "has_more", "next_cursor"}}`.
  Follow `meta.next_cursor` while `meta.has_more` is true; `next_cursor` is `null` on the
  last page. Clients pass the value back verbatim and never construct or parse one.

`id` is a ULID, so it is lexicographically time-ordered and breaks a `created_at` tie in
the same direction as the primary sort — which is what makes paging across a group of rows
sharing one timestamp neither duplicate nor drop a row.
