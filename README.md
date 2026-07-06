# auto-itinerary

> Invisible assistant that turns emailed business-trip calendar invites into live TREK trips.

## What it does

Add a dedicated family inbox as a guest on a business-trip calendar invite. This plugin polls that
inbox on a schedule, parses the `.ics` payload, and creates a fully-structured TREK Trip (accommodation,
transport, reservations) via TREK's built-in MCP server — so the family can follow along on a public
share link without the traveler ever opening the app.

**Status:** scaffold only. The `processed_invites` ledger schema is created on load, but nothing yet
reads or writes to it — ingestion (IMAP + `.ics` parsing), MCP trip-building, and the idempotency logic
that uses this ledger are not yet implemented. See the project plan for the milestone breakdown.

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Isolated SQLite ledger (`processed_invites`) to guarantee one trip per invite, even across repeated cron runs. |

`http:outbound:<host>` + matching `egress` entries for the IMAP host and the TREK instance host will be
added once ingestion and MCP calls are implemented.

## Setup

1. Build the bundle: `npm install && npm run build` (bundles `src/index.js` + dependencies into
   `server/index.js` — TREK does not run `npm install` on installed plugins, so runtime dependencies must
   be bundled in).
2. Configure instance settings (admin-only, set once): IMAP host/port/security/username/password/folder,
   an optional sender allowlist, the TREK instance's public base URL, and an MCP machine client's
   `client_id`/`client_secret` (create one under **Settings → Integrations → MCP → OAuth Clients →
   Machine client**, with scopes `trips:write places:write reservations:write trips:share`).
3. `npm run dev` to run locally against `trek-plugin-sdk dev` (loads `dev-fixtures.json` for
   `ctx.trips`/`ctx.users` if present).
4. `npm run pack` to build the distributable `plugin.zip`.

## License

MIT
