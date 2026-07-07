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

### TODO M5 — Verification harness
`createMockHost` permission-scope tests (`PERMISSION_DENIED` / `RESOURCE_FORBIDDEN`), mock-MCP
integration tests, `trek-plugin-sdk dev` + `dev-fixtures.json` run, real TREK docker E2E, bundle smoke
test. See `docs/PLAN.md` §5.

### TODO M6 — Package, sign, publish
`trek-plugin-sdk validate` + `pack`, `keygen`/`sign` (Ed25519), sideload to Admin → Plugins; optionally
a `docs/screenshot.png` (note: `docs/` is excluded from the packed artifact, so this only matters for
the registry listing) and a registry PR to `mauriceboe/TREK-Plugins`.

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
    >=20.12.0` in `package.json` (matches `@clack/core`'s transitive requirement via `trek-plugin-sdk`).
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
