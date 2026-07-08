# auto-itinerary

> Invisible assistant that turns emailed business-trip calendar invites into live TREK trips.

## What it does

Add a dedicated family inbox as a guest on a business-trip calendar invite, and forward that inbox
through [Resend's inbound email](https://resend.com/docs/dashboard/receiving/introduction) so it
calls this plugin's webhook on every new message. This plugin parses the `.ics` payload and creates
a fully-structured TREK Trip (accommodation, transport, reservations) via TREK's built-in MCP
server — so the family can follow along on a public share link without the traveler ever opening
the app.

**Status:** the full pipeline is implemented and confirmed working end-to-end against a real TREK
instance — `.ics` parsing, MCP trip-building (`create_trip` → `create_and_assign_place` →
`create_accommodation`/`create_transport`/`create_reservation` → optional `create_share_link`), and
the idempotency ledger (one trip per invite, update detection, cancellation handling), including
with genuine external test emails. Today every trip is built under **one** TREK account (whichever
user owns the configured MCP machine client) — per-family-member routing to separate accounts is
planned (see the project plan for the milestone breakdown).

Ingestion is a **push webhook** (`POST /resend-webhook`), not a polling job — this replaced an
earlier IMAP-polling design specifically because TREK's own job scheduler was found to never
reliably invoke a sideloaded plugin's declared `jobs` on a real self-hosted instance (see the
project plan's version history for the full investigation). A `routes` handler has no such
dependency: TREK serves plugin routes directly, and `trek-plugin-sdk dev` can even exercise it
locally (see Development below).

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Isolated SQLite ledger (`processed_invites`) to guarantee one trip per invite, even across repeated webhook deliveries. |
| `http:outbound:<host>` + matching `egress` entry | One per host this plugin connects to: `api.resend.com` (to fetch attachment content — Resend's webhook payload only carries attachment *metadata*, not the `.ics` bytes) and the TREK instance's own host (for MCP calls). Generated at build time — see below. |

**Note on the signed attachment `download_url`:** the URL Resend hands back to fetch attachment
content is a separate, dynamic host (S3-style), not necessarily `api.resend.com` itself — this has
not yet been verified against a live delivery. If the egress guard blocks that fetch in practice,
the observed host needs to be added to `EGRESS_HOSTS` too; document whatever is actually observed
here once confirmed.

### Manifest generation (`trek-plugin.json`)

`trek-plugin.json` is a **generated file** (gitignored) — edit `trek-plugin.template.json` instead.
`npm run build` regenerates `trek-plugin.json` from the template, adding `http:outbound:<host>` +
`egress` entries for every host listed in the `EGRESS_HOSTS` env var (comma-separated). This lets each
installer bake in their own hosts without editing the manifest by hand:

```sh
EGRESS_HOSTS=api.resend.com,your-trek-instance.example.com npm run build
```

The host(s) here **must exactly match** the host portion of `trek_base_url` configured after
install (plus `api.resend.com`), or the egress guard silently blocks the connection. If
`EGRESS_HOSTS` is unset, `npm run build`/`dev` still work (useful for casual iteration) but the
manifest ships with no egress permissions — set it for real before `npm run pack`.

## Setup & Deployment (single-user, today)

This is the complete path for private/family use — confirmed working end-to-end against a real
TREK instance. There is no public registry involved; TREK's Admin → Plugins panel accepts a direct
upload.

1. **Build and pack:**
   ```sh
   npm install
   EGRESS_HOSTS=api.resend.com,<your-trek-instance-host> npm run pack
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
3. **Activate it**, then configure the instance settings: a webhook shared secret, your Resend API
   key, the TREK instance's public base URL, and an MCP machine client's `client_id`/`client_secret`
   (create one under **Settings → Integrations → MCP → OAuth Clients → Machine client**, with scopes
   `trips:write places:write reservations:write trips:share`).

   **If there's no settings UI for the plugin** (confirmed missing in at least one real TREK
   admin panel — the `...` menu only had Restart/View error logs/Delete): the settings still have a
   real backend home at `GET`/`PUT /api/admin/plugins/auto-itinerary/config`. Configure them
   directly from your browser's DevTools Console while logged in as an admin (so your session
   cookie is used) — `GET` first to see the current/expected shape, then `PUT` the flat settings
   object as the body (the API wraps the *stored* value in `{ config: {...} }` on read, but does
   **not** expect you to wrap it yourself on write — sending an already-wrapped body just double-nests
   it):
   ```js
   fetch('/api/admin/plugins/auto-itinerary/config', {
     method: 'PUT',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({
       webhook_secret: '...', resend_api_key: 're_...',
       trek_base_url: 'https://trek.example.com',
       mcp_client_id: '...', mcp_client_secret: '...',
       mcp_scopes: 'trips:write places:write reservations:write trips:share',
       auto_share: 'yes',
     }),
   }).then(r => r.json()).then(console.log)
   ```
   Then use **Restart** (from the plugin's `...` menu) to make it reload with the new config.
4. **Configure Resend's inbound webhook** to add the family inbox address as a domain/route in
   Resend's dashboard, and point its `email.received` webhook at:
   ```
   https://<your-trek-instance-host>/api/resend-webhook?secret=<your webhook_secret>
   ```
   **Why the secret is a query parameter, not a header:** `trek-plugin-sdk` plugin routes receive
   only `{method, path, query, body, user}` — there is no request-headers surface at all (confirmed
   against the installed SDK's type definitions and its `dev` route dispatcher), so the usual
   header-based webhook auth pattern (and Resend's own Svix-style signature headers) isn't available
   to a plugin route. The shared secret has to travel in the URL instead.

   Every trip built is owned by whichever TREK user created the machine client above; there's no
   per-family-member routing yet (planned, see the project plan).

## Publishing to the community registry (later, optional)

Not needed for the deployment above. If this plugin is ever meant to be installable by other TREK
users via the public `mauriceboe/TREK-Plugins` registry, that's a separate, additional path:
`keygen`/`sign` (Ed25519 signing for trust-on-first-use key pinning), a real README screenshot, a
tagged GitHub release with `plugin.zip` attached, then `trek-plugin entry` → `preflight` → `submit`.
See the project plan for details.

## Development

- `npm run dev` runs locally against `trek-plugin-sdk dev` (loads `dev-fixtures.json` for
  `ctx.config`/`ctx.trips`/`ctx.users` if present). Unlike the old `jobs`-based pipeline, this
  actually exercises the real ingestion entry point: plugin routes are mounted at `/api<path>`, so
  `POST http://localhost:4317/api/resend-webhook?secret=<dev-fixtures.json's webhook_secret>` drives
  the real route handler locally — no separate "does the scheduler even fire" question exists
  anymore. `npm run smoke:dev` automates exactly this (see below).
- `npm test` runs the fixture-based unit tests (70+ tests: Resend webhook secret verification,
  attachment metadata → download_url → content extraction, `.ics` parsing, event classification, MCP
  orchestration, ledger, permission scoping).
- `npm run smoke` loads the packed bundle in a scratch directory with no real `node_modules` besides
  a stubbed `trek-plugin-sdk`, to catch any dependency esbuild failed to bundle.
- `npm run smoke:dev` spawns a real `trek-plugin-sdk dev` instance and POSTs a sample Resend
  `email.received` payload at `/api/resend-webhook`, asserting a bad `secret` query param is
  rejected (401) and a valid one is accepted (200) — proves the route is wired up correctly without
  touching the real Resend API (the sample payload has no attachments, so it hits the "nothing to
  do" no-op branch rather than making a live `api.resend.com` call).
- `node scripts/e2e-mcp.js` runs the real MCP trip-building pipeline against a live TREK instance —
  set `E2E_TREK_BASE_URL`/`E2E_MCP_CLIENT_ID`/`E2E_MCP_CLIENT_SECRET`; skips cleanly without them.
  `E2E_DRY_RUN=1` only prints live tool schemas without creating anything.

## License

MIT
