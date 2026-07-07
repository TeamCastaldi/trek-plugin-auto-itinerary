const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockTrekServer, sendJson, sendSse } = require('./helpers/mock-trek-server');
const { createSession } = require('../src/mcp/client');
const { _resetTokenCacheForTests } = require('../src/mcp/token');

const SESSION_ID = 'sess-abc123';

function baseConfig(url) {
  return {
    trek_base_url: url,
    mcp_client_id: 'client123',
    mcp_client_secret: 'secret123',
    mcp_scopes: 'trips:write',
  };
}

async function withTokenServerStubbed(mcpHandler, testFn) {
  _resetTokenCacheForTests();
  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => {
      sendJson(res, 200, { access_token: 'trekoa_test', expires_in: 3600 });
    },
    mcpHandler,
  });
  try {
    await testFn(server);
  } finally {
    await server.close();
  }
}

function mcpRequestsOnly(requestLog) {
  return requestLog.filter((entry) => entry.path === '/mcp');
}

test('createSession performs initialize + notifications/initialized and tracks the session id', async () => {
  await withTokenServerStubbed(
    (entry, res) => {
      if (entry.body.method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: {} }, { 'mcp-session-id': SESSION_ID });
        return;
      }
      if (entry.body.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (entry.body.method === 'tools/list') {
        assert.equal(entry.headers['mcp-session-id'], SESSION_ID);
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: { tools: [] } });
        return;
      }
      res.writeHead(500).end();
    },
    async (server) => {
      const session = await createSession(baseConfig(server.url));
      await session.listTools();

      const mcpRequests = mcpRequestsOnly(server.requestLog);
      assert.equal(mcpRequests.length, 3);
      assert.equal(mcpRequests[0].body.method, 'initialize');
      assert.equal(mcpRequests[1].body.method, 'notifications/initialized');
      assert.equal(mcpRequests[2].body.method, 'tools/list');
      assert.equal(mcpRequests[2].headers['mcp-session-id'], SESSION_ID);
    }
  );
});

test('listTools caches the result across calls', async () => {
  let toolsListCalls = 0;
  await withTokenServerStubbed(
    (entry, res) => {
      if (entry.body.method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: {} }, { 'mcp-session-id': SESSION_ID });
        return;
      }
      if (entry.body.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (entry.body.method === 'tools/list') {
        toolsListCalls += 1;
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: entry.body.id,
          result: { tools: [{ name: 'create_trip', inputSchema: { properties: { title: {} } } }] },
        });
        return;
      }
      res.writeHead(500).end();
    },
    async (server) => {
      const session = await createSession(baseConfig(server.url));
      const first = await session.listTools();
      const second = await session.listTools();

      assert.equal(toolsListCalls, 1);
      assert.equal(first, second);
      assert.ok(first.has('create_trip'));
    }
  );
});

test('parses a text/event-stream tools/call response', async () => {
  await withTokenServerStubbed(
    (entry, res) => {
      if (entry.body.method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: {} }, { 'mcp-session-id': SESSION_ID });
        return;
      }
      if (entry.body.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (entry.body.method === 'tools/call') {
        sendSse(res, 200, {
          jsonrpc: '2.0',
          id: entry.body.id,
          result: { structuredContent: { tripId: 'trip_1' } },
        });
        return;
      }
      res.writeHead(500).end();
    },
    async (server) => {
      const session = await createSession(baseConfig(server.url));
      const result = await session.callTool('create_trip', { title: 'Business trip' });
      assert.deepEqual(result, { tripId: 'trip_1' });
    }
  );
});

test('retries once after a 401 with a freshly refreshed token', async () => {
  let tokenCalls = 0;
  let toolCallAttempts = 0;
  _resetTokenCacheForTests();
  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => {
      tokenCalls += 1;
      sendJson(res, 200, { access_token: `trekoa_${tokenCalls}`, expires_in: 3600 });
    },
    mcpHandler: (entry, res) => {
      if (entry.body.method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: {} }, { 'mcp-session-id': SESSION_ID });
        return;
      }
      if (entry.body.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (entry.body.method === 'tools/call') {
        toolCallAttempts += 1;
        if (toolCallAttempts === 1) {
          res.writeHead(401).end();
          return;
        }
        assert.equal(entry.headers.authorization, 'Bearer trekoa_2');
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: { structuredContent: { ok: true } } });
        return;
      }
      res.writeHead(500).end();
    },
  });

  try {
    const session = await createSession(baseConfig(server.url));
    const result = await session.callTool('create_trip', {});
    assert.deepEqual(result, { ok: true });
    assert.equal(toolCallAttempts, 2);
    assert.equal(tokenCalls, 2);
  } finally {
    await server.close();
  }
});

test('retries once after a 429', async () => {
  let attempts = 0;
  await withTokenServerStubbed(
    (entry, res) => {
      if (entry.body.method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: {} }, { 'mcp-session-id': SESSION_ID });
        return;
      }
      if (entry.body.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (entry.body.method === 'tools/call') {
        attempts += 1;
        if (attempts === 1) {
          res.writeHead(429, { 'retry-after': '0' }).end();
          return;
        }
        sendJson(res, 200, { jsonrpc: '2.0', id: entry.body.id, result: { structuredContent: { ok: true } } });
        return;
      }
      res.writeHead(500).end();
    },
    async (server) => {
      const session = await createSession(baseConfig(server.url));
      const result = await session.callTool('create_trip', {});
      assert.deepEqual(result, { ok: true });
      assert.equal(attempts, 2);
    }
  );
});

test('a 403 on /mcp throws immediately with no retry', async () => {
  let attempts = 0;
  await withTokenServerStubbed(
    (entry, res) => {
      attempts += 1;
      if (entry.body.method === 'initialize') {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(500).end();
    },
    async (server) => {
      await assert.rejects(createSession(baseConfig(server.url)), /MCP addon is disabled/);
      assert.equal(attempts, 1);
    }
  );
});
