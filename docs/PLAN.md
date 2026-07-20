# auto-itinerary — Architecture & Design Reference

> This is the technical reference: verified platform facts, the corrected assumptions behind the
> design, and the detailed per-area plan. For current status and open work, see `CLAUDE.md` at the
> repo root — that file is the single source of truth for the TODO list and version history; this
> file does not duplicate it.
>
> All platform facts below were verified against the live TREK wiki and `plugin-sdk`/server source
> (`github.com/mauriceboe/TREK`), not assumed. Load-bearing facts carry a source note.

## Context

The traveler receives a business-trip **calendar invite (`.ics`)** and adds a dedicated family
IMAP inbox as a guest/recipient. This plugin is an **invisible, headless background service** that
polls that inbox, parses the invite, and creates a fully-structured **TREK Trip** (trip + place +
accommodation/transport/reservation) so the family watches a **live itinerary via TREK's public
share link** — with zero app interaction from the traveler and no clutter in family personal
calendars.

- Plugin id: `auto-itinerary` · repo: `trek-plugin-auto-itinerary` · type: **`integration`** (no UI).
- Constraint: **pure JavaScript, CommonJS, zero native modules** (`.node`/`binding.gyp`/`prebuilds/`
  are rejected at pack + install time — regex-enforced in `plugin-sdk/src/cli/pack.ts`).
- Trip creation happens through TREK's **built-in MCP server** over HTTP using an OAuth 2.1
  **`client_credentials`** machine client — because the core `ctx` API cannot create trips and, in a
  background job, cannot act as a user at all (see corrections below).

---

## Corrections to the original brief (these change the design — read first)

| # | Original assumption | Verified reality | Impact |

|---|---|---|---|
| 1 | `jobs` (and `hooks`/`entryPoints`) are manifest fields | **Jobs live in server code** via `definePlugin({ jobs:[…] })` in `server/index.js`. The manifest only declares `permissions`, `egress`, `capabilities`, deps, `settings`. | Cron schedule is code, not JSON. |
| 2 | `ctx.trips.*` is barred in jobs, so route via MCP | True **and stronger**: there is **no `ctx.trips.create` at all** (ctx can only *update* a trip / add places/days). MCP `create_trip` is the *only* way to spawn a Trip — independent of the no-user rule. | MCP is mandatory, not a workaround. |
| 3 | MCP "Machine client credentials" provisioned in Admin → MCP Tokens | Machine clients are created in **user Settings → Integrations → MCP → OAuth Clients → "Machine client (no browser login)"**. The **Admin → MCP Tokens** panel is **view/revoke only**. Token is **user-bound** ("acts as its owner"). Max 10 clients/user. | Setup doc + the token carries a real user identity (this is *why* it sidesteps the no-user job limit). Trips are owned by that user. |
| 4 | Need to satisfy "iframe CSP restrictions" | `integration` plugins have **no iframe / no client UI**, so `connect-src`/CSP does **not** apply to us. Egress is enforced **server-side only** via `egress[]`. | Drop all CSP concerns; focus on `egress[]` + `http:outbound`. |
| 5 | Pack deps into the zip (vendored `node_modules`) | `pack` **strips `node_modules`** and TREK **never runs `npm install`**. Third-party deps must be **bundled** into `server/` (e.g. esbuild → CommonJS). `trek-plugin-sdk` must stay a **devDependency, marked external** (injected at runtime). | Build step = bundler; "vendor" means "inline into `server/`". |
| 6 | Transport creation is under trips | `create_transport` requires **`reservations:write`**, not `trips:write`. | Scope set must include `reservations:write`. |
| 7 | `http:outbound` covers IMAP + "local MCP loopback" | **Egress is a HOST-ONLY allowlist** (hostnames/`*.wildcards` only — no ports, so `mailhost:993` is inexpressible; protocol never stated in docs, later confirmed protocol-agnostic from source — see R1). **Loopback (`127.0.0.1`/`::1`) and link-local are ALWAYS blocked by an SSRF backstop, even when allow-listed** (`ALLOW_INTERNAL_NETWORK=true` only relaxes RFC-1918, and only for "integrations" — plugins not named). So the MCP call **cannot target `127.0.0.1`** — it must use the public `APP_URL` host. See R1/R1a. | Both ingestion and MCP reachability had to be reworked vs the brief. |
| 8 | Once activated, TREK's scheduler automatically invokes a sideloaded plugin's declared `jobs` — per the wiki, "TREK owns the cron and calls your handler" | **Empirically false on at least one real self-hosted instance** (v3.2.1): across multiple activate/deactivate/Restart cycles, with valid saved settings, `poll-inbox` was never invoked — confirmed via a live docker-logs tail (`--since 20m`) showing zero scheduler/plugin activity while an untouched UNSEEN test message sat waiting. Root cause is server-side; not something this plugin's code can fix. Also found along the way: this instance's admin UI had **no settings screen at all** for the sideloaded plugin (only Restart/Error log/Delete) — settings had to be set directly via `PUT /api/admin/plugins/:id/config` (flat body; the `{ config: {...} }` wrapper only appears on `GET` reads, not expected on write). See R5. | `scripts/manual-run.js` (real `onLoad`+job `handler`, unmodified) on a **host-level cron** is the confirmed-working interim path — see README's Setup & Deployment step 4. |

---

## Verified platform reference (ground truth)

**Manifest `trek-plugin.json`** — required: `id` (`^[a-z][a-z0-9-]{2,39}$`; a mismatched directory
name is only a `validate` **warning**, not an error — confirmed empirically), `name`, `version`
(semver), `type` (`integration|page|widget|trip-page`). Optional: `apiVersion` (default `1`), `trek`
(host semver range e.g. `">=3.2.1 <4.0.0"`), `author`, `description`, `license`, `icon`, `homepage`,
`nativeModules` (must be false/absent), `permissions[]`, `egress[]` (required when any
`http:outbound`), `capabilities.*`, `requiredAddons[]`, `pluginDependencies[]`, `settings[]`, and a
`routes[]` metadata mirror (method/path/auth) for any routes also declared in code — we don't use
routes. Validation is code-based (`validateManifest` in `plugin-sdk/src/manifest.ts`); run
`trek-plugin-sdk validate` (or `npm run validate`).

**Permissions we need:** `db:own` (isolated SQLite) today; `http:outbound:<host>` (host-scoped) +
matching `egress[]` entries. A host in `egress[]` without the matching `http:outbound:<host>`
permission is **silently blocked at runtime** — the two must mirror exactly.

**`ctx` surface (server code):** `ctx.db.query/exec/migrate` (own SQLite), `ctx.config` (resolved
settings, secrets decrypted server-side), `ctx.log.info/warn/error`, `ctx.id`, plus user-scoped
`ctx.trips/places/days/itinerary/costs/meta/...` that are **membership-checked and refuse with
`RESOURCE_FORBIDDEN` when there is no bound user** (i.e. in `jobs` and `onLoad`). No `ctx.http`,
`ctx.fetch`, `ctx.mcp`, or `ctx.secrets` — outbound HTTP uses a plain runtime primitive (global
`fetch`/Node `net`/`tls` — all funnel through the same patched egress choke point, see R1), secrets
arrive via `ctx.config`.

**Execution contexts:** `routes` (bound to request user) · `jobs` (scheduled, **no user**) · `hooks`
(bound to triggering user, short timeout — and `hook:calendar-source` is **reserved/non-functional**,
"no core consumer calls them yet", so it is not a usable ingestion primitive) · `widget/page` (iframe).
All run in plain forked Node child processes (not a VM sandbox). **v3.3.0+ adds `ctx.scheduler`**
(`at`/`in`/`every`/`cancel`, needs `jobs:run`): runtime-armed, persistent timers firing into a
`scheduled({name, payload}, ctx)` handler, same userless restriction class as `jobs` but armed by the
plugin itself (with an observable `{scheduled: boolean}` result) instead of a declarative array the
host has to discover — this is what `poll-inbox` now uses, see §3.

**MCP server** (`server/src/mcp`, transport = `StreamableHTTPServerTransport`):

- Endpoint `POST {APP_URL}/mcp` (Streamable HTTP; JSON-RPC + SSE leg; `Mcp-Session-Id` header). `403`
  if the MCP addon is disabled, `401` on auth failure.
- Auth: `POST {APP_URL}/oauth/token` with `grant_type=client_credentials`, `client_id`, `client_secret`,
  `scope=...`. Returns a `trekoa_` bearer, **1h TTL, no refresh** — re-request silently. `APP_URL`
  must be set server-side or OAuth discovery fails. `mcp-remote` cannot do `client_credentials` — the
  plugin speaks the protocol itself.
- Scopes for itinerary building: **`trips:write`** (trip, days, day notes, accommodations, members),
  **`places:write`** (places + day assignments), **`reservations:write`** (transports **and**
  reservations), optionally **`trips:share`** (share links), `geo:read`/`weather:read` for lookups.
  A `:write` implies `:read`. `list_trips` + `get_trip_summary` are always available.
- Tools: `create_trip`, `create_accommodation` (`trips:write`); `create_transport`, `create_reservation`
  (`reservations:write`, reservation created `pending`); `create_place`/`assign_place_to_day`/
  `create_and_assign_place` (`places:write`); `get_trip_summary` (context loader); `create_share_link`/
  `get_share_link`/`delete_share_link` (`trips:share`). **Input JSON schemas are not in the wiki** —
  enumerate at runtime via MCP `tools/list` and read each tool's `inputSchema`.
- Limits: 300 req/min/user, 20 concurrent sessions/user, 3600s idle TTL. Multi-replica needs sticky
  sessions (single self-hosted instance: N/A).
- **Trip/day model, verified against a live instance (2026-07-07, M6):** `create_trip` auto-generates
  one `day` row (`{id, trip_id, day_number, date}`) per calendar date across `[start_date, end_date]`.
  There is **no `list_days` tool** — `get_trip_summary({tripId})` is the only way to read them back,
  and its result is a **flat object** (`{ trip, members, days: [...], accommodations, reservations,
  ... }` — `days` is a sibling of `trip`, not nested under it, unlike every `create_*` result). Every
  sub-entity tool wants an integer **`dayId`** (or `start_day_id`/`end_day_id` for a date range), never
  a raw date or timestamp — a message's events must be mapped to the resolved day ids before any
  sub-entity `create_*` call (`src/mcp/orchestrate.js`'s `resolveDayMap`).
- **Id casing is per-tool, not one convention** (verified field-by-field, not assumed): `create_trip`'s
  own fields are snake_case (`start_date`/`end_date`); `create_and_assign_place` and
  `create_transport`/`create_share_link` want `tripId`/`dayId` **camelCase** but then use snake_case
  for `start_day_id`/`end_day_id`/`category_id`; `create_accommodation` and `create_reservation` use
  snake_case (`place_id`/`day_id`/`start_day_id`/`end_day_id`) throughout. `create_transport` has
  **no `place_id` field at all** — location data belongs in a structured `endpoints` array instead
  (populating it from a free-text `LOCATION` is deferred — see below). `create_reservation`'s `type`
  is one of `hotel|restaurant|event|tour|activity|other`; this plugin's classifier can't distinguish
  finer than `'other'` from a plain calendar invite, and `place_id`/`start_day_id`/`end_day_id`/
  `check_in`/`check_out` on that tool are documented "hotel type only" (hotels go through
  `create_accommodation` instead), so the generic path uses the free-text `location` field.
  `create_accommodation`'s `check_in`/`check_out` are short **`"HH:MM"` time-of-day strings**, not
  timestamps (`undefined` for an all-day event — no time-of-day to report). All of the above is now
  implemented in `src/mcp/payloads.js`/`src/mcp/orchestrate.js`; **deferred, not yet implemented:**
  `create_transport`'s `endpoints` array (needs parsing free-text `LOCATION` into named
  origin/destination points) and any `create_reservation` `type` finer than `'other'`.

**Egress enforcement mechanism (source-verified, `server/src/nest/plugins/runtime/`):** the guard
patches **`net.Socket.prototype.connect`** — the single TCP choke point that `node:http/https/net/tls`
and `undici`/`fetch` all funnel through — plus wraps `globalThis.fetch` directly. Since `tls.connect()`
builds on that same `net.Socket`, a raw IMAP-over-TLS client hits the **identical** host-allowlist +
SSRF check (`isBlockedIp`, blocking loopback/private/link-local/CGNAT/ULA) as an HTTP call. Node's OS
`--permission` flag is fs-read-only (no network-scoping flag exists), and `net`/`tls` are not blocked
from `require()` (only the literal `'trek-plugin-sdk'` string is intercepted for injection). See R1.

**SDK / tooling (`trek-plugin-sdk`, npm-published, currently v1.3.x):** CLI verbs `create`,
**`dev [dir] [--port 4317]`** (real request loop + `db:own` SQLite + hot reload, loads
`dev-fixtures.json` — but does **not** reproduce the production egress/SSRF guard), `validate`, `pack`
(`plugin.zip`, prints sha256+size), `keygen`/`sign` (Ed25519), `entry`/`preflight`/`submit`/`release`/
`publish` (registry `mauriceboe/TREK-Plugins`). **`createMockHost()`** from `trek-plugin-sdk/testing`
(`{ grants, trips, queryResults, pluginExports }` → `{ ctx, broadcasts, emitted }`) enforces the same
permission model in unit tests. Packaging limits: 25 MB/file, 50 MB total, 4000 entries; ships
`trek-plugin.json`, `README.md`, `LICENSE`, `package.json`, `server/`, `client/`; drops `node_modules`,
`.git`, `.map`, `.ts`, `docs/`.

---

## 1. Manifest structure (`trek-plugin.json`)

Current manifest (`trek-plugin.json` at repo root) has `permissions: ["db:own"]` + generated
`http:outbound:<host>` and `egress[]` entries per host (the IMAP host and the TREK instance host),
mirrored exactly, based on the `EGRESS_HOSTS` build env var.

**Instance settings** (scaffolded in `trek-plugin.json`, `scope: "instance"`, admin-set once):
`imap_host`, `imap_port`, `imap_tls` (`tls`/`starttls`), `imap_user`, `imap_password` (secret),
`imap_folder`, `processed_folder` (M4: mail-flag second guard destination, optional — `\Seen`-only
if blank), `sender_allowlist` (will need e.g. `*@amextravel.com` in v1.1), `trek_base_url`,
`mcp_client_id`, `mcp_client_secret` (secret), `mcp_scopes`, `auto_share`. The poll cron interval
is defined in code (`src/index.js`), not settings.

---

## 2. Dependencies & runtime evaluation

All candidates verified **pure-JS, no native addons** (registry metadata):

| Purpose | Pick | License | Bundling note |

|---|---|---|---|
| `.ics` parse | **`node-ical`** (0.26.x) | Apache-2.0 | Lean (`rrule-temporal` + `temporal-polyfill`), sync string parse, no network. Bundles clean. |
| Email → attachment | **`mailparser`** (3.9.x) | MIT | Extracts `text/calendar` parts from raw RFC822; no workers/native. Bundles clean. |
| IMAP | **`imap-simple`/`node-imap`** | MIT | Small, trivially-bundleable tree (`imap`, `iconv-lite`, `utf8`, `quoted-printable`, `uuencode`, `nodeify`), no workers. |

**Runtime/packaging strategy (given TREK runs no `npm install` and strips `node_modules`):** all
three land as regular `dependencies` (not `devDependencies`), bundled into `server/index.js` via
`scripts/build.js` (esbuild, `platform: node`, `format: cjs`, `external: ['trek-plugin-sdk']`). Only
`trek-plugin-sdk` and `esbuild` are `devDependencies` — the host injects `trek-plugin-sdk` at runtime.

---

## 3. Execution & workflow mapping

**Poll loop** (server code, no user context → cannot touch `ctx.trips.*` → all trip mutations via MCP).
Current mechanism in `src/index.js`: `ctx.scheduler.every(60_000, 'poll-inbox')`, armed in `onLoad`,
firing into a top-level `scheduled({name, payload}, ctx)` handler that dispatches to `pollInbox(ctx)` —
**not** a declared `jobs[]` cron entry (that mechanism was confirmed unreliable on the real instance;
see CLAUDE.md's load-bearing facts). `pollInbox` itself (the IMAP-connect/search/process loop) and the
MCP orchestration inside it are unchanged from M2/M3 — only the trigger changed. `scripts/manual-run.js`
calls `pollInbox` directly as a host-cron fallback.

Per-run pipeline (built in M2/M3, Strategy pattern expansion planned for v1.1/M9+):

1. **IMAP**: connect (settings from `ctx.config`) → open `imap_folder` → search **UNSEEN** (+ optional
   sender allowlist) → fetch raw source of each message.
2. **Extract**: `mailparser` → find the `text/calendar` part (v1.1: fall back to plain text/HTML).
3. **Parse**: `node-ical` → iterate `VEVENT`(s). (v1.1: `parse-router.js` delegates to `src/parsers/ics.js`
   or unstructured shards like `amex.js`).
4. **Idempotency gate** (§4): skip if the `UID`(+`SEQUENCE`) is already in the `ctx.db` ledger.
5. **Auth**: ensure a fresh `trekoa_` token (token manager: cache ~55 min, re-`POST /oauth/token`).
6. **MCP session**: open Streamable HTTP session at `/mcp`; `tools/list` once to read live `inputSchema`s.
7. **Build trip** (idempotently — see §4): `create_trip` → `get_trip_summary` to resolve each event's
   date to its auto-generated `dayId` (see the trip/day model note above — required before any
   sub-entity call) → `create_and_assign_place` for `LOCATION` → `create_accommodation` /
   `create_transport` / `create_reservation` per event type → optional `create_share_link` if
   `auto_share`.
8. **Commit**: write ledger row (trip id, uid, sequence, share url), then mark mail `\Seen` (and/or a
   `$TrekProcessed` keyword / move to a processed folder). `ctx.log` throughout.

**Conditional parsing engine — `.ics` → MCP payloads:**

| `.ics` field | Maps to | Tool / field |

|---|---|---|
| `DTSTART` / `DTEND` | trip date range → auto-generated days; event's resolved `dayId` | `create_trip` dates; `create_transport.start_day_id`/`end_day_id`, `create_accommodation.start_day_id`/`end_day_id`, `create_reservation.day_id` |
| `SUMMARY` | trip title and/or reservation/event title | `create_trip.title`, `create_transport.title`, `create_reservation.title` |
| `LOCATION` | place (name), assigned to the event's day; generic reservations use it as a plain string instead | `create_and_assign_place.name`; `create_reservation.location` |
| `DESCRIPTION` | reservation/transport notes | `create_*.notes` |
| `UID` (+ `SEQUENCE`) | idempotency key + update detection | ledger PK (§4) |
| `METHOD:CANCEL` | cancellation | update/delete existing trip item |

**Event-type classifier** (which tool to call) — keyword/heuristic on `SUMMARY`/`DESCRIPTION`/
`CATEGORIES`/organizer domain: flight/airline/PNR → `create_transport(type:flight)`; train → transport;
hotel/check-in/check-out → `create_accommodation`; otherwise a generic `create_reservation`.
*Architectural constraint (M10):* All future unstructured parsers (AMEX, Concur) must output this exact
normalized `VEVENT` interface so the classifier and MCP payload builders remain completely untouched.

---

## 4. Idempotency & state strategy

**Goal:** each invite yields exactly one trip/entity no matter how often the cron re-reads the mailbox,
including safe handling of updates and partial failures.

- **Primary key resolution (M4, implemented in `src/ledger.js`):** a single message can contain
  multiple VEVENTs with *different* `UID`s (e.g. `test/fixtures/multi-vevent.ics`), but the locked
  decision is one message = one trip. So the ledger's `uid` PK holds the **first active
  (non-cancelled) event's UID** as a stand-in identifier for the whole message's trip-build — not
  "every VEVENT's UID." `sequence` holds `max(sequence)` across the message's active events.
  Secondary guard: RFC822 `Message-Id` (`message_id` column). For v1.1 unstructured emails (AMEX,
  Concur), this pivots to a deterministic hash (e.g. `hash(PNR + StartDate + Destination)`) or the
  RFC822 `Message-Id` directly, since those senders lack `UID`/`SEQUENCE` (M11).
- **Ledger in `ctx.db`** (own SQLite, `db:own`) — schema migrated in `src/index.js`:
  `processed_invites(uid TEXT PRIMARY KEY, message_id TEXT, sequence INT, trip_id TEXT, share_url TEXT,
  status TEXT, payload_hash TEXT, created_at, updated_at)`. `status ∈ {in_progress, done, cancelled,
  error}`. Wired into `poll-inbox` via `src/ledger.js` (M4).
- **Two-phase write to survive crashes:** `ledger.beginProcessing` inserts/resumes an `in_progress`
  row before the first MCP call and **preserves any existing `trip_id`**; `ledger.recordTripCreated`
  writes `trip_id` immediately after a fresh `create_trip` succeeds (before any sub-entity calls); a
  later poll that finds a stale `in_progress` row with a stored `trip_id` resumes
  `buildTripForMessage` against that id (skipping `create_trip`) rather than a `list_trips` search —
  only a `NULL` `trip_id` on a stale row falls back to a from-scratch retry, since nothing was
  created yet.
- **Mail flags as a second ledger:** after the ledger row reaches `done`/`cancelled`,
  `imap.markProcessed` marks the message `\Seen` and, if the `processed_folder` setting is
  configured, moves it there — best-effort, never throws, since the DB ledger is the authoritative
  guard. Search stays on **UNSEEN** so the flag is the coarse filter and the DB ledger is the exact
  guard — belt-and-suspenders.
- **Updates (M4 scope, deliberately bounded):** incoming `SEQUENCE > stored` **or** a changed
  `payload_hash` (a content fingerprint independent of `SEQUENCE`, since senders bump it
  inconsistently) on an already-`done` invite logs a warning and refreshes the ledger's
  fingerprint — it does **not** call any MCP update tool. Full per-entity delta updates
  (`update_day`/re-calling `create_*`) depend on real (currently SCHEMA-GUESS) `inputSchema`s from a
  live TREK instance and are deferred past M4. **Cancellations**
  (`METHOD:CANCEL`/`STATUS:CANCELLED`, i.e. all of a message's events are inactive) mark the ledger
  `cancelled`; the trip itself is left as-is (no auto-revoke/delete) for the same reason.

---

## 5. Verification plan

| Layer | How | Asserts |

|---|---|---|
| **Permission scoping** | `createMockHost({ grants:['db:own'] })`; call an ungranted method | rejects with `PERMISSION_DENIED`; job-context trip read → `RESOURCE_FORBIDDEN` |
| **Parser (pure)** | fixture `.ics` files → `node-ical` → mapper | correct trip/transport/reservation JSON per the mapping table; handles all-day, TZ, multi-VEVENT, CANCEL |
| **Email extract** | raw RFC822 fixtures → `mailparser` | `text/calendar` part found (attachment + inline) |
| **Idempotency** | run the pipeline twice over the same fixture | exactly one trip; second run is a no-op; `SEQUENCE` bump updates |
| **Local run** | `trek-plugin-sdk dev --port 4317` + `dev-fixtures.json` (trips/users/config) | manifest/permissions load and `onLoad`'s `db:own` migrate succeeds under the real SDK, hot reload works — **not** job execution (see M5 correction below) |
| **MCP integration** | mock local HTTP server for `POST /oauth/token` + `/mcp` (`tools/list`, `create_*`); then a real local TREK docker with a machine client | token exchange, session, tool calls, share link |
| **Packaging** | `trek-plugin-sdk validate` → `pack` | manifest/layout valid; no `node_modules`/native; within size limits |
| **Live IMAP smoke test** | `scripts/smoke-imap.js` | passed in M2 against Gmail/Workspace, empirically confirming R1 |
| **Bundle smoke test** | `scripts/smoke-bundle.js` (`npm run smoke`) | esbuild output loads with zero `node_modules` besides a stubbed `trek-plugin-sdk`; `onLoad`/`scheduled`/`pollInbox` present |

**M5 correction (source-verified against the real installed `trek-plugin-sdk@1.3.1`, not assumed):**
`trek-plugin-sdk dev`'s implementation (`dist/cli/dev.js`) only calls the plugin's `onLoad(ctx)` and
serves `plugin.routes` over HTTP — it never invokes `plugin.jobs`. So the "Local run" row's "job
executes" claim doesn't hold for `dev` specifically; job-execution correctness is proven by the
`processMessage` unit/integration tests instead (`test/index.test.js`, `test/mcp-integration.test.js`).
`scripts/smoke-dev.js` (`npm run smoke:dev`) automates the corrected scope of this row: it spawns
`trek-plugin-sdk dev` against the built plugin + a (deliberately empty, since this plugin never reads
`ctx.trips`/`ctx.users`) root `dev-fixtures.json`, and asserts the dashboard responds without a
"plugin failed to load" error.

`createMockHost` (from `trek-plugin-sdk/testing`) matches the shape described above exactly:
`{ grants, config, trips, users, queryResults, actingUserId, budgetAddonEnabled, pluginExports }` →
`{ ctx, calls, logs, broadcasts, emitted }`. An ungranted call throws `PermissionDenied` (message
`PERMISSION_DENIED: <method> requires <perm>`); any user-scoped call (`ctx.trips.*` etc.) throws
`RESOURCE_FORBIDDEN: this call requires an authenticated user context` whenever no `actingUserId`
is configured — the exact mechanism for modeling a job/`onLoad` context in a unit test.
`test/permissions.test.js` covers all three assertions in the table's first row, plus a
plugin-specific check that `processMessage` never calls any `ctx` surface outside `db:own`.

`test/mcp-integration.test.js` closes the mock-server half of the "MCP integration" row: it drives
`processMessage` with the *real* `createSession`/`buildTripForMessage` (not the in-memory fakes used
by `test/mcp-orchestrate.test.js`) against an HTTP `startMockTrekServer` implementing a minimal
`initialize`/`tools/list`/`tools/call` JSON-RPC router, asserting a full trip build (with share link)
on the first run and zero new `/mcp` traffic on an idempotent re-poll.

The real-docker half of "MCP integration" — `scripts/e2e-mcp.js` (`npm run e2e:mcp`) — is
env-var-gated (`E2E_TREK_BASE_URL`/`E2E_MCP_CLIENT_ID`/`E2E_MCP_CLIENT_SECRET`) exactly like
`scripts/smoke-imap.js`, and skips cleanly without them. **Written but not yet run against a live
instance** (no Docker daemon was available in the M5 development environment) — running it once
against a real TREK instance is what would finally resolve every `SCHEMA-GUESS` in
`src/mcp/payloads.js` (the script prints any live `tools/list` schema mismatches it finds). To run it:

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32) docker run -d -p 3000:3000 \
  -e ENCRYPTION_KEY=$ENCRYPTION_KEY -e APP_URL=http://localhost:3000 \
  -v ./data:/app/data -v ./uploads:/app/uploads mauriceboe/trek
```

then, once logged in: Settings → Integrations → MCP → OAuth Clients → "Machine client (no browser
login)" to mint a `client_credentials` pair scoped `trips:write places:write reservations:write
trips:share`, and export `E2E_TREK_BASE_URL=http://localhost:3000`, `E2E_MCP_CLIENT_ID`,
`E2E_MCP_CLIENT_SECRET` before running `npm run e2e:mcp`.

**Live run results (2026-07-07, against a real family TREK instance) — TODO M6:** the first live
call to `create_trip` surfaced that it returns `{ trip: { id, user_id, title, start_date, end_date,
currency, ... } }` — the full created row nested under the entity's singular name — not the bare
`{ tripId }` originally guessed. That, plus a full `E2E_DRY_RUN=1`/`E2E_SCHEMA_TOOLS`/
`E2E_INSPECT_DAYS=1` pass across every `create_*` tool's live `inputSchema` (and one throwaway
`create_trip` + `get_trip_summary` call to observe response shapes `tools/list` can't describe),
resolved every remaining `SCHEMA-GUESS` in `src/mcp/payloads.js`/`src/mcp/orchestrate.js` — see the
"Trip/day model" and "Id casing is per-tool" notes earlier in this section for the full verified
details (day resolution via `get_trip_summary`, per-tool camelCase/snake_case id fields, dropped
`place_id` on `create_transport`, `create_reservation`'s `'other'`-only `type`,
`create_accommodation`'s `"HH:MM"` check-in/out strings). `create_and_assign_place`'s and
`create_share_link`'s **result** shapes (as opposed to their now-verified input schemas) are still
assumed, not confirmed, to follow `create_trip`'s `{ <entity>: {...} }` wrapping convention — the
`extractEntity`/`extractId` helpers in `src/mcp/orchestrate.js` fall back to the old flat guess for
resilience either way.

**Full non-dry-run confirmation (2026-07-07):** `npm run e2e:mcp` against `travel.castaldifamily.com`
for all three remaining fixtures — `flight.ics` (trip 5, `create_transport`), `hotel.ics` (trip 6,
`create_accommodation`), `generic.ics` (trip 7, `create_reservation`) — each completed end-to-end
with **"no schema-guess mismatches"** and rendered correctly in the app (verified visually: the hotel
accommodation and dinner reservation both showed with correct dates/times). TODO M6 is fully closed.
Two earlier throwaway/broken trips from mid-fix debugging (ids 3 and 4) plus these three real ones
(5, 6, 7) are safe to delete manually from the app — there is no `delete_trip` tool.

---

## Assumptions & risks

- **R1 (RESOLVED — high confidence, confirmed empirically in M2):** The egress guard patches
  `net.Socket.prototype.connect` — the single TCP choke point that all network calls funnel through.
  A raw IMAP-over-TLS client hits the **identical** host-allowlist + SSRF check as an HTTP call. Node's OS
  `--permission` flag is fs-read-only, and `net`/`tls` are not blocked from `require()`. **Live smoke test
  in M2 confirmed this empirically. Option A is a go.**
- **R1a (confirmed):** The SSRF backstop (`isBlockedIp`) blocks loopback/private IPs regardless of
  allowlisting — so `http://127.0.0.1/mcp` is categorically out. We've locked in **public-hostname**
  TREK deployment (`APP_URL` resolves to a routable IP).
- **R2:** Machine token is **user-bound** → trips are owned by that user; the family sees them via the
  **public share link**, not membership.
- **R3:** `create_place` may need coordinates vs a name string — read the live `inputSchema` (`tools/list`).
- **R4:** `.ics` variety (recurring `RRULE`, all-day, timezones) — cover in fixtures.
- **R5 (partially superseded, was OPEN/platform-side — confirmed 2026-07-07):** TREK's job scheduler
  did not invoke this sideloaded plugin's `poll-inbox` job at all on a real self-hosted v3.2.1
  instance, contradicting the wiki's documented "TREK owns the cron" behavior — see corrections table
  row 8. Unknown whether this was sideload-specific (vs. registry-installed plugins), version-specific,
  or a general bug; not reproducible/fixable from this repo. Interim mitigation shipped:
  `scripts/manual-run.js` + a host-level cron entry (documented in README). **Update:** TREK v3.3.0
  introduced `ctx.scheduler` (see §3/execution-contexts), a runtime-armed alternative to the declared
  `jobs[]` array that this plugin now uses for `poll-inbox` instead. This directly targets the class
  of bug (a declarative mechanism the host may silently never honor) but has **not yet been verified
  reliable over time on the real family instance** — only confirmed to arm correctly and dispatch
  correctly via the real `trek-plugin-sdk dev` CLI locally. `scripts/manual-run.js` + host-cron remains
  the documented fallback until `ctx.scheduler` is observed working reliably in production.

## Decisions (locked)

- **Ingestion:** Option **A — IMAP direct** (source-verified and tested live).
- **MCP reachability:** call `/oauth/token` + `/mcp` via the **public `APP_URL` host**, never loopback.
- **Trip model:** **one invite → one trip**, and **auto-publish** the public share link (`trips:share`);
  the family views via that link.
- **IMAP client:** **`imap-simple`/`node-imap`** (guaranteed-clean bundle).
- **Parsing Architecture (v1.1):** Use the **Strategy pattern** (`src/parsers/`). Shards (`ics.js`,
  `amex.js`, `concur.js`) are heavily isolated to prevent unstructured parsing logic from destabilizing
  the core pipeline.

---

## Roadmap: v1.1 Unstructured Ingestion (AMEX, Concur)

*Post-v1.0 architectural plan to support non-standard travel emails without breaking the `.ics` core.*

- **M9: Modular Extraction & Router:** Update `src/extract.js` to return the full email payload (falling back to plain text or HTML if no `.ics` is found). Create a parsing router (`src/parse-router.js`) that queries a registry of isolated parser strategies (`canParse(emailPayload)`) and delegates accordingly.
- **M10: Parser Shards (`src/parsers/`):** Move `node-ical` logic into `src/parsers/ics.js`. Build `src/parsers/amex.js`. Every parser shard must output a normalized `VEVENT`-style object array (`summary`, `start`, `end`, `location`, `description`) to keep the downstream MCP orchestrator format-agnostic.
- **M11: Ledger & Idempotency Pivot:** Expand `processed_invites` schema/logic. Use a deterministic hash (`hash(PNR + StartDate)`) or the RFC822 `Message-Id` as the primary key for unstructured emails to safely handle updates and block duplicates.
- **M12: Fixtures, Verification & Release:** Add `.eml` fixtures for the new shards. Write isolated unit tests in `test/parsers/`. Update manifest/settings, bump to `1.1.0`, validate, pack, and publish.
