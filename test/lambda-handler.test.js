import assert from 'node:assert/strict';
import test from 'node:test';

import { handleEvent } from '../lambda/handler.js';

const token = 'test-token';

function event({ method = 'POST', path = '/content', body = {}, headers = {} } = {}) {
  return {
    rawPath: path,
    requestContext: {
      http: {
        method,
      },
    },
    headers,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function authHeaders(value = token) {
  return {
    authorization: `Bearer ${value}`,
  };
}

test('rejects requests without the bearer token', async () => {
  const response = await handleEvent(event({
    body: { url: 'https://example.com' },
  }), {
    token,
    renderUrl: async () => '<html></html>',
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
});

test('rejects requests when the renderer token is not configured', async () => {
  const previousToken = process.env.RENDER_TOKEN;
  delete process.env.RENDER_TOKEN;

  const response = await handleEvent(event({
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    renderUrl: async () => '<html></html>',
  });

  if (previousToken === undefined) {
    delete process.env.RENDER_TOKEN;
  } else {
    process.env.RENDER_TOKEN = previousToken;
  }

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'renderer token not configured' });
});

test('rejects missing urls', async () => {
  const response = await handleEvent(event({
    body: {},
    headers: authHeaders(),
  }), {
    token,
    renderUrl: async () => '<html></html>',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'url required' });
});

test('rejects unsupported url protocols', async () => {
  const response = await handleEvent(event({
    body: { url: 'file:///etc/passwd' },
    headers: authHeaders(),
  }), {
    token,
    renderUrl: async () => '<html></html>',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'unsupported url protocol' });
});

test('returns rendered content', async () => {
  const response = await handleEvent(event({
    body: {
      url: 'https://example.com',
      waitUntil: 'networkidle0',
      timeout: 12_000,
      userAgent: 'SitePulse',
    },
    headers: authHeaders(),
  }), {
    token,
    renderUrl: async (url, options) => {
      assert.equal(url, 'https://example.com/');
      assert.deepEqual(options, {
        waitUntil: 'networkidle0',
        timeout: 12_000,
        userAgent: 'SitePulse',
      });

      return '<html><body>rendered</body></html>';
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    content: '<html><body>rendered</body></html>',
  });
});

test('returns a non-2xx response for oversized rendered content', async () => {
  const response = await handleEvent(event({
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    maxResponseBytes: 30,
    renderUrl: async () => '<html><body>too large</body></html>',
  });

  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).error, 'rendered content too large');
});

test('responds to health checks', async () => {
  const response = await handleEvent(event({
    method: 'GET',
    path: '/healthz',
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ok, true);
});
