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

### TODO M2 — Ingestion + `.ics` parsing
Real IMAP connect (`imap-simple`/`node-imap`) → `mailparser` (extract `text/calendar`) → `node-ical`
(parse `VEVENT`s) → the event-type classifier in `docs/PLAN.md` §3. Unit-test against fixture
`.eml`/`.ics` files. Include the live IMAP smoke test (first real connect against a real mailbox from a
real TREK instance) to empirically confirm the source-verified R1 prediction in `docs/PLAN.md`.
**Needs:** real or fixture IMAP credentials.

### TODO M3 — MCP client + trip-build orchestration
Token manager for `client_credentials` against the public `APP_URL` host (`POST /oauth/token`, cache
~55 min, no refresh token), Streamable HTTP session to `/mcp`, `tools/list` to read live `inputSchema`s,
then `create_trip` → `create_and_assign_place`/`create_place` → `create_accommodation`/
`create_transport`/`create_reservation` → optional `create_share_link`. See `docs/PLAN.md` §3.
**Needs:** live TREK instance + MCP machine client (`client_id`/`client_secret`, scopes `trips:write
places:write reservations:write trips:share`).

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
