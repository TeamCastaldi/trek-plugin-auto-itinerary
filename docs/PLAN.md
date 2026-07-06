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
matching `egress[]` entries once M2/M3 add real IMAP/MCP calls. A host in `egress[]` without the
matching `http:outbound:<host>` permission is **silently blocked at runtime** — the two must mirror
exactly.

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
All run in plain forked Node child processes (not a VM sandbox).

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

Current manifest (`trek-plugin.json` at repo root) has `permissions: ["db:own"]` only — no
`http:outbound`/`egress` yet, since no code makes outbound calls until M2/M3. When those land, add
one `http:outbound:<host>` + one `egress[]` entry **per host** (the IMAP host and the TREK instance
host), mirrored exactly, plus the settings fields already scaffolded (see below).

**Open note (O1):** egress hosts are *static* manifest strings, but the real IMAP/TREK hostnames come
from instance settings (filled in by the admin at install time, not known at build time). Resolve by
either documenting that the admin's settings must match the manifest's `egress[]`/`http:outbound:<host>`
entries, or using a `*.wildcard` egress entry if the deployment allows it.

**Instance settings** (already scaffolded in `trek-plugin.json`, `scope: "instance"`, admin-set once):
`imap_host`, `imap_port`, `imap_tls` (`tls`/`starttls`), `imap_user`, `imap_password` (secret),
`imap_folder`, `sender_allowlist`, `trek_base_url`, `mcp_client_id`, `mcp_client_secret` (secret),
`mcp_scopes`, `auto_share`. The poll cron interval is defined in code (`src/index.js`), not settings.

---

## 2. Dependencies & runtime evaluation

All candidates verified **pure-JS, no native addons** (registry metadata):

| Purpose | Pick | License | Bundling note |
|---|---|---|---|
| `.ics` parse | **`node-ical`** (0.26.x) | Apache-2.0 | Lean (`rrule-temporal` + `temporal-polyfill`), sync string parse, no network. Bundles clean. Alt: `ical.js` (Mozilla, zero-dep) if size matters. |
| Email → attachment | **`mailparser`** (3.9.x) | MIT | Extracts `text/calendar` parts from raw RFC822; no workers/native. Bundles clean. |
| IMAP | **`imap-simple`/`node-imap`** (locked decision) | MIT | Small, trivially-bundleable tree (`imap`, `iconv-lite`, `utf8`, `quoted-printable`, `uuencode`, `nodeify`), no workers. `imapflow` was considered but transitively depends on `pino` (bundler-hostile); revisit only if a bundle smoke test on `imap-simple` fails. |

**Runtime/packaging strategy (given TREK runs no `npm install` and strips `node_modules`):** all
three land as regular `dependencies` (not `devDependencies`), bundled into `server/index.js` via
`scripts/build.js` (esbuild, `platform: node`, `format: cjs`, `external: ['trek-plugin-sdk']`). Only
`trek-plugin-sdk` and `esbuild` are `devDependencies` — the host injects `trek-plugin-sdk` at runtime.

---

## 3. Execution & workflow mapping

**Job loop** (server code, no user context → cannot touch `ctx.trips.*` → all trip mutations via MCP).
Current skeleton in `src/index.js`: `jobs: [{ id: 'poll-inbox', schedule: '*/5 * * * *', handler }]`,
`onLoad` migrates the `processed_invites` ledger. Handler is currently a stub.

Per-run pipeline (to build in M2/M3):
1. **IMAP**: connect (settings from `ctx.config`) → open `imap_folder` → search **UNSEEN** (+ optional
   sender allowlist) → fetch raw source of each message.
2. **Extract**: `mailparser` → find the `text/calendar` part (attachment `*.ics` or inline).
3. **Parse**: `node-ical` → iterate `VEVENT`(s).
4. **Idempotency gate** (§4): skip if the `UID`(+`SEQUENCE`) is already in the `ctx.db` ledger.
5. **Auth**: ensure a fresh `trekoa_` token (token manager: cache ~55 min, re-`POST /oauth/token`).
6. **MCP session**: open Streamable HTTP session at `/mcp`; `tools/list` once to read live `inputSchema`s.
7. **Build trip** (idempotently — see §4): `create_trip` → `create_and_assign_place`/`create_place` for
   `LOCATION` → `create_accommodation` / `create_transport` / `create_reservation` per event type →
   optional `create_share_link` if `auto_share`.
8. **Commit**: write ledger row (trip id, uid, sequence, share url), then mark mail `\Seen` (and/or a
   `$TrekProcessed` keyword / move to a processed folder). `ctx.log` throughout.

**Conditional parsing engine — `.ics` → MCP payloads:**

| `.ics` field | Maps to | Tool / field |
|---|---|---|
| `DTSTART` / `DTEND` (+ VTIMEZONE, all-day) | trip date range → auto-generated days; event times | `create_trip` dates; `create_transport` dep/arr times |
| `SUMMARY` | trip title and/or reservation/event title | `create_trip.title`, `create_reservation.title` |
| `LOCATION` | place (name → geocode/coords per tool schema) | `create_and_assign_place` / `create_place` |
| `DESCRIPTION` (notes text) | day notes / reservation notes / confirmation codes | day note or `create_*` notes/confirmation |
| `UID` (+ `SEQUENCE`) | idempotency key + update detection | ledger PK (§4) |
| `ORGANIZER`/`ATTENDEE` | ignored or noted | — |
| `METHOD:CANCEL` / `STATUS:CANCELLED` | cancellation | update/delete existing trip item |

**Event-type classifier** (which tool to call) — keyword/heuristic on `SUMMARY`/`DESCRIPTION`/
`CATEGORIES`/organizer domain: flight/airline/PNR → `create_transport(type:flight)`; train → transport;
hotel/check-in/check-out → `create_accommodation`; otherwise a generic `create_reservation`
(restaurant/event/tour/meeting). Default fallback = one `create_reservation` pinned to the day, so no
invite is dropped.

---

## 4. Idempotency & state strategy

**Goal:** each invite yields exactly one trip/entity no matter how often the cron re-reads the mailbox,
including safe handling of updates and partial failures.

- **Primary key:** iCalendar `UID` (globally unique per event) + `SEQUENCE` (bumped on updates).
  Secondary guard: RFC822 `Message-Id`.
- **Ledger in `ctx.db`** (own SQLite, `db:own`) — schema already migrated in `src/index.js`:
  `processed_invites(uid TEXT PRIMARY KEY, message_id TEXT, sequence INT, trip_id TEXT, share_url TEXT,
  status TEXT, payload_hash TEXT, created_at, updated_at)`. `status ∈ {in_progress, done, error}`.
  **Not yet wired into any read/write logic** — that's M4.
- **Two-phase write to survive crashes:** insert `in_progress` **before** the first MCP call; flip to
  `done` after the trip is fully built. If a later run finds `in_progress`, reconcile via `list_trips`/
  `get_trip_summary` (or a deterministic external key) instead of blindly re-creating.
- **Mail flags as a second ledger:** only after the ledger row is `done`, mark the message `\Seen` (and
  optionally set a `$TrekProcessed` keyword or move to a `Processed` folder). Search on **UNSEEN** so the
  flag is the coarse filter and the DB ledger is the exact guard — belt-and-suspenders.
- **Updates:** incoming `SEQUENCE > stored` → update the existing `trip_id` (`update_day`/`create_*` deltas)
  rather than create. **Cancellations** (`METHOD:CANCEL`/`STATUS:CANCELLED`) → mark ledger `cancelled`,
  optionally revoke share link / delete trip item.
- **Dedup across restart/no-DB edge:** if `db:own` is ever unavailable, fall back to a
  `get_trip_summary`/`list_trips` lookup keyed on a stable title+UID marker stored in trip notes.

---

## 5. Verification plan

| Layer | How | Asserts |
|---|---|---|
| **Permission scoping** | `createMockHost({ grants:['db:own'] })`; call an ungranted method | rejects with `PERMISSION_DENIED`; job-context trip read → `RESOURCE_FORBIDDEN` |
| **Parser (pure)** | fixture `.ics` files → `node-ical` → mapper | correct trip/transport/reservation JSON per the mapping table; handles all-day, TZ, multi-VEVENT, CANCEL |
| **Email extract** | raw RFC822 fixtures → `mailparser` | `text/calendar` part found (attachment + inline) |
| **Idempotency** | run the pipeline twice over the same fixture | exactly one trip; second run is a no-op; `SEQUENCE` bump updates |
| **Local run** | `trek-plugin-sdk dev --port 4317` + `dev-fixtures.json` (trips/users/config) | job executes, `db:own` persists ledger, hot reload |
| **MCP integration** | mock local HTTP server for `POST /oauth/token` + `/mcp` (`tools/list`, `create_*`); then a real local TREK docker with a machine client | token exchange, session, tool calls, share link |
| **Packaging** | `trek-plugin-sdk validate` → `pack` | manifest/layout valid; no `node_modules`/native; within size limits |
| **Bundle smoke test** | `node -e "require('./server/index.js')"` on the esbuild output | deps resolve with `node_modules` absent |
| **Live IMAP smoke test** | first real `tls.connect`/IMAP login against a real mailbox from a real TREK instance | confirms the R1 source-read prediction empirically (see Assumptions & risks) |

Mock MCP fixtures (`dev-fixtures.json` + a stub `/mcp` server) let us validate the full flow **without a
live TREK**; a real TREK docker instance validates the real OAuth + Streamable HTTP path before we
`pack`/`sign`/`publish`.

---

## Assumptions & risks

- **R1 (RESOLVED — high confidence, from source):** Read TREK's actual runtime source
  (`server/src/nest/plugins/runtime/plugin-host-entry.ts`, `egress-policy.ts`). The egress guard patches
  **`net.Socket.prototype.connect`** — the single TCP choke point that `node:http/https/net/tls` and
  `undici`/`fetch` all funnel through — plus wraps `globalThis.fetch` directly ("four channels... so a
  plugin can't sidestep one with another"). Since `tls.connect()` builds on that same `net.Socket`, a raw
  IMAP-over-TLS client hits the **identical** host-allowlist + SSRF check as an HTTP call. Node's OS
  `--permission` flag is fs-read-only (no network-scoping flag exists — confirmed in `paths.ts`), and
  `net`/`tls` are not blocked from `require()` (only the literal `'trek-plugin-sdk'` string is intercepted).
  Plugins run as plain forked Node processes (`fork(entry, ...)`), not a VM sandbox. **Conclusion: raw IMAP
  TLS to an allow-listed host will work.** Residual gap: no live subprocess test observed this directly
  (TREK's own suite only unit-tests the guard's pure helpers) — a live smoke test in M2 will confirm.
  **Option A is a go.**
- **R1a (confirmed, consistent with R1):** The same choke point's SSRF backstop (`isBlockedIp`) blocks
  loopback/private/link-local/CGNAT/ULA regardless of allowlisting — so `http://127.0.0.1/mcp` is
  categorically out. We've locked in **public-hostname** TREK deployment (`APP_URL` resolves to a
  routable IP), so this guard simply won't trigger for our `/mcp` and `/oauth/token` calls — no
  `ALLOW_INTERNAL_NETWORK` override needed.
- **R2:** Machine token is **user-bound** → trips are owned by that user; the family sees them via the
  **public share link** (`create_share_link`), not membership. This is the intended sharing model
  (confirmed with the user).
- **R3:** `create_place` may need coordinates vs a name string — read the live `inputSchema` (`tools/list`)
  and geocode via `geo:read` if required.
- **R4:** `.ics` variety (recurring `RRULE`, all-day, timezones, `METHOD:REQUEST/CANCEL`) — cover in fixtures.
- **R5:** MCP addon must be enabled (`/mcp` else `403`) and `APP_URL` set (else OAuth discovery fails) —
  operational prerequisites to document for whoever deploys this.
- **R6:** AGPL-3.0 host vs MIT plugin — fine; TREK treats plugins as independently authored/licensed
  (manifest `license` field, Ed25519-signed artifacts). No copyleft obligation on our separately
  distributed plugin.
- **R7:** Rate limit 300 req/min/user — batch per-invite tool calls; back off on 429.

## Decisions (locked)
- **Ingestion:** Option **A — IMAP direct** (source-verified high confidence, see R1); pre-designated
  fallback **C — Cloudflare Email Routing webhook → `auth:false` plugin route** if a live smoke test
  ever contradicts the source-read prediction. (Option B / HTTPS mail API held in reserve.)
- **MCP reachability:** call `/oauth/token` + `/mcp` via the **public `APP_URL` host**, never loopback.
- **Trip model:** **one invite → one trip**, and **auto-publish** the public share link (`trips:share`);
  the family views via that link (the machine token is user-bound, so trips are owned by the client's
  owner — R2).
- **IMAP client:** **`imap-simple`/`node-imap`** (guaranteed-clean bundle).

## Residual implementation notes
- **O1 (egress hosts):** `egress[]` / `http:outbound:<host>` are *static* manifest strings, but the IMAP
  and TREK hosts come from instance settings. Resolve by baking the known self-hosted hostnames into the
  manifest (or `*.wildcard`) at build/config time and documenting that the admin's settings must match.
