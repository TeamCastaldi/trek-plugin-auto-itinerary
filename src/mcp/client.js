const { getAccessToken } = require('./token');

// SCHEMA-GUESS: MCP protocol version string is unverified against a live TREK instance; this is
// the latest spec revision as of writing. Adjust if a live `initialize` response rejects it.
const PROTOCOL_VERSION = '2025-06-18';
const RATE_LIMIT_RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a `/mcp` JSON-RPC response body, handling both a direct `application/json` reply and a
 * `text/event-stream` (SSE) reply. We only need the single frame matching our request's id — no
 * reconnect/backpressure handling, since this client only does synchronous request/response.
 */
async function parseJsonRpcResponse(res, expectedId) {
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!text) return null;

  if (contentType.includes('text/event-stream')) {
    const frames = text
      .split('\n\n')
      .map((frame) => frame.trim())
      .filter(Boolean);

    for (const frame of frames) {
      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim());
      if (!dataLines.length) continue;

      const parsed = JSON.parse(dataLines.join('\n'));
      if (parsed.id === expectedId) return parsed;
    }
    throw new Error(`no matching SSE frame for request id ${expectedId}`);
  }

  return JSON.parse(text);
}

/**
 * SCHEMA-GUESS: the tool-call result shape is unverified until tested live. This follows the
 * generic MCP `CallToolResult` shape (`structuredContent` preferred, else the first text `content`
 * block parsed as JSON, else the raw block), and throws on `isError`.
 */
function unwrapToolResult(rawResult) {
  if (!rawResult) return null;

  if (rawResult.isError) {
    const message = Array.isArray(rawResult.content)
      ? rawResult.content.map((part) => part.text || '').join(' ')
      : 'tool call reported an error';
    throw new Error(`MCP tool call failed: ${message}`);
  }

  if (rawResult.structuredContent) return rawResult.structuredContent;

  if (Array.isArray(rawResult.content)) {
    const textPart = rawResult.content.find((part) => part.type === 'text');
    if (textPart) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return { text: textPart.text };
      }
    }
  }

  return rawResult;
}

/**
 * Opens one Streamable HTTP MCP session against the TREK instance in `config.trek_base_url`:
 * performs the `initialize` handshake, tracks the `Mcp-Session-Id` header, and exposes
 * `listTools`/`callTool` for the orchestration layer. One session is created per invite/message,
 * not per job run or per event.
 */
async function createSession(config) {
  let sessionId = null;
  let requestId = 0;
  let toolsCache = null;

  function nextRequestId() {
    requestId += 1;
    return requestId;
  }

  function captureSessionId(res) {
    const header = res.headers.get('mcp-session-id');
    if (header) sessionId = header;
  }

  async function post(body) {
    const token = await getAccessToken(config);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    return fetch(`${config.trek_base_url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async function postWithRetry(body, { allowAuthRetry = true, allowRateRetry = true } = {}) {
    const res = await post(body);

    if (res.status === 401 && allowAuthRetry) {
      await getAccessToken(config, { forceRefresh: true });
      return postWithRetry(body, { allowAuthRetry: false, allowRateRetry });
    }
    if (res.status === 429 && allowRateRetry) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = Number(retryAfterHeader);
      const delayMs =
        retryAfterHeader && Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : RATE_LIMIT_RETRY_DELAY_MS;
      await sleep(delayMs);
      return postWithRetry(body, { allowAuthRetry, allowRateRetry: false });
    }
    if (res.status === 403) {
      throw new Error('MCP addon is disabled on this TREK instance (403)');
    }

    return res;
  }

  async function call(method, params) {
    const id = nextRequestId();
    const res = await postWithRetry({ jsonrpc: '2.0', id, method, params });
    captureSessionId(res);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${method} failed: ${res.status} ${text.slice(0, 500)}`);
    }

    const message = await parseJsonRpcResponse(res, id);
    if (message && message.error) {
      const err = new Error(`MCP ${method} error: ${message.error.message}`);
      err.code = message.error.code;
      throw err;
    }
    return message ? message.result : undefined;
  }

  async function notify(method, params) {
    const res = await postWithRetry({ jsonrpc: '2.0', method, params });
    captureSessionId(res);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${method} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    await res.text().catch(() => '');
  }

  async function listTools() {
    if (!toolsCache) {
      const result = await call('tools/list', {});
      toolsCache = new Map((result?.tools || []).map((tool) => [tool.name, tool.inputSchema]));
    }
    return toolsCache;
  }

  async function callTool(name, args) {
    const result = await call('tools/call', { name, arguments: args });
    return unwrapToolResult(result);
  }

  async function close() {
    // No explicit MCP session-teardown call is documented/verified; Streamable HTTP sessions
    // time out server-side after 3600s idle (docs/PLAN.md), which is far longer than one
    // per-message session lives. No-op for now.
  }

  await call('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'auto-itinerary', version: '0.1.0' },
  });
  await notify('notifications/initialized', {});

  return { call, listTools, callTool, close };
}

module.exports = { createSession };
