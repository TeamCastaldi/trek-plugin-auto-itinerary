# auto-itinerary

> Invisible assistant that turns emailed business-trip calendar invites into live TREK trips.

## What it does

Add a dedicated family inbox as a guest on a business-trip calendar invite. This plugin polls that
inbox on a schedule, parses the `.ics` payload, and creates a fully-structured TREK Trip (accommodation,
transport, reservations) via TREK's built-in MCP server — so the family can follow along on a public
share link without the traveler ever opening the app.

**Status:** ingestion + `.ics` parsing implemented (IMAP connect → extract calendar → parse VEVENTs →
classify by type), logged per run. MCP trip-building and the idempotency ledger wiring are not yet
implemented. See the project plan for the milestone breakdown.

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Isolated SQLite ledger (`processed_invites`) to guarantee one trip per invite, even across repeated cron runs. |
| `http:outbound:<host>` + matching `egress` entry | One per host that this plugin connects to (the IMAP host today; the TREK instance host once MCP lands). Generated at build time — see below. |

### Manifest generation (`trek-plugin.json`)

`trek-plugin.json` is a **generated file** (gitignored) — edit `trek-plugin.template.json` instead.
`npm run build` regenerates `trek-plugin.json` from the template, adding `http:outbound:<host>` +
`egress` entries for every host listed in the `EGRESS_HOSTS` env var (comma-separated). This lets each
installer bake in their own IMAP host without editing the manifest by hand:

```sh
EGRESS_HOSTS=imap.gmail.com npm run build
```

The host(s) here **must exactly match** the `imap_host` instance setting configured after install, or
the egress guard silently blocks the connection. If `EGRESS_HOSTS` is unset, `npm run build`/`dev`
still work (useful for casual iteration) but the manifest ships with no egress permissions — set it for
real for `npm run pack`.

## Setup

1. Build the bundle: `npm install && EGRESS_HOSTS=<your-imap-host> npm run build` (bundles
   `src/index.js` + dependencies into `server/index.js` — TREK does not run `npm install` on installed
   plugins, so runtime dependencies must be bundled in — and regenerates `trek-plugin.json`, see above).
2. Configure instance settings (admin-only, set once): IMAP host/port/security/username/password/folder,
   an optional sender allowlist, the TREK instance's public base URL, and an MCP machine client's
   `client_id`/`client_secret` (create one under **Settings → Integrations → MCP → OAuth Clients →
   Machine client**, with scopes `trips:write places:write reservations:write trips:share`).

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
3. `npm run dev` to run locally against `trek-plugin-sdk dev` (loads `dev-fixtures.json` for
   `ctx.trips`/`ctx.users` if present).
4. `npm run pack` to build the distributable `plugin.zip`.
5. `npm test` runs the fixture-based unit tests (IMAP fetch, `.ics` extraction/parsing, event
   classification). `node scripts/smoke-imap.js` runs a real IMAP connect against a live mailbox —
   set `SMOKE_IMAP_HOST`/`PORT`/`TLS`/`USER`/`PASSWORD` (and optionally `SMOKE_IMAP_FOLDER`) to run it;
   it skips cleanly if those aren't set.

## License

MIT
