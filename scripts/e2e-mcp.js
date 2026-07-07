const fs = require('fs');
const path = require('path');
const { createSession } = require('../src/mcp/client');
const { filterActiveEvents, buildTripForMessage } = require('../src/mcp/orchestrate');
const { parseEvents } = require('../src/parse');
const { classifyEvent } = require('../src/classify');

/**
 * Real MCP integration check against a live local TREK instance (docs/PLAN.md §5's "real local
 * TREK docker with a machine client" row). Unlike the mock-server tests in
 * test/mcp-integration.test.js, this hits actual `/oauth/token` + `/mcp` endpoints and, crucially,
 * actual live `tools/list` `inputSchema`s — every `SCHEMA-GUESS` comment in src/mcp/payloads.js is
 * only fully resolved once this has been run once against a real instance and its schema-check
 * trace comes back empty.
 *
 * Skips cleanly (same pattern as scripts/smoke-imap.js) unless E2E_TREK_BASE_URL/
 * E2E_MCP_CLIENT_ID/E2E_MCP_CLIENT_SECRET are set. See docs/PLAN.md §5 for the docker run + machine
 * client setup steps to get those values.
 *
 * Set E2E_DRY_RUN=1 to only fetch and print the live `inputSchema`s for the tools this fixture
 * would call, without calling any create_* tool — useful for eyeballing every SCHEMA-GUESS in
 * src/mcp/payloads.js against a real instance before creating anything.
 */
function toolNameForType(type) {
  if (type === 'flight' || type === 'train') return 'create_transport';
  if (type === 'hotel') return 'create_accommodation';
  return 'create_reservation';
}

async function main() {
  const required = ['E2E_TREK_BASE_URL', 'E2E_MCP_CLIENT_ID', 'E2E_MCP_CLIENT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.log(`[e2e-mcp] skipping — missing env vars: ${missing.join(', ')}`);
    console.log('[e2e-mcp] set E2E_TREK_BASE_URL/E2E_MCP_CLIENT_ID/E2E_MCP_CLIENT_SECRET (and optionally');
    console.log('[e2e-mcp] E2E_MCP_SCOPES/E2E_FIXTURE/E2E_AUTO_SHARE) to run against a real TREK instance.');
    return;
  }

  const config = {
    trek_base_url: process.env.E2E_TREK_BASE_URL,
    mcp_client_id: process.env.E2E_MCP_CLIENT_ID,
    mcp_client_secret: process.env.E2E_MCP_CLIENT_SECRET,
    mcp_scopes: process.env.E2E_MCP_SCOPES || 'trips:write places:write reservations:write trips:share',
    auto_share: process.env.E2E_AUTO_SHARE || 'yes',
  };

  const fixtureName = process.env.E2E_FIXTURE || 'flight.ics';
  const icsText = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', fixtureName), 'utf8');
  const classifiedEvents = parseEvents(icsText).map((event) => classifyEvent(event));
  const activeEvents = filterActiveEvents(classifiedEvents);
  if (!activeEvents.length) {
    throw new Error(`fixture "${fixtureName}" has no active (non-cancelled) VEVENTs to build a trip from`);
  }

  console.log(`[e2e-mcp] connecting to ${config.trek_base_url}...`);
  const session = await createSession(config);
  console.log(`[e2e-mcp] MCP session established (fixture: ${fixtureName})`);

  const toolsMap = await session.listTools();
  console.log(`[e2e-mcp] live tools/list returned ${toolsMap.size} tool(s)`);

  const relevantToolNames = new Set(['create_trip', 'create_and_assign_place']);
  for (const { type } of activeEvents) relevantToolNames.add(toolNameForType(type));
  if (config.auto_share === 'yes') relevantToolNames.add('create_share_link');

  console.log('[e2e-mcp] live inputSchema for the tool(s) this fixture will call:');
  for (const name of relevantToolNames) {
    const schema = toolsMap.get(name);
    if (!schema) {
      console.warn(`  - ${name}: NOT FOUND in tools/list (scope missing, or the tool doesn't exist on this instance)`);
      continue;
    }
    console.log(`  - ${name}:`);
    console.log(
      JSON.stringify(schema, null, 2)
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n')
    );
  }

  if (process.env.E2E_DRY_RUN) {
    console.log('[e2e-mcp] E2E_DRY_RUN set — stopping before any create_* call. No trip was created.');
    return;
  }

  const result = await buildTripForMessage(session, { uid: 'e2e' }, classifiedEvents, config);

  console.log(`[e2e-mcp] created trip ${result.tripId} (${result.entityCount} entries)`);
  if (result.shareUrl) console.log(`[e2e-mcp] share link: ${result.shareUrl}`);

  const schemaWarnings = result.trace.filter((entry) => entry.step === 'schema-check');
  if (schemaWarnings.length) {
    console.warn('[e2e-mcp] SCHEMA-GUESS mismatches found against the live inputSchema:');
    for (const warning of schemaWarnings) console.warn(`  - ${warning.tool}: ${warning.error}`);
  } else {
    console.log('[e2e-mcp] no schema-guess mismatches — every payload field matched the live inputSchema');
  }
}

main().catch((err) => {
  console.error('[e2e-mcp] failed:', err);
  process.exitCode = 1;
});
