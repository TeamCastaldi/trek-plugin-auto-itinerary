const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyWebhookSecret } = require('../src/resend');

test('accepts a request whose query.secret matches config.webhook_secret', () => {
  const req = { query: { secret: 'sekrit' } };
  assert.equal(verifyWebhookSecret(req, { webhook_secret: 'sekrit' }), true);
});

test('rejects a request with a mismatched secret', () => {
  const req = { query: { secret: 'wrong' } };
  assert.equal(verifyWebhookSecret(req, { webhook_secret: 'sekrit' }), false);
});

test('rejects a request with no secret query param', () => {
  const req = { query: {} };
  assert.equal(verifyWebhookSecret(req, { webhook_secret: 'sekrit' }), false);
});

test('rejects when no webhook_secret is configured, even with a matching-looking query param', () => {
  const req = { query: { secret: '' } };
  assert.equal(verifyWebhookSecret(req, {}), false);
});

test('does not throw or false-positive on differing-length secrets', () => {
  const req = { query: { secret: 'short' } };
  assert.equal(verifyWebhookSecret(req, { webhook_secret: 'a-much-longer-secret-value' }), false);
});
