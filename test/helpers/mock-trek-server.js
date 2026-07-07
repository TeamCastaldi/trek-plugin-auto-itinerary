const http = require('node:http');

/**
 * Minimal in-process fake of a TREK instance's `/oauth/token` and `/mcp` endpoints, for testing
 * the token manager and MCP client without a live TREK server. Not a `node:test` suite itself.
 */
function startMockTrekServer({ tokenHandler, mcpHandler } = {}) {
  const requestLog = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = null;
      }
      const entry = { method: req.method, path: req.url, headers: req.headers, rawBody, body };
      requestLog.push(entry);

      if (req.url === '/oauth/token' && tokenHandler) {
        tokenHandler(entry, res);
        return;
      }
      if (req.url === '/mcp' && mcpHandler) {
        mcpHandler(entry, res);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestLog,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function sendSse(res, status, jsonRpcMessage, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'text/event-stream', ...extraHeaders });
  res.end(`data: ${JSON.stringify(jsonRpcMessage)}\n\n`);
}

module.exports = { startMockTrekServer, sendJson, sendSse };
