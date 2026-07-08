const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startMockTrekServer, sendJson } = require('./helpers/mock-trek-server');
const { processMessage } = require('../src/index');
const { _resetTokenCacheForTests } = require('../src/mcp/token');

/**
 * Full-stack integration test: unlike test/mcp-client.test.js (session handshake only) and
 * test/mcp-orchestrate.test.js (orchestration against an in-memory fake session), this drives
 * processMessage with the REAL createSession/buildTripForMessage against an actual HTTP server —
 * the "mock-MCP integration test" row of docs/PLAN.md §5.
 */
function mcpJsonRpcRouter(toolResults) {
  return (entry, res) => {
    const { method, params, id } = entry.body;
    if (method === 'initialize') {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'sess-int' });
      return;
    }
    if (method === 'notifications/initialized') {
      sendJson(res, 200, {});
      return;
    }
    if (method === 'tools/list') {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: [] } });
      return;
    }
    if (method === 'tools/call') {
      const toolName = params.name;
      const structuredContent = toolResults[toolName];
      if (!structuredContent) {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `unexpected tool ${toolName}` }] } });
        return;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { structuredContent } });
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `unhandled method ${method}` } });
  };
}

function fakeCtx() {
  const rows = new Map();
  const logs = { info: [], warn: [], error: [] };
  return {
    log: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
    logs,
    config: {},
    db: {
      async query(sql, params) {
        const row = rows.get(params[0]);
        return row ? [{ ...row }] : [];
      },
      async exec(sql, params) {
        if (sql.includes('INSERT INTO processed_invites')) {
          const [uid, messageId, sequence, payloadHash] = params;
          const existing = rows.get(uid);
          rows.set(uid, {
            uid,
            message_id: messageId,
            sequence,
            trip_id: existing ? existing.trip_id : null,
            share_url: existing ? existing.share_url : null,
            status: 'in_progress',
            payload_hash: payloadHash,
          });
        } else if (sql.includes('SET trip_id = ?')) {
          const [tripId, uid] = params;
          rows.set(uid, { ...rows.get(uid), trip_id: tripId });
        } else if (sql.includes("status = 'done'")) {
          const [tripId, shareUrl, sequence, payloadHash, uid] = params;
          const row = rows.get(uid);
          rows.set(uid, {
            ...row,
            status: 'done',
            trip_id: tripId ?? row.trip_id,
            share_url: shareUrl ?? row.share_url,
            sequence: sequence ?? row.sequence,
            payload_hash: payloadHash ?? row.payload_hash,
          });
        } else if (sql.includes("status = 'cancelled'")) {
          rows.set(params[0], { ...rows.get(params[0]), status: 'cancelled' });
        } else if (sql.includes("status = 'error'")) {
          rows.set(params[0], { ...rows.get(params[0]), status: 'error' });
        } else {
          throw new Error(`fakeCtx: unrecognized SQL: ${sql}`);
        }
      },
    },
    _rows: rows,
  };
}

function stubResendFetch(t, icsText) {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url, ...rest) => {
    if (typeof url === 'string' && url.includes('/attachments/')) {
      return new Response(JSON.stringify({ download_url: 'https://files.example.com/att_1' }), { status: 200 });
    }
    if (url === 'https://files.example.com/att_1') {
      return new Response(icsText, { status: 200 });
    }
    // Anything else (the mock TREK server's /oauth/token and /mcp) goes through the real fetch.
    return originalFetch(url, ...rest);
  };
}

function flightWebhookPayload() {
  return {
    type: 'email.received',
    data: {
      email_id: 'email_flight_1',
      from: 'reservations@testairlines.com',
      to: ['family-inbox@example.com'],
      subject: 'Flight confirmation',
      headers: { 'message-id': '<flight-1@testairlines.com>' },
      attachments: [{ id: 'att_1', filename: 'invite.ics', content_type: 'text/calendar' }],
    },
  };
}

test('processMessage builds a trip end-to-end against a real HTTP mock TREK server', async (t) => {
  _resetTokenCacheForTests();
  const flightIcs = fs.readFileSync(path.join(__dirname, 'fixtures', 'flight.ics'), 'utf8');
  stubResendFetch(t, flightIcs);

  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => sendJson(res, 200, { access_token: 'trekoa_test', expires_in: 3600 }),
    mcpHandler: mcpJsonRpcRouter({
      create_trip: { trip: { id: 'trip_int_1' } },
      get_trip_summary: { days: [{ id: 'day_int_1', date: '2026-08-01' }] },
      create_and_assign_place: { place: { id: 'place_int_1' } },
      create_transport: {},
      create_share_link: { url: 'https://trek.example.com/share/abc' },
    }),
  });

  try {
    const ctx = fakeCtx();
    ctx.config = {
      trek_base_url: server.url,
      mcp_client_id: 'client123',
      mcp_client_secret: 'secret123',
      mcp_scopes: 'trips:write places:write reservations:write trips:share',
      auto_share: 'yes',
    };
    const payload = flightWebhookPayload();

    const result = await processMessage(ctx, payload);
    assert.equal(result.ok, true);

    const [row] = [...ctx._rows.values()];
    assert.equal(row.status, 'done');
    assert.equal(row.trip_id, 'trip_int_1');
    assert.equal(row.share_url, 'https://trek.example.com/share/abc');

    const mcpCalls = server.requestLog
      .filter((entry) => entry.path === '/mcp')
      .map((entry) => entry.body.params && entry.body.params.name ? entry.body.params.name : entry.body.method);
    assert.deepEqual(mcpCalls, [
      'initialize',
      'notifications/initialized',
      'tools/list',
      'create_trip',
      'get_trip_summary',
      'create_and_assign_place',
      'create_transport',
      'create_share_link',
    ]);

    const mcpRequestCountAfterFirstRun = server.requestLog.filter((entry) => entry.path === '/mcp').length;

    // Re-delivering the same already-done invite must be a no-op: no new /mcp traffic at all.
    const secondResult = await processMessage(ctx, payload);
    assert.equal(secondResult.ok, true);
    const mcpRequestCountAfterSecondRun = server.requestLog.filter((entry) => entry.path === '/mcp').length;
    assert.equal(mcpRequestCountAfterSecondRun, mcpRequestCountAfterFirstRun);
  } finally {
    await server.close();
  }
});
