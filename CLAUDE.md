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

### TODO M8 — Package, sign, publish

`trek-plugin-sdk validate` + `pack`, `keygen`/`sign` (Ed25519), sideload to Admin → Plugins; optionally
a `docs/screenshot.png` (note: `docs/` is excluded from the packed artifact, so this only matters for
the registry listing) and a registry PR to `mauriceboe/TREK-Plugins`.

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
    routing is now **M7**, packaging is **M8**, and the v1.1 unstructured-ingestion milestones are
    now **M9–M12**. **Confirmed live** (2026-07-07): a full non-dry-run `npm run e2e:mcp` against
    `travel.castaldifamily.com` for all three remaining fixtures — `flight.ics` (trip 5,
    `create_transport`), `hotel.ics` (trip 6, `create_accommodation`), `generic.ics` (trip 7,
    `create_reservation`) — each completed end-to-end with **zero schema-guess mismatches** and
    rendered correctly in the app. TODO M6 is fully closed. Five trips from this milestone's live
    debugging (ids 3–7, two throwaway/broken plus three working confirmations) are safe to delete
    manually from the app — there is no `delete_trip` tool.
