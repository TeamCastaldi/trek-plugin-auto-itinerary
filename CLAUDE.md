# auto-itinerary

TREK plugin (`type: integration`, no UI) that watches a dedicated family IMAP inbox for business-trip
calendar invites, parses the `.ics` payload, and builds a live TREK Trip via TREK's built-in MCP server
— so the family follows along on a public share link without the traveler touching the app.

Full architecture rationale, verified platform facts, and the detailed per-area design live in
**`docs/PLAN.md`** — read it before touching manifest permissions, egress, MCP, or IMAP code. This file
is the concise entry point: workflow, load-bearing gotchas, current TODOs, and version history.

## Workflow

Work here is driven by the numbered TODOs below. For each one: **enter plan mode first** — re-derive
and refine the approach against the current repo state and `docs/PLAN.md`, surface anything that's
changed or newly uncertain, get it reviewed — **then** implement. Don't jump straight to code on a TODO
number. Reference TODOs by their milestone number (e.g. "work on TODO M3").

## Load-bearing facts (don't relitigate these without reading `docs/PLAN.md` first)

- **`ctx.trips` cannot create a trip** — only update one. `create_trip` via MCP is the only way to spawn
  one, independent of any user-context restriction.
- **`jobs` run with no bound user.** Any `ctx.trips`/`places`/`days` call in a job throws
  `RESOURCE_FORBIDDEN`. All trip mutations must go through the MCP server using a **user-bound**
  `client_credentials` machine token (created in the owning user's Settings → Integrations → MCP, *not*
  the admin panel).
- **TREK never runs `npm install` on plugins** and strips `node_modules` at pack time. Every runtime
  dependency must be esbuild-bundled into `server/index.js`; only `trek-plugin-sdk` stays external
  (host-injected). Run `npm run build` before `dev`/`pack` (already wired into those npm scripts).
- **Egress (`http:outbound:<host>` + `egress[]`) is a host-only allowlist**, enforced at the raw
  `net.Socket.connect` layer — protocol-agnostic, so raw IMAP TLS works, not just HTTP. But loopback and
  link-local are **always** blocked (SSRF backstop), so the MCP/`oauth` calls must target the public
  `APP_URL` hostname, never `127.0.0.1`.
- Directory name (`trek-plugin-auto-itinerary`) not matching manifest `id` (`auto-itinerary`) is only a
  `validate` **warning** — confirmed empirically, not a blocker.
- **TREK's own job scheduler did not reliably invoke a sideloaded plugin's declared `jobs`** (as of
  v3.2.1) — the wiki documented "TREK owns the cron and calls your handler," but on the real family
  instance `poll-inbox` was never invoked automatically across multiple activate/deactivate/restart
  cycles, with valid, saved config, over 20+ minutes of observation and zero related lines in the
  container's logs. **Superseded**: as of TREK v3.3.0 / `trek-plugin-sdk@1.4.1`, ingestion is armed
  via `ctx.scheduler.every(ms, name, payload?)` in `onLoad` instead of a declared `jobs[]` cron entry
  — see the bullet below. `scripts/manual-run.js` (which runs the exact same production `onLoad` +
  `pollInbox` code on demand, put on a **host-level cron**) is kept as a documented fallback rather
  than removed, in case `ctx.scheduler` has gaps of its own, or the target instance predates v3.3.0.
  See README's Setup & Deployment section.
- **`ctx.scheduler` (TREK v3.3.0+ / SDK 1.4.1+) is the current ingestion trigger**, replacing the old
  `jobs[]` declaration — verified directly against the installed SDK's `dist/index.d.ts` and
  `dist/mock-host.js`, not the wiki. Real signature:
  `{ at(whenMs, name, payload?), in(ms, name, payload?), every(ms, name, payload?), cancel(name) }`,
  each returning `{scheduled: boolean}`/`{cancelled: boolean}` — a real, observable arming result,
  unlike the old declarative array. `every`'s interval floor is 60_000ms; it's an upsert by name, so
  calling it on every `onLoad` is safe. Requires the **`jobs:run`** permission (every `scheduler.*`
  call does `need('jobs:run', ...)` — this was NOT required for the old `jobs[]` array, so it had to
  be newly added to `trek-plugin.template.json`). Fires into a new top-level
  `scheduled({name, payload}, ctx)` handler on the plugin definition, userless (same restriction
  class as `jobs[]`/`onLoad` — no `ctx.trips`/etc). `trek-plugin-sdk/testing`'s `createMockHost`
  models this: `host.run(pluginDef).scheduled(name, payload?)` fires it against `userlessCtx`, and
  `host.scheduled` (a `Map<name, {dueAt, everyMs, payload}>`) records what got armed — both are
  first-class, not hand-rolled. `trek-plugin-sdk dev`'s dev context delegates `ctx.scheduler` to the
  same mock host, gated on the manifest's granted `jobs:run`, and exposes
  `POST /__dev/fire/scheduled/<name>` to manually trigger it locally — confirmed by actually running
  `npm run dev` and firing that endpoint, not just reading the source.
- **Sideloaded plugins may have no settings UI at all** — confirmed on the real instance: the only
  `...` menu options were Restart/View error logs/Delete, no Configure/Settings. Settings still have
  a real backend home (`GET`/`PUT /api/admin/plugins/:id/config`, confirmed via direct browser
  `fetch()` calls) — the API wraps the stored value in `{ config: {...} }` on read, but `PUT` expects
  the flat settings object as the body directly (not re-wrapped), storing it as-is.

## Open TODOs

### TODO M7 — Multi-account routing (per-recipient MCP credentials)

Route an invite to the correct family member's own TREK account/trip based on which address (`To`/
`Cc`) it was actually sent to, instead of every trip landing under one fixed `mcp_client_id`. Design:
a new secret settings field holding a JSON-encoded routing table (`{match, mcp_client_id,
mcp_client_secret, mcp_scopes, auto_share}[]` — there's no native array/object settings type, so a
single JSON-blob `password`-type field is the only option), matched case-insensitive substring
against `src/imap.js`'s captured `To`/`Cc` headers (mirroring the existing `sender_allowlist`
convention), first-match-wins, falling back unchanged to the base single-account settings when
nothing matches (fully backward-compatible for single-account installs).

### TODO M8 — Publish to the community registry (long-term, optional)

**Short-term deployment (private/single-account use) is done** — confirmed working against the real
family instance; see README's Setup & Deployment section for the actual steps (`pack` → sideload via
Admin → Plugins → activate → configure settings). No signing, no GitHub release, no registry PR
needed for that path at all.

This TODO is only for *eventually* publishing to the public `mauriceboe/TREK-Plugins` registry, so
other TREK users can install it — not required for our own use:

- `keygen`/`sign` (Ed25519) — sideloaded installs never require this; it only matters for
  registry-verified installs (trust-on-first-use key pinning).
- A real `docs/screenshot.png` or similar (note: `docs/` is excluded from the packed artifact, so
  this only matters for the README, not the zip) — `trek-plugin preflight`'s README gate requires
  `## What it does`/`## Screenshots`/`## Permissions`/`## Setup` sections, ≥400 chars of real prose,
  at least one resolvable screenshot image, and every declared manifest permission mentioned in the
  README's prose.
- A tagged GitHub release with the packed `plugin.zip` as a release asset.
- `trek-plugin entry` (builds the registry JSON entry from the manifest + release + optional
  signature) → `preflight` (runs the registry's CI checks locally, over the network, before opening
  a PR) → `submit` (forks `mauriceboe/TREK-Plugins`, commits the entry, opens the PR).

### TODO M9 (v1.1) — Modular Extraction & Router

Update `src/extract.js` to return the full email payload (falling back to plain text or HTML if no `.ics` is found). Create a new parsing router (`src/parse-router.js`) that iterates through a registry of isolated parser strategies (e.g., `ics`, `amex`, `concur`). The router will ask each strategy `canParse(emailPayload)`, and delegate to the first one that returns true.

### TODO M10 (v1.1) — Parser Shards (`src/parsers/`)

Move the existing `node-ical` logic into `src/parsers/ics.js`. Build `src/parsers/amex.js` to extract data from AMEX emails. *Crucial constraint:* Every parser shard must implement the exact same interface and output a normalized `VEVENT`-style object array (`summary`, `start`, `end`, `location`, `description`). This guarantees the downstream MCP orchestrator (`src/mcp/orchestrate.js`) remains completely agnostic to where the data came from.

### TODO M11 (v1.1) — Ledger & Idempotency Pivot

*(Same as previous)* Modify the `processed_invites` database schema. Since unstructured emails lack the standard iCalendar `UID` and `SEQUENCE` fields, implement a secondary deduplication strategy. Use a deterministic hash (e.g., `hash(PNR + StartDate)`) or the RFC822 `Message-Id` as the primary key for unstructured emails to safely handle updates.

### TODO M12 (v1.1) — Fixtures, Verification & Release

Add raw `.eml` fixtures for the new parser shards (AMEX, Concur). Write unit tests for each isolated parser in `test/parsers/` to ensure their normalized output matches expectations. Update settings/manifest as needed. Bump version to `1.1.0`, validate, pack, and publish.

## Version history

- **0.1.0** (2026-07-06)
  - M0 — Discovery/planning: full architecture blueprint verified against TREK's live wiki and
    `plugin-sdk`/server source (not assumed).
  - M0.5 — Egress-enforcement spike: source-read of TREK's plugin runtime confirmed (high confidence)
    that raw IMAP-over-TLS passes the egress guard, since it patches the universal `net.Socket.connect`
    choke point rather than being HTTP-only. Unblocked ingestion Option A (IMAP direct).
  - M1 — Initial scaffold: `trek-plugin.json` manifest + settings schema, `definePlugin` skeleton
    (`processed_invites` ledger migration, stubbed `poll-inbox` job), esbuild build pipeline. Validates
    clean; bundle smoke-tested. (PR #1)
  - Addressed Copilot PR review: clarified README ledger-status wording, declared `engines.node
    >=20.12.0` in `package.json` (matches `@clack/core`'s transitive requirement via`trek-plugin-sdk`).
  - M2 — Ingestion + `.ics` parsing: real `imap-simple` connect (`src/imap.js`) → `mailparser`
    calendar-part extraction (`src/extract.js`) → `node-ical` VEVENT normalization (`src/parse.js`,
    including all-day/TZ/multi-VEVENT/CANCEL handling) → keyword classifier (`src/classify.js`), wired
    into the `poll-inbox` job handler (log-only for now — MCP calls and ledger writes are still M3/M4).
    13 fixture-based unit tests (`node:test`, no new test-framework dependency) cover
    `.eml`/`.ics` extraction and parsing. Resolved manifest open note **O1**: `trek-plugin.json` is now
    generated at build time from `trek-plugin.template.json`, with `http:outbound:<host>` + `egress`
    entries populated per host from the `EGRESS_HOSTS` env var, so each installer bakes in their own
    IMAP host without hand-editing the manifest. Live IMAP smoke test script added
    (`scripts/smoke-imap.js`, env-var driven, skips cleanly without credentials). **Live smoke test run
    and passed** against the real family mailbox (Gmail/Workspace, `imap.gmail.com:993` TLS) — real
    `tls.connect` + IMAP login + UNSEEN search succeeded, empirically confirming the R1 egress
    prediction (M0.5) for actual raw IMAP traffic, not just source-code reasoning. Also confirmed
    empirically: a Workspace "alternate email" is a send-as alias into the *primary* account's mailbox,
    not its own IMAP-authenticatable inbox — `imap_user` must be the primary account
    (`you@example.com`), while the alternate address (`trek@example.com`) is only what
    gets added as a guest on the calendar invite.
  - M3 — MCP client + trip-build orchestration: hand-rolled Streamable HTTP JSON-RPC client
    (`src/mcp/client.js`) — no `@modelcontextprotocol/sdk` dependency, rejected after research showed
    its client transport still requires wrapping `fetch` for auth (typescript-sdk#495) while pulling in
    express/hono/cross-spawn irrelevant to a pure outbound client. Token manager (`src/mcp/token.js`,
    form-urlencoded `client_credentials`, ~55 min cache, force-refresh on 401) → session `initialize` +
    `Mcp-Session-Id` tracking → `tools/list` (cached per session) → orchestration
    (`src/mcp/orchestrate.js`) folding one invite's VEVENTs into one `create_trip` →
    `create_and_assign_place` → `create_accommodation`/`create_transport`/`create_reservation` →
    optional `create_share_link`, per the locked "one invite → one trip" decision. Every guessed MCP
    field name (real `inputSchema`s are undocumented pending a live `tools/list` call) is isolated in
    `src/mcp/payloads.js` behind `SCHEMA-GUESS` comments, plus a best-effort schema-presence warning
    logged (never a hard failure) when a guess doesn't match the live schema. Wired into `poll-inbox` in
    place of the M2 log-only loop. 29 new tests (`node:test`, 43 total in the suite) cover the token
    cache/refresh, session
    handshake/retry (401/429/403, JSON and SSE response parsing) against a `node:http`-based mock TREK
    server, pure payload builders, and orchestration sequencing (single/multi-VEVENT folding,
    mid-sequence failure propagation, cancelled-event filtering) against a fake session. Deferred to M4
    by design: ledger wiring, update/cancellation-of-existing-trip detection, and any duplicate-trip
    guard for the repeat-processing gap this creates until M4's mail-flagging lands. Full live-instance
    verification (real OAuth exchange, real tool schemas) not yet done — needs a live TREK instance,
    tracked as residual risk for M5.
  - M4 — Idempotency & state ledger: `src/ledger.js` wires the `processed_invites` table into real
    use. Resolved the ledger-key ambiguity left open since M1: since one message can carry multiple
    VEVENTs with different UIDs but the locked model is one message = one trip, the `uid` PK now holds
    the message's first active event's UID as a stand-in identifier (see `docs/PLAN.md` §4). Two-phase
    write: `beginProcessing` (insert/resume `in_progress`, preserving any prior `trip_id`) →
    `recordTripCreated` (persists `trip_id` immediately after a fresh `create_trip`, before any
    sub-entity calls, via a new `onTripCreated` hook on `buildTripForMessage`) → `markDone`. A stale
    `in_progress` row with a stored `trip_id` resumes the build against it (skipping `create_trip`,
    via `buildTripForMessage`'s new `existingTripId` option) rather than searching `list_trips`; a
    `NULL` `trip_id` on a stale row is safe to retry from scratch. `SEQUENCE`/content-hash-based
    update detection logs a warning and refreshes the ledger fingerprint without calling any MCP
    update tool (full per-entity delta updates need real, currently SCHEMA-GUESS, `inputSchema`s from
    a live instance — deferred past M4, flagged explicitly rather than guessed at). An all-cancelled
    invite marks the ledger `cancelled` (trip left as-is, no auto-revoke). `src/imap.js` split into
    `openConnection`/`searchUnseen` (now also extracts `Message-Id`) so the connection stays open for
    the whole job run, plus a best-effort `markProcessed` (marks `\Seen`, optionally moves to a new
    `processed_folder` instance setting) as the mail-flag second guard. `poll-inbox`'s handler logic
    was extracted into an exported, dependency-injectable `processMessage` for testing. 21 new tests
    (64 total): ledger round-trip/resume/hash stability, IMAP flag/move/best-effort-failure and
    `Message-Id` extraction, orchestrate's resume/`onTripCreated` paths, and a full
    `poll-inbox` branch-matrix integration test (new invite, no-op re-poll, sequence-bump warning,
    cancel-after-done, cancel-with-no-prior-trip, in-progress resume, build failure).
  - Addressed Copilot PR review (PR #4): `computePayloadHash` was hashing `event.sequence` despite
    being documented as SEQUENCE-independent, so a pure `SEQUENCE` bump with no real content change
    would still fire the "changed content/sequence" warning. Dropped `sequence` from the hashed
    fields and added a regression test asserting hash stability across a sequence bump alone (65
    total tests).
  - M5 — Verification harness: installed the real `trek-plugin-sdk@1.3.1` (previously never present
    in `node_modules` in this checkout) and confirmed all 65 existing tests pass unmodified.
    `test/permissions.test.js` (4 tests) uses the real `createMockHost` from `trek-plugin-sdk/testing`
    to prove `onLoad` succeeds under `db:own`, an ungranted `ctx` call throws `PERMISSION_DENIED`, a
    job-context trip read (no `actingUserId`) throws `RESOURCE_FORBIDDEN`, and — plugin-specific —
    `processMessage` never calls any `ctx` surface outside `db:own`. `test/mcp-integration.test.js`
    (1 test) closes the mock-server half of the "MCP integration" row by driving `processMessage`
    with the real `createSession`/`buildTripForMessage` (not in-memory fakes) against an HTTP
    `startMockTrekServer`, asserting a full trip build with a share link and an idempotent no-op
    re-poll (70 total tests). `scripts/smoke-bundle.js` (`npm run smoke`) loads the esbuild output
    from a scratch directory with only a stubbed `trek-plugin-sdk` present, proving the bundle has no
    stray unbundled `require`s. `scripts/smoke-dev.js` (`npm run smoke:dev`) automates a real
    `trek-plugin-sdk dev` run against a new root `dev-fixtures.json`. Corrected a PLAN.md assumption
    along the way, source-verified against the installed SDK: `trek-plugin-sdk dev` never executes
    `plugin.jobs` (only `onLoad` + `routes`), so the "Local run" verification row proves manifest/
    permission loading, not job execution — see `docs/PLAN.md` §5. `scripts/e2e-mcp.js`
    (`npm run e2e:mcp`) is the real-docker leg: env-var-gated like `scripts/smoke-imap.js`, confirmed
    to skip cleanly with no credentials, but **not yet run against a live TREK instance** — no Docker
    daemon was available in this environment; a runbook for running it is in `docs/PLAN.md` §5.
  - Added `E2E_DRY_RUN` to `scripts/e2e-mcp.js`: prints the live `tools/list` `inputSchema` for every
    tool a fixture would call, then stops before any `create_*` call — lets schemas be vetted
    against every `SCHEMA-GUESS` in `src/mcp/payloads.js` without creating a real trip.
  - **First live run against a real TREK instance** (2026-07-07) surfaced a real schema bug: the
    initial run predated the `E2E_DRY_RUN` pull and created a live trip for real, whose error
    response revealed `create_trip` returns `{ trip: { id, ... } }` (the full row nested under
    `trip`), not the guessed bare `{ tripId }`. Fixed in `src/mcp/orchestrate.js` via new
    `extractEntity`/`extractId` helpers that unwrap `{ <entity>: {...} }` first and fall back to the
    old flat guess for resilience; added a regression test using the real captured response shape
    (71 total tests). The other `create_*` tools' result shapes are still unconfirmed guesses,
    updated to note they *assume* the same wrapping convention pending their own live verification.
  - M6 — Fix real MCP payload schemas: a full live `tools/list` pass (`E2E_DRY_RUN`,
    `E2E_SCHEMA_TOOLS`, and a new `E2E_INSPECT_DAYS=1` script mode that creates one throwaway trip
    to observe `create_trip`'s auto-generated days and `get_trip_summary`'s response shape — neither
    is visible from an `inputSchema` alone) resolved every remaining `SCHEMA-GUESS` in
    `src/mcp/payloads.js`/`src/mcp/orchestrate.js`. Trips are made of `day` rows
    (`{id, trip_id, day_number, date}`) auto-generated across `[start_date, end_date]`; every
    sub-entity tool wants an integer `dayId`/`start_day_id`/`end_day_id`, not a raw date — added
    `resolveDayMap` (`get_trip_summary` → `Map<date, dayId>`), called once per trip build (fresh or
    resumed), with each event's date resolved before its `create_*` call (throws immediately if a
    date falls outside the trip's own range — should never happen, but is now an explicit invariant
    rather than a silently-`undefined` field). Id casing turned out to be **per-tool, not one
    convention**: `create_and_assign_place`/`create_transport`/`create_share_link` want `tripId`/
    `dayId` camelCase but snake_case `start_day_id`/`end_day_id`; `create_accommodation`/
    `create_reservation` are snake_case throughout. Rewrote every builder in `src/mcp/payloads.js`
    field-by-field against the verified schemas: dropped `create_transport`'s guessed `place_id`
    (doesn't exist — location belongs in a structured `endpoints` array, deferred, not implemented),
    renamed its `departure_time`/`arrival_time` to `reservation_time`/`reservation_end_time`;
    `create_reservation` now sends the verified `type:'other'` (enum is
    `hotel|restaurant|event|tour|activity|other`, and the classifier can't distinguish finer) plus a
    `location` string instead of an unused place reference; `create_accommodation`'s `check_in`/
    `check_out` are now `"HH:MM"` time-of-day strings (new `toTimeOnly` helper, `undefined` for
    all-day events) instead of guessed full timestamps, and it no longer sends a nonexistent `title`
    field. Updated `test/mcp-payloads.test.js`/`test/mcp-orchestrate.test.js`/
    `test/mcp-integration.test.js` throughout, including a `get_trip_summary` mock in every
    orchestrate test that reaches day resolution and a new test asserting the explicit
    date-not-found error (73 total tests). Renumbered the roadmap to make room: multi-account
    routing is now **M7**, community-registry publishing is **M8**, and the v1.1
    unstructured-ingestion milestones are now **M9–M12**. **Confirmed live** (2026-07-07): a full
    non-dry-run `npm run e2e:mcp` against `travel.castaldifamily.com` for all three remaining
    fixtures — `flight.ics` (trip 5, `create_transport`), `hotel.ics` (trip 6,
    `create_accommodation`), `generic.ics` (trip 7, `create_reservation`) — each completed
    end-to-end with **zero schema-guess mismatches** and rendered correctly in the app. TODO M6 is
    fully closed. Five trips from this milestone's live debugging (ids 3–7, two throwaway/broken
    plus three working confirmations) are safe to delete manually from the app — there is no
    `delete_trip` tool.
  - **Sideload deployment confirmed** (2026-07-07): `npm run pack` → Admin → Plugins upload on
    `travel.castaldifamily.com` succeeded, no signing required, landed inactive, activated
    manually, settings configured. This is the complete deployment path for private/single-account
    use — see README's Setup & Deployment section. Split TODO M8 (previously "Package, sign, publish") into
    this now-done short-term path and a long-term-only "publish to the community registry" TODO.
  - **Live end-to-end mail test + TREK scheduler investigation** (2026-07-07): sent a real external
    test email (with a real `.ics` attachment) to the monitored mailbox and found it was never
    ingested. Root-caused through a full diagnostic pass: confirmed IMAP connectivity/credentials
    were correct throughout (`scripts/smoke-imap.js`, after fixing it — see below); discovered the
    sideloaded plugin had **no settings UI** at all (only Restart/Error log/Delete in its menu), so
    `ctx.config` had been empty since install; configured real settings via direct
    `PUT /api/admin/plugins/auto-itinerary/config` calls (confirming the API's request/response
    wrapping asymmetry, documented above); then, even with valid config and a Restart, TREK's own
    cron still never invoked `poll-inbox` (re-confirmed with a second, untouched test email and a
    live docker-logs tail showing zero plugin/scheduler activity) — a platform-level gap, not
    something in this plugin's code. Along the way: fixed `scripts/smoke-imap.js`, which had rotted
    since M4's `src/imap.js` refactor and crashed immediately (`fetchUnseenMessages` no longer
    exists — replaced with `openConnection`/`searchUnseen`); added `scripts/manual-run.js`, which
    runs the real, unmodified `onLoad` + job `handler` (pulled directly off `src/index.js`'s
    exports) against a real mailbox/TREK instance, backed by a real `node:sqlite` ledger for correct
    idempotency — used to prove the pipeline itself works perfectly (built a real trip end-to-end
    from a genuine external email) independent of TREK's scheduler, and is now the documented
    interim path to real automation via a host-level cron entry (see README). Also fielded and
    disregarded, with independent re-verification against the wiki, an unsolicited/unverifiable
    message claiming the opposite architecture (plugins must self-schedule via `setInterval`) —
    treated as an unreliable source rather than acted on.
  - **Ingestion trigger: `jobs[poll-inbox]` → `ctx.scheduler`** (TREK v3.3.0 / `trek-plugin-sdk@1.4.1`).
    A separate attempt to fix the scheduler gap above by switching ingestion to a push-based Resend
    webhook was built, tested end-to-end, and explicitly backed out (PR #8 closed unmerged) — the
    decision was to minimize external dependencies and stay within TREK's own plugin mechanisms.
    `ctx.scheduler.every(60_000, 'poll-inbox')` is now armed in `onLoad` (upsert by name, safe on
    every restart/reload) instead of a declared `jobs: [{id, schedule}]` array, firing into a new
    `scheduled({name, payload}, ctx)` handler. The old `jobs[0].handler` body (IMAP connect →
    `searchUnseen` → loop `processMessage` → `finally connection.end()`) was extracted verbatim into
    a standalone exported `pollInbox(ctx)`, called both from `scheduled()` and directly by
    `scripts/manual-run.js` (which no longer reaches into `plugin.jobs[0].handler` — that array no
    longer exists). `trek-plugin.template.json` gained the `jobs:run` permission (newly required,
    unlike the old `jobs[]`) and its `trek` compatibility range was tightened to `>=3.3.0 <4.0.0`
    since `ctx.scheduler` doesn't exist on older hosts and installing there should fail manifest
    validation up front rather than throw an opaque `TypeError` on first load.
    `trek-plugin-sdk` devDependency bumped `^1.3.1` → `^1.4.1`. `test/permissions.test.js` gained
    scheduler-specific coverage using `createMockHost`'s real `scheduled`/`run(def).scheduled(name)`
    testing surface (confirmed to exist in the installed SDK, not hand-rolled): arming succeeds and
    is recorded, arming without `jobs:run` throws `PERMISSION_DENIED`, firing `poll-inbox` touches no
    `ctx` surface outside `db:own`, and an unrecognized task name is a no-op. `scripts/smoke-bundle.js`
    now asserts `onLoad`/`scheduled`/`pollInbox` are present instead of the old `jobs[0]` shape.
    Manually verified against the real `trek-plugin-sdk dev` CLI (not just unit tests): `onLoad` logs
    `poll-inbox scheduler armed: true`, and `POST /__dev/fire/scheduled/poll-inbox` correctly
    dispatches into `pollInbox` (observed a clean IMAP-connection-refused failure in the credential-
    less dev environment, proving the dispatch wiring itself works). 77 total tests, all green. The
    host-cron fallback (`scripts/manual-run.js`) is retained, reframed in the README as a fallback
    rather than the default assumption of brokenness — not yet verified whether `ctx.scheduler`
    itself is reliably invoked by TREK on the real family instance (that requires sideloading this
    version and observing it over time, same as how the original `jobs[]` gap was discovered).
  - **Real-instance sideload test — mixed results, `ctx.scheduler`'s in-app reliability still an open
    question.** Confirmed TREK v3.3.0 is actually running on the family instance (container startup
    banner). Two deployment mistakes surfaced and were fixed along the way, neither a plugin bug:
    `trek_base_url` was misconfigured as `trek.castaldifamily.com` instead of the real
    `travel.castaldifamily.com` (caused `/oauth/token` 404s), and the manifest's `egress[]` was baked
    at pack time with the same wrong host — `PUT /api/admin/plugins/:id/egress-hosts` (a v3.3.0
    `operatorEgress` feature) rejected adding the correct host at runtime with
    `"plugin auto-itinerary did not declare operatorEgress"`, since this manifest doesn't opt into
    that flag, so fixing egress required a full repack + re-upload.

    With config corrected, the scheduler **did** fire reliably for a short observed window —
    `poll-inbox` errors landed in the plugin's error log at ~60s intervals (`00:13:55`, `00:14:54`,
    `00:15:54`), each one correctly finding the same test message (`uid=90482`). But after the
    egress-corrected version was re-uploaded and the plugin restarted, `ctx.scheduler` went **silent
    for hours** — no further log lines of any kind (not even errors), no trip built, test email still
    unread. Root cause not identified: config was re-verified intact via a live `GET`, so it wasn't a
    wiped-settings issue; whether `onLoad` even re-ran after that particular restart/reinstall is
    unconfirmed, since the admin UI's "Error log" modal appears to be error-level only — `ctx.log.info`
    (which is what "scheduler armed" and "found N unseen message(s)" log at) may not be visible there
    at all, meaning "no errors logged" was never actually evidence that anything ran successfully.
    **This is the same shape of gap as the original `jobs[]` problem** (a mechanism that worked in
    isolated testing but couldn't be confirmed reliably invoking on the real sideloaded instance) —
    open, unresolved, and worth raising with the TREK maintainer(s) directly rather than continuing to
    guess at it blind from outside the container.

    To unblock real end-to-end verification without waiting on that open question, `scripts/manual-run.js`
    was run directly against the real mailbox/instance (bypassing TREK's scheduler entirely, calling
    `onLoad` + `pollInbox` as plain Node) — first run failed with a genuine, previously-unknown parsing
    bug (see next entry), second run **built a real trip successfully** (`trip 9`) from the same
    still-unread test email. This is the actual, confirmed end-to-end proof for this milestone: the
    ingestion → parse → classify → MCP pipeline works correctly against a real Google Calendar invite.
    Whether `ctx.scheduler` reliably *triggers* that pipeline unattended inside TREK itself remains
    unconfirmed — same honest caveat as the entry above, now backed by a real (partial, concerning)
    observation instead of just "not yet tested."
  - **Fixed a real parsing bug found via the manual-run.js test above**: `src/parse.js` assumed
    `event.summary`/`.description`/`.location` from `node-ical` are always plain strings. True for
    every fixture in this repo, false for a real Google Calendar-generated invite — Google adds a
    `LANGUAGE=en` parameter (e.g. `SUMMARY;LANGUAGE=en:Flight to NYC`), which makes `node-ical` return
    `{ params, val }` instead of a string. Reproduced directly against `node-ical` locally to confirm
    before fixing (not assumed from the iCalendar spec). `create_trip`'s `title` was receiving that
    object wholesale, failing MCP's input validation (`expected: "string", received: "object"`). Added
    a `textValue()` unwrap helper in `src/parse.js` applied to `summary`/`description`/`location` (not
    `uid`, which has no known real-world parameterization case and wasn't touched, to keep the fix
    minimal). New regression test in `test/parse.test.js` using an inline `.ics` with parameterized
    fields, asserting plain-string output. 78 total tests, all green. This bug was invisible to every
    prior verification pass (unit tests, mock-host tests, `trek-plugin-sdk dev`, even the M6 live E2E
    runs) because none of those ever fed the pipeline a real Google Calendar-generated `.ics` — only
    hand-written fixtures and manually-crafted E2E script payloads, none of which happened to include
    parameterized properties.
