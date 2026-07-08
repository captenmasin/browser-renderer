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

test('rejects lighthouse requests without the bearer token', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
  }), {
    token,
    lighthouseRunner: async () => ({ categories: {} }),
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

test('rejects missing lighthouse urls', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: {},
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async () => ({ categories: {} }),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'url required' });
});

test('returns lighthouse results', async () => {
  const lighthouseResult = {
    categories: {
      performance: {
        score: 0.91,
      },
    },
  };
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async (url, options) => {
      assert.equal(url, 'https://example.com/');
      assert.equal(options.timeoutMs, 120_000);
      assert.deepEqual(options.settings, {
        disableStorageReset: true,
        emulatedUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        formFactor: 'desktop',
        screenEmulation: {
          deviceScaleFactor: 1,
          disabled: false,
          height: 940,
          mobile: false,
          width: 1350,
        },
        throttling: {
          cpuSlowdownMultiplier: 1,
          downloadThroughputKbps: 0,
          requestLatencyMs: 0,
          rttMs: 0,
          throughputKbps: 0,
          uploadThroughputKbps: 0,
        },
        throttlingMethod: 'provided',
      });

      return lighthouseResult;
    },
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.lighthouseResult, lighthouseResult);
  assert.equal(body.source, 'browser-renderer');
  assert.equal(typeof body.durationMs, 'number');
});

test('strips lighthouse screenshot blobs from the response', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async () => ({
      audits: {
        'final-screenshot': { details: { data: 'data:image/webp;base64,huge' } },
        'screenshot-thumbnails': { details: { items: [{ data: 'data:image/webp;base64,huge' }] } },
      },
      categories: {
        performance: {
          score: 0.91,
        },
      },
      fullPageScreenshot: {
        screenshot: {
          data: 'data:image/webp;base64,huge',
        },
      },
    }),
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.lighthouseResult.fullPageScreenshot, undefined);
  assert.equal(body.lighthouseResult.audits['final-screenshot'], undefined);
  assert.equal(body.lighthouseResult.audits['screenshot-thumbnails'], undefined);
  assert.equal(body.lighthouseResult.categories.performance.score, 0.91);
});

test('returns safe json when lighthouse times out', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    lighthouseTimeoutMs: 1,
    lighthouseRunner: async () => new Promise(() => {}),
  });

  assert.equal(response.statusCode, 504);
  assert.deepEqual(JSON.parse(response.body), { error: 'lighthouse timed out' });
});

test('returns safe json when lighthouse fails', async () => {
  const response = await handleEvent(event({
    path: '/lighthouse',
    body: { url: 'https://example.com' },
    headers: authHeaders(),
  }), {
    token,
    lighthouseRunner: async () => {
      throw new Error('lighthouse exploded');
    },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'lighthouse exploded' });
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
