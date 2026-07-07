# auto-itinerary

> Invisible assistant that turns emailed business-trip calendar invites into live TREK trips.

## What it does

Add a dedicated family inbox as a guest on a business-trip calendar invite. This plugin polls that
inbox on a schedule, parses the `.ics` payload, and creates a fully-structured TREK Trip (accommodation,
transport, reservations) via TREK's built-in MCP server — so the family can follow along on a public
share link without the traveler ever opening the app.

**Status:** the full pipeline is implemented and confirmed working end-to-end against a real TREK
instance — IMAP ingestion, `.ics` parsing, MCP trip-building (`create_trip` →
`create_and_assign_place` → `create_accommodation`/`create_transport`/`create_reservation` →
optional `create_share_link`), and the idempotency ledger (one trip per invite, update detection,
cancellation handling). Today every trip is built under **one** TREK account (whichever user owns
the configured MCP machine client) — per-family-member routing to separate accounts is planned
(see the project plan for the milestone breakdown).

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Isolated SQLite ledger (`processed_invites`) to guarantee one trip per invite, even across repeated cron runs. |
| `http:outbound:<host>` + matching `egress` entry | One per host this plugin connects to: the IMAP host and the TREK instance's own host (for MCP calls). Generated at build time — see below. |

### Manifest generation (`trek-plugin.json`)

`trek-plugin.json` is a **generated file** (gitignored) — edit `trek-plugin.template.json` instead.
`npm run build` regenerates `trek-plugin.json` from the template, adding `http:outbound:<host>` +
`egress` entries for every host listed in the `EGRESS_HOSTS` env var (comma-separated). This lets each
installer bake in their own IMAP host without editing the manifest by hand:

```sh
EGRESS_HOSTS=imap.gmail.com,your-trek-instance.example.com npm run build
```

The host(s) here **must exactly match** the `imap_host` instance setting and the host portion of
`trek_base_url` configured after install, or the egress guard silently blocks the connection. If
`EGRESS_HOSTS` is unset, `npm run build`/`dev` still work (useful for casual iteration) but the
manifest ships with no egress permissions — set it for real before `npm run pack`.

## Deployment (single-user, today)

This is the complete path for private/family use — confirmed working end-to-end against a real
TREK instance. There is no public registry involved; TREK's Admin → Plugins panel accepts a direct
upload.

1. **Build and pack:**
   ```sh
   npm install
   EGRESS_HOSTS=<your-imap-host>,<your-trek-instance-host> npm run pack
   ```
   This bundles `src/index.js` + dependencies into `server/index.js` (TREK never runs `npm install`
   on installed plugins, so runtime dependencies must be bundled in), regenerates `trek-plugin.json`
   with the egress hosts baked in, and produces `plugin.zip` (prints its sha256 + size).
2. **Sideload it:** in your TREK instance, go to **Admin → Plugins** and either drag `plugin.zip`
   onto the panel or use the **Upload** button. TREK validates it with the same checks as a registry
   install (safe extraction, manifest checks, no native binaries) — **no signing/`keygen` step is
   needed for a sideloaded install**, that only matters for the public-registry path below. The
   plugin lands **inactive** and tagged **"Sideloaded"** (auto-updates are disabled for sideloaded
   plugins — a new version means repeating steps 1–2 and re-uploading by hand).
3. **Activate it**, then fill in the instance settings on its settings screen: IMAP
   host/port/security/username/password/folder, an optional sender allowlist, the TREK instance's
   public base URL, and an MCP machine client's `client_id`/`client_secret` (create one under
   **Settings → Integrations → MCP → OAuth Clients → Machine client**, with scopes
   `trips:write places:write reservations:write trips:share`).

   For a Google Workspace "alternate email" mailbox: `imap_host = imap.gmail.com`, `imap_port = 993`,
   `imap_tls = tls`. Since this plugin authenticates via plain IMAP basic auth (not OAuth2/XOAUTH2),
   Google requires a 16-character **App Password** (Google Account → Security → 2-Step Verification →
   App passwords) in `imap_password` rather than the account's real password — 2-Step Verification is
   on by default for most Workspace accounts. A Workspace admin can also disable IMAP access org-wide
   (Admin console → Apps → Google Workspace → Gmail → IMAP access); confirm it's enabled first.

   **Alternate addresses aren't separate mailboxes:** a Workspace "alternate email" (e.g.
   `trek@example.com`) is a send-as alias into the *primary* account's mailbox, not its own
   IMAP-authenticatable inbox. Put the **primary account** in `imap_user` (e.g.
   `you@example.com`) — mail addressed to the alternate address still lands in that same
   mailbox. The alternate address is what you add as a guest on the business-trip calendar invite; the
   primary account is what this plugin logs into IMAP as. Confirmed empirically: authenticating as the
   alternate address fails, authenticating as the primary account succeeds and sees the alternate
   address's mail.
4. The `poll-inbox` job runs on its own schedule (every 5 minutes) once activated — no further action
   needed. Every trip it builds is owned by whichever TREK user created the machine client in step 3;
   there's no per-family-member routing yet (planned, see the project plan).

## Publishing to the community registry (later, optional)

Not needed for the deployment above. If this plugin is ever meant to be installable by other TREK
users via the public `mauriceboe/TREK-Plugins` registry, that's a separate, additional path:
`keygen`/`sign` (Ed25519 signing for trust-on-first-use key pinning), a real README screenshot, a
tagged GitHub release with `plugin.zip` attached, then `trek-plugin entry` → `preflight` → `submit`.
See the project plan for details.

## Development

- `npm run dev` runs locally against `trek-plugin-sdk dev` (loads `dev-fixtures.json` for
  `ctx.trips`/`ctx.users` if present — this plugin doesn't read either, so it's intentionally
  minimal). Note: `dev` only calls `onLoad` and serves any `routes` — it does not execute the
  `poll-inbox` cron job, so it's useful for confirming the manifest/permissions load cleanly, not
  for exercising the ingestion pipeline.
- `npm test` runs the fixture-based unit tests (65+ tests: IMAP fetch, `.ics` extraction/parsing,
  event classification, MCP orchestration, ledger, permission scoping).
- `npm run smoke` loads the packed bundle in a scratch directory with no real `node_modules` besides
  a stubbed `trek-plugin-sdk`, to catch any dependency esbuild failed to bundle.
- `node scripts/smoke-imap.js` runs a real IMAP connect against a live mailbox — set
  `SMOKE_IMAP_HOST`/`PORT`/`TLS`/`USER`/`PASSWORD` (and optionally `SMOKE_IMAP_FOLDER`) to run it; it
  skips cleanly if those aren't set.
- `node scripts/e2e-mcp.js` runs the real MCP trip-building pipeline against a live TREK instance —
  set `E2E_TREK_BASE_URL`/`E2E_MCP_CLIENT_ID`/`E2E_MCP_CLIENT_SECRET`; skips cleanly without them.
  `E2E_DRY_RUN=1` only prints live tool schemas without creating anything.

## License

MIT
