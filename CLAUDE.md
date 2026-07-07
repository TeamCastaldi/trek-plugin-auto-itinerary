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

### TODO M4 — Idempotency & state ledger

Wire the `processed_invites` ledger (schema already migrated in `src/index.js`) into real use:
two-phase write (`in_progress` → `done`), `SEQUENCE`-based update detection, `CANCEL` handling,
mail-flag second guard (`\Seen` / processed folder). See `docs/PLAN.md` §4.

### TODO M5 — Verification harness

`createMockHost` permission-scope tests (`PERMISSION_DENIED` / `RESOURCE_FORBIDDEN`), mock-MCP
integration tests, `trek-plugin-sdk dev` + `dev-fixtures.json` run, real TREK docker E2E, bundle smoke
test. See `docs/PLAN.md` §5.

### TODO M6 — Package, sign, publish

`trek-plugin-sdk validate` + `pack`, `keygen`/`sign` (Ed25519), sideload to Admin → Plugins; optionally
a `docs/screenshot.png` (note: `docs/` is excluded from the packed artifact, so this only matters for
the registry listing) and a registry PR to `mauriceboe/TREK-Plugins`.

### TODO M7 (v1.1) — Modular Extraction & Router

Update `src/extract.js` to return the full email payload (falling back to plain text or HTML if no `.ics` is found). Create a new parsing router (`src/parse-router.js`) that iterates through a registry of isolated parser strategies (e.g., `ics`, `amex`, `concur`). The router will ask each strategy `canParse(emailPayload)`, and delegate to the first one that returns true.

### TODO M8 (v1.1) — Parser Shards (`src/parsers/`)

Move the existing `node-ical` logic into `src/parsers/ics.js`. Build `src/parsers/amex.js` to extract data from AMEX emails. *Crucial constraint:* Every parser shard must implement the exact same interface and output a normalized `VEVENT`-style object array (`summary`, `start`, `end`, `location`, `description`). This guarantees the downstream MCP orchestrator (`src/mcp/orchestrate.js`) remains completely agnostic to where the data came from.

### TODO M9 (v1.1) — Ledger & Idempotency Pivot

*(Same as previous)* Modify the `processed_invites` database schema. Since unstructured emails lack the standard iCalendar `UID` and `SEQUENCE` fields, implement a secondary deduplication strategy. Use a deterministic hash (e.g., `hash(PNR + StartDate)`) or the RFC822 `Message-Id` as the primary key for unstructured emails to safely handle updates.

### TODO M10 (v1.1) — Fixtures, Verification & Release

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
