const DEFAULT_SCOPES = 'trips:write places:write reservations:write trips:share';
const CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const MAX_TTL_SECONDS = 3600;

let cache = null;

/**
 * Encodes the `/oauth/token` request body. Form-urlencoded per RFC 6749; isolated here so
 * switching to a JSON body (if a live TREK instance turns out to require it) is a one-function
 * change.
 */
function encodeTokenRequestBody({ clientId, clientSecret, scopes }) {
  return new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: scopes,
  }).toString();
}

async function requestToken(config) {
  const body = encodeTokenRequestBody({
    clientId: config.mcp_client_id,
    clientSecret: config.mcp_client_secret,
    scopes: config.mcp_scopes || DEFAULT_SCOPES,
  });

  const res = await fetch(`${config.trek_base_url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/oauth/token failed: ${res.status} ${text.slice(0, 500)}`);
  }

  const { access_token: token, expires_in: expiresIn } = JSON.parse(text);
  const ttlSeconds = Math.min(expiresIn ?? MAX_TTL_SECONDS, MAX_TTL_SECONDS);
  const expiresAt = Date.now() + ttlSeconds * 1000 - CACHE_SAFETY_MARGIN_MS;

  return { token, expiresAt };
}

/**
 * Returns a cached `client_credentials` bearer token for the TREK MCP server, transparently
 * re-requesting one when the cache is empty, expired, or `forceRefresh` is set (used after a 401).
 */
async function getAccessToken(config, { forceRefresh = false } = {}) {
  if (!forceRefresh && cache && Date.now() < cache.expiresAt) {
    return cache.token;
  }

  cache = await requestToken(config);
  return cache.token;
}

/** Test-only: clears the module-level token cache between test cases. */
function _resetTokenCacheForTests() {
  cache = null;
}

module.exports = { getAccessToken, _resetTokenCacheForTests };
