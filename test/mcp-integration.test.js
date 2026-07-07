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

function fakeConnection() {
  const marked = [];
  return { marked, addFlags: async (uid) => marked.push(uid), moveMessage: async () => {} };
}

function flightMessage() {
  const ics = fs.readFileSync(path.join(__dirname, 'fixtures', 'flight.ics'), 'utf8');
  const source = [
    'From: reservations@testairlines.com',
    'To: family-inbox@example.com',
    'Subject: Flight confirmation',
    'MIME-Version: 1.0',
    'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
    'Content-Transfer-Encoding: 7bit',
    '',
    ics,
  ].join('\r\n');
  return { uid: 1, messageId: '<flight-1@testairlines.com>', source };
}

test('processMessage builds a trip end-to-end against a real HTTP mock TREK server', async () => {
  _resetTokenCacheForTests();
  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => sendJson(res, 200, { access_token: 'trekoa_test', expires_in: 3600 }),
    mcpHandler: mcpJsonRpcRouter({
      create_trip: { tripId: 'trip_int_1' },
      create_and_assign_place: { placeId: 'place_int_1' },
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
    const connection = fakeConnection();
    const message = flightMessage();

    await processMessage(ctx, connection, message);

    const [row] = [...ctx._rows.values()];
    assert.equal(row.status, 'done');
    assert.equal(row.trip_id, 'trip_int_1');
    assert.equal(row.share_url, 'https://trek.example.com/share/abc');
    assert.deepEqual(connection.marked, [1]);

    const mcpCalls = server.requestLog
      .filter((entry) => entry.path === '/mcp')
      .map((entry) => entry.body.params && entry.body.params.name ? entry.body.params.name : entry.body.method);
    assert.deepEqual(mcpCalls, [
      'initialize',
      'notifications/initialized',
      'tools/list',
      'create_trip',
      'create_and_assign_place',
      'create_transport',
      'create_share_link',
    ]);

    const mcpRequestCountAfterFirstRun = server.requestLog.filter((entry) => entry.path === '/mcp').length;

    // Re-polling the same already-done invite must be a no-op: no new /mcp traffic at all.
    await processMessage(ctx, connection, message);
    const mcpRequestCountAfterSecondRun = server.requestLog.filter((entry) => entry.path === '/mcp').length;
    assert.equal(mcpRequestCountAfterSecondRun, mcpRequestCountAfterFirstRun);
    assert.deepEqual(connection.marked, [1, 1]);
  } finally {
    await server.close();
  }
});
