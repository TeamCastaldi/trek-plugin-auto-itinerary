const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockTrekServer, sendJson } = require('./helpers/mock-trek-server');
const { getAccessToken, _resetTokenCacheForTests } = require('../src/mcp/token');

const baseConfig = {
  mcp_client_id: 'client123',
  mcp_client_secret: 'secret123',
  mcp_scopes: 'trips:write',
};

test('fetches and caches a token; a second call within the cache window makes no extra request', async () => {
  _resetTokenCacheForTests();
  let tokenCalls = 0;
  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => {
      tokenCalls += 1;
      sendJson(res, 200, { access_token: 'trekoa_abc', expires_in: 3600 });
    },
  });

  try {
    const config = { ...baseConfig, trek_base_url: server.url };
    const first = await getAccessToken(config);
    const second = await getAccessToken(config);

    assert.equal(first, 'trekoa_abc');
    assert.equal(second, 'trekoa_abc');
    assert.equal(tokenCalls, 1);
  } finally {
    await server.close();
  }
});

test('re-requests once the cached token has expired', async () => {
  _resetTokenCacheForTests();
  let tokenCalls = 0;
  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => {
      tokenCalls += 1;
      // expires_in below the safety margin forces an already-expired cache entry.
      sendJson(res, 200, { access_token: `trekoa_${tokenCalls}`, expires_in: 1 });
    },
  });

  try {
    const config = { ...baseConfig, trek_base_url: server.url };
    const first = await getAccessToken(config);
    const second = await getAccessToken(config);

    assert.equal(first, 'trekoa_1');
    assert.equal(second, 'trekoa_2');
    assert.equal(tokenCalls, 2);
  } finally {
    await server.close();
  }
});

test('forceRefresh bypasses a still-valid cache entry', async () => {
  _resetTokenCacheForTests();
  let tokenCalls = 0;
  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => {
      tokenCalls += 1;
      sendJson(res, 200, { access_token: `trekoa_${tokenCalls}`, expires_in: 3600 });
    },
  });

  try {
    const config = { ...baseConfig, trek_base_url: server.url };
    const first = await getAccessToken(config);
    const second = await getAccessToken(config, { forceRefresh: true });

    assert.equal(first, 'trekoa_1');
    assert.equal(second, 'trekoa_2');
    assert.equal(tokenCalls, 2);
  } finally {
    await server.close();
  }
});

test('a non-2xx /oauth/token response throws a descriptive error', async () => {
  _resetTokenCacheForTests();
  const server = await startMockTrekServer({
    tokenHandler: (_entry, res) => {
      sendJson(res, 401, { error: 'invalid_client' });
    },
  });

  try {
    const config = { ...baseConfig, trek_base_url: server.url };
    await assert.rejects(getAccessToken(config), /\/oauth\/token failed: 401/);
  } finally {
    await server.close();
  }
});
